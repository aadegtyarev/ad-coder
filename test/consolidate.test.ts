import { expect, test } from "bun:test";
import type { BacklogFollowUp, FollowUp, NoteFollowUp } from "../src";
import { consolidateFollowUps } from "../src/project-operations/consolidate";
import { validateFollowUp } from "../src/project-operations/follow-ups";

function backlog(overrides: Partial<BacklogFollowUp> = {}): BacklogFollowUp {
  return {
    kind: "backlog",
    title: "Repair claim handling",
    evidence: [{ summary: "Claim race observed", path: "src/work.ts", line: 4 }],
    provenance: [{ producer: "reviewer", runId: "run-1", branch: "feature/ops" }],
    priority: "high",
    ...overrides,
  };
}

function note(overrides: Partial<NoteFollowUp> = {}): NoteFollowUp {
  return {
    kind: "note",
    title: "Record claim flow",
    evidence: [{ summary: "Observed mismatch", path: "src/work.ts" }],
    provenance: [{ producer: "reviewer", runId: "run-1" }],
    ...overrides,
  };
}

test("three adjacent small same-destination follow-ups consolidate into one unioned item", () => {
  const first = backlog({
    title: "Fix claim race",
    evidence: [{ summary: "A", path: "src/a.ts" }],
    provenance: [{ producer: "reviewer", runId: "run-1" }],
  });
  const second = backlog({
    title: "Guard claim lease",
    evidence: [{ summary: "B", path: "src/b.ts" }],
    provenance: [{ producer: "security", runId: "run-2" }],
  });
  const third = backlog({
    title: "Document claim flow",
    evidence: [{ summary: "C", path: "src/c.ts" }],
    provenance: [{ producer: "reviewer", runId: "run-1" }],
  });

  const result = consolidateFollowUps([first, second, third]);
  expect(result).toHaveLength(1);
  const merged = result[0]!;
  expect(merged.kind).toBe("backlog");
  if (merged.kind !== "backlog") throw new Error("expected a backlog follow-up");
  expect(merged.priority).toBe("high");
  expect(merged.evidence.map((entry) => entry.summary)).toEqual(["A", "B", "C"]);
  expect(merged.provenance.map((entry) => entry.producer).sort()).toEqual(["reviewer", "security"]);
  expect(merged.title).toContain("Consolidated 3 backlog follow-ups");
  expect(merged.title).toContain("Fix claim race");
  expect(merged.title).toContain("Guard claim lease");
  expect(merged.title).toContain("Document claim flow");
});

test("different destinations or kinds are left untouched", () => {
  const high = backlog({
    title: "High priority item",
    evidence: [{ summary: "A", path: "src/a.ts" }],
  });
  const medium = backlog({
    title: "Medium priority item",
    evidence: [{ summary: "B", path: "src/b.ts" }],
    priority: "medium",
  });
  const byPriority = consolidateFollowUps([high, medium]);
  expect(byPriority).toHaveLength(2);

  const asNote = note({
    title: "Same directory note",
    evidence: [{ summary: "N", path: "src/n.ts" }],
  });
  const byKind = consolidateFollowUps([high, asNote]);
  expect(byKind).toHaveLength(2);
});

test("a group of six stays untouched because it exceeds the cap of five", () => {
  const members = Array.from({ length: 6 }, (_, index) =>
    backlog({
      title: `Claim item ${index}`,
      evidence: [{ summary: `E${index}`, path: `src/item-${index}.ts` }],
    }),
  );
  const result = consolidateFollowUps(members);
  expect(result).toHaveLength(6);
  expect(new Set(result.map((item) => item.title)).size).toBe(6);
});

