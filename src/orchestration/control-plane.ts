import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { ProjectOperationsError } from "../project-operations/errors";
import type { ProjectStore } from "../project-store/project-store";
import type { VersionedState } from "../project-store/types";
import { ProjectStoreError } from "../project-store/types";
import { MAX_PROVIDER_RETRY_HINT_MS, ProviderLimitError } from "../runner/errors";
import type { Tool } from "../runner/tool";
import { defineTool } from "../runner/tool";
import type { SessionLimitController, SessionLimitSnapshot } from "../session-limits";
import { deriveChildSpecs } from "./decompose";
import type { PipelineResult, PipelineStageMetrics, Verdict } from "./types";

export type RunMode = "auto" | "manual";
export type ControlPlaneRunStatus =
  | "queued"
  | "running"
  | "paused"
  | "awaiting_decision"
  | "cancelled"
  | "complete"
  | "failed";

export interface RunScope {
  allowedPaths: string[];
  allowedCapabilities: string[];
  externalEffects: string[];
}

export interface ChildPipelineSpec extends RunScope {
  task: string;
  // A host-supplied spec names the decision that authorized it; a derived spec gets its id attached when the decision accepts it (remainingChildren mapping below).
  parentDecisionId?: string;
}

export interface DecisionRecord {
  id: string;
  status: "pending" | "accepted" | "rejected" | "deferred";
  action?: "accept" | "reject" | "defer";
  rationale?: string;
  evidence: string[];
  scope: RunScope;
  mandateSource: "operator" | "auto_mode";
  affectedRunIds: string[];
  createdAt: string;
  resolvedAt?: string;
}

export interface ExternalLimit {
  source: "provider" | "session" | "project";
  state: "unavailable" | "limited" | "unknown" | "exhausted";
  resumable: true;
  /** Validated delay only; provider headers and messages are never retained. */
  retryAfterMs?: number;
}

export interface DurableRunRecord {
  schemaVersion: 1;
  id: string;
  requestKey: string;
  task: string;
  mode: RunMode;
  status: ControlPlaneRunStatus;
  depth: number;
  rootRunId: string;
  parentRunId?: string;
  childRunIds: string[];
  remainingChildren: ChildPipelineSpec[];
  scope: RunScope;
  decisions: DecisionRecord[];
  verdicts: Verdict[];
  createdAt: string;
  updatedAt: string;
  cancelRequested: boolean;
  providerTurnInFlight: boolean;
  executionLease?: string;
  authorizationDecisionId?: string;
  eventSequence: number;
  events: ControlPlaneEvent[];
  result?: PipelineResult;
  externalLimit?: ExternalLimit;
  failureCode?: string;
  breakpoint?: RunBreakpoint;
  reviewedPaths?: string[];
  contentBinding?: ContentBinding;
  publication?: PublicationSummary;
  sessionLimitSnapshot?: SessionLimitSnapshot;
  operations?: RunOperationalSummary;
  /** Persisted so process reconstruction cannot reset the automatic retry ceiling. */
  automaticRetryAttempts?: number;
}

export type ControlPlaneEventType =
  | "run.completed"
  | "decision.required"
  | "decomposition.required"
  | "run.paused.external_limit"
  | "run.failed"
  | "publication.completed";

export interface ControlPlaneEvent {
  sequence: number;
  type: ControlPlaneEventType;
  runId: string;
  createdAt: string;
}

export type RunBreakpoint = "pipeline" | "decision" | "publication";

export interface ContentBindingEntry {
  path: string;
  kind: "file" | "symlink" | "deleted";
  mode: number;
  sha256: string;
}

export interface ContentBinding {
  algorithm: "sha256";
  manifestHash: string;
  entries: ContentBindingEntry[];
  headOid: string;
  treeOid: string;
  publishTreeOid: string;
}

export interface PublicationSummary {
  phase: "finished" | "awaiting-manual";
  featureOid?: string;
  baseOid?: string;
  prUrl?: string;
  gateStatuses: string[];
  recoveryCategories: string[];
  binding: ContentBinding;
}

export interface RunReport {
  run: SafeRunStatus;
  children: SafeRunStatus[];
  verdicts: Verdict[];
  decisions: SafeDecisionStatus[];
  contentBinding?: ContentBinding;
  publication?: PublicationSummary;
  sessionLimit?: SessionLimitSnapshot;
  decomposition: { remaining: number; depth: number };
  filesChanged: string[];
  checks: Array<{ name: string; status: "passed" | "failed" | "skipped" }>;
  usage: { turns: number; costUsd: number };
  stageMetrics: PipelineStageMetrics[];
  checkpointPath: string;
  backlog: { destination: string; file?: string; count: number };
}

export interface RunOperationalSummary {
  filesChanged?: string[];
  checks?: Array<{ name: string; status: "passed" | "failed" | "skipped" }>;
  checkpointPath?: string;
  backlog?: { destination: string; file?: string; count: number };
}

export interface TriageInput {
  touchesContracts: boolean;
  securitySurface: "ordinary" | "elevated";
  changeSize: "local" | "large";
  reversible: boolean;
}

export function triageControlPlaneTask(input: TriageInput): "inline" | "pipeline" {
  if (
    typeof input !== "object" ||
    input === null ||
    typeof input.touchesContracts !== "boolean" ||
    !(input.securitySurface === "ordinary" || input.securitySurface === "elevated") ||
    !(input.changeSize === "local" || input.changeSize === "large") ||
    typeof input.reversible !== "boolean"
  )
    throw new ProjectOperationsError("invalid_config", "triage");
  return input.touchesContracts ||
    input.securitySurface === "elevated" ||
    input.changeSize === "large" ||
    !input.reversible
    ? "pipeline"
    : "inline";
}

interface ControlPlaneIndex {
  schemaVersion: 1;
  requests: Record<string, string>;
  rootIds: string[];
}

export interface ControlPlaneConfig {
  autoDecomposition?: boolean;
  /** Semantic recursion guard. Zero explicitly means unlimited. */
  maxDecompositionDepth?: number;
  /** Resource guard. Zero explicitly means unlimited. */
  maxChildPipelines?: number;
  maxQueuedRootRuns?: number;
  maxActiveRootRuns?: number;
  maxProjectTurns?: number;
  maxProjectCostUsd?: number;
  /** Zero disables all automatic timed retry, including provider hints. */
  retryIntervalMs?: number;
  /** Zero disables automatic retry; positive values bound attempts per run. */
  maxAutomaticRetryAttempts?: number;
}

export const MAX_RETRY_DELAY_MS = MAX_PROVIDER_RETRY_HINT_MS;
export const MAX_AUTOMATIC_RETRY_ATTEMPTS = 100;

export const DEFAULT_CONTROL_PLANE_CONFIG = {
  autoDecomposition: true,
  maxDecompositionDepth: 1,
  maxChildPipelines: 0,
  maxQueuedRootRuns: 0,
  maxActiveRootRuns: 0,
  maxProjectTurns: 0,
  maxProjectCostUsd: 0,
  retryIntervalMs: 0,
  maxAutomaticRetryAttempts: 0,
} as const;

