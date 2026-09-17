import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ProjectStore } from "../project-store/project-store";
import { ProjectStoreError } from "../project-store/types";
import type { RunPipelineResult, StepCost } from "./orchestrator";

export type BackgroundLifecycle =
  | "requested"
  | "started"
  | "stage_changed"
  | "operator_attention"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "completed";
export type BackgroundTerminalLifecycle = "failed" | "cancelled" | "timed_out" | "completed";

export interface BackgroundRunEvent {
  sequence: number;
  runId: string;
  lifecycle: BackgroundLifecycle;
  timestamp: number;
  stage?: StepCost["phase"];
  errorCode?: "internal_failure" | "operator_attention" | "deadline_exceeded";
  metrics?: { steps: number; totalCost: number };
}
export interface BackgroundEventPage {
  events: BackgroundRunEvent[];
  nextCursor: number;
  gap: boolean;
}
/** A bounded push hint. Callers retain explicit cursor polling for reconnect and backlog reads. */
export interface BackgroundRunNotice extends BackgroundEventPage {
  type: "background_events";
  runId: string;
  /** Events omitted by retention before this subscriber could observe them. */
  droppedEvents: number;
  /** More persisted events exist beyond this bounded notice. */
  pending: boolean;
}
export type BackgroundRunNoticeConsumer = (notice: BackgroundRunNotice) => void | Promise<void>;
export interface BackgroundRunStatus {
  runId: string;
  lifecycle: BackgroundLifecycle;
  metrics: { steps: number; totalCost: number };
  recovery?: "wait" | "inspect_events" | "resume_pipeline" | "none";
}
export interface BackgroundRunOutcome extends BackgroundRunStatus {
  lifecycle: BackgroundTerminalLifecycle;
  approved?: boolean;
  rounds?: number;
  verdict?: string;
}
export type BackgroundRunErrorCode =
  | "not_found"
  | "resource_limit"
  | "closed"
  | "invalid_request"
  | "not_terminal"
  | "launch_failed"
  | "state_unavailable";
export class BackgroundRunError extends Error {
  override readonly name = "BackgroundRunError";
  readonly detail = "background_run";
  constructor(
    readonly code: BackgroundRunErrorCode,
    readonly runId?: string,
  ) {
    super(code);
  }
}
export type SameTargetPolicy = "allow" | "reject" | "serialize";
export interface BackgroundRunLimits {
  maxActiveRuns: number;
  maxProcessActiveRuns: number;
  maxTaskBytes: number;
  maxEventsPerRun: number;
  maxPageSize: number;
  maxPageBytes: number;
  /** Maximum undelivered notice pages retained for each subscriber. */
  subscriberQueueCapacity: number;
  maxRunMs: number;
  closeDrainMs: number;
  /** Lease heartbeat window used to distinguish a live detached worker from abandonment. */
  leaseMs: number;
  sameTargetPolicy: SameTargetPolicy;
}
/** Hard cap independent of callers: each subscriber retains up to this many pages. */
export const MAX_BACKGROUND_SUBSCRIBER_QUEUE_CAPACITY = 1_024;
export const DEFAULT_BACKGROUND_RUN_LIMITS: Readonly<BackgroundRunLimits> = Object.freeze({
  maxActiveRuns: 0,
  maxProcessActiveRuns: 0,
  maxTaskBytes: 0,
  maxEventsPerRun: 0,
  maxPageSize: 32,
  maxPageBytes: 16 * 1024,
  subscriberQueueCapacity: 16,
  maxRunMs: 0,
  closeDrainMs: 0,
  leaseMs: 15_000,
  sameTargetPolicy: "reject",
});
interface PersistedEntry {
  version: 1;
  ownerId: string;
  runId: string;
  lifecycle: BackgroundLifecycle;
  events: BackgroundRunEvent[];
  nextSequence: number;
  metrics: { steps: number; totalCost: number };
  lease?: { workerId: string; heartbeatAt: number } | undefined;
  outcome?: BackgroundRunOutcome | undefined;
}
export interface BackgroundDetachedLaunch {
  runId: string;
  task: string;
  limits: Readonly<BackgroundRunLimits>;
}
export type BackgroundHostLauncher = (launch: BackgroundDetachedLaunch) => void | Promise<void>;

