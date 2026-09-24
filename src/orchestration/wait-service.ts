import * as crypto from "node:crypto";
import * as fs from "node:fs";
import type { ProjectStore } from "../project-store/project-store";
import { ProjectStoreError, type VersionedState } from "../project-store/types";
import type { WaitSourceAdapterRegistry } from "./wait-adapters";

/** The durable schema version, independent of ProjectStore's CAS envelope. */
export const WAIT_RECORD_VERSION = 1;
export const WAIT_EVENT_VERSION = 1;
export const DEFAULT_WAIT_SERVICE_LIMITS = Object.freeze({
  maxEventsPerWait: 32,
  maxEvidenceEntries: 8,
  /** A wait record is durable control-plane state, never an unbounded log. */
  maxPersistedStateBytes: 64 * 1024,
  minPollIntervalMs: 100,
});

export type WaitLifecycle =
  | "pending"
  | "satisfied"
  | "failed"
  | "unavailable"
  | "timed_out"
  | "stalled"
  | "cancelled";
export type WaitTerminalLifecycle = Exclude<WaitLifecycle, "pending">;
export type WaitDelivery = "events" | "poll";
export type WaitRecoveryAction = "inspect" | "retry" | "replace";
export type WaitEvidenceCode =
  | "condition_met"
  | "condition_failed"
  | "source_unavailable"
  | "deadline_exceeded"
  | "source_stalled"
  | "cancelled"
  | "reconcile_uncertain";

/** No text supplied by an adapter crosses this boundary. */
export interface WaitEvidence {
  code: WaitEvidenceCode;
  at: number;
}
export interface WaitTarget {
  /** A source-local type name, not a URL, command, PID, or provider payload. */
  kind: string;
  /** A safe opaque identity minted by the owning adapter. */
  id: string;
}
export interface WaitCondition {
  kind: string;
  /** Optional numeric threshold used by observation-only adapters (for example timers). */
  at?: number;
}
export interface WaitSource {
  adapter: string;
  version: number;
  target: WaitTarget;
}
export interface WaitOwner {
  kind: "run" | "session" | "operator";
  id: string;
}
export interface WaitPolicy {
  delivery: WaitDelivery;
  /** Required for polling; the core never creates a timer from this value. */
  pollIntervalMs?: number;
}
export interface CreateWaitInput {
  id?: string;
  source: WaitSource;
  condition: WaitCondition;
  owner: WaitOwner;
  policy: WaitPolicy;
  /** Absolute milliseconds since epoch. Omit for no core deadline. */
  deadlineAt?: number;
  recovery: WaitRecoveryAction;
}
export interface WaitObservation {
  lifecycle: Exclude<WaitTerminalLifecycle, "cancelled"> | "pending";
  evidence?: Exclude<WaitEvidenceCode, "cancelled" | "reconcile_uncertain">;
}
export interface WaitSourceAdapter {
  readonly id: string;
  readonly version: number;
  validate(target: WaitTarget, condition: WaitCondition): void;
  /**
   * Must be idempotent for operationId. The core checkpoints this id before
   * calling it and never repeats a dispatched operation after a crash.
   */
  reconcile(input: {
    waitId: string;
    operationId: string;
    source: WaitSource;
    condition: WaitCondition;
  }): WaitObservation | Promise<WaitObservation>;
}
export interface WaitEvent {
  version: typeof WAIT_EVENT_VERSION;
  sequence: number;
  waitId: string;
  lifecycle: WaitLifecycle;
  timestamp: number;
  evidence?: WaitEvidence;
}
export interface WaitEventPage {
  events: WaitEvent[];
  nextCursor: number;
  gap: boolean;
}
export interface WaitRecord {
  version: typeof WAIT_RECORD_VERSION;
  id: string;
  lifecycle: WaitLifecycle;
  source: WaitSource;
  condition: WaitCondition;
  owner: WaitOwner;
  policy: WaitPolicy;
  deadlineAt?: number;
  recovery: WaitRecoveryAction;
  createdAt: number;
  updatedAt: number;
  nextSequence: number;
  events: WaitEvent[];
  evidence: WaitEvidence[];
  /** A dispatched call with no result is deliberately never replayed. */
  reconciliation?: { operationId: string; dispatchedAt: number };
}
export interface WaitServiceLimits {
  maxEventsPerWait: number;
  maxEvidenceEntries: number;
  /** Positive UTF-8 ceiling for one persisted wait record, including its envelope. */
  maxPersistedStateBytes: number;
  minPollIntervalMs: number;
}
export type WaitServiceErrorCode =
  | "invalid_request"
  | "invalid_adapter"
  | "not_found"
  | "already_exists"
  | "not_pending"
  | "state_too_large"
  | "reconcile_uncertain";