export interface ProviderAvailability {
  state: "available" | "unavailable" | "limited" | "unknown";
}

export interface PipelineExecution {
  result: PipelineResult;
  children?: ChildPipelineSpec[];
  reviewedPaths?: string[];
  operations?: RunOperationalSummary;
}

export interface RetryCoordinator {
  schedule(runId: string, delayMs: number, callback: () => Promise<void>): void;
  cancel(runId: string): void;
}

export interface LiveRetryCoordinatorOptions {
  /** Host-wide provider admissions. A positive bound is required. */
  maxConcurrentAdmissions?: number;
  /** Ready callbacks retained while admissions are busy. A positive bound is required. */
  maxQueuedAdmissions?: number;
  /** Fractional delay spread applied symmetrically. Defaults to 10%. */
  jitterRatio?: number;
  random?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

/**
 * Shared live-host retry gate. One instance is deliberately reusable by every
 * control plane in a process, so provider recovery cannot bypass a host-wide
 * admission bound by creating more run objects.
 */
export class LiveRetryCoordinator implements RetryCoordinator {
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly ready: Array<{ runId: string; callback: () => Promise<void> }> = [];
  private active = 0;
  private readonly maxConcurrentAdmissions: number;
  private readonly maxQueuedAdmissions: number;
  private readonly jitterRatio: number;
  private readonly random: () => number;
  private readonly setTimer: NonNullable<LiveRetryCoordinatorOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<LiveRetryCoordinatorOptions["clearTimer"]>;

  constructor(options: LiveRetryCoordinatorOptions = {}) {
    this.maxConcurrentAdmissions = options.maxConcurrentAdmissions ?? 1;
    this.maxQueuedAdmissions = options.maxQueuedAdmissions ?? 1_024;
    this.jitterRatio = options.jitterRatio ?? 0.1;
    if (!Number.isSafeInteger(this.maxConcurrentAdmissions) || this.maxConcurrentAdmissions <= 0)
      throw new ProjectOperationsError("invalid_config", "maxConcurrentAdmissions");
    if (!Number.isSafeInteger(this.maxQueuedAdmissions) || this.maxQueuedAdmissions <= 0)
      throw new ProjectOperationsError("invalid_config", "maxQueuedAdmissions");
    if (!Number.isFinite(this.jitterRatio) || this.jitterRatio < 0 || this.jitterRatio > 1)
      throw new ProjectOperationsError("invalid_config", "jitterRatio");
    this.random = options.random ?? Math.random;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  schedule(runId: string, delayMs: number, callback: () => Promise<void>): void {
    this.cancel(runId);
    const spread = delayMs * this.jitterRatio;
    const jittered = Math.round(delayMs - spread + this.random() * spread * 2);
    const timer = this.setTimer(
      () => {
        if (this.pending.get(runId) !== timer) return;
        this.pending.delete(runId);
        if (this.ready.length >= this.maxQueuedAdmissions) {
          process.stderr.write(
            "ad-coder: provider retry queue is full; explicit resume required\n",
          );
          return;
        }
        this.ready.push({ runId, callback });
        this.drain();
      },
      Math.min(MAX_RETRY_DELAY_MS, Math.max(1_000, jittered)),
    );
    this.pending.set(runId, timer);
  }

  cancel(runId: string): void {
    const timer = this.pending.get(runId);
    if (timer !== undefined) this.clearTimer(timer);
    this.pending.delete(runId);
    const queued = this.ready.findIndex((entry) => entry.runId === runId);
    if (queued >= 0) this.ready.splice(queued, 1);
  }

  private drain(): void {
    while (this.active < this.maxConcurrentAdmissions) {
      const entry = this.ready.shift();
      if (entry === undefined) return;
      this.active += 1;
      void entry
        .callback()
        .catch(() => {
          process.stderr.write(
            "ad-coder: provider retry callback failed; explicit resume required\n",
          );
        })
        .finally(() => {
          this.active -= 1;
          this.drain();
        });
    }
  }
}

export interface ControlPlaneDependencies {
  store: ProjectStore;
  execute: (record: Readonly<DurableRunRecord>) => Promise<PipelineExecution>;
  providerAvailability?: () => Promise<ProviderAvailability> | ProviderAvailability;
  /** Shared live-host gate. Daemon-free callers omit it and resume explicitly. */
  retryCoordinator?: RetryCoordinator;
  resolveAutoDecision?: (
    decision: Readonly<DecisionRecord>,
    record: Readonly<DurableRunRecord>,
  ) => Promise<{
    action: "accept" | "reject" | "defer";
    rationale: string;
    evidence: string[];
  }>;
  now?: () => Date;
  id?: () => string;
  config?: ControlPlaneConfig;
  sessionLimits?: SessionLimitController;
  publishApproved?: (
    record: Readonly<DurableRunRecord>,
    binding: Readonly<ContentBinding>,
  ) => Promise<Omit<PublicationSummary, "binding">>;
}

export interface StartRunInput {
  requestKey: string;
  task: string;
  mode: RunMode;
  scope?: Partial<RunScope>;
}

export interface ResumeRunInput {
  runUntil?: RunBreakpoint;
}

export interface DecisionRequest {
  action: string;
  evidence: string[];
  scope: Partial<RunScope>;
  affectedRunIds?: string[];
}

export interface SafeRunStatus {
  id: string;
  status: ControlPlaneRunStatus;
  mode: RunMode;
  depth: number;
  rootRunId: string;
  parentRunId?: string;
  childRunIds: string[];
  decisionCount: number;
  verdictStatuses: Verdict["status"][];
  outcome?: PipelineResult["outcome"];
  /** Escalation signal, present only when the review stop rule settled the run. */
  escalation?: PipelineResult["escalation"];
  externalLimit?: ExternalLimit;
}

export interface SafeDecisionStatus {
  id: string;
  status: DecisionRecord["status"];
  mandateSource: DecisionRecord["mandateSource"];
  affectedRunIds: string[];
}

function normalizedScope(scope: unknown = {}): RunScope {
  if (typeof scope !== "object" || scope === null || Array.isArray(scope))
    throw new ProjectOperationsError("invalid_follow_up", "scope");
  const value = scope as Record<string, unknown>;
  const clean = (values: unknown, name: string): string[] => {
    if (values === undefined) return [];
    if (!Array.isArray(values) || values.some((entry) => typeof entry !== "string"))
      throw new ProjectOperationsError("invalid_follow_up", name);
    return [...new Set(values as string[])]
      .map((entry) => entry.trim())
      .filter(Boolean)
      .sort();
  };
  return {
    allowedPaths: clean(value.allowedPaths, "scope.allowedPaths"),
    allowedCapabilities: clean(value.allowedCapabilities, "scope.allowedCapabilities"),
    externalEffects: clean(value.externalEffects, "scope.externalEffects"),
  };
}

function evidenceReferences(values: string[]): string[] {
  const unique = [...new Set(values)].sort();
  if (unique.some((value) => !/^[A-Za-z0-9._/#:-]{1,200}$/.test(value)))
    throw new ProjectOperationsError("invalid_follow_up", "decision.evidence");
  return unique;
}

function redactCredentialLike(value: string): string {
  return value.replace(
    /\b(?:sk|ghp|github_pat|xox[baprs])[-_A-Za-z0-9]{8,}\b|\b(?:token|secret|password|api[_-]?key)\s*[:=]\s*\S+/gi,
    "[redacted]",
  );
}

function redactForPersistence<T>(value: T): T {
  if (typeof value === "string") return redactCredentialLike(value) as T;
  if (Array.isArray(value)) return value.map((entry) => redactForPersistence(entry)) as T;
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactForPersistence(entry)]),
    ) as T;
  return value;
}

function isSubset(child: RunScope, parent: RunScope): boolean {
  const subset = (values: string[], allowed: string[]) =>
    values.every((value) => allowed.includes(value));
  return (
    subset(child.allowedPaths, parent.allowedPaths) &&
    subset(child.allowedCapabilities, parent.allowedCapabilities) &&
    subset(child.externalEffects, parent.externalEffects)
  );
}

function safeStatus(record: DurableRunRecord): SafeRunStatus {
  return {
    id: record.id,
    status: record.status,
    mode: record.mode,
    depth: record.depth,
    rootRunId: record.rootRunId,
    ...(record.parentRunId !== undefined && { parentRunId: record.parentRunId }),
    childRunIds: [...record.childRunIds],
    decisionCount: record.decisions.length,
    verdictStatuses: record.verdicts.map((verdict) => verdict.status),
    ...(record.result !== undefined && { outcome: record.result.outcome }),
    ...(record.result?.escalation !== undefined && { escalation: record.result.escalation }),
    ...(record.externalLimit !== undefined && { externalLimit: record.externalLimit }),
  };
}

/** Durable, daemon-free admission and execution service. `start` only persists intent. */
export class OrchestratorControlPlane {
  private readonly config: Required<ControlPlaneConfig>;

