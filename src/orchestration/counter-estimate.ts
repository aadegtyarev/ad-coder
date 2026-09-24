import { DEFAULT_ROLE_STAGE_LIMITS } from "../cli/resolve-config";
import type { ProfileRole } from "../profiles/types";
import type { StageLimits } from "./stage-limits";

/**
 * The contract's own third way (docs/contracts/orchestrator.md:22): before
 * work starts the budget can be COUNTER-ESTIMATED WITH EVIDENCE, so a dispatch
 * that states no budget decision does not have to stop -- and never has to
 * proceed with an unknown budget by implication, either.
 *
 * The basis is deliberately REUSED, not re-estimated here: the per-role cost
 * ceilings the dispatch will actually run under (`DEFAULT_ROLE_STAGE_LIMITS`
 * in `src/cli/resolve-config.ts` or the host's resolved overlay), which are the
 * values [Stage-limit calibration] records and the operator's own console
 * runs on. The reserve composites those recorded ceilings over the built-in
 * pipeline's roles; each evidence line names the role, its ceiling, and the
 * recorded source, so the decision on record cites evidence rather than
 * authority. There is deliberately no second empirical estimator: the
 * `forecastCost` machinery in `src/economics/forecast.ts` needs per-complexity
 * historical samples that no pre-work caller has, and its own no-samples
 * contract (`sampleCount: 0`, `confidence: "none"`) is exactly the honest
 * blocked state this module mirrors by returning `undefined`.
 */

export interface BudgetCounterEstimate {
  /** Whole-task work reserve in USD: the sum of the recorded role ceilings. */
  ceilingUsd: number;
  /** The tier the route resolves on when the dispatch names no complexity. */
  complexity: "trivial" | "medium" | "complex";
  /** Bounded, secret-free evidence lines; recorded with the decision. */
  evidence: string[];
  /** The per-role rows the evidence names, in the pipeline's plan order. */
  roleCosts: Array<{ role: ProfileRole; maxCostUsd: number }>;
}

/**
 * The roles a built-in `plan -> [security] -> code <-> review` run reserves
 * before work starts. Security is conditional on the plan, but a whole-cycle
 * reserve does not know the plan yet ([Task estimation] reserves the full
 * proposed cycle), so its ceiling is reserved and named as such.
 */
const BUDGET_RESERVE_ROLES: readonly ProfileRole[] = ["planner", "security", "coder", "reviewer"];

/** A ceiling can carry an estimate only when the config NAMED one: disabled (0) and absent are both unlimited, i.e. no basis. */
function estimateBearing(limits: StageLimits | undefined): boolean {
  return (
    typeof limits?.maxCostUsd === "number" &&
    Number.isFinite(limits.maxCostUsd) &&
    limits.maxCostUsd > 0
  );
}

/**
 * Counter-estimate the whole-task budget from the recorded per-role ceilings,
 * or return `undefined` when no estimate can be produced WITH evidence. The
 * returned object is what the gate records: `evidence` is the record's proof,
 * and a caller that cannot name a ceiling for any reserved role honestly has
 * no basis at all.
 */
export function counterEstimateBudget(
  complexity: "trivial" | "medium" | "complex" | undefined,
  resolved: Partial<Record<ProfileRole, StageLimits>> = DEFAULT_ROLE_STAGE_LIMITS,
): BudgetCounterEstimate | undefined {
  const roleCosts: BudgetCounterEstimate["roleCosts"] = [];
  for (const role of BUDGET_RESERVE_ROLES) {
    const limits = resolved?.[role];
    if (!estimateBearing(limits)) return undefined;
    roleCosts.push({ role, maxCostUsd: limits?.maxCostUsd as number });
  }
  const ceilingUsd = roleCosts.reduce((sum, row) => sum + (row.maxCostUsd as number), 0);
  const tier = complexity ?? "medium";
  const evidence = [
    "whole-task reserve = sum of the recorded per-role stage cost ceilings (docs/contracts/stage-limit-calibration.md; DEFAULT_ROLE_STAGE_LIMITS in src/cli/resolve-config.ts)",
    `reserve roles (built-in pipeline): ${BUDGET_RESERVE_ROLES.join(" -> ")}`,
    ...roleCosts.map((row) => `recorded ceiling ${row.role}:maxCostUsd=${row.maxCostUsd}`),
    "security is conditional on the plan; its ceiling is reserved, not yet committed",
    `route tier: ${tier} (pre-read classification; the built-in "medium" fallback when the dispatch states none)`,
    "one review round counted; review rework stays inside the code ceiling above",
  ];
  return { ceilingUsd, complexity: tier, evidence, roleCosts };
}

/**
 * The intake statement that only exists because a counter-estimate was
 * produced: every field the intake contract names is present, honest about
 * what has actually happened at this point (outcome and size not yet assessed;
 * ambiguity list empty because nothing was stated), and free of the task text.
 */
export function counterEstimatedStatement(
  estimate: BudgetCounterEstimate,
): import("./intake").IntakeStatement {
  return {
    outcome:
      "run the stated task under the counter-estimated whole-task budget recorded at the pre-work gate",
    scopeExclusions: [],
    mode: "auto",
    taskShape: {
      complexity: estimate.complexity,
      stage: "plan->[security]->code->review",
      sizeClass: "unknown",
    },
    budget: { ceilingUsd: estimate.ceilingUsd, source: "estimate" },
    ceilings: estimate.roleCosts.map(
      (row) => `roleStageLimits:${row.role}:maxCostUsd=${row.maxCostUsd}`,
    ),
    resultChangingAmbiguities: [],
  };
}
