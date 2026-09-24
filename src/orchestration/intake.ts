import * as crypto from "node:crypto";
import * as path from "node:path";
import { ProjectOperationsError } from "../project-operations/errors";
import type { ProjectStore } from "../project-store/project-store";
import { ProjectStoreError } from "../project-store/types";

/**
 * The orchestrator contract's intake guarantee (docs/contracts/orchestrator.md,
 * audit slices g2/g3): intake states the outcome, scope exclusions, mode,
 * measured task shape, budget, ceilings, and any ambiguity that changes the
 * result; and BEFORE work starts the budget is exactly one of accepted,
 * counter-estimated (with evidence), or explicitly blocked for a decision.
 * This module owns those two statement shapes, their validation, and the
 * durable record both live under. The block/wait error is here too: it names
 * the decided wait, never a refusal of an unstated budget -- the counter-
 * estimate path (src/orchestration/counter-estimate.ts) supplies the third
 * branch so an unstated budget is decided, not fatal.
 *
 * The budget here is the WHOLE-TASK work budget [Autonomy] defines -- never the
 * role context budget [Compaction] owns and never the per-stage cost ceilings
 * [Stage-limit calibration] records. A ceiling the statement NAMES is a named
 * limit the work will run under, not a budget.
 */

/** Authored code for an intake statement that fails its shape checks. */
export const INTAKE_ERROR_CODE = "invalid_intake";
/** Authored code for a budget block that does not say one of the three kinds. */
export const BUDGET_DECISION_ERROR_CODE = "invalid_budget_decision";

/** Bounded, secret-free statement sizes so no free-text field can flood a record. */
const MAX_STATEMENT_CHARS = 2_000;
const MAX_STATEMENT_ITEM_CHARS = 300;
const MAX_STATEMENT_ITEMS = 32;

/** The mode an intake statement runs under; mirrors `RunMode` in control-plane. */
export type IntakeMode = "auto" | "manual";

/** The measured task shape: model, role/stage, and size class ([Task estimation]). */
export interface MeasuredTaskShape {
  /** The orchestrator's pre-read complexity classification, before dispatch. */
  complexity: "trivial" | "medium" | "complex";
  /** The stage or role the measured profile names (e.g. `plan->code->review`). */
  stage: string;
  /** The measured size class (e.g. `local`, `large`), as change size is stated. */
  sizeClass: string;
}

/** The whole-task work budget the intake states. NOT a context or stage cost. */
export interface IntakeBudget {
  /** Whole-task work ceiling in USD, as [Autonomy] defines the task budget. */
  ceilingUsd: number;
  /** Who established the ceiling. */
  source: "operator" | "estimate";
}

/** The statement the orchestrator records at intake, per the contract's field list. */
export interface IntakeStatement {
  /** The intended end state of the task's work on the target project. */
  outcome: string;
  /** Work named as outside this task. */
  scopeExclusions: string[];
  mode: IntakeMode;
  taskShape: MeasuredTaskShape;
  budget: IntakeBudget;
  /** Named ceilings the work runs under (e.g. `stageLimits:maxModelTurns=8`). */
  ceilings: string[];
  /** Unresolved questions whose readings lead to different work; empty means none stated. */
  resultChangingAmbiguities: string[];
}

/** One of exactly three pre-work budget outcomes (docs/contracts/orchestrator.md). */
export type BudgetDecisionKind = "accepted" | "counter_estimated" | "blocked";

export interface BudgetDecision {
  kind: BudgetDecisionKind;
  /** Required for `counter_estimated`: the recorded evidence for the estimate. */
  evidence?: string[];
  /** Required for `blocked`: the next action that resolves the wait. */
  nextAction?: string;
  /** Optional bounded rationale. */
  reason?: string;
}

/** The durable intake record: statement + budget decision, keyed for read-back. */
export interface DurableIntakeRecord {
  schemaVersion: 1;
  id: string;
  statement: IntakeStatement;
  budget: BudgetDecision;
  createdAt: string;
  updatedAt: string;
}

function parseBoundedString(raw: unknown, who: string): string {
  if (typeof raw !== "string") throw new ProjectOperationsError("invalid_intake", who);
  const value = raw.trim();
  if (value === "" || value.length > MAX_STATEMENT_CHARS)
    throw new ProjectOperationsError("invalid_intake", who);
  return value;
}