  constructor(private readonly deps: ControlPlaneDependencies) {
    this.config = { ...DEFAULT_CONTROL_PLANE_CONFIG, ...deps.config };
    for (const [name, value] of Object.entries(this.config)) {
      if (name === "autoDecomposition") continue;
      const valid =
        name === "maxProjectCostUsd"
          ? typeof value === "number" && Number.isFinite(value) && value >= 0
          : Number.isSafeInteger(value) && (value as number) >= 0;
      if (!valid) throw new ProjectOperationsError("invalid_config", name);
    }
    if (this.config.retryIntervalMs > MAX_RETRY_DELAY_MS)
      throw new ProjectOperationsError("invalid_config", "retryIntervalMs");
    if (this.config.maxAutomaticRetryAttempts > MAX_AUTOMATIC_RETRY_ATTEMPTS)
      throw new ProjectOperationsError("invalid_config", "maxAutomaticRetryAttempts");
  }

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  private recordPath(id: string): string {
    this.deps.store.validateId(id);
    return path.join(this.deps.store.layout.runs, `control-${id}.json`);
  }

  private indexPath(): string {
    return path.join(this.deps.store.layout.runs, "control-index.json");
  }

  private stageMetrics(record: DurableRunRecord): PipelineStageMetrics[] {
    if (record.result?.stageMetrics !== undefined)
      return structuredClone(record.result.stageMetrics);
    const coordinatorPath = path.join(this.deps.store.layout.runs, `coordinator-${record.id}.json`);
    try {
      const checkpoint = this.deps.store.readVersionedJson<{
        workflowState?: { stageMetrics?: PipelineStageMetrics[] };
      }>(coordinatorPath);
      return structuredClone(checkpoint.value.workflowState?.stageMetrics ?? []);
    } catch (error) {
      if (error instanceof ProjectStoreError && error.code === "not_found") {
        // Queued and legacy runs legitimately have no coordinator checkpoint yet.
        return [];
      }
      throw error;
    }
  }

  private read(id: string): VersionedState<DurableRunRecord> {
    return this.deps.store.readVersionedJson(this.recordPath(id));
  }

  private write(
    state: VersionedState<DurableRunRecord>,
    value: DurableRunRecord,
  ): VersionedState<DurableRunRecord> {
    try {
      return this.deps.store.writeVersionedJson(this.recordPath(value.id), value, state.version);
    } catch (error) {
      if (error instanceof ProjectStoreError && error.code === "version_conflict")
        throw new ProjectOperationsError("checkpoint_conflict", value.id);
      throw error;
    }
  }

  private withEvent(record: DurableRunRecord, type: ControlPlaneEventType): DurableRunRecord {
    const sequence = record.eventSequence + 1;
    return {
      ...record,
      eventSequence: sequence,
      events: [...record.events, { sequence, type, runId: record.id, createdAt: this.now() }],
    };
  }

  private records(): VersionedState<DurableRunRecord>[] {
    const names = fs
      .readdirSync(this.deps.store.layout.runs)
      .filter(
        (name) => name !== "control-index.json" && /^control-[A-Za-z0-9_-]{1,64}\.json$/.test(name),
      )
      .sort();
    return names.map((name) =>
      this.deps.store.readVersionedJson<DurableRunRecord>(
        path.join(this.deps.store.layout.runs, name),
      ),
    );
  }

