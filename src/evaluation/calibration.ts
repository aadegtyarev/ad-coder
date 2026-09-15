import type { LedgerRecord } from "../ledger/types";

export type CalibrationMode = "role" | "manual-workflow" | "automatic-pipeline";

export interface CalibrationTask {
  id: string;
  role: string;
  complexity: "trivial" | "medium" | "complex";
  mode: CalibrationMode;
  prompt: string;
  checks: Array<{ id: string; weight: number }>;
  /**
   * Which LEDGER roles count as the work this task measures.
   *
   * `role` is the task's dispatch label, and for a pipeline task it is the
   * synthetic string `"pipeline"` -- no ledger row ever carries it, because a
   * pipeline's rows are stamped with the worker that took the turn (`coder`,
   * `reviewer`, ...). Matching `model` on `role` alone therefore reported
   * `null` for exactly the multi-role runs the attribution was built for. A
   * pipeline task names its measured workers here; a single-role task omits
   * this and falls back to `role`, which its ledger rows do carry.
   */
  measuredRoles?: string[];
}

export interface CalibrationCheckResult {
  id: string;
  passed: boolean;
  detail?: string;
}

/** One (role, model) pair the run actually used, with the work it did. */
export interface CalibrationModelShare {
  role: string;
  /**
   * The provider that served this model, from the ledger row.
   *
   * A model name alone does not identify what ran. The same name behind two
   * providers can be a different quantization, a different context ceiling and a
   * different set of supported thinking levels -- `docs/provider-catalogs.md`
   * records `deepseek-v4-pro` accepting `low` on opencode-go and marked
   * unsupported on openrouter, same vendor, same name. A measurement published
   * without it invites a reader to carry a score to a host where it does not
   * hold.
   */
  provider: string;
  model: string;
  modelTurns: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface CalibrationMeasurement {
  taskId: string;
  inventory: string;
  /**
   * The model that ran the task's MEASURED role (see
   * `CalibrationTask.measuredRoles`), or `null` when no ledger row carries one.
   *
   * It used to be `ledger[0].model` -- whoever happened to take the first turn
   * -- which labelled an eight-turn pipeline with its planner's model and made
   * every cross-model comparison of a multi-role run meaningless. `models`
   * carries the full breakdown; this field only names the role under test.
   */
  model: string | null;
  /**
   * The provider that served `model`, or `null` when no ledger row carries the
   * measured role. Recorded for the same reason as `CalibrationModelShare.provider`.
   */
  provider: string | null;
  /** Every (role, provider, model) triple the run used, ordered by cost, highest first. */
  models: CalibrationModelShare[];
  thinkingLevel: string;
  role: string;
  complexity: CalibrationTask["complexity"];
  mode: CalibrationMode;
  accepted: boolean;
  quality: number;
  durationMs: number;
  modelTurns: number;
  toolTurns: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costUsd: number;
  repairs: number;
  escapedDefects: number;
  orchestratorComplexity: CalibrationTask["complexity"] | null;
  plannerComplexity: CalibrationTask["complexity"] | null;
  complexityCorrect: boolean | null;
  plannerAgreement: boolean | null;
  costEfficiency: number | null;
}

/**
 * The ledger roles a task measures: its explicit `measuredRoles`, or its
 * dispatch `role` when it is itself a ledger role. Throws on a declared but
 * unusable list rather than silently falling back -- a typo there would
 * reinstate the silent `model: null` this field exists to prevent.
 */
export function measuredRolesOf(task: CalibrationTask): string[] {
  if (task.measuredRoles === undefined) return [task.role];
  if (
    !Array.isArray(task.measuredRoles) ||
    task.measuredRoles.length === 0 ||
    task.measuredRoles.some((role) => typeof role !== "string" || role.trim() === "")
  )
    throw new Error(`calibration task ${task.id} has invalid measuredRoles`);
  return task.measuredRoles;
}

export function scoreCalibrationRun(input: {
  task: CalibrationTask;
  checks: CalibrationCheckResult[];
  ledger: readonly LedgerRecord[];
  inventory: string;
  thinkingLevel: string;
  durationMs: number;
  toolTurns?: number;
  repairs?: number;
  escapedDefects?: number;
  orchestratorComplexity?: CalibrationTask["complexity"];
  plannerComplexity?: CalibrationTask["complexity"];
}): CalibrationMeasurement {
  if (!Number.isFinite(input.durationMs) || input.durationMs < 0)
    throw new Error("durationMs must be a non-negative number");
  const expected = new Map(input.task.checks.map((check) => [check.id, check.weight]));
  if (expected.size !== input.task.checks.length || [...expected.values()].some((w) => w <= 0))
    throw new Error(`calibration task ${input.task.id} has invalid checks`);
  const actual = new Map(input.checks.map((check) => [check.id, check.passed]));
  if (actual.size !== input.checks.length || input.checks.some((check) => !expected.has(check.id)))
    throw new Error(`calibration result for ${input.task.id} has unknown or duplicate checks`);
  const totalWeight = [...expected.values()].reduce((sum, weight) => sum + weight, 0);
  const passedWeight = [...expected].reduce(
    (sum, [id, weight]) => sum + (actual.get(id) === true ? weight : 0),
    0,
  );
  const quality = passedWeight / totalWeight;
  const usage = input.ledger.reduce(
    (sum, row) => ({
      input: sum.input + row.usage.input,
      cacheRead: sum.cacheRead + row.usage.cacheRead,
      cacheWrite: sum.cacheWrite + row.usage.cacheWrite,
      output: sum.output + row.usage.output,
      reasoning: sum.reasoning + (row.usage.reasoning ?? 0),
      cost: sum.cost + row.usage.cost.total,
      toolTurns:
        sum.toolTurns + Object.values(row.toolCalls ?? {}).reduce((n, count) => n + count, 0),
    }),
    { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, cost: 0, toolTurns: 0 },
  );
  const accepted = quality === 1 && (input.escapedDefects ?? 0) === 0;
  const shares = new Map<string, CalibrationModelShare>();
  for (const row of input.ledger) {
    const key = `${row.role}\u0000${row.provider}\u0000${row.model}`;
    const share = shares.get(key) ?? {
      role: row.role,
      provider: row.provider,
      model: row.model,
      modelTurns: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
    share.modelTurns += 1;
    share.inputTokens += row.usage.input;
    share.outputTokens += row.usage.output;
    share.costUsd += row.usage.cost.total;
    shares.set(key, share);
  }
  const models = [...shares.values()].sort((left, right) => right.costUsd - left.costUsd);
  // The measured roles are what the task claims to measure -- `measuredRoles`
  // when the dispatch label is not itself a ledger role (pipeline tasks), the
  // label otherwise. A delegated role's rows carry a `role:<name>` step, so the
  // plain role name is the one under test; ties go to the most turns, then to
  // the highest cost, so the pick is stable when two measured roles tie.
  const measured = new Set(measuredRolesOf(input.task));
  const declared = models
    .filter((share) => measured.has(share.role))
    .sort((left, right) => right.modelTurns - left.modelTurns || right.costUsd - left.costUsd)[0];
  return {
    taskId: input.task.id,
    inventory: input.inventory,
    model: declared?.model ?? null,
    provider: declared?.provider ?? null,
    models,
    thinkingLevel: input.thinkingLevel,
    role: input.task.role,
    complexity: input.task.complexity,
    mode: input.task.mode,
    accepted,
    quality,
    durationMs: input.durationMs,
    modelTurns: input.ledger.length,
    toolTurns: input.toolTurns ?? usage.toolTurns,
    inputTokens: usage.input,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    outputTokens: usage.output,
    reasoningTokens: usage.reasoning,
    costUsd: usage.cost,
    repairs: input.repairs ?? 0,
    escapedDefects: input.escapedDefects ?? 0,
    orchestratorComplexity: input.orchestratorComplexity ?? null,
    plannerComplexity: input.plannerComplexity ?? null,
    complexityCorrect:
      input.orchestratorComplexity === undefined
        ? null
        : input.orchestratorComplexity === input.task.complexity,
    plannerAgreement:
      input.orchestratorComplexity === undefined || input.plannerComplexity === undefined
        ? null
        : input.orchestratorComplexity === input.plannerComplexity,
    costEfficiency: usage.cost > 0 ? quality / usage.cost : null,
  };
}

export function compareCalibrationRuns(samples: readonly CalibrationMeasurement[]) {
  return [...samples].sort((left, right) => {
    if (left.accepted !== right.accepted) return left.accepted ? -1 : 1;
    if (left.quality !== right.quality) return right.quality - left.quality;
    if (left.costUsd !== right.costUsd) return left.costUsd - right.costUsd;
    return left.durationMs - right.durationMs;
  });
}