export class WaitServiceError extends Error {
  override readonly name = "WaitServiceError";
  constructor(
    readonly code: WaitServiceErrorCode,
    readonly waitId?: string,
  ) {
    super(code);
  }
}

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
/** Must stay compatible with ProjectStore's managed directory identifier. */
const WAIT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_KIND = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const TERMINAL = new Set<WaitLifecycle>([
  "satisfied",
  "failed",
  "unavailable",
  "timed_out",
  "stalled",
  "cancelled",
]);

/**
 * Durable, foreground-free wait state machine. It deliberately owns neither
 * timers nor subprocesses: hosts call reconcile at their bounded cadence or
 * from an adapter event.
 */
export class WaitService {
  private readonly adapterRegistry: { get(id: string, version: number): WaitSourceAdapter };
  private readonly limits: WaitServiceLimits;

  constructor(
    private readonly store: ProjectStore,
    adapters: readonly WaitSourceAdapter[] | WaitSourceAdapterRegistry,
    limits: Partial<WaitServiceLimits> = {},
    private readonly now: () => number = Date.now,
  ) {
    this.limits = { ...DEFAULT_WAIT_SERVICE_LIMITS, ...limits };
    if (Object.values(this.limits).some((value) => !Number.isSafeInteger(value) || value <= 0))
      throw new WaitServiceError("invalid_request");
    if (Array.isArray(adapters)) {
      const registry = new Map<string, WaitSourceAdapter>();
      for (const adapter of adapters) {
        if (
          !SAFE_ID.test(adapter.id) ||
          !Number.isSafeInteger(adapter.version) ||
          adapter.version <= 0 ||
          typeof adapter.validate !== "function" ||
          typeof adapter.reconcile !== "function" ||
          registry.has(adapter.id)
        )
          throw new WaitServiceError("invalid_adapter");
        registry.set(adapter.id, adapter);
      }
      this.adapterRegistry = {
        get(id, version) {
          const adapter = registry.get(id);
          if (adapter === undefined || adapter.version !== version)
            throw new WaitServiceError("invalid_adapter");
          return adapter;
        },
      };
    } else {
      this.adapterRegistry = adapters as WaitSourceAdapterRegistry;
    }
  }

