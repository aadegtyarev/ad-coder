import * as path from "node:path";
import type { ProjectStore } from "../project-store/project-store";
import { ProjectStoreError } from "../project-store/types";
import type { WaitCondition, WaitObservation, WaitSourceAdapter, WaitTarget } from "./wait-service";

export const RUN_WAIT_ADAPTER_ID = "run";
export const TIMER_WAIT_ADAPTER_ID = "timer";
export const WAIT_ADAPTER_VERSION = 1;

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const RUN_CONDITIONS = new Set(["terminal", "complete"]);
const TERMINAL = new Set(["complete", "completed"]);
const FAILURE = new Set(["failed", "cancelled"]);
const PAUSED = new Set(["paused", "stalled", "awaiting_decision", "operator_attention"]);

export type WaitAdapterValidationCode = "invalid_target" | "invalid_condition";
export class WaitAdapterValidationError extends Error {
  override readonly name = "WaitAdapterValidationError";
  constructor(
    readonly code: WaitAdapterValidationCode,
    readonly adapterId: string,
  ) {
    super(code);
  }
}

export type WaitSourceAdapterRegistryErrorCode =
  | "invalid_adapter"
  | "duplicate_adapter"
  | "unavailable_adapter";
export class WaitSourceAdapterRegistryError extends Error {
  override readonly name = "WaitSourceAdapterRegistryError";
  constructor(
    readonly code: WaitSourceAdapterRegistryErrorCode,
    readonly adapterId?: string,
  ) {
    super(code);
  }
}

/** Immutable-by-default lookup boundary for source adapters. */
export class WaitSourceAdapterRegistry {
  private readonly adapters = new Map<string, WaitSourceAdapter>();

  constructor(adapters: readonly WaitSourceAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: WaitSourceAdapter): this {
    if (
      !adapter ||
      !SAFE_ID.test(adapter.id) ||
      !Number.isSafeInteger(adapter.version) ||
      adapter.version <= 0 ||
      typeof adapter.validate !== "function" ||
      typeof adapter.reconcile !== "function"
    )
      throw new WaitSourceAdapterRegistryError("invalid_adapter", adapter?.id);
    if (this.adapters.has(adapter.id))
      throw new WaitSourceAdapterRegistryError("duplicate_adapter", adapter.id);
    this.adapters.set(adapter.id, adapter);
    return this;
  }

  get(id: string, version: number): WaitSourceAdapter {
    const adapter = this.adapters.get(id);
    if (adapter === undefined || adapter.version !== version)
      throw new WaitSourceAdapterRegistryError("unavailable_adapter", id);
    return adapter;
  }

  values(): readonly WaitSourceAdapter[] {
    return [...this.adapters.values()];
  }
}

function unavailable(): WaitObservation {
  return { lifecycle: "unavailable", evidence: "source_unavailable" };
}

function validTarget(target: WaitTarget): boolean {
  return (
    !!target &&
    (target.kind === "standalone" || target.kind === "coordinator") &&
    SAFE_ID.test(target.id)
  );
}

function runPath(store: ProjectStore, target: WaitTarget): string {
  // validateRun is always called before this function; IDs cannot introduce a path segment.
  return path.join(store.layout.runs, `${target.kind}-${target.id}.json`);
}

function readRecord(store: ProjectStore, target: WaitTarget): Record<string, unknown> | undefined {
  try {
    const state = store.readVersionedJson<unknown>(runPath(store, target)).value;
    if (typeof state !== "object" || state === null || Array.isArray(state)) return undefined;
    return state as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ProjectStoreError && error.code === "not_found") return undefined;
    return undefined;
  }
}

function validateRun(target: WaitTarget, condition: WaitCondition): void {
  if (!validTarget(target))
    throw new WaitAdapterValidationError("invalid_target", RUN_WAIT_ADAPTER_ID);
  if (!condition || !RUN_CONDITIONS.has(condition.kind))
    throw new WaitAdapterValidationError("invalid_condition", RUN_WAIT_ADAPTER_ID);
}

/** Reads only durable run status; it never exposes task, paths, process data, or output. */
export function createRunWaitAdapter(store: ProjectStore): WaitSourceAdapter {
  return {
    id: RUN_WAIT_ADAPTER_ID,
    version: WAIT_ADAPTER_VERSION,
    validate: validateRun,
    reconcile({ source, condition }) {
      try {
        validateRun(source.target, condition);
      } catch (error) {
        if (error instanceof WaitAdapterValidationError) return unavailable();
        throw error;
      }
      const record = readRecord(store, source.target);
      if (record === undefined) return unavailable();
      const status =
        source.target.kind === "standalone"
          ? record.status
          : record.phase === "complete"
            ? "complete"
            : record.pause !== undefined
              ? "paused"
              : record.phase;
      if (typeof status !== "string") return unavailable();
      if (TERMINAL.has(status)) return { lifecycle: "satisfied", evidence: "condition_met" };
      if (FAILURE.has(status)) return { lifecycle: "failed", evidence: "condition_failed" };
      if (PAUSED.has(status)) return { lifecycle: "stalled", evidence: "source_stalled" };
      if (
        [
          "starting",
          "running",
          "settling",
          "queued",
          "workflow",
          "follow-ups",
          "decisions",
          "closeout",
        ].includes(status)
      )
        return { lifecycle: "pending" };
      return unavailable();
    },
  };
}

export function createStandaloneRunWaitAdapter(store: ProjectStore): WaitSourceAdapter {
  const adapter = createRunWaitAdapter(store);
  return { ...adapter, id: "standalone" };
}

export function createCoordinatorRunWaitAdapter(store: ProjectStore): WaitSourceAdapter {
  const adapter = createRunWaitAdapter(store);
  return { ...adapter, id: "coordinator" };
}

export interface TimerWaitClock {
  now(): number;
}

/** Observation-only timer: compares numbers and never schedules a host timer. */
export function createTimerWaitAdapter(
  clock: TimerWaitClock = { now: Date.now },
): WaitSourceAdapter {
  return {
    id: TIMER_WAIT_ADAPTER_ID,
    version: WAIT_ADAPTER_VERSION,
    validate(target, condition) {
      const at = condition?.at;
      if (
        target?.kind !== "timer" ||
        !SAFE_ID.test(target.id) ||
        condition?.kind !== "at" ||
        typeof at !== "number" ||
        !Number.isSafeInteger(at) ||
        at < 0
      )
        throw new WaitAdapterValidationError("invalid_condition", TIMER_WAIT_ADAPTER_ID);
    },
    reconcile({ source, condition }) {
      try {
        this.validate(source.target, condition);
      } catch (error) {
        if (error instanceof WaitAdapterValidationError) return unavailable();
        throw error;
      }
      const at = condition.at as number;
      return clock.now() >= at
        ? { lifecycle: "satisfied", evidence: "condition_met" }
        : { lifecycle: "pending" };
    },
  };
}

export function createProductionWaitSourceRegistry(
  store: ProjectStore,
  clock?: TimerWaitClock,
): WaitSourceAdapterRegistry {
  return new WaitSourceAdapterRegistry([
    createRunWaitAdapter(store),
    createTimerWaitAdapter(clock),
  ]);
}

export function createProductionWaitSourceAdapters(
  store: ProjectStore,
  clock?: TimerWaitClock,
): readonly WaitSourceAdapter[] {
  return createProductionWaitSourceRegistry(store, clock).values();
}

export const productionWaitSourceAdapters = createProductionWaitSourceAdapters;