  start(input: StartRunInput): SafeRunStatus {
    if (typeof input !== "object" || input === null)
      throw new ProjectOperationsError("invalid_config", "start");
    if (typeof input.requestKey !== "string" || typeof input.task !== "string")
      throw new ProjectOperationsError("invalid_config", "start");
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.requestKey))
      throw new ProjectOperationsError("invalid_config", "requestKey");
    if (input.task.trim() === "") throw new ProjectOperationsError("invalid_config", "task");
    if (input.mode !== "auto" && input.mode !== "manual")
      throw new ProjectOperationsError("invalid_config", "mode");
    if (input.mode === "auto" && this.deps.resolveAutoDecision === undefined)
      throw new ProjectOperationsError("invalid_config", "resolveAutoDecision");
    let admitted: DurableRunRecord | undefined;
    try {
      this.deps.store.mutateVersionedJson<ControlPlaneIndex>(this.indexPath(), (current) => {
        const index = current?.value ?? { schemaVersion: 1, requests: {}, rootIds: [] };
        const existingId = index.requests[input.requestKey];
        if (existingId !== undefined) {
          admitted = this.read(existingId).value;
          return index;
        }
        const roots = index.rootIds.map((rootId) => this.read(rootId).value);
        const queued = roots.filter((item) => item.status === "queued").length;
        const active = roots.filter((item) =>
          ["running", "paused", "awaiting_decision"].includes(item.status),
        ).length;
        if (this.config.maxQueuedRootRuns > 0 && queued >= this.config.maxQueuedRootRuns)
          throw new ProjectOperationsError("resource_limit", "maxQueuedRootRuns");
        if (this.config.maxActiveRootRuns > 0 && active >= this.config.maxActiveRootRuns)
          throw new ProjectOperationsError("resource_limit", "maxActiveRootRuns");
        const id = this.deps.id?.() ?? crypto.randomUUID();
        const timestamp = this.now();
        admitted = {
          schemaVersion: 1,
          id,
          requestKey: input.requestKey,
          task: redactCredentialLike(input.task),
          mode: input.mode,
          status: "queued",
          depth: 0,
          rootRunId: id,
          childRunIds: [],
          remainingChildren: [],
          scope: normalizedScope(input.scope),
          decisions: [],
          verdicts: [],
          createdAt: timestamp,
          updatedAt: timestamp,
          cancelRequested: false,
          providerTurnInFlight: false,
          eventSequence: 0,
          events: [],
        };
        this.deps.store.writeVersionedJson(this.recordPath(id), admitted, 0);
        return {
          schemaVersion: 1,
          requests: { ...index.requests, [input.requestKey]: id },
          rootIds: [...index.rootIds, id],
        };
      });
    } catch (error) {
      if (error instanceof ProjectStoreError && error.code === "version_conflict") {
        try {
          const existingId = this.deps.store.readVersionedJson<ControlPlaneIndex>(this.indexPath())
            .value.requests[input.requestKey];
          if (existingId !== undefined) admitted = this.read(existingId).value;
          else throw new ProjectOperationsError("checkpoint_conflict", input.requestKey);
        } catch (readError) {
          if (readError instanceof ProjectOperationsError) throw readError;
          throw new ProjectOperationsError("checkpoint_conflict", input.requestKey);
        }
      } else throw error;
    }
    if (admitted === undefined)
      throw new ProjectOperationsError("checkpoint_conflict", input.requestKey);
    return safeStatus(admitted);
  }

  status(id: string): SafeRunStatus {
    return safeStatus(this.read(id).value);
  }

  list(): SafeRunStatus[] {
    return this.records().map((item) => safeStatus(item.value));
  }

  listDecisions(id: string): SafeDecisionStatus[] {
    return this.read(id).value.decisions.map((decision) => ({
      id: decision.id,
      status: decision.status,
      mandateSource: decision.mandateSource,
      affectedRunIds: [...decision.affectedRunIds],
    }));
  }

  events(id: string, after = 0): ControlPlaneEvent[] {
    if (!Number.isSafeInteger(after) || after < 0)
      throw new ProjectOperationsError("invalid_config", "events.after");
    return structuredClone(this.read(id).value.events.filter((event) => event.sequence > after));
  }

  /** Trusted host view. Model-facing tools must use status/list safe projections instead. */
  record(id: string): DurableRunRecord {
    return structuredClone(this.read(id).value);
  }

  async requestDecision(id: string, request: DecisionRequest): Promise<DecisionRecord> {
    if (
      typeof request !== "object" ||
      request === null ||
      typeof request.action !== "string" ||
      request.action.trim() === "" ||
      !Array.isArray(request.evidence) ||
      request.evidence.some((entry) => typeof entry !== "string") ||
      (request.affectedRunIds !== undefined &&
        (!Array.isArray(request.affectedRunIds) ||
          request.affectedRunIds.some((entry) => typeof entry !== "string")))
    )
      throw new ProjectOperationsError("invalid_follow_up", "decision");
    let state = this.read(id);
    const scope = normalizedScope(request.scope);
    if (!isSubset(scope, state.value.scope))
      throw new ProjectOperationsError("invalid_follow_up", "decision.scope");
    const timestamp = this.now();
    const decision: DecisionRecord = {
      id: crypto
        .createHash("sha256")
        .update(`${id}:${request.action}:${state.value.decisions.length}`)
        .digest("hex")
        .slice(0, 32),
      status: "pending",
      evidence: evidenceReferences(request.evidence),
      scope,
      mandateSource: state.value.mode === "auto" ? "auto_mode" : "operator",
      affectedRunIds: request.affectedRunIds ?? [id],
      createdAt: timestamp,
    };
    if (state.value.mode === "manual") {
      state = this.write(
        state,
        this.withEvent(
          {
            ...state.value,
            decisions: [...state.value.decisions, decision],
            status: "awaiting_decision",
            updatedAt: timestamp,
          },
          "decision.required",
        ),
      );
      return structuredClone(decision);
    }
    if (this.deps.resolveAutoDecision === undefined)
      throw new ProjectOperationsError("invalid_config", "resolveAutoDecision");
    const resolution = await this.deps.resolveAutoDecision(decision, state.value);
    if (!(["accept", "reject", "defer"] as const).includes(resolution.action))
      throw new ProjectOperationsError("invalid_follow_up", "decision.action");
    const resolved: DecisionRecord = {
      ...decision,
      status:
        resolution.action === "accept"
          ? "accepted"
          : resolution.action === "reject"
            ? "rejected"
            : "deferred",
      action: resolution.action,
      rationale: redactCredentialLike(resolution.rationale),
      evidence: evidenceReferences([...decision.evidence, ...resolution.evidence]),
      resolvedAt: this.now(),
    };
    this.write(state, {
      ...state.value,
      decisions: [...state.value.decisions, resolved],
      status: resolved.status === "deferred" ? "paused" : "queued",
      updatedAt: this.now(),
    });
    return structuredClone(resolved);
  }

  /** Manual authority boundary: only trusted host/CLI code should expose this method. */
  resolveDecisionFromOperator(
    runId: string,
    decisionId: string,
    action: "accept" | "reject" | "defer",
    rationale: string,
  ): DecisionRecord {
    if (!(action === "accept" || action === "reject" || action === "defer"))
      throw new ProjectOperationsError("invalid_follow_up", "decision.action");
    if (typeof rationale !== "string" || rationale.trim() === "")
      throw new ProjectOperationsError("invalid_follow_up", "decision.rationale");
    const state = this.read(runId);
    if (state.value.mode !== "manual")
      throw new ProjectOperationsError("invalid_follow_up", "decision.mode");
    const index = state.value.decisions.findIndex((item) => item.id === decisionId);
    const decision = state.value.decisions[index];
    if (decision === undefined) throw new ProjectOperationsError("not_found", decisionId);
    if (decision.status !== "pending") return structuredClone(decision);
    const resolved: DecisionRecord = {
      ...decision,
      status: action === "accept" ? "accepted" : action === "reject" ? "rejected" : "deferred",
      action,
      rationale: redactCredentialLike(rationale),
      resolvedAt: this.now(),
    };
    const decisions = [...state.value.decisions];
    decisions[index] = resolved;
    this.write(state, {
      ...state.value,
      decisions,
      status: resolved.status === "deferred" ? "paused" : "queued",
      updatedAt: this.now(),
    });
    return structuredClone(resolved);
  }

