import type { Complexity } from "../orchestration/types";
import type { EconomicRecord, UserProfile } from "../user-profile/types";

export interface CalibrationCostSample {
  assignedComplexity?: Complexity;
  accepted?: boolean;
  reportedCostUsd?: number;
}

export interface CostForecast {
  sampleCount: number;
  confidence: "none" | "low" | "medium";
  optimisticUsd?: number;
  expectedUsd?: number;
  adverseUsd?: number;
  creditBalance?: number;
  creditsPerUsd?: number;
  optimisticCredits?: number;
  expectedCredits?: number;
  adverseCredits?: number;
  budgetStatus: "unknown" | "fits_expected" | "below_expected";
}

/** Latest provider-scoped balance; model is deliberately ignored because credits are account-wide. */
export function latestCreditBalance(
  profile: UserProfile,
  provider: string,
  unit = "credits",
): EconomicRecord | undefined {
  return profile.economicRecords
    .filter(
      (record) =>
        record.kind === "credit_balance" && record.provider === provider && record.unit === unit,
    )
    .reduce<EconomicRecord | undefined>(
      (latest, record) =>
        latest === undefined || record.observedAt >= latest.observedAt ? record : latest,
      undefined,
    );
}

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index] as number;
}

/**
 * A transparent empirical forecast: accepted samples of the requested complexity
 * only. It is deliberately not a promise and never fabricates a balance.
 */
export function forecastCost(
  samples: readonly CalibrationCostSample[],
  complexity: Complexity,
  options: { creditBalance?: number; creditsPerUsd?: number } = {},
): CostForecast {
  const costs = samples
    .filter(
      (sample) =>
        sample.accepted === true &&
        sample.assignedComplexity === complexity &&
        typeof sample.reportedCostUsd === "number" &&
        Number.isFinite(sample.reportedCostUsd) &&
        sample.reportedCostUsd >= 0,
    )
    .map((sample) => sample.reportedCostUsd as number)
    .sort((left, right) => left - right);
  if (costs.length === 0)
    return {
      sampleCount: 0,
      confidence: "none",
      budgetStatus: "unknown",
      ...(options.creditBalance !== undefined && { creditBalance: options.creditBalance }),
      ...(options.creditsPerUsd !== undefined && { creditsPerUsd: options.creditsPerUsd }),
    };
  const optimisticUsd = costs[0] as number;
  const expectedUsd = percentile(costs, 0.5);
  const adverseUsd = costs[costs.length - 1] as number;
  const creditsPerUsd = options.creditsPerUsd;
  const expectedCredits =
    creditsPerUsd === undefined ? undefined : Math.ceil(expectedUsd * creditsPerUsd);
  return {
    sampleCount: costs.length,
    confidence: costs.length < 5 ? "low" : "medium",
    optimisticUsd,
    expectedUsd,
    adverseUsd,
    ...(options.creditBalance !== undefined && { creditBalance: options.creditBalance }),
    ...(creditsPerUsd !== undefined && {
      creditsPerUsd,
      optimisticCredits: Math.ceil(optimisticUsd * creditsPerUsd),
      ...(expectedCredits !== undefined && { expectedCredits }),
      adverseCredits: Math.ceil(adverseUsd * creditsPerUsd),
    }),
    budgetStatus:
      options.creditBalance === undefined || expectedCredits === undefined
        ? "unknown"
        : options.creditBalance >= expectedCredits
          ? "fits_expected"
          : "below_expected",
  };
}
