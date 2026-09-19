/**
 * Unit tests for the machine-measured trivial-edit bound and its durable
 * record (issue #388).
 *
 * FAIL-FIRST VERIFIABILITY: these tests import
 * `../src/orchestration/trivial-edit` directly. That module does not exist on
 * origin/main (this slice creates it), so the suite cannot even load without
 * it -- `bun test test/trivial-edit.test.ts` fails with a module-not-found
 * before this slice and passes only with the new module. Nothing else in the
 * tree is touched by this slice.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ProjectStore } from "../src";
import {
  appendTrivialEditEntry,
  measureEditPatch,
  measureWritePatch,
  readTrivialEditRecord,
  settleTrivialEditCover,
  TRIVIAL_EDIT_MAX_ENTRIES,
  type TrivialEditEntry,
  type TrivialEditRecord,
  trivialEditRecordPath,
  uncoveredTotals,
  withinTrivialBound,
} from "../src/orchestration/trivial-edit";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** A tmp target directory with its own private store, per test. */
function store(): ProjectStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-trivial-"));
  roots.push(root);
  return new ProjectStore(root);
}

/** A minimal uncovered entry, overridden per test. */
function entry(overrides: Partial<TrivialEditEntry> = {}): TrivialEditEntry {
  return {
    ts: 1_700_000_000_000,
    tool: "edit",
    file: "src/a.ts",
    linesAdded: 1,
    linesRemoved: 0,
    cover: { status: "reviewer_unavailable" },
    covered: false,
    ...overrides,
  };
}

describe("measureEditPatch", () => {
  test("counts a 7-line newText as linesAdded 7 and sums across entries", () => {
    const shape = measureEditPatch([{ oldText: "one", newText: "1\n2\n3\n4\n5\n6\n7" }]);
    expect(shape).toEqual({ files: 1, linesAdded: 7, linesRemoved: 1 });
    const summed = measureEditPatch([
      { oldText: "a\nb", newText: "a\nb\nc" },
      { oldText: "d", newText: "e" },
    ]);
    expect(summed).toEqual({ files: 1, linesAdded: 4, linesRemoved: 3 });
  });

  test("ignores one trailing newline and counts an empty replacement as zero", () => {
    expect(measureEditPatch([{ oldText: "", newText: "a\nb\n" }]).linesAdded).toBe(2);
    expect(measureEditPatch([{ oldText: "a\nb", newText: "" }]).linesRemoved).toBe(2);
    expect(measureEditPatch([{ oldText: "x", newText: "\n" }]).linesAdded).toBe(1);
  });
});

describe("measureWritePatch", () => {
  test("a fresh file counts every line as added and removes nothing", () => {
    expect(measureWritePatch(undefined, "a\nb\nc")).toEqual({
      files: 1,
      linesAdded: 3,
      linesRemoved: 0,
    });
  });

  test("a replacement charges both sides, one trailing newline ignored", () => {
    expect(measureWritePatch("x\ny\n", "z")).toEqual({
      files: 1,
      linesAdded: 1,
      linesRemoved: 2,
    });
  });
});

describe("withinTrivialBound", () => {
  test("accepts five accumulated changed lines and refuses six", () => {
    expect(withinTrivialBound(3, 2, 1)).toBe(true);
    expect(withinTrivialBound(5, 0, 0)).toBe(true);
    expect(withinTrivialBound(6, 0, 0)).toBe(false);
    expect(withinTrivialBound(3, 3, 1)).toBe(false);
  });
});

describe("trivialEditRecordPath", () => {
  test("is relative to the target directory under the store's private root", () => {
    expect(trivialEditRecordPath("run_trivial")).toBe(
      path.join(".ad-coder", "runs", "trivial-edits", "run_trivial.json"),
    );
  });
});