  create(input: CreateWaitInput): WaitRecord {
    this.validateInput(input);
    const adapter = this.adapterFor(input.source);
    try {
      adapter.validate(input.source.target, input.condition);
    } catch {
      throw new WaitServiceError("invalid_adapter");
    }
    const id = input.id ?? crypto.randomUUID();
    if (!WAIT_ID.test(id)) throw new WaitServiceError("invalid_request", id);
    const timestamp = this.now();
    const initial: WaitRecord = {
      version: WAIT_RECORD_VERSION,
      id,
      lifecycle: "pending",
      source: copySource(input.source),
      condition: copyCondition(input.condition),
      owner: { kind: input.owner.kind, id: input.owner.id },
      policy: copyPolicy(input.policy),
      ...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }),
      recovery: input.recovery,
      createdAt: timestamp,
      updatedAt: timestamp,
      nextSequence: 1,
      events: [],
      evidence: [],
    };
    this.append(initial, "pending", timestamp);
    this.assertRecordSize(initial, id, 1);
    try {
      this.store.writeVersionedJson(this.store.waitStatePath(id), initial, 0);
    } catch (error) {
      if (error instanceof ProjectStoreError && error.code === "version_conflict")
        throw new WaitServiceError("already_exists", id);
      throw error;
    }
    return copyRecord(initial);
  }

  get(id: string): WaitRecord {
    return copyRecord(this.read(id));
  }

  /**
   * Bounded keyset enumeration of durable wait ids. Pages return ids strictly
   * after the `after` boundary and resume from the last id, not from a numeric
   * offset, so a wait removed mid-enumeration or a restart that resumes at a
   * non-empty cursor cannot silently skip progress. `gap` is a durable-signal
   * type (it narrows away when no gap), and is set exactly when the supplied
   * boundary wait no longer exists in the id set: consumers recover by
   * re-enumerating from the start, because entries may have been created or
   * removed under the boundary since the previous page.
   */
  listIds(
    after = "",
    limit = this.limits.maxEventsPerWait,
  ): { ids: string[]; nextCursor: string; gap: boolean } {
    if (
      typeof after !== "string" ||
      (after !== "" && !WAIT_ID.test(after)) ||
      !Number.isSafeInteger(limit) ||
      limit <= 0
    )
      throw new WaitServiceError("invalid_request");
    const ids = fs
      .readdirSync(this.store.layout.waits, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^[A-Za-z0-9_-]{1,64}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    let start = 0;
    let gap = false;
    if (after !== "") {
      start = ids.findIndex((id) => id > after);
      if (start === -1) start = ids.length;
      // The boundary itself is gone: the caller's resume point is no longer
      // anchored in durable state, so report the gap instead of pretending
      // the page is a complete continuation.
      if (!ids.includes(after)) gap = true;
    }
    const page = ids.slice(start, start + limit);
    return {
      ids: page,
      // A full page continues from its last id; anything less means the set
      // is exhausted and the next sweep starts over.
      nextCursor: page.length === limit ? (page[page.length - 1] ?? "") : "",
      gap,
    };
  }

  events(id: string, cursor = 0, limit = this.limits.maxEventsPerWait): WaitEventPage {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit <= 0)
      throw new WaitServiceError("invalid_request", id);
    const record = this.read(id);
    const first = record.events[0]?.sequence ?? record.nextSequence;
    const gap = cursor > 0 && cursor < first - 1;
    const events = record.events.filter((event) => event.sequence > cursor).slice(0, limit);
    return {
      events: events.map(copyEvent),
      nextCursor: events.at(-1)?.sequence ?? cursor,
      gap,
    };
  }

  cancel(id: string): WaitRecord {
    return this.transition(id, "cancelled", "cancelled");
  }

  /** Reopen validates an existing checkpoint; it has no external side effect. */
  reopen(id: string): WaitRecord {
    const record = this.read(id);
    return copyRecord(record);
  }

  /**
   * Checkpoints operation dispatch before calling an adapter. If a process dies
   * at that boundary, reopening refuses replay rather than risking a duplicate
   * subscription/command. A later recovery policy can inspect or replace it.
   */
  async reconcile(id: string): Promise<WaitRecord> {
    const record = this.read(id);
    if (TERMINAL.has(record.lifecycle)) return copyRecord(record);
    const timestamp = this.now();
    if (record.deadlineAt !== undefined && timestamp >= record.deadlineAt)
      return this.transition(id, "timed_out", "deadline_exceeded", timestamp);
    if (record.reconciliation !== undefined) throw new WaitServiceError("reconcile_uncertain", id);
    if (
      record.policy.delivery === "poll" &&
      record.updatedAt + (record.policy.pollIntervalMs as number) > timestamp
    )
      return copyRecord(record);
    const operationId = crypto.randomUUID();
    const dispatched = this.mutate(id, (current) => {
      const value = this.currentPending(current, id);
      if (value.reconciliation !== undefined) throw new WaitServiceError("reconcile_uncertain", id);
      return {
        ...value,
        updatedAt: timestamp,
        reconciliation: { operationId, dispatchedAt: timestamp },
      };
    });
    const adapter = this.adapterFor(dispatched.source);
    let observation: WaitObservation;
    try {
      observation = await adapter.reconcile({
        waitId: id,
        operationId,
        source: copySource(dispatched.source),
        condition: copyCondition(dispatched.condition),
      });
      this.validateObservation(observation);
    } catch (error) {
      if (error instanceof WaitServiceError) throw error;
      // The checkpoint remains dispatching: recovery must never guess whether
      // the adapter performed its external effect.
      throw new WaitServiceError("reconcile_uncertain", id);
    }
    return this.mutate(id, (current) => {
      const value = this.current(current, id);
      if (value.reconciliation?.operationId !== operationId)
        throw new WaitServiceError("reconcile_uncertain", id);
      // A concurrent cancellation or deadline transition wins the lifecycle,
      // but must retain the dispatch witness.  The late adapter result cannot
      // establish whether its effect happened before that transition, so never
      // collapse it into the generic not_pending result.
      if (value.lifecycle !== "pending") throw new WaitServiceError("reconcile_uncertain", id);
      const { reconciliation: _reconciliation, ...withoutReconciliation } = value;
      const next = { ...withoutReconciliation, updatedAt: this.now() };
      if (observation.lifecycle === "pending") return next;
      this.append(next, observation.lifecycle, next.updatedAt, observation.evidence);
      return next;
    });
  }

  private transition(
    id: string,
    lifecycle: WaitTerminalLifecycle,
    evidence: WaitEvidenceCode,
    timestamp = this.now(),
  ): WaitRecord {
    return this.mutate(id, (current) => {
      const value = this.current(current, id);
      if (TERMINAL.has(value.lifecycle)) {
        if (value.lifecycle === lifecycle) return value;
        throw new WaitServiceError("not_pending", id);
      }
      // Keep an in-flight dispatch witness after a user cancellation or an
      // elapsed deadline.  A late adapter return must remain explicitly
      // ambiguous rather than making recovery evidence disappear.
      const next = { ...value, lifecycle, updatedAt: timestamp };
      this.append(next, lifecycle, timestamp, evidence);
      return next;
    });
  }

  private append(
    record: WaitRecord,
    lifecycle: WaitLifecycle,
    timestamp: number,
    evidenceCode?: WaitEvidenceCode,
  ): void {
    const evidence = evidenceCode === undefined ? undefined : { code: evidenceCode, at: timestamp };
    record.lifecycle = lifecycle;
    record.updatedAt = timestamp;
    record.events.push({
      version: WAIT_EVENT_VERSION,
      sequence: record.nextSequence++,
      waitId: record.id,
      lifecycle,
      timestamp,
      ...(evidence === undefined ? {} : { evidence }),
    });
    if (evidence !== undefined) record.evidence.push(evidence);
    while (record.events.length > this.limits.maxEventsPerWait) record.events.shift();
    while (record.evidence.length > this.limits.maxEvidenceEntries) record.evidence.shift();
  }

  private read(id: string): WaitRecord {
    if (!WAIT_ID.test(id)) throw new WaitServiceError("invalid_request", id);
    try {
      const state = this.store.readVersionedJson<WaitRecord>(this.store.waitStatePath(id));
      this.validateRecord(state.value, this.envelopeVersion(state.version, id));
      return state.value;
    } catch (error) {
      if (error instanceof ProjectStoreError && error.code === "not_found")
        throw new WaitServiceError("not_found", id);
      throw error;
    }
  }
  /**
   * Enforce the wait-specific ceiling on every mutation, even when the shared
   * ProjectStore has its generic state limit disabled.  The check sits before
   * ProjectStore serializes/writes, so an overgrown next record is never made
   * durable by this service.
   */
  private mutate(
    id: string,
    mutate: (current: VersionedState<WaitRecord> | undefined) => WaitRecord,
  ): WaitRecord {
    return this.store.mutateVersionedJson<WaitRecord>(this.store.waitStatePath(id), (current) => {
      const next = mutate(current);
      this.assertRecordSize(next, id, this.nextEnvelopeVersion(current, id));
      return next;
    }).value;
  }
  private assertRecordSize(record: WaitRecord, id = record.id, envelopeVersion = 1): void {
    // Include ProjectStore's versioned envelope and newline: this is exactly
    // what reaches disk, rather than an optimistic estimate of record fields.
    const bytes =
      Buffer.byteLength(JSON.stringify({ version: envelopeVersion, value: record })) + 1;
    if (bytes > this.limits.maxPersistedStateBytes)
      throw new WaitServiceError("state_too_large", id);
  }

  private current(current: VersionedState<WaitRecord> | undefined, id: string): WaitRecord {
    if (current === undefined) throw new WaitServiceError("not_found", id);
    this.validateRecord(current.value, this.envelopeVersion(current.version, id));
    return current.value;
  }
  private envelopeVersion(version: unknown, id: string): number {
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version <= 0)
      throw new WaitServiceError("invalid_request", id);
    return version;
  }
  private nextEnvelopeVersion(current: VersionedState<WaitRecord> | undefined, id: string): number {
    return (current === undefined ? 0 : this.envelopeVersion(current.version, id)) + 1;
  }
  private currentPending(current: VersionedState<WaitRecord> | undefined, id: string): WaitRecord {
    const value = this.current(current, id);
    if (value.lifecycle !== "pending") throw new WaitServiceError("not_pending", id);
    return value;
  }
  private adapterFor(source: WaitSource): WaitSourceAdapter {
    try {
      return this.adapterRegistry.get(source.adapter, source.version);
    } catch (error) {
      if (error instanceof WaitServiceError) throw error;
      throw new WaitServiceError("invalid_adapter");
    }
  }
  private validateInput(input: CreateWaitInput): void {
    if (!input || typeof input !== "object") throw new WaitServiceError("invalid_request");
    this.validateSource(input.source);
    if (
      !plainObject(input.condition, ["kind", "at"]) ||
      !SAFE_KIND.test(input.condition?.kind ?? "") ||
      (input.condition.at !== undefined &&
        (!Number.isSafeInteger(input.condition.at) || input.condition.at < 0))
    )
      throw new WaitServiceError("invalid_request");
    if (!plainObject(input.owner, ["kind", "id"])) throw new WaitServiceError("invalid_request");
    if (
      !SAFE_ID.test(input.owner?.id ?? "") ||
      !["run", "session", "operator"].includes(input.owner?.kind)
    )
      throw new WaitServiceError("invalid_request");
    if (!plainObject(input.policy, ["delivery", "pollIntervalMs"]))
      throw new WaitServiceError("invalid_request");
    if (!["events", "poll"].includes(input.policy?.delivery))
      throw new WaitServiceError("invalid_request");
    if (input.policy.delivery === "poll") {
      if (
        !Number.isSafeInteger(input.policy.pollIntervalMs) ||
        (input.policy.pollIntervalMs as number) < this.limits.minPollIntervalMs
      )
        throw new WaitServiceError("invalid_request");
    } else if (input.policy.pollIntervalMs !== undefined)
      throw new WaitServiceError("invalid_request");
    if (
      input.deadlineAt !== undefined &&
      (!Number.isSafeInteger(input.deadlineAt) || input.deadlineAt <= 0)
    )
      throw new WaitServiceError("invalid_request");
    if (!["inspect", "retry", "replace"].includes(input.recovery))
      throw new WaitServiceError("invalid_request");
  }
  private validateSource(source: WaitSource): void {
    if (
      !plainObject(source, ["adapter", "version", "target"]) ||
      !SAFE_ID.test(source.adapter) ||
      !Number.isSafeInteger(source.version) ||
      source.version <= 0 ||
      !plainObject(source.target, ["kind", "id"]) ||
      !SAFE_KIND.test(source.target?.kind ?? "") ||
      !SAFE_ID.test(source.target?.id ?? "")
    )
      throw new WaitServiceError("invalid_request");
  }
  private validateObservation(observation: WaitObservation): void {
    if (
      !observation ||
      !["pending", "satisfied", "failed", "unavailable", "timed_out", "stalled"].includes(
        observation.lifecycle,
      ) ||
      (observation.evidence !== undefined &&
        ![
          "condition_met",
          "condition_failed",
          "source_unavailable",
          "deadline_exceeded",
          "source_stalled",
        ].includes(observation.evidence))
    )
      throw new WaitServiceError("invalid_adapter");
  }
  private validateRecord(record: WaitRecord, envelopeVersion = 1): void {
    if (
      !plainObject(record, [
        "version",
        "id",
        "lifecycle",
        "source",
        "condition",
        "owner",
        "policy",
        "deadlineAt",
        "recovery",
        "createdAt",
        "updatedAt",
        "nextSequence",
        "events",
        "evidence",
        "reconciliation",
      ]) ||
      record.version !== WAIT_RECORD_VERSION ||
      !WAIT_ID.test(record.id)
    )
      throw new WaitServiceError("invalid_request");
    this.validateInput(record);
    if (
      !WAIT_LIFECYCLE.has(record.lifecycle) ||
      !safeTimestamp(record.createdAt) ||
      !safeTimestamp(record.updatedAt) ||
      !Number.isSafeInteger(record.nextSequence) ||
      record.nextSequence <= 0 ||
      !Array.isArray(record.events) ||
      record.events.length > this.limits.maxEventsPerWait ||
      !Array.isArray(record.evidence) ||
      record.evidence.length > this.limits.maxEvidenceEntries
    )
      throw new WaitServiceError("invalid_request", record.id);
    let previousSequence = 0;
    for (const event of record.events) {
      if (
        !plainObject(event, [
          "version",
          "sequence",
          "waitId",
          "lifecycle",
          "timestamp",
          "evidence",
        ]) ||
        event.version !== WAIT_EVENT_VERSION ||
        !Number.isSafeInteger(event.sequence) ||
        event.sequence <= previousSequence ||
        event.sequence >= record.nextSequence ||
        event.waitId !== record.id ||
        !WAIT_LIFECYCLE.has(event.lifecycle as WaitLifecycle) ||
        !safeTimestamp(event.timestamp) ||
        (event.evidence !== undefined && !validEvidence(event.evidence))
      )
        throw new WaitServiceError("invalid_request", record.id);
      previousSequence = event.sequence;
    }
    for (const evidence of record.evidence)
      if (!validEvidence(evidence)) throw new WaitServiceError("invalid_request", record.id);
    if (
      record.reconciliation !== undefined &&
      (!plainObject(record.reconciliation, ["operationId", "dispatchedAt"]) ||
        !SAFE_ID.test(record.reconciliation.operationId) ||
        !safeTimestamp(record.reconciliation.dispatchedAt))
    )
      throw new WaitServiceError("invalid_request", record.id);
    this.assertRecordSize(record, record.id, envelopeVersion);
  }
}