  cancel(id: string): SafeRunStatus {
    this.deps.retryCoordinator?.cancel(id);
    const state = this.read(id);
    if (["complete", "failed", "cancelled"].includes(state.value.status))
      return safeStatus(state.value);
    const record: DurableRunRecord = {
      ...state.value,
      cancelRequested: true,
      status: state.value.providerTurnInFlight ? state.value.status : "cancelled",
      updatedAt: this.now(),
    };
    return safeStatus(this.write(state, record).value);
  }

  async resume(id: string, input: ResumeRunInput = {}): Promise<SafeRunStatus> {
    if (
      typeof input !== "object" ||
      input === null ||
      (input.runUntil !== undefined &&
        !(["pipeline", "decision", "publication"] as const).includes(input.runUntil))
    )
      throw new ProjectOperationsError("invalid_config", "resume");
    this.deps.retryCoordinator?.cancel(id);
    let state = this.read(id);
    const budgetRecord = this.read(state.value.rootRunId).value;
    if (budgetRecord.sessionLimitSnapshot !== undefined)
      this.deps.sessionLimits?.restore(budgetRecord.sessionLimitSnapshot);
    if (["complete", "failed", "cancelled"].includes(state.value.status))
      return safeStatus(state.value);
    if (state.value.providerTurnInFlight) return safeStatus(state.value);
    if (state.value.cancelRequested && !state.value.providerTurnInFlight) {
      state = this.write(state, { ...state.value, status: "cancelled", updatedAt: this.now() });
      return safeStatus(state.value);
    }
    if (
      input.runUntil === undefined &&
      state.value.result?.outcome === "decomposition_required" &&
      state.value.remainingChildren.length > 0
    ) {
      state = this.write(state, { ...state.value, status: "running", updatedAt: this.now() });
      return this.runChildren(state);
    }
    if (
      input.runUntil === undefined &&
      state.value.breakpoint === "publication" &&
      state.value.result?.outcome === "approved"
    ) {
      const { breakpoint: _breakpoint, ...continued } = state.value;
      return safeStatus(
        this.write(state, { ...continued, status: "complete", updatedAt: this.now() }).value,
      );
    }
    if (input.runUntil !== undefined) {
      state = this.write(
        state,
        this.withEvent(
          {
            ...state.value,
            breakpoint: input.runUntil,
            updatedAt: this.now(),
          },
          "run.paused.external_limit",
        ),
      );
      if (input.runUntil === "pipeline" || input.runUntil === "decision")
        return safeStatus(
          this.write(state, { ...state.value, status: "paused", updatedAt: this.now() }).value,
        );
    }
    const projectUsage = this.records()
      .map((entry) => entry.value)
      .filter((record) => record.depth === 0 && record.sessionLimitSnapshot !== undefined)
      .reduce(
        (total, record) => ({
          turns: total.turns + (record.sessionLimitSnapshot?.admittedTurns ?? 0),
          costUsd: total.costUsd + (record.sessionLimitSnapshot?.observedCostUsd ?? 0),
        }),
        { turns: 0, costUsd: 0 },
      );
    if (
      (this.config.maxProjectTurns > 0 && projectUsage.turns >= this.config.maxProjectTurns) ||
      (this.config.maxProjectCostUsd > 0 && projectUsage.costUsd >= this.config.maxProjectCostUsd)
    ) {
      state = this.write(
        state,
        this.withEvent(
          {
            ...state.value,
            status: "paused",
            externalLimit: { source: "project", state: "exhausted", resumable: true },
            updatedAt: this.now(),
          },
          "run.paused.external_limit",
        ),
      );
      return safeStatus(state.value);
    }
    try {
      this.deps.sessionLimits?.assertActive();
    } catch {
      state = this.write(
        state,
        this.withEvent(
          {
            ...state.value,
            status: "paused",
            externalLimit: { source: "session", state: "exhausted", resumable: true },
            updatedAt: this.now(),
          },
          "run.paused.external_limit",
        ),
      );
      return safeStatus(state.value);
    }
    const availability = await this.deps.providerAvailability?.();
    if (availability !== undefined && availability.state !== "available") {
      state = this.write(state, {
        ...state.value,
        status: "paused",
        externalLimit: {
          source: "provider",
          state: availability.state,
          resumable: true,
        },
        updatedAt: this.now(),
      });
      return safeStatus(state.value);
    }
    const { externalLimit: _externalLimit, ...availableRecord } = state.value;
    const executionLease = crypto.randomUUID();
    try {
      state = this.write(state, {
        ...availableRecord,
        status: "running",
        providerTurnInFlight: true,
        executionLease,
        updatedAt: this.now(),
      });
    } catch (error) {
      if (error instanceof ProjectOperationsError && error.code === "checkpoint_conflict") {
        const current = this.read(id).value;
        if (current.providerTurnInFlight) return safeStatus(current);
      }
      throw error;
    }
    try {
      const execution = await this.deps.execute(state.value);
      this.persistSessionLimits(state.value.rootRunId);
      state = this.read(id);
      if (state.value.executionLease !== executionLease)
        throw new ProjectOperationsError("checkpoint_conflict", id);
      const record: DurableRunRecord = {
        ...state.value,
        result: redactForPersistence(execution.result),
        verdicts: redactForPersistence(execution.result.verdicts),
        providerTurnInFlight: false,
        updatedAt: this.now(),
        ...(execution.reviewedPaths !== undefined && {
          reviewedPaths: [...execution.reviewedPaths].sort(),
        }),
        ...(execution.operations !== undefined && {
          operations: structuredClone(execution.operations),
        }),
      };
      delete record.executionLease;
      if (record.cancelRequested) record.status = "cancelled";
      else if (execution.result.outcome === "approved") {
        record.status = record.breakpoint === "publication" ? "paused" : "complete";
        if (record.reviewedPaths !== undefined)
          record.contentBinding = this.createContentBinding(record.reviewedPaths);
      } else if (!this.config.autoDecomposition) record.status = "paused";
      else {
        const depthAllowed =
          this.config.maxDecompositionDepth === 0 ||
          record.depth < this.config.maxDecompositionDepth;
        if (!depthAllowed) record.status = "paused";
        else {
          const hostChildren = execution.children;
          const children =
            hostChildren !== undefined && hostChildren.length > 0
              ? hostChildren
              : deriveChildSpecs(record, execution.result).map((child) => ({
                  ...child,
                  task: redactCredentialLike(child.task),
                }));
          if (children.length === 0) {
            const lastBlocking = [...record.verdicts]
              .reverse()
              .find((verdict) => verdict.status === "changes_requested");
            const rationale =
              execution.result.escalation?.required !== true
                ? "decomposition.required but the settled result carried no escalation signal"
                : lastBlocking === undefined
                  ? "decomposition.required but the escalation's blocking verdict is missing"
                  : "decomposition.required but the last blocking verdict carries no blocker or major issue";
            const createdAt = this.now();
            record.decisions = [
              ...record.decisions,
              {
                id: crypto
                  .createHash("sha256")
                  .update(`${record.id}:decomposition:${record.decisions.length}`)
                  .digest("hex")
                  .slice(0, 32),
                status: "deferred",
                action: "defer",
                rationale,
                evidence: evidenceReferences(["docs/contracts/operation-modes.md"]),
                scope: structuredClone(record.scope),
                mandateSource: record.mode === "auto" ? "auto_mode" : "operator",
                affectedRunIds: [record.id],
                createdAt,
                resolvedAt: this.now(),
              },
            ];
            record.status = "paused";
            state = this.write(state, this.withEvent(record, "decomposition.required"));
            return safeStatus(state.value);
          }
          const existingChildren = this.records().filter(
            (item) => item.value.rootRunId === record.rootRunId && item.value.depth > 0,
          ).length;
          if (
            this.config.maxChildPipelines > 0 &&
            existingChildren + children.length > this.config.maxChildPipelines
          )
            throw new ProjectOperationsError("resource_limit", "maxChildPipelines");
          for (const child of children) {
            if (
              typeof child !== "object" ||
              child === null ||
              typeof child.task !== "string" ||
              child.task.trim() === "" ||
              !isSubset(normalizedScope(child), record.scope)
            )
              throw new ProjectOperationsError("invalid_follow_up", "child.scope");
          }
          const decision = await this.resolveDecompositionDecision(record, children);
          record.decisions = [...record.decisions, decision];
          if (decision.status !== "accepted") {
            record.status = decision.status === "pending" ? "awaiting_decision" : "paused";
            state = this.write(
              state,
              this.withEvent(
                record,
                decision.status === "pending" ? "decision.required" : "decomposition.required",
              ),
            );
            return safeStatus(state.value);
          }
          record.remainingChildren = children.map((child) => ({
            ...child,
            parentDecisionId: decision.id,
            ...normalizedScope(child),
          }));
          record.status = record.parentRunId === undefined ? "running" : "paused";
        }
      }
      state = this.write(
        state,
        record.status === "complete" ? this.withEvent(record, "run.completed") : record,
      );
      if (state.value.status === "running" && state.value.remainingChildren.length > 0)
        return this.runChildren(state);
      return safeStatus(state.value);
    } catch (error) {
      this.persistSessionLimits(state.value.rootRunId);
      state = this.read(id);
      if (error instanceof ProviderLimitError) {
        const externalLimit: ExternalLimit = {
          source: "provider",
          state: "exhausted",
          resumable: true,
          ...(error.retryAfterMs !== undefined && { retryAfterMs: error.retryAfterMs }),
        };
        const configured = this.config.retryIntervalMs;
        const attempts = state.value.automaticRetryAttempts ?? 0;
        const shouldSchedule =
          configured > 0 &&
          (this.config.maxAutomaticRetryAttempts === 0 ||
            attempts < this.config.maxAutomaticRetryAttempts) &&
          this.deps.retryCoordinator !== undefined;
        const pausedRecord: DurableRunRecord = {
          ...state.value,
          status: "paused",
          externalLimit,
          providerTurnInFlight: false,
          updatedAt: this.now(),
          ...(shouldSchedule && { automaticRetryAttempts: attempts + 1 }),
        };
        delete pausedRecord.executionLease;
        delete pausedRecord.failureCode;
        const paused = this.write(state, this.withEvent(pausedRecord, "run.paused.external_limit"));
        if (shouldSchedule) {
          const retryCoordinator = this.deps.retryCoordinator;
          if (retryCoordinator === undefined)
            throw new ProjectOperationsError("invalid_config", "retryCoordinator");
          const baseDelay = error.retryAfterMs ?? configured;
          const requested = Math.min(MAX_RETRY_DELAY_MS, baseDelay * 2 ** attempts);
          const delay = Math.min(MAX_RETRY_DELAY_MS, Math.max(1_000, requested));
          retryCoordinator.schedule(id, delay, async () => {
            await this.resume(id).catch((resumeError) => {
              const code =
                resumeError !== null && typeof resumeError === "object" && "code" in resumeError
                  ? String((resumeError as { code: unknown }).code)
                  : "unexpected";
              process.stderr.write(`ad-coder: scheduled retry failed (${code})\n`);
            });
          });
        }
        return safeStatus(paused.value);
      }
      const code =
        error !== null && typeof error === "object" && "code" in error
          ? String((error as { code: unknown }).code)
          : "unexpected";
      this.write(
        state,
        this.withEvent(
          {
            ...state.value,
            status: "failed",
            failureCode: code,
            providerTurnInFlight: false,
            updatedAt: this.now(),
          },
          "run.failed",
        ),
      );
      throw error;
    }
  }