function parseBoundedStringList(raw: unknown, who: string): string[] {
  if (!Array.isArray(raw)) throw new ProjectOperationsError("invalid_intake", who);
  if (raw.length > MAX_STATEMENT_ITEMS) throw new ProjectOperationsError("invalid_intake", who);
  return raw.map((entry, index) => {
    const value = parseBoundedString(entry, `${who}[${index}]`);
    if (value.length > MAX_STATEMENT_ITEM_CHARS)
      throw new ProjectOperationsError("invalid_intake", `${who}[${index}]`);
    return value;
  });
}

/**
 * Validate an intake statement's named fields, or refuse by name. Completeness
 * is the gate, not content judging: an empty `scopeExclusions` (nothing is
 * outside this task) and an empty `resultChangingAmbiguities` (no open
 * question) are lawful statements; every named field must be present.
 */
export function parseIntakeStatement(raw: unknown, who = "intake"): IntakeStatement {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new ProjectOperationsError("invalid_intake", who);
  const value = raw as Record<string, unknown>;
  const outcome = parseBoundedString(value.outcome, `${who}.outcome`);
  const scopeExclusions = parseBoundedStringList(value.scopeExclusions, `${who}.scopeExclusions`);
  if (value.mode !== "auto" && value.mode !== "manual")
    throw new ProjectOperationsError("invalid_intake", `${who}.mode`);
  if (typeof value.taskShape !== "object" || value.taskShape === null)
    throw new ProjectOperationsError("invalid_intake", `${who}.taskShape`);
  const shape = value.taskShape as Record<string, unknown>;
  if (
    shape.complexity !== "trivial" &&
    shape.complexity !== "medium" &&
    shape.complexity !== "complex"
  )
    throw new ProjectOperationsError("invalid_intake", `${who}.taskShape.complexity`);
  const taskShape = {
    complexity: shape.complexity as IntakeStatement["taskShape"]["complexity"],
    stage: parseBoundedString(shape.stage, `${who}.taskShape.stage`),
    sizeClass: parseBoundedString(shape.sizeClass, `${who}.taskShape.sizeClass`),
  };
  if (typeof value.budget !== "object" || value.budget === null)
    throw new ProjectOperationsError("invalid_intake", `${who}.budget`);
  const budgetRaw = value.budget as Record<string, unknown>;
  if (
    typeof budgetRaw.ceilingUsd !== "number" ||
    !Number.isFinite(budgetRaw.ceilingUsd) ||
    budgetRaw.ceilingUsd <= 0
  )
    throw new ProjectOperationsError("invalid_intake", `${who}.budget.ceilingUsd`);
  if (budgetRaw.source !== "operator" && budgetRaw.source !== "estimate")
    throw new ProjectOperationsError("invalid_intake", `${who}.budget.source`);
  const budget = {
    ceilingUsd: budgetRaw.ceilingUsd,
    source: budgetRaw.source as IntakeStatement["budget"]["source"],
  };
  const ceilings = parseBoundedStringList(value.ceilings, `${who}.ceilings`);
  const resultChangingAmbiguities = parseBoundedStringList(
    value.resultChangingAmbiguities,
    `${who}.resultChangingAmbiguities`,
  );
  return {
    outcome,
    scopeExclusions,
    mode: value.mode,
    taskShape,
    budget,
    ceilings,
    resultChangingAmbiguities,
  };
}

const BUDGET_DECISION_KINDS: readonly BudgetDecisionKind[] = [
  "accepted",
  "counter_estimated",
  "blocked",
];

/**
 * Validate a budget decision against the three-and-only-three outcomes.
 *
 * `counter_estimated` must carry its evidence -- a counter-estimate without
 * evidence is exactly the implicit unknown-budget proceed the gate exists to
 * stop. `blocked` must name its next action, so the honest wait is resumable
 * (the contract guarantee: the orchestrator can name its state and next event).
 */