const WAIT_LIFECYCLE = new Set<WaitLifecycle>([
  "pending",
  "satisfied",
  "failed",
  "unavailable",
  "timed_out",
  "stalled",
  "cancelled",
]);
const WAIT_EVIDENCE = new Set<WaitEvidenceCode>([
  "condition_met",
  "condition_failed",
  "source_unavailable",
  "deadline_exceeded",
  "source_stalled",
  "cancelled",
  "reconcile_uncertain",
]);

function safeTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function validEvidence(value: unknown): value is WaitEvidence {
  return (
    plainObject(value, ["code", "at"]) &&
    typeof value.code === "string" &&
    WAIT_EVIDENCE.has(value.code as WaitEvidenceCode) &&
    safeTimestamp(value.at)
  );
}

function copyCondition(condition: WaitCondition): WaitCondition {
  return condition.at === undefined
    ? { kind: condition.kind }
    : { kind: condition.kind, at: condition.at };
}
function copySource(source: WaitSource): WaitSource {
  return {
    adapter: source.adapter,
    version: source.version,
    target: { kind: source.target.kind, id: source.target.id },
  };
}
function copyPolicy(policy: WaitPolicy): WaitPolicy {
  if (policy.delivery !== "poll") return { delivery: "events" };
  if (policy.pollIntervalMs === undefined) throw new WaitServiceError("invalid_request");
  return { delivery: "poll", pollIntervalMs: policy.pollIntervalMs };
}
function plainObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}
function copyEvent(event: WaitEvent): WaitEvent {
  return {
    version: event.version,
    sequence: event.sequence,
    waitId: event.waitId,
    lifecycle: event.lifecycle,
    timestamp: event.timestamp,
    ...(event.evidence === undefined
      ? {}
      : { evidence: { code: event.evidence.code, at: event.evidence.at } }),
  };
}
function copyRecord(record: WaitRecord): WaitRecord {
  return {
    version: record.version,
    id: record.id,
    lifecycle: record.lifecycle,
    source: copySource(record.source),
    condition: copyCondition(record.condition),
    owner: { kind: record.owner.kind, id: record.owner.id },
    policy: copyPolicy(record.policy),
    ...(record.deadlineAt === undefined ? {} : { deadlineAt: record.deadlineAt }),
    recovery: record.recovery,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    nextSequence: record.nextSequence,
    events: record.events.map(copyEvent),
    evidence: record.evidence.map((item) => ({ code: item.code, at: item.at })),
    ...(record.reconciliation === undefined
      ? {}
      : { reconciliation: { ...record.reconciliation } }),
  };
}