interface Entry extends PersistedEntry {
  active: boolean;
  cancelled: boolean;
  promise: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  lease?: { workerId: string; heartbeatAt: number } | undefined;
  leaseTimer?: ReturnType<typeof setInterval>;
}
interface BackgroundSubscriber {
  consumer: BackgroundRunNoticeConsumer;
  cursors: Map<string, number>;
  queue: BackgroundRunNotice[];
  active: boolean;
  draining: boolean;
}

const MAX_BACKGROUND_EVENT_PAGE_EVENT: BackgroundRunEvent = {
  sequence: Number.MAX_SAFE_INTEGER,
  runId: "x".repeat(256),
  lifecycle: "stage_changed",
  timestamp: Number.MAX_SAFE_INTEGER,
  stage: "security",
  errorCode: "deadline_exceeded",
  metrics: { steps: Number.MAX_SAFE_INTEGER, totalCost: Number.MAX_VALUE },
};
/** Enough room for every schema-valid event, so cursor polling always advances. */
export const MIN_BACKGROUND_EVENT_PAGE_BYTES =
  Buffer.byteLength(JSON.stringify(MAX_BACKGROUND_EVENT_PAGE_EVENT)) + 3;

let processActive = 0;
const targetTails = new Map<string, Promise<void>>();

/** Create each private state ancestor only after rejecting links and foreign permissions. */
function privateStateDirectory(targetDir: string): string {
  const uid = process.getuid?.();
  let current = fs.realpathSync(targetDir);
  for (const segment of [".ad-coder", "runs", "background"]) {
    current = path.join(current, segment);
    try {
      fs.lstatSync(current);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      fs.mkdirSync(current, { recursive: false, mode: 0o700 });
    }
    const stat = fs.lstatSync(current);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 ||
      (uid !== undefined && stat.uid !== uid)
    )
      throw new BackgroundRunError("state_unavailable");
    fs.chmodSync(current, 0o700);
  }
  return current;
}