  report(id: string): RunReport {
    const record = this.read(id).value;
    const children = record.childRunIds.map((childId) => safeStatus(this.read(childId).value));
    const snapshot = record.sessionLimitSnapshot;
    return {
      run: safeStatus(record),
      children,
      verdicts: structuredClone(record.verdicts),
      decisions: this.listDecisions(id),
      ...(record.contentBinding !== undefined && {
        contentBinding: structuredClone(record.contentBinding),
      }),
      ...(record.publication !== undefined && { publication: structuredClone(record.publication) }),
      ...(record.sessionLimitSnapshot !== undefined && {
        sessionLimit: structuredClone(record.sessionLimitSnapshot),
      }),
      decomposition: { remaining: record.remainingChildren.length, depth: record.depth },
      filesChanged: [...(record.operations?.filesChanged ?? record.reviewedPaths ?? [])],
      checks: structuredClone(record.operations?.checks ?? []),
      usage: {
        turns: snapshot?.admittedTurns ?? 0,
        costUsd: snapshot?.observedCostUsd ?? 0,
      },
      stageMetrics: this.stageMetrics(record),
      checkpointPath: record.operations?.checkpointPath ?? this.recordPath(id),
      backlog: structuredClone(record.operations?.backlog ?? { destination: "skipped", count: 0 }),
    };
  }

  async publish(id: string): Promise<PublicationSummary> {
    const state = this.read(id);
    if (!state.value.scope.externalEffects.includes("publish"))
      throw new ProjectOperationsError("unauthorized_path", "publish");
    if (state.value.result?.outcome !== "approved" || state.value.contentBinding === undefined)
      throw new ProjectOperationsError("approval_required", id);
    if (this.deps.publishApproved === undefined)
      throw new ProjectOperationsError("invalid_config", "publishApproved");
    const current = this.createContentBinding(
      state.value.contentBinding.entries.map((e) => e.path),
    );
    if (JSON.stringify(current) !== JSON.stringify(state.value.contentBinding))
      throw new ProjectOperationsError("stale_binding", id);
    const projected = await this.deps.publishApproved(state.value, current);
    const summary: PublicationSummary = { ...projected, binding: current };
    const latest = this.read(id);
    const { breakpoint: _breakpoint, ...withoutBreakpoint } = latest.value;
    this.write(
      latest,
      this.withEvent(
        { ...withoutBreakpoint, publication: summary, updatedAt: this.now() },
        "publication.completed",
      ),
    );
    return structuredClone(summary);
  }

