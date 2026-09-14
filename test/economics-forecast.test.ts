import { expect, test } from "bun:test";
import { forecastCost, latestCreditBalance } from "ad-coder";

test("forecasts accepted samples only and maps a known provider-wide balance to credits", () => {
  const forecast = forecastCost(
    [
      { accepted: true, assignedComplexity: "medium", reportedCostUsd: 0.25 },
      { accepted: true, assignedComplexity: "medium", reportedCostUsd: 0.7 },
      { accepted: false, assignedComplexity: "medium", reportedCostUsd: 99 },
      { accepted: true, assignedComplexity: "trivial", reportedCostUsd: 0.01 },
    ],
    "medium",
    { creditBalance: 500, creditsPerUsd: 50 },
  );
  expect(forecast).toMatchObject({
    sampleCount: 2,
    confidence: "low",
    optimisticUsd: 0.25,
    expectedUsd: 0.25,
    adverseUsd: 0.7,
    expectedCredits: 13,
    budgetStatus: "fits_expected",
  });
});

test("selects the latest provider balance across model observations", () => {
  const profile = {
    version: 1 as const,
    inventories: [],
    calibratedRouting: [],
    subscriptionCapacityRanges: [],
    economicRecords: [
      {
        id: "one",
        observedAt: "2026-09-13T00:00:00.000Z",
        provider: "p",
        model: "a",
        kind: "credit_balance" as const,
        value: 500,
        unit: "credits",
        source: "manual-entry",
        confidence: "measured" as const,
      },
      {
        id: "two",
        observedAt: "2026-09-14T00:00:00.000Z",
        provider: "p",
        model: "b",
        kind: "credit_balance" as const,
        value: 300,
        unit: "credits",
        source: "manual-entry",
        confidence: "measured" as const,
      },
    ],
  };
  expect(latestCreditBalance(profile, "p")?.value).toBe(300);
});