export function parseBudgetDecision(raw: unknown, who = "budget"): BudgetDecision {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new ProjectOperationsError("invalid_budget_decision", who);
  const value = raw as Record<string, unknown>;
  if (!BUDGET_DECISION_KINDS.includes(value.kind as BudgetDecisionKind))
    throw new ProjectOperationsError("invalid_budget_decision", `${who}.kind`);
  const kind = value.kind as BudgetDecisionKind;
  const decision: BudgetDecision = { kind };
  if (value.reason !== undefined)
    decision.reason = parseBoundedString(value.reason, `${who}.reason`);
  if (value.evidence !== undefined) {
    const evidence = parseBoundedStringList(value.evidence, `${who}.evidence`);
    if (evidence.length === 0) throw new ProjectOperationsError("invalid_budget_decision", who);
    decision.evidence = evidence;
  } else if (kind === "counter_estimated")
    throw new ProjectOperationsError("invalid_budget_decision", `${who}.evidence`);
  if (value.nextAction !== undefined)
    decision.nextAction = parseBoundedString(value.nextAction, `${who}.nextAction`);
  else if (kind === "blocked")
    throw new ProjectOperationsError("invalid_budget_decision", `${who}.nextAction`);
  return decision;
}

/** True only for the two budget states that may start work. */
export function isWorkStartableBudget(decision: BudgetDecision): boolean {
  return decision.kind === "accepted" || decision.kind === "counter_estimated";
}

/** The SAFE-path surface code for the wait error below. */
export const BUDGET_BLOCKED_HEADER = "budget_blocked";

/**
 * Raised when work does not start and the task waits for a budget decision:
 * EITHER the dispatch's stated budget is explicitly blocked, OR there is no
 * decision on record and no counter-estimate could be produced with evidence
 * (detail `no_forecast_basis`) -- the guarantee's two honest stop states. The
 * message names the state and the next action; the task stays WIP, and no
 * work starts, with no work run, since runPipeline is not entered.
 */
export class BudgetWaitError extends Error {
  override readonly name = "BudgetWaitError";
  readonly code = BUDGET_BLOCKED_HEADER;
  readonly detail: string;

  constructor(detail: string) {
    super(
      `budget blocked, waiting for a decision: ${detail}: work did not start; resume after the budget decision resolves (state one: accepted, counter-estimated with evidence, or blocked / name the next action)`,
    );
    this.code = BUDGET_BLOCKED_HEADER;
    this.detail = detail;
  }
}

/**
 * Where intake statements and budget decisions live.
 *
 * The durable half reuses the ONE existing persistence pattern in this tree --
 * ProjectStore versioned JSON in the managed `runs` layout, the same mechanism
 * the control-plane run records use -- so a restart or context boundary reads
 * the same record file back; no new persistence machinery is introduced. The
 * in-memory half serves embedded cores without a durable target (tests), on
 * which the gate still functions within the process.
 */
export interface IntakeStore {
  set(id: string, statement: IntakeStatement, budget: BudgetDecision, timestamp: string): void;
  get(id: string): DurableIntakeRecord | undefined;
}

/** Durable intake records under `<target>/.ad-coder/runs/intake-<id>.json`. */
export class ProjectStoreIntakeStore implements IntakeStore {
  constructor(private readonly store: ProjectStore) {}

  private path(id: string): string {
    return path.join(this.store.layout.runs, `intake-${this.store.validateId(id)}.json`);
  }

  /** A deterministic, content-free id: the task's SHA-256, hex, bounded to 32. */
  static idForTask(task: string): string {
    return crypto.createHash("sha256").update(task).digest("hex").slice(0, 32);
  }

  set(id: string, statement: IntakeStatement, budget: BudgetDecision, timestamp: string): void {
    this.store.writeVersionedJson<DurableIntakeRecord>(this.path(id), {
      schemaVersion: 1,
      id,
      statement,
      budget,
      createdAt: this.get(id)?.createdAt ?? timestamp,
      updatedAt: timestamp,
    });
  }

  get(id: string): DurableIntakeRecord | undefined {
    try {
      return this.store.readVersionedJson<DurableIntakeRecord>(this.path(id)).value;
    } catch (error) {
      if (error instanceof ProjectStoreError && error.code === "not_found") return undefined;
      throw error;
    }
  }
}

/** Process-local fallback for embedded cores without a durable target. */
export class MemoryIntakeStore implements IntakeStore {
  private readonly records = new Map<string, DurableIntakeRecord>();

  static idForTask(task: string): string {
    return ProjectStoreIntakeStore.idForTask(task);
  }

  set(id: string, statement: IntakeStatement, budget: BudgetDecision, timestamp: string): void {
    const existing = this.records.get(id);
    this.records.set(id, {
      schemaVersion: 1,
      id,
      statement,
      budget,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    });
  }

  get(id: string): DurableIntakeRecord | undefined {
    const existing = this.records.get(id);
    return existing === undefined ? undefined : structuredClone(existing);
  }
}