  private createContentBinding(paths: string[]): ContentBinding {
    const entries = [...new Set(paths)].sort().map((relative): ContentBindingEntry => {
      if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes(".."))
        throw new ProjectOperationsError("unsafe_destination", "contentBinding.path");
      const absolute = path.join(this.deps.store.layout.targetDir, relative);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(absolute);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return {
            path: relative,
            kind: "deleted",
            mode: 0,
            sha256: crypto.createHash("sha256").update("").digest("hex"),
          };
        throw error;
      }
      const kind = stat.isSymbolicLink() ? "symlink" : "file";
      const bytes =
        kind === "symlink" ? Buffer.from(fs.readlinkSync(absolute)) : fs.readFileSync(absolute);
      return {
        path: relative,
        kind,
        mode: stat.mode & 0o777777,
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      };
    });
    const manifestHash = crypto.createHash("sha256").update(JSON.stringify(entries)).digest("hex");
    const git = (argument: string) =>
      execFileSync("git", ["rev-parse", argument], {
        cwd: this.deps.store.layout.targetDir,
        encoding: "utf8",
      }).trim();
    const temporaryIndex = path.join(
      this.deps.store.layout.tmp,
      `binding-index-${crypto.randomUUID()}`,
    );
    let publishTreeOid: string;
    try {
      execFileSync("git", ["read-tree", "HEAD"], {
        cwd: this.deps.store.layout.targetDir,
        env: { ...process.env, GIT_INDEX_FILE: temporaryIndex },
      });
      if (entries.length > 0)
        execFileSync("git", ["add", "--", ...entries.map((entry) => entry.path)], {
          cwd: this.deps.store.layout.targetDir,
          env: { ...process.env, GIT_INDEX_FILE: temporaryIndex },
        });
      publishTreeOid = execFileSync("git", ["write-tree"], {
        cwd: this.deps.store.layout.targetDir,
        env: { ...process.env, GIT_INDEX_FILE: temporaryIndex },
        encoding: "utf8",
      }).trim();
    } finally {
      fs.rmSync(temporaryIndex, { force: true });
    }
    return {
      algorithm: "sha256",
      manifestHash,
      entries,
      headOid: git("HEAD"),
      treeOid: git("HEAD^{tree}"),
      publishTreeOid,
    };
  }

  private persistSessionLimits(rootRunId: string): void {
    if (this.deps.sessionLimits === undefined) return;
    const root = this.read(rootRunId);
    this.write(root, {
      ...root.value,
      sessionLimitSnapshot: this.deps.sessionLimits.snapshot(),
      updatedAt: this.now(),
    });
  }

  private async resolveDecompositionDecision(
    record: DurableRunRecord,
    children: ChildPipelineSpec[],
  ): Promise<DecisionRecord> {
    const createdAt = this.now();
    const base: DecisionRecord = {
      id: crypto
        .createHash("sha256")
        .update(`${record.id}:decomposition:${record.decisions.length}`)
        .digest("hex")
        .slice(0, 32),
      status: "pending",
      evidence: evidenceReferences([
        "docs/contracts/operation-modes.md",
        ...children.flatMap((child) => (child.parentDecisionId ? [child.parentDecisionId] : [])),
      ]),
      scope: structuredClone(record.scope),
      mandateSource: record.mode === "auto" ? "auto_mode" : "operator",
      affectedRunIds: [record.id],
      createdAt,
    };
    if (record.mode === "manual") return base;
    if (this.deps.resolveAutoDecision === undefined)
      throw new ProjectOperationsError("invalid_config", "resolveAutoDecision");
    const resolution = await this.deps.resolveAutoDecision(base, record);
    if (
      !(
        resolution.action === "accept" ||
        resolution.action === "reject" ||
        resolution.action === "defer"
      ) ||
      typeof resolution.rationale !== "string" ||
      resolution.rationale.trim() === "" ||
      !Array.isArray(resolution.evidence)
    )
      throw new ProjectOperationsError("invalid_follow_up", "decision.action");
    return {
      ...base,
      status:
        resolution.action === "accept"
          ? "accepted"
          : resolution.action === "reject"
            ? "rejected"
            : "deferred",
      action: resolution.action,
      rationale: redactCredentialLike(resolution.rationale),
      evidence: evidenceReferences([...base.evidence, ...resolution.evidence]),
      resolvedAt: this.now(),
    };
  }

  private async runChildren(rootState: VersionedState<DurableRunRecord>): Promise<SafeRunStatus> {
    let root = rootState;
    while (root.value.remainingChildren.length > 0) {
      root = this.read(root.value.id);
      if (root.value.cancelRequested) {
        root = this.write(root, { ...root.value, status: "cancelled", updatedAt: this.now() });
        return safeStatus(root.value);
      }
      const [spec, ...remaining] = root.value.remainingChildren;
      if (spec === undefined) break;
      if (spec.parentDecisionId === undefined)
        throw new ProjectOperationsError("pending_decision", "decomposition.parentDecisionId");
      const authorization = root.value.decisions.find(
        (decision) => decision.id === spec.parentDecisionId,
      );
      if (authorization?.status !== "accepted")
        throw new ProjectOperationsError("pending_decision", spec.parentDecisionId);
      const childId = this.deps.id?.() ?? crypto.randomUUID();
      const timestamp = this.now();
      const child: DurableRunRecord = {
        schemaVersion: 1,
        id: childId,
        requestKey: `${root.value.requestKey}-${childId}`.slice(0, 64),
        task: redactCredentialLike(spec.task),
        mode: root.value.mode,
        status: "queued",
        depth: root.value.depth + 1,
        rootRunId: root.value.rootRunId,
        parentRunId: root.value.id,
        childRunIds: [],
        remainingChildren: [],
        scope: normalizedScope(spec),
        decisions: [],
        verdicts: [],
        createdAt: timestamp,
        updatedAt: timestamp,
        cancelRequested: false,
        providerTurnInFlight: false,
        authorizationDecisionId: spec.parentDecisionId,
        eventSequence: 0,
        events: [],
      };
      this.deps.store.writeVersionedJson(this.recordPath(childId), child, 0);
      root = this.write(root, {
        ...root.value,
        childRunIds: [...root.value.childRunIds, childId],
        remainingChildren: remaining,
        updatedAt: timestamp,
      });
      const childStatus = await this.resume(childId);
      if (childStatus.outcome === "decomposition_required" || childStatus.status !== "complete") {
        root = this.write(root, {
          ...root.value,
          status: "paused",
          updatedAt: this.now(),
        });
        return safeStatus(root.value);
      }
    }
    root = this.write(
      root,
      this.withEvent({ ...root.value, status: "complete", updatedAt: this.now() }, "run.completed"),
    );
    return safeStatus(root.value);
  }
}

export function createOrchestratorControlPlane(
  dependencies: ControlPlaneDependencies,
): OrchestratorControlPlane {
  return new OrchestratorControlPlane(dependencies);
}

