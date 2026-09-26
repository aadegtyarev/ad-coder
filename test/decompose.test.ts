import { expect, test } from "bun:test";
import type { DurableRunRecord } from "../src/orchestration/control-plane";
import { deriveChildSpecs, MAX_DERIVED_CHILDREN } from "../src/orchestration/decompose";
import type { PipelineResult, Verdict } from "../src/orchestration/types";

const scope = { allowedPaths: ["src"], allowedCapabilities: ["edit"], externalEffects: [] };

function makeRecord(verdicts: Verdict[]): DurableRunRecord {
  return {
    schemaVersion: 1,
    id: "run-1",
    requestKey: "decompose",
    task: "root",
    mode: "auto",
    status: "running",
    depth: 0,
    rootRunId: "run-1",
    childRunIds: [],
    remainingChildren: [],
    scope,
    decisions: [],
    verdicts,
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
    cancelRequested: false,
    providerTurnInFlight: false,
    eventSequence: 0,
    events: [],
  };
}

function makeResult(overrides: Partial<PipelineResult> = {}): PipelineResult {
  return {
    outcome: "decomposition_required",
    approved: false,
    rounds: 1,
    verdicts: [],
    runIds: [],
    stageMetrics: [],
    ...overrides,
  };
}

const blockingEscalation = {
  required: true as const,
  reason: "blocking_verdicts" as const,
  blockingVerdicts: 1,
};

test("derives one trimmed spec per blocker/major issue, keeping verdict order and record scope", () => {
  const rec = makeRecord([
    {
      status: "changes_requested",
      issues: [
        { severity: "blocker", what: "  split the module  " },
        { severity: "major", what: "add tests" },
        { severity: "minor", what: "ignore this nit" },
      ],
      summary: "split",
    },
  ]);
  const specs = deriveChildSpecs(rec, makeResult({ escalation: blockingEscalation }));
  expect(specs).toEqual([
    { task: "split the module", ...scope },
    { task: "add tests", ...scope },
  ]);
  expect(specs[0]).not.toHaveProperty("parentDecisionId");
});

test("a scope key named `task` cannot overwrite the derived issue text", () => {
  const rec = makeRecord([
    {
      status: "changes_requested",
      issues: [{ severity: "blocker", what: "fix the real thing" }],
      summary: "block",
    },
  ]);
  // RunScope has no `task` field, so the hostile key is cast in at the boundary
  // it would arrive from: a persisted scope object carrying an extra property.
  rec.scope = {
    ...scope,
    task: "a task smuggled in through the scope",
  } as DurableRunRecord["scope"];
  const specs = deriveChildSpecs(rec, makeResult({ escalation: blockingEscalation }));
  expect(specs).toHaveLength(1);
  expect(specs[0]?.task).toBe("fix the real thing");
  expect(specs[0]?.allowedPaths).toEqual(scope.allowedPaths);
});

test("a verdict with only minor issues derives nothing", () => {
  const rec = makeRecord([
    {
      status: "changes_requested",
      issues: [{ severity: "minor", what: "nits" }],
      summary: "nits",
    },
  ]);
  expect(deriveChildSpecs(rec, makeResult({ escalation: blockingEscalation }))).toEqual([]);
});

test("a result without escalation derives nothing", () => {
  const rec = makeRecord([
    {
      status: "changes_requested",
      issues: [{ severity: "blocker", what: "must fix" }],
      summary: "block",
    },
  ]);
  expect(deriveChildSpecs(rec, makeResult())).toEqual([]);
});

test("a cap_exhausted escalation (required false) derives nothing", () => {
  // A bare round-cap hit names the limit without classifying the work, so the
  // decomposition lane must not turn its blocking verdict into child specs.
  const rec = makeRecord([
    {
      status: "changes_requested",
      issues: [{ severity: "blocker", what: "must fix" }],
      summary: "block",
    },
  ]);
  const capExhausted = makeResult({
    escalation: { required: false, reason: "cap_exhausted", blockingVerdicts: 1 },
  });
  expect(deriveChildSpecs(rec, capExhausted)).toEqual([]);
});

test("caps derived children at MAX_DERIVED_CHILDREN", () => {
  expect(MAX_DERIVED_CHILDREN).toBe(4);
  const rec = makeRecord([
    {
      status: "changes_requested",
      issues: Array.from({ length: 6 }, (_, i) => ({
        severity: "blocker" as const,
        what: `issue ${i}`,
      })),
      summary: "many",
    },
  ]);
  const specs = deriveChildSpecs(rec, makeResult({ escalation: blockingEscalation }));
  expect(specs).toHaveLength(4);
  expect(specs.map((spec) => spec.task)).toEqual(["issue 0", "issue 1", "issue 2", "issue 3"]);
});

test("several changes_requested verdicts: the LAST one supplies the issues", () => {
  const rec = makeRecord([
    {
      status: "changes_requested",
      issues: [{ severity: "blocker", what: "from the first verdict" }],
      summary: "first",
    },
    { status: "approved", issues: [], summary: "middle" },
    {
      status: "changes_requested",
      issues: [{ severity: "major", what: "from the last verdict" }],
      summary: "last",
    },
  ]);
  const specs = deriveChildSpecs(rec, makeResult({ escalation: blockingEscalation }));
  expect(specs.map((spec) => spec.task)).toEqual(["from the last verdict"]);
});

test("whitespace-only issues derive nothing and never consume a cap slot", () => {
  const blankOnly = makeRecord([
    {
      status: "changes_requested",
      issues: [{ severity: "blocker", what: "from an earlier verdict" }],
      summary: "earlier",
    },
    {
      status: "changes_requested",
      issues: [{ severity: "blocker", what: "  \n\t " }],
      summary: "last verdict is blank",
    },
  ]);
  expect(deriveChildSpecs(blankOnly, makeResult({ escalation: blockingEscalation }))).toEqual([]);

  const mixed = makeRecord([
    {
      status: "changes_requested",
      issues: [
        { severity: "blocker", what: "   " },
        { severity: "major", what: " usable fix " },
        { severity: "blocker", what: "\n" },
      ],
      summary: "one usable issue beside blank ones",
    },
  ]);
  expect(deriveChildSpecs(mixed, makeResult({ escalation: blockingEscalation }))).toEqual([
    { task: "usable fix", ...scope },
  ]);

  const blanksBeforeUsable = makeRecord([
    {
      status: "changes_requested",
      issues: [
        { severity: "blocker", what: " " },
        { severity: "blocker", what: "\t" },
        ...Array.from({ length: 5 }, (_, i) => ({
          severity: "blocker" as const,
          what: `issue ${i}`,
        })),
      ],
      summary: "blank issues precede the cap",
    },
  ]);
  expect(
    deriveChildSpecs(blanksBeforeUsable, makeResult({ escalation: blockingEscalation })).map(
      (spec) => spec.task,
    ),
  ).toEqual(["issue 0", "issue 1", "issue 2", "issue 3"]);
});