/** Session-owned durable, content-free projection over isolated pipeline workers. */
export class BackgroundRunManager {
  private readonly entries = new Map<string, Entry>();
  private readonly limits: BackgroundRunLimits;
  private readonly ownerId: string;
  private readonly stateDir?: string;
  private readonly store?: ProjectStore;
  private readonly subscribers = new Set<BackgroundSubscriber>();
  private watcher: fs.FSWatcher | undefined;
  private closed = false;
  constructor(
    private readonly execute: (
      task: string,
      runId: string,
      control: { cancelled: () => boolean; onStage: (step: StepCost) => void },
    ) => Promise<RunPipelineResult>,
    limits: Partial<BackgroundRunLimits> = {},
    targetDir?: string,
    ownerId: string = crypto.randomUUID(),
    private readonly launchDetachedHost?: BackgroundHostLauncher,
  ) {
    this.limits = { ...DEFAULT_BACKGROUND_RUN_LIMITS, ...limits };
    const numericLimits = [
      this.limits.maxActiveRuns,
      this.limits.maxProcessActiveRuns,
      this.limits.maxTaskBytes,
      this.limits.maxEventsPerRun,
      this.limits.maxPageSize,
      this.limits.maxPageBytes,
      this.limits.subscriberQueueCapacity,
      this.limits.maxRunMs,
      this.limits.closeDrainMs,
      this.limits.leaseMs,
    ];
    if (numericLimits.some((value) => !Number.isSafeInteger(value) || value < 0))
      throw new BackgroundRunError("invalid_request");
    if (
      this.limits.maxPageSize <= 0 ||
      this.limits.maxPageBytes < MIN_BACKGROUND_EVENT_PAGE_BYTES ||
      this.limits.subscriberQueueCapacity <= 0 ||
      this.limits.subscriberQueueCapacity > MAX_BACKGROUND_SUBSCRIBER_QUEUE_CAPACITY ||
      this.limits.leaseMs <= 0
    )
      throw new BackgroundRunError("invalid_request");
    if (!(["allow", "reject", "serialize"] as const).includes(this.limits.sameTargetPolicy))
      throw new BackgroundRunError("invalid_request");
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(ownerId)) throw new BackgroundRunError("invalid_request");
    this.ownerId = ownerId;
    if (targetDir !== undefined) {
      this.store = new ProjectStore(targetDir);
      this.stateDir = privateStateDirectory(targetDir);
      this.load();
    }
  }
  start(task: string): { runId: string; lifecycle: "requested" } {
    return this.create(task, false);
  }
  /** Admit and launch a durable request through the host supplied by the embedding application. */
  async startDetached(task: string): Promise<{ runId: string; lifecycle: "requested" }> {
    const requested = this.create(task, true);
    const entry = this.entries.get(requested.runId);
    if (entry === undefined) throw new BackgroundRunError("not_found");
    try {
      if (this.launchDetachedHost === undefined)
        throw new Error("detached host launcher is not configured");
      await this.launchDetachedHost({ runId: requested.runId, task, limits: { ...this.limits } });
      return requested;
    } catch {
      this.failLaunch(entry);
      throw new BackgroundRunError("launch_failed", requested.runId);
    }
  }
  /** Claim a requested record in the detached worker process. */
  claim(runId: string, task: string): void {
    const entry = this.owned(runId);
    if (entry.lifecycle !== "requested" || entry.lease !== undefined)
      throw new BackgroundRunError("invalid_request");
    const workerId = crypto.randomUUID();
    if (this.store !== undefined) {
      const file = path.join(this.stateDir as string, `${runId}.json`);
      try {
        this.store.mutateVersionedJson<PersistedEntry>(file, (current) => {
          const value = current?.value;
          if (value === undefined || value.lifecycle !== "requested" || value.lease !== undefined)
            throw new BackgroundRunError("invalid_request", runId);
          return { ...value, lease: { workerId, heartbeatAt: Date.now() } };
        });
      } catch (error) {
        if (error instanceof BackgroundRunError) throw error;
        if (error instanceof ProjectStoreError && error.code === "version_conflict")
          throw new BackgroundRunError("invalid_request", runId);
        throw error;
      }
    }
    entry.active = true;
    entry.lease = { workerId, heartbeatAt: Date.now() };
    this.launch(entry, task);
  }
  private create(task: string, detached: boolean): { runId: string; lifecycle: "requested" } {
    if (this.closed) throw new BackgroundRunError("closed");
    if (
      typeof task !== "string" ||
      task.trim() === "" ||
      (this.limits.maxTaskBytes > 0 && Buffer.byteLength(task) > this.limits.maxTaskBytes)
    )
      throw new BackgroundRunError("resource_limit");
    const active = [...this.entries.values()].filter((entry) => entry.active).length;
    if (
      (this.limits.maxActiveRuns > 0 && active >= this.limits.maxActiveRuns) ||
      (this.limits.maxProcessActiveRuns > 0 && processActive >= this.limits.maxProcessActiveRuns) ||
      (this.stateDir !== undefined &&
        this.limits.sameTargetPolicy === "reject" &&
        targetTails.has(this.stateDir))
    )
      throw new BackgroundRunError("resource_limit");
    const runId = crypto.randomUUID();
    const entry: Entry = {
      version: 1,
      ownerId: this.ownerId,
      runId,
      lifecycle: "requested",
      events: [],
      nextSequence: 1,
      metrics: { steps: 0, totalCost: 0 },
      active: !detached,
      cancelled: false,
      promise: Promise.resolve(),
    };
    this.entries.set(runId, entry);
    this.append(entry, "requested");
    const preceding =
      this.stateDir !== undefined && this.limits.sameTargetPolicy === "serialize"
        ? targetTails.get(this.stateDir)
        : undefined;
    if (detached) {
      entry.active = false;
      entry.promise = Promise.resolve();
      return { runId, lifecycle: "requested" };
    }
    this.launch(entry, task, preceding);
    return { runId, lifecycle: "requested" };
  }
  private failLaunch(entry: Entry): void {
    entry.lifecycle = "failed";
    entry.outcome = { ...this.statusOf(entry), lifecycle: "failed", recovery: "inspect_events" };
    this.append(entry, "failed", {
      errorCode: "internal_failure",
      metrics: { ...entry.metrics },
    });
    this.persist(entry);
  }
  private launch(entry: Entry, task: string, preceding?: Promise<void>): void {
    processActive += 1;
    entry.lease ??= { workerId: crypto.randomUUID(), heartbeatAt: Date.now() };
    this.persist(entry);
    const execute = Promise.resolve(preceding).then(async () => {
      if (entry.cancelled) return;
      entry.lifecycle = "started";
      this.append(entry, "started");
      if (this.limits.maxRunMs > 0)
        entry.timer = setTimeout(() => this.timeout(entry), this.limits.maxRunMs);
      const result = await this.execute(task, entry.runId, {
        cancelled: () => entry.cancelled,
        onStage: (step) => {
          if (entry.cancelled) return;
          entry.metrics = {
            steps: entry.metrics.steps + 1,
            totalCost: entry.metrics.totalCost + step.cost,
          };
          this.append(entry, "stage_changed", { stage: step.phase, metrics: { ...entry.metrics } });
        },
      });
      if (entry.cancelled) return;
      entry.metrics = { steps: result.perStep.length, totalCost: result.totalCost };
      entry.lifecycle = "completed";
      const lastVerdict = result.result.verdicts.at(-1);
      entry.outcome = {
        ...this.statusOf(entry),
        lifecycle: "completed",
        approved: result.result.approved,
        rounds: result.result.rounds,
        ...(lastVerdict === undefined ? { verdict: "not_run" } : { verdict: lastVerdict.status }),
      };
      this.append(entry, "completed", { metrics: { ...entry.metrics } });
    });
    entry.promise = execute
      .catch((error: unknown) => {
        if (entry.cancelled) return;
        const attention = isOperatorAttention(error);
        entry.lifecycle = attention ? "operator_attention" : "failed";
        this.append(entry, entry.lifecycle, {
          errorCode: attention ? "operator_attention" : "internal_failure",
          metrics: { ...entry.metrics },
        });
        if (attention) return;
        entry.outcome = {
          ...this.statusOf(entry),
          lifecycle: "failed",
          recovery: "inspect_events",
        };
        this.persist(entry);
      })
      .finally(() => {
        entry.active = false;
        if (entry.timer !== undefined) clearTimeout(entry.timer);
        if (entry.leaseTimer !== undefined) clearInterval(entry.leaseTimer);
        entry.lease = undefined;
        this.persist(entry);
        processActive -= 1;
        if (this.stateDir !== undefined && targetTails.get(this.stateDir) === entry.promise)
          targetTails.delete(this.stateDir);
      });
    if (this.stateDir !== undefined && this.limits.sameTargetPolicy !== "allow")
      targetTails.set(this.stateDir, entry.promise);
    entry.leaseTimer = setInterval(
      () => {
        if (entry.active && entry.lease !== undefined) {
          entry.lease.heartbeatAt = Date.now();
          this.persist(entry);
        }
      },
      Math.max(100, Math.floor(this.limits.leaseMs / 3)),
    );
    void entry.promise;
  }
  async wait(runId: string): Promise<void> {
    await this.owned(runId).promise;
  }
  /**
   * Subscribe to future owner-scoped, content-free lifecycle pages.
   *
   * Each callback receives pages through an asynchronous bounded per-subscriber queue.
   * Notifications are hints only: reconnect and backlog consumption continue to use events(runId, cursor).
   */
  subscribe(consumer: BackgroundRunNoticeConsumer): () => void {
    if (this.closed) throw new BackgroundRunError("closed");
    if (typeof consumer !== "function") throw new BackgroundRunError("invalid_request");
    const subscriber: BackgroundSubscriber = {
      consumer,
      cursors: new Map(),
      queue: [],
      active: true,
      draining: false,
    };
    for (const entry of this.entries.values())
      subscriber.cursors.set(entry.runId, entry.nextSequence - 1);
    this.subscribers.add(subscriber);
    try {
      this.ensureWatcher();
    } catch (error) {
      this.subscribers.delete(subscriber);
      throw error;
    }
    return () => this.removeSubscriber(subscriber);
  }
  /** Owner-scoped, bounded lifecycle summary. Foreign records are never loaded. */
  list(limit = this.limits.maxPageSize): BackgroundRunStatus[] {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new BackgroundRunError("invalid_request");
    return [...this.entries.values()]
      .slice(0, Math.min(limit || this.limits.maxPageSize, this.limits.maxPageSize))
      .map((entry) => this.statusOf(entry));
  }
  status(runId: string): BackgroundRunStatus {
    return this.statusOf(this.owned(runId));
  }
  events(runId: string, cursor: number, limit = this.limits.maxPageSize): BackgroundEventPage {
    const entry = this.owned(runId);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 0)
      throw new BackgroundRunError("invalid_request");
    return this.eventsOf(entry, cursor, limit || this.limits.maxPageSize);
  }
  result(runId: string): BackgroundRunOutcome {
    const entry = this.owned(runId);
    if (entry.outcome === undefined) throw new BackgroundRunError("not_terminal");
    return copyOutcome(entry.outcome);
  }
  cancel(runId: string): BackgroundRunStatus {
    const entry = this.owned(runId);
    if (!isTerminal(entry.lifecycle)) {
      entry.cancelled = true;
      entry.lifecycle = "cancelled";
      entry.outcome = { ...this.statusOf(entry), lifecycle: "cancelled", recovery: "none" };
      this.append(entry, "cancelled", { metrics: { ...entry.metrics } });
    }
    return this.statusOf(entry);
  }
  async close(preserveWorkers = false): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopWatcher();
    for (const subscriber of this.subscribers) this.deactivateSubscriber(subscriber);
    this.subscribers.clear();
    for (const entry of this.entries.values())
      if (!preserveWorkers && entry.active && !isTerminal(entry.lifecycle))
        this.cancel(entry.runId);
    if (this.limits.closeDrainMs === 0) return;
    const pending = Promise.allSettled([...this.entries.values()].map((entry) => entry.promise));
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.limits.closeDrainMs);
      void pending.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  private timeout(e: Entry): void {
    if (isTerminal(e.lifecycle)) return;
    e.cancelled = true;
    e.lifecycle = "timed_out";
    e.outcome = { ...this.statusOf(e), lifecycle: "timed_out", recovery: "resume_pipeline" };
    this.append(e, "timed_out", { errorCode: "deadline_exceeded", metrics: { ...e.metrics } });
  }
  private statusOf(e: Entry): BackgroundRunStatus {
    return {
      runId: e.runId,
      lifecycle: e.lifecycle,
      metrics: { ...e.metrics },
      recovery: isTerminal(e.lifecycle)
        ? "none"
        : e.lifecycle === "operator_attention"
          ? "resume_pipeline"
          : "wait",
    };
  }
  private owned(runId: string): Entry {
    const current = this.entries.get(runId);
    if (current !== undefined && !current.active) this.refresh(runId);
    const entry = this.entries.get(runId);
    if (entry === undefined) throw new BackgroundRunError("not_found");
    return entry;
  }
  private append(
    e: Entry,
    lifecycle: BackgroundLifecycle,
    fields: Partial<BackgroundRunEvent> = {},
  ): void {
    e.events.push({
      sequence: e.nextSequence++,
      runId: e.runId,
      lifecycle,
      timestamp: Date.now(),
      ...fields,
    });
    if (this.limits.maxEventsPerRun > 0 && e.events.length > this.limits.maxEventsPerRun)
      e.events.splice(0, e.events.length - this.limits.maxEventsPerRun);
    this.persist(e);
    this.notify(e);
  }
  private persist(e: Entry): void {
    if (this.stateDir === undefined) return;
    const file = path.join(this.stateDir, `${e.runId}.json`);
    const data: PersistedEntry = {
      version: 1,
      ownerId: e.ownerId,
      runId: e.runId,
      lifecycle: e.lifecycle,
      events: e.events,
      nextSequence: e.nextSequence,
      metrics: e.metrics,
      ...(e.lease && { lease: e.lease }),
      ...(e.outcome && { outcome: e.outcome }),
    };
    if (this.store !== undefined) {
      this.store.mutateVersionedJson<PersistedEntry>(file, () => data);
      return;
    }
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(temp, file);
  }
  private refresh(runId: string): void {
    if (this.stateDir === undefined) return;
    const file = path.join(this.stateDir, `${runId}.json`);
    let persisted: PersistedEntry;
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      persisted = parsePersistedEntry(raw.value ?? raw);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw new BackgroundRunError("state_unavailable", runId);
    }
    if (persisted.ownerId !== this.ownerId) return;
    const entry = this.entries.get(runId);
    if (entry === undefined || entry.active) return;
    const changed = persisted.nextSequence !== entry.nextSequence;
    entry.lifecycle = persisted.lifecycle;
    entry.events = persisted.events.map(copyEvent);
    entry.nextSequence = persisted.nextSequence;
    entry.metrics = copyMetrics(persisted.metrics);
    entry.lease = persisted.lease;
    entry.outcome = persisted.outcome === undefined ? undefined : copyOutcome(persisted.outcome);
    if (changed) this.notify(entry);
  }
  private ensureWatcher(): void {
    if (this.stateDir === undefined || this.watcher !== undefined) return;
    try {
      this.watcher = fs.watch(this.stateDir, (_event, filename) => {
        try {
          const name = filename?.toString();
          if (name?.endsWith(".json")) {
            const runId = name.slice(0, -5);
            if (this.entries.has(runId)) this.refresh(runId);
            return;
          }
          for (const runId of this.entries.keys()) this.refresh(runId);
        } catch {
          this.stopWatcher();
          this.subscribers.clear();
          console.error(
            "ad-coder: background state became unavailable; use polling after state recovery",
          );
        }
      });
    } catch {
      throw new BackgroundRunError("state_unavailable");
    }
  }
  private stopWatcher(): void {
    this.watcher?.close();
    this.watcher = undefined;
  }
  private notify(entry: Entry): void {
    for (const subscriber of this.subscribers) {
      const cursor = subscriber.cursors.get(entry.runId) ?? 0;
      const page = this.eventsOf(entry, cursor, this.limits.maxPageSize);
      const pending = page.nextCursor < entry.nextSequence - 1;
      if (page.events.length === 0 && !page.gap && !pending) continue;
      const oldest = entry.events[0]?.sequence ?? entry.nextSequence;
      const droppedEvents = page.gap ? Math.max(0, oldest - cursor - 1) : 0;
      subscriber.cursors.set(entry.runId, page.nextCursor);
      this.enqueue(subscriber, {
        type: "background_events",
        runId: entry.runId,
        ...page,
        droppedEvents,
        pending,
      });
    }
  }
  private enqueue(subscriber: BackgroundSubscriber, notice: BackgroundRunNotice): void {
    if (!subscriber.active) return;
    if (subscriber.queue.length >= this.limits.subscriberQueueCapacity) {
      const replaced = subscriber.queue.shift();
      if (replaced !== undefined) {
        notice.droppedEvents += replaced.droppedEvents + replaced.events.length;
        notice.pending = true;
      }
    }
    subscriber.queue.push(notice);
    this.drainSubscriber(subscriber);
  }
  private drainSubscriber(subscriber: BackgroundSubscriber): void {
    if (!subscriber.active || subscriber.draining) return;
    subscriber.draining = true;
    queueMicrotask(async () => {
      try {
        while (subscriber.active) {
          const notice = subscriber.queue.shift();
          if (notice === undefined) break;
          await subscriber.consumer(notice);
        }
      } catch {
        this.removeSubscriber(subscriber);
        console.error("ad-coder: background subscriber failed; subscription removed");
      } finally {
        subscriber.draining = false;
        if (subscriber.active && subscriber.queue.length > 0) this.drainSubscriber(subscriber);
      }
    });
  }
  private deactivateSubscriber(subscriber: BackgroundSubscriber): void {
    subscriber.active = false;
    subscriber.queue.length = 0;
  }
  private removeSubscriber(subscriber: BackgroundSubscriber): void {
    this.deactivateSubscriber(subscriber);
    this.subscribers.delete(subscriber);
    if (this.subscribers.size === 0) this.stopWatcher();
  }
  private eventsOf(entry: Entry, cursor: number, limit: number): BackgroundEventPage {
    const countCap = Math.min(limit, this.limits.maxPageSize);
    const oldest = entry.events[0]?.sequence ?? entry.nextSequence;
    const gap = cursor + 1 < oldest;
    const effective = gap ? oldest - 1 : cursor;
    const events: BackgroundRunEvent[] = [];
    let bytes = 2;
    for (const event of entry.events) {
      if (event.sequence <= effective || events.length >= countCap) continue;
      const size = Buffer.byteLength(JSON.stringify(event)) + 1;
      if (bytes + size > this.limits.maxPageBytes) break;
      events.push(copyEvent(event));
      bytes += size;
    }
    return { events, nextCursor: events.at(-1)?.sequence ?? effective, gap };
  }
  private load(): void {
    if (this.stateDir === undefined) return;
    for (const name of fs.readdirSync(this.stateDir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(this.stateDir, name), "utf8"));
        const persisted = parsePersistedEntry(raw.value ?? raw);
        if (persisted.ownerId !== this.ownerId) continue;
        const interrupted = !isTerminal(persisted.lifecycle);
        const abandoned =
          interrupted &&
          persisted.lifecycle !== "requested" &&
          !hasFreshLease(persisted.lease, this.limits.leaseMs);
        const entry: Entry = {
          version: 1,
          ownerId: persisted.ownerId,
          runId: persisted.runId,
          lifecycle: persisted.lifecycle,
          events: persisted.events.map(copyEvent),
          nextSequence: persisted.nextSequence,
          metrics: copyMetrics(persisted.metrics),
          ...(persisted.outcome !== undefined
            ? { outcome: copyOutcome(persisted.outcome) }
            : abandoned
              ? {
                  outcome: {
                    runId: persisted.runId,
                    lifecycle: "failed" as const,
                    metrics: copyMetrics(persisted.metrics),
                    recovery: "resume_pipeline" as const,
                  },
                }
              : {}),
          active: false,
          cancelled: false,
          ...(persisted.lease === undefined ? {} : { lease: persisted.lease }),
          promise: Promise.resolve(),
        };
        this.entries.set(entry.runId, entry);
        if (abandoned) {
          entry.lifecycle = "failed";
          entry.cancelled = true;
          entry.outcome = {
            runId: persisted.runId,
            lifecycle: "failed" as const,
            metrics: copyMetrics(persisted.metrics),
            recovery: "resume_pipeline" as const,
          };
          this.append(entry, "failed", {
            errorCode: "internal_failure",
            metrics: { ...entry.metrics },
          });
        }
      } catch {
        // A partial or malformed record is untrusted and deliberately unavailable.
      }
    }
  }
}
const LIFECYCLES = [
  "requested",
  "started",
  "stage_changed",
  "operator_attention",
  "failed",
  "cancelled",
  "timed_out",
  "completed",
] as const;
const TERMINAL_LIFECYCLES = ["failed", "cancelled", "timed_out", "completed"] as const;
const PHASES = ["plan", "research", "security", "code", "review", "done"] as const;
const ERROR_CODES = ["internal_failure", "operator_attention", "deadline_exceeded"] as const;
const RECOVERIES = ["wait", "inspect_events", "resume_pipeline", "none"] as const;

function strictObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError("record must be an object");
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !keys.includes(key)))
    throw new TypeError("record contains an unknown field");
  return object;
}
function enumValue<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T))
    throw new TypeError("record contains an invalid enum");
  return value as T;
}
function safeInteger(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum)
    throw new TypeError("record contains an invalid integer");
  return value as number;
}
function finiteNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new TypeError("record contains an invalid number");
  return value;
}
function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256)
    throw new TypeError("record contains an invalid string");
  return value;
}
function parseMetrics(value: unknown): { steps: number; totalCost: number } {
  const object = strictObject(value, ["steps", "totalCost"]);
  return { steps: safeInteger(object.steps), totalCost: finiteNumber(object.totalCost) };
}
function copyMetrics(value: { steps: number; totalCost: number }): {
  steps: number;
  totalCost: number;
} {
  return { steps: value.steps, totalCost: value.totalCost };
}
function parseEvent(value: unknown, runId: string): BackgroundRunEvent {
  const object = strictObject(value, [
    "sequence",
    "runId",
    "lifecycle",
    "timestamp",
    "stage",
    "errorCode",
    "metrics",
  ]);
  if (object.runId !== runId) throw new TypeError("event run does not match record");
  const lifecycle = enumValue(object.lifecycle, LIFECYCLES);
  return {
    sequence: safeInteger(object.sequence, 1),
    runId,
    lifecycle,
    timestamp: safeInteger(object.timestamp),
    ...(object.stage === undefined ? {} : { stage: enumValue(object.stage, PHASES) }),
    ...(object.errorCode === undefined
      ? {}
      : { errorCode: enumValue(object.errorCode, ERROR_CODES) }),
    ...(object.metrics === undefined ? {} : { metrics: parseMetrics(object.metrics) }),
  };
}
function copyEvent(event: BackgroundRunEvent): BackgroundRunEvent {
  return {
    sequence: event.sequence,
    runId: event.runId,
    lifecycle: event.lifecycle,
    timestamp: event.timestamp,
    ...(event.stage === undefined ? {} : { stage: event.stage }),
    ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
    ...(event.metrics === undefined ? {} : { metrics: copyMetrics(event.metrics) }),
  };
}
function parseOutcome(value: unknown, runId: string): BackgroundRunOutcome {
  const object = strictObject(value, [
    "runId",
    "lifecycle",
    "metrics",
    "recovery",
    "approved",
    "rounds",
    "verdict",
  ]);
  if (object.runId !== runId) throw new TypeError("outcome run does not match record");
  const lifecycle = enumValue(object.lifecycle, TERMINAL_LIFECYCLES);
  if (object.approved !== undefined && typeof object.approved !== "boolean")
    throw new TypeError("outcome approval is invalid");
  return {
    runId,
    lifecycle,
    metrics: parseMetrics(object.metrics),
    ...(object.recovery === undefined ? {} : { recovery: enumValue(object.recovery, RECOVERIES) }),
    ...(object.approved === undefined ? {} : { approved: object.approved }),
    ...(object.rounds === undefined ? {} : { rounds: safeInteger(object.rounds) }),
    ...(object.verdict === undefined
      ? {}
      : {
          verdict: enumValue(object.verdict, ["approved", "changes_requested", "not_run"] as const),
        }),
  };
}
function copyOutcome(outcome: BackgroundRunOutcome): BackgroundRunOutcome {
  return {
    runId: outcome.runId,
    lifecycle: outcome.lifecycle,
    metrics: copyMetrics(outcome.metrics),
    ...(outcome.recovery === undefined ? {} : { recovery: outcome.recovery }),
    ...(outcome.approved === undefined ? {} : { approved: outcome.approved }),
    ...(outcome.rounds === undefined ? {} : { rounds: outcome.rounds }),
    ...(outcome.verdict === undefined ? {} : { verdict: outcome.verdict }),
  };
}
function hasFreshLease(lease: PersistedEntry["lease"], leaseMs: number): boolean {
  return lease !== undefined && Date.now() - lease.heartbeatAt <= leaseMs;
}
function parsePersistedEntry(value: unknown): PersistedEntry {
  const object = strictObject(value, [
    "version",
    "ownerId",
    "runId",
    "lifecycle",
    "events",
    "nextSequence",
    "metrics",
    "lease",
    "outcome",
  ]);
  if (object.version !== 1 || !Array.isArray(object.events))
    throw new TypeError("record schema version is invalid");
  const ownerId = requiredString(object.ownerId);
  const runId = requiredString(object.runId);
  const lifecycle = enumValue(object.lifecycle, LIFECYCLES);
  const events = object.events.map((event) => parseEvent(event, runId));
  const nextSequence = safeInteger(object.nextSequence, 1);
  if (
    events.some(
      (event, index) =>
        event.sequence >= nextSequence ||
        (index > 0 && event.sequence <= (events[index - 1]?.sequence ?? 0)),
    )
  )
    throw new TypeError("event sequence is invalid");
  const lease =
    object.lease === undefined
      ? undefined
      : (() => {
          const leaseObject = strictObject(object.lease, ["workerId", "heartbeatAt"]);
          return {
            workerId: requiredString(leaseObject.workerId),
            heartbeatAt: safeInteger(leaseObject.heartbeatAt),
          };
        })();
  const outcome = object.outcome === undefined ? undefined : parseOutcome(object.outcome, runId);
  if (outcome !== undefined && outcome.lifecycle !== lifecycle)
    throw new TypeError("outcome lifecycle does not match record");
  if (isTerminal(lifecycle) !== (outcome !== undefined))
    throw new TypeError("terminal outcome is missing or unexpected");
  return {
    version: 1,
    ownerId,
    runId,
    lifecycle,
    events,
    nextSequence,
    metrics: parseMetrics(object.metrics),
    ...(lease === undefined ? {} : { lease }),
    ...(outcome === undefined ? {} : { outcome }),
  };
}
function isTerminal(x: BackgroundLifecycle): x is BackgroundTerminalLifecycle {
  return (TERMINAL_LIFECYCLES as readonly string[]).includes(x);
}
function isOperatorAttention(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ["pipeline_paused", "operator_attention", "stage_limit"].includes(
      String((error as { code: unknown }).code),
    )
  );
}