describe("record store", () => {
  test("reads an absent record as empty and caps entries, dropping the oldest", () => {
    const target = store();
    const runId = "run_cap";
    expect(readTrivialEditRecord(target, runId)).toEqual({ schemaVersion: 1, entries: [] });

    for (let index = 0; index < TRIVIAL_EDIT_MAX_ENTRIES + 5; index += 1) {
      appendTrivialEditEntry(target, runId, entry({ file: `src/${index}.ts` }));
    }
    const record = readTrivialEditRecord(target, runId);
    expect(record.entries.length).toBe(TRIVIAL_EDIT_MAX_ENTRIES);
    expect(record.entries[0]?.file).toBe("src/5.ts");
    expect(record.entries.at(-1)?.file).toBe(`src/${TRIVIAL_EDIT_MAX_ENTRIES + 4}.ts`);
  });

  test("settle approved covers every uncovered entry and resets the window", () => {
    const target = store();
    const runId = "run_settle";
    appendTrivialEditEntry(
      target,
      runId,
      entry({ file: "src/a.ts", linesAdded: 2, linesRemoved: 1 }),
    );
    appendTrivialEditEntry(target, runId, entry({ file: "src/b.ts", linesAdded: 1 }));
    expect(uncoveredTotals(readTrivialEditRecord(target, runId))).toEqual({
      lines: 4,
      files: 2,
      entries: 2,
    });

    settleTrivialEditCover(target, runId, {
      verdict: "approved",
      reviewerRunId: "run_reviewer",
    });

    const settled = readTrivialEditRecord(target, runId);
    expect(uncoveredTotals(settled)).toEqual({ lines: 0, files: 0, entries: 0 });
    for (const item of settled.entries) {
      expect(item.covered).toBe(true);
      expect(item.cover).toEqual({
        status: "reviewed",
        reviewerRunId: "run_reviewer",
        verdict: "approved",
      });
    }

    // A subsequent one-line edit opens a fresh window of its own.
    appendTrivialEditEntry(target, runId, entry({ file: "src/a.ts", linesAdded: 1 }));
    expect(uncoveredTotals(readTrivialEditRecord(target, runId))).toEqual({
      lines: 1,
      files: 1,
      entries: 1,
    });
  });

  test("settle changes_requested records the verdict and keeps entries uncovered", () => {
    const target = store();
    const runId = "run_settle_changes";
    appendTrivialEditEntry(target, runId, entry({ file: "src/a.ts", linesAdded: 2 }));

    settleTrivialEditCover(target, runId, {
      verdict: "changes_requested",
      reviewerRunId: "run_reviewer",
      issueCount: 2,
    });

    const record = readTrivialEditRecord(target, runId);
    expect(record.entries.length).toBe(1);
    const item = record.entries[0];
    expect(item?.covered).toBe(false);
    expect(item?.cover).toEqual({
      status: "reviewed",
      reviewerRunId: "run_reviewer",
      verdict: "changes_requested",
      issueCount: 2,
    });
    expect(uncoveredTotals(record)).toEqual({ lines: 2, files: 1, entries: 1 });
  });

  test("settling an absent record is a no-op that creates no state", () => {
    const target = store();
    const runId = "run_absent";
    settleTrivialEditCover(target, runId, {
      verdict: "approved",
      reviewerRunId: "run_reviewer",
    });
    expect(fs.existsSync(path.join(target.layout.targetDir, trivialEditRecordPath(runId)))).toBe(
      false,
    );
  });

  test("an unsupported schemaVersion throws instead of failing open", () => {
    const target = store();
    const runId = "run_bad_schema";
    const file = path.join(target.layout.targetDir, trivialEditRecordPath(runId));
    target.mutateVersionedJson(
      file,
      () => ({ schemaVersion: 2, entries: [] }) as unknown as TrivialEditRecord,
    );
    expect(() => readTrivialEditRecord(target, runId)).toThrow(
      "trivial edit record: unsupported schemaVersion 2",
    );
  });

  test("appending refuses to silently extend an unsupported schemaVersion record", () => {
    const target = store();
    const runId = "run_bad_schema_append";
    const file = path.join(target.layout.targetDir, trivialEditRecordPath(runId));
    target.mutateVersionedJson(
      file,
      () => ({ schemaVersion: 2, entries: [] }) as unknown as TrivialEditRecord,
    );
    expect(() => appendTrivialEditEntry(target, runId, entry())).toThrow(
      "trivial edit record: unsupported schemaVersion 2",
    );
  });
});

describe("uncoveredTotals", () => {
  test("sums only uncovered entries and counts distinct files", () => {
    const record: TrivialEditRecord = {
      schemaVersion: 1,
      entries: [
        entry({ file: "src/a.ts", linesAdded: 2, linesRemoved: 1 }),
        entry({ file: "src/a.ts", linesAdded: 1, linesRemoved: 0 }),
        entry({ file: "src/b.ts", linesAdded: 1, linesRemoved: 1 }),
        entry({ file: "src/c.ts", linesAdded: 5, linesRemoved: 0, covered: true }),
      ],
    };
    expect(uncoveredTotals(record)).toEqual({ lines: 6, files: 2, entries: 3 });
  });
});
