import type { LedgerRecord } from "../ledger/types";

export type CalibrationMode = "role" | "manual-workflow" | "automatic-pipeline";

export interface CalibrationTask {
  id: string;
  role: string;
  complexity: "trivial" | "medium" | "complex";
  mode: CalibrationMode;
  prompt: string;
  checks: Array<{ id: string; weight: number }>;
}

export interface CalibrationCheckResult {
  id: string;
  passed: boolean;
  detail?: string;
}

/** One (role, model) pair the run actually used, with the work it did. */
export interface CalibrationModelShare {
  role: string;
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
   * The model that ran the task's DECLARED role, or `null` when no ledger row
   * carries that role.
   *
   * It used to be `ledger[0].model` -- whoever happened to take the first turn
   * -- which labelled an eight-turn pipeline with its planner's model and made
   * every cross-model comparison of a multi-role run meaningless. `models`
   * carries the full breakdown; this field only names the role under test.
   */
  model: string | null;
  /** Every (role, model) pair the run used, ordered by cost, highest first. */
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
    const key = `${row.role}\u0000${row.model}`;
    const share = shares.get(key) ?? {
      role: row.role,
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
  // The declared role is what the task claims to measure. A delegated role's
  // rows carry a `role:<name>` step, so the plain role name is the one under
  // test; ties inside it go to whichever model did the most turns.
  const declared = models
    .filter((share) => share.role === input.task.role)
    .sort((left, right) => right.modelTurns - left.modelTurns)[0];
  return {
    taskId: input.task.id,
    inventory: input.inventory,
    model: declared?.model ?? null,
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