export const CONTROL_PLANE_TOOL_NAMES = [
  "control_start",
  "control_status",
  "control_list",
  "control_resume",
  "control_cancel",
  "control_decisions",
  "control_decision_request",
  "control_run_until",
  "control_report",
  "control_events",
  "control_publish",
  "control_triage",
] as const;

function safeToolError(error: unknown): string {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string"
  )
    return JSON.stringify({ error: { code: (error as { code: string }).code } });
  return JSON.stringify({ error: { code: "unexpected" } });
}

/** Model-facing capabilities expose allowlisted projections and no manual resolution authority. */
export function buildControlPlaneTools(control: OrchestratorControlPlane): Tool[] {
  const execute = (operation: () => unknown | Promise<unknown>) => async () => {
    try {
      return {
        content: [{ type: "text" as const, text: JSON.stringify(await operation()) }],
        details: {},
      };
    } catch (error) {
      return { content: [{ type: "text" as const, text: safeToolError(error) }], details: {} };
    }
  };
  return [
    defineTool({
      name: "control_events",
      label: "run events",
      description: "Read durable run events after a sequence cursor.",
      parameters: Type.Object({ id: Type.String(), after: Type.Optional(Type.Number()) }),
      execute: (_id, p) => execute(() => control.events(p.id, p.after ?? 0))(),
    }),
    defineTool({
      name: "control_start",
      label: "start run",
      description: "Queue an auto-mandated durable pipeline run.",
      parameters: Type.Object({ requestKey: Type.String(), task: Type.String() }),
      execute: (_id, p) =>
        execute(() => control.start({ requestKey: p.requestKey, task: p.task, mode: "auto" }))(),
    }),
    defineTool({
      name: "control_status",
      label: "run status",
      description: "Read safe durable run status.",
      parameters: Type.Object({ id: Type.String() }),
      execute: (_id, p) => execute(() => control.status(p.id))(),
    }),
    defineTool({
      name: "control_list",
      label: "list runs",
      description: "List safe durable run statuses.",
      parameters: Type.Object({}),
      execute: () => execute(() => control.list())(),
    }),
    defineTool({
      name: "control_resume",
      label: "resume run",
      description: "Resume a durable run.",
      parameters: Type.Object({ id: Type.String() }),
      execute: (_id, p) => execute(() => control.resume(p.id))(),
    }),
    defineTool({
      name: "control_cancel",
      label: "cancel run",
      description: "Request cooperative cancellation.",
      parameters: Type.Object({ id: Type.String() }),
      execute: (_id, p) => execute(() => control.cancel(p.id))(),
    }),
    defineTool({
      name: "control_decisions",
      label: "list decisions",
      description: "List safe decision metadata; manual resolution is deliberately unavailable.",
      parameters: Type.Object({ id: Type.String() }),
      execute: (_id, p) => execute(() => control.listDecisions(p.id))(),
    }),
    defineTool({
      name: "control_decision_request",
      label: "request decision",
      description: "Record an in-scope decision point; auto resolves under mandate, manual waits.",
      parameters: Type.Object({
        id: Type.String(),
        action: Type.String(),
        evidence: Type.Array(Type.String()),
        allowedPaths: Type.Array(Type.String()),
        allowedCapabilities: Type.Array(Type.String()),
        externalEffects: Type.Array(Type.String()),
      }),
      execute: (_id, p) =>
        execute(async () => {
          await control.requestDecision(p.id, {
            action: p.action,
            evidence: p.evidence,
            scope: {
              allowedPaths: p.allowedPaths,
              allowedCapabilities: p.allowedCapabilities,
              externalEffects: p.externalEffects,
            },
          });
          return control.listDecisions(p.id).at(-1);
        })(),
    }),
    defineTool({
      name: "control_run_until",
      label: "run until",
      description: "Resume until a durable breakpoint.",
      parameters: Type.Object({
        id: Type.String(),
        breakpoint: Type.Union([
          Type.Literal("pipeline"),
          Type.Literal("decision"),
          Type.Literal("publication"),
        ]),
      }),
      execute: (_id, p) => execute(() => control.resume(p.id, { runUntil: p.breakpoint }))(),
    }),
    defineTool({
      name: "control_report",
      label: "run report",
      description: "Return a transcript-safe report projection.",
      parameters: Type.Object({ id: Type.String() }),
      execute: (_id, p) =>
        execute(() => {
          const report = control.report(p.id);
          return {
            run: report.run,
            children: report.children,
            decisionCount: report.decisions.length,
            verdictStatuses: report.verdicts.map((v) => v.status),
            ...(report.run.escalation !== undefined && {
              escalation: report.run.escalation,
            }),
            contentHash: report.contentBinding?.manifestHash,
            publicationPhase: report.publication?.phase,
            decomposition: report.decomposition,
            filesChangedCount: report.filesChanged.length,
            checkStatuses: report.checks.map((check) => check.status),
            usage: report.usage,
            stageMetrics: report.stageMetrics.map((metric) => ({
              stage: metric.stage,
              provider: metric.provider ?? "unknown",
              model: metric.model ?? "unknown",
              thinkingLevel: metric.thinkingLevel ?? "unknown",
              durationMs: metric.durationMs ?? 0,
              input: metric.input,
              cachedInput: metric.cachedInput,
              freshInput: metric.freshInput,
              output: metric.output,
              reasoning: metric.reasoning ?? 0,
              costUsd: metric.costUsd ?? 0,
              requestBytes: metric.requestBytes,
              readFilesTotal: metric.readFilesTotal,
              readFilesTruncated: metric.readFilesTruncated,
              diffBytes: metric.diffBytes,
              contextStrategy: metric.contextStrategy,
              ...(metric.pipelineContextStrategy !== undefined && {
                pipelineContextStrategy: metric.pipelineContextStrategy,
              }),
              ...(metric.pipelineContextFallbackReason !== undefined && {
                pipelineContextFallbackReason: metric.pipelineContextFallbackReason,
              }),
            })),
            retryAfterMs: report.run.externalLimit?.retryAfterMs,
            backlogCount: report.backlog.count,
          };
        })(),
    }),
    defineTool({
      name: "control_publish",
      label: "publish run",
      description: "Publish a bound approved run when its inherited scope permits publishing.",
      parameters: Type.Object({ id: Type.String() }),
      execute: (_id, p) => execute(() => control.publish(p.id))(),
    }),
    defineTool({
      name: "control_triage",
      label: "triage task",
      description: "Mechanically choose inline or pipeline routing.",
      parameters: Type.Object({
        touchesContracts: Type.Boolean(),
        securitySurface: Type.Union([Type.Literal("ordinary"), Type.Literal("elevated")]),
        changeSize: Type.Union([Type.Literal("local"), Type.Literal("large")]),
        reversible: Type.Boolean(),
      }),
      execute: (_id, p) => execute(() => ({ route: triageControlPlaneTask(p) }))(),
    }),
  ];
}