test("one member with three distinct evidence paths keeps the whole group untouched", () => {
  const cleanA = backlog({
    title: "Clean A",
    evidence: [{ summary: "A", path: "src/a.ts" }],
  });
  const cleanB = backlog({
    title: "Clean B",
    evidence: [{ summary: "B", path: "src/b.ts" }],
  });
  const threePaths = backlog({
    title: "Three paths",
    evidence: [
      { summary: "X", path: "src/x.ts" },
      { summary: "Y", path: "src/y.ts" },
      { summary: "Z", path: "src/z.ts" },
    ],
  });
  const result = consolidateFollowUps([cleanA, cleanB, threePaths]);
  expect(result).toHaveLength(3);
  expect(new Set(result.map((item) => item.title)).size).toBe(3);
});

test("the merged item satisfies validateFollowUp unchanged", () => {
  const members = [
    backlog({
      title: "Fix claim race",
      evidence: [{ summary: "A", path: "src/a.ts" }],
      provenance: [{ producer: "reviewer", runId: "run-1" }],
    }),
    backlog({
      title: "Guard claim lease",
      evidence: [{ summary: "B", path: "src/b.ts" }],
      provenance: [{ producer: "security", runId: "run-2" }],
    }),
  ];
  const result = consolidateFollowUps(members);
  expect(result).toHaveLength(1);
  expect(() => validateFollowUp(result[0])).not.toThrow();
  expect(validateFollowUp(result[0])).toMatchObject({ kind: "backlog", priority: "high" });
});

test("output order is deterministic and the input array is not mutated", () => {
  const members: FollowUp[] = [
    backlog({
      title: "Zebra",
      evidence: [{ summary: "Z", path: "src/z.ts" }],
      provenance: [{ producer: "reviewer", runId: "run-z" }],
    }),
    backlog({
      title: "Alpha",
      evidence: [{ summary: "A", path: "src/a.ts" }],
      provenance: [{ producer: "security", runId: "run-a" }],
    }),
    backlog({
      title: "Middle",
      evidence: [{ summary: "M", path: "src/m.ts" }],
      provenance: [{ producer: "coder", runId: "run-m" }],
    }),
  ];
  const before = structuredClone(members);
  const first = consolidateFollowUps(members);
  const second = consolidateFollowUps(members);
  expect(first).toEqual(second);
  expect(members).toEqual(before);
  expect(first).toHaveLength(1);
});

test("a group whose merged evidence exceeds a positive evidenceLimit stays unconsolidated", () => {
  const first = backlog({
    title: "Fix claim race",
    evidence: [{ summary: "First evidence entry for the claim race", path: "src/a.ts" }],
    provenance: [{ producer: "reviewer", runId: "run-1" }],
  });
  const second = backlog({
    title: "Guard claim lease",
    evidence: [{ summary: "Second evidence entry for the claim lease", path: "src/b.ts" }],
    provenance: [{ producer: "security", runId: "run-2" }],
  });

  const mergedEvidence = [...first.evidence, ...second.evidence].sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b)),
  );
  const tightLimit = Buffer.byteLength(JSON.stringify(mergedEvidence)) - 1;

  const result = consolidateFollowUps([first, second], { evidenceLimit: tightLimit });
  expect(result).toHaveLength(2);
  expect(new Set(result.map((item) => item.title)).size).toBe(2);
});

test("the same group merges when the evidenceLimit is generous", () => {
  const first = backlog({
    title: "Fix claim race",
    evidence: [{ summary: "First evidence entry for the claim race", path: "src/a.ts" }],
    provenance: [{ producer: "reviewer", runId: "run-1" }],
  });
  const second = backlog({
    title: "Guard claim lease",
    evidence: [{ summary: "Second evidence entry for the claim lease", path: "src/b.ts" }],
    provenance: [{ producer: "security", runId: "run-2" }],
  });

  const result = consolidateFollowUps([first, second], { evidenceLimit: 10_000 });
  expect(result).toHaveLength(1);
  const merged = result[0]!;
  expect(merged.evidence).toHaveLength(2);
  expect(() => validateFollowUp(merged, { evidenceLimit: 10_000 })).not.toThrow();
});
