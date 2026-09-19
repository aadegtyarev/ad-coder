/**
 * The machine-measured bound on the orchestrator's `trivial` direct-edit
 * exception, plus the durable record of what those edits covered (issue #388).
 *
 * WHY THIS MODULE EXISTS. The `trivial` exception let the orchestrator edit a
 * file directly without reviewer cover, bounded only by the orchestrator's own
 * judgment of what "trivial" means -- unbounded and self-granted. The
 * operator's 2026-09-19 rule draws the line from outside instead: "one line, a
 * typo, a rename's fallout". This module makes that line machine-measured: a
 * trivial edit touches at most ONE file and at most FIVE changed lines
 * (added + removed), measured from the patch BEFORE it applies, accumulated
 * across uncovered edits until a reviewer approves.
 *
 * This module owns only the arithmetic and the durable record helpers. The
 * guard that calls them owns the entry list and therefore the
 * one-uncovered-file rule; a later slice wires the guard.
 */
import * as path from "node:path";
import {
  type AgentHarnessTool,
  type ExecutionEnv,
  type ExecutionToolContext,
  TODO_CONTEXT,
} from "@earendil-works/pi-agent-core";
import type { ProjectStore } from "../project-store/project-store";
import type { VersionedState } from "../project-store/types";
import { ProjectStoreError } from "../project-store/types";

/**
 * At most ONE file per trivial-edit window. A frozen constant, not a
 * configurable: the operator's 2026-09-19 rule ("one line, a typo, a rename's
 * fallout") is bounded by the machine, never by the orchestrator's own
 * judgment (issue #388). Enforced by the guard, which owns the entry list and
 * the file names; the arithmetic below never sees a file name.
 */
export const TRIVIAL_EDIT_MAX_FILES = 1;

/**
 * At most FIVE changed lines (added + removed), accumulated across uncovered
 * edits until a reviewer approves. A frozen constant, not a configurable: the
 * operator's 2026-09-19 rule ("one line, a typo, a rename's fallout") is
 * bounded by the machine, never by the orchestrator's own judgment (issue
 * #388).
 */
export const TRIVIAL_EDIT_MAX_CHANGED_LINES = 5;

/** The breadth of one measured patch: one file, and the lines it changes. */
export interface TrivialEditPatchShape {
  /** Always 1: the edit and write tools are single-file. */
  files: number;
  linesAdded: number;
  linesRemoved: number;
}

/**
 * Lines in a replacement text. EXACT ARITHMETIC (issue #388): a line is a
 * "\n"-separated segment; an empty string is zero lines; ONE trailing "\n" is
 * a terminator, not an extra line -- "a\nb\n" and "a\nb" are both 2 lines,
 * while a second trailing newline still counts, because it renders as a blank
 * line.
 *
 * LIMITATION. This counts replacement breadth, not a semantic line diff: every
 * line of the matched old text plus every line of the new text is charged,
 * even where they are identical. Any line diff removes at most all lines of
 * the old text and adds at most all lines of the new text, so breadth is an
 * upper bound on the true diff and the bound is deliberately conservative:
 * over-counting refuses a change a semantic diff would allow, under-counting
 * never passes a change a semantic diff would refuse.
 */
function countLines(text: string): number {
  if (text.length === 0) return 0;
  const withoutTrailingNewline = text.endsWith("\n") ? text.slice(0, -1) : text;
  return withoutTrailingNewline.split("\n").length;
}

/**
 * Measure an edit-tool patch ({path, edits}) BEFORE it applies. The edit tool
 * is single-file, so `files` is always 1; the changed lines sum over the
 * entries -- each entry's `newText` breadth counts as added, its matched
 * `oldText` breadth as removed. Entries apply sequentially to the one file, so
 * overlapping regions double-charge: another over-count, never an under-count.
 */
export function measureEditPatch(
  edits: readonly { oldText: string; newText: string }[],
): TrivialEditPatchShape {
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const edit of edits) {
    linesAdded += countLines(edit.newText);
    linesRemoved += countLines(edit.oldText);
  }
  return { files: 1, linesAdded, linesRemoved };
}

/**
 * Measure a write-tool patch BEFORE it applies: one file, the whole new
 * content charged as added, the whole old content (when replacing an existing
 * file) charged as removed; a fresh file (oldContent undefined) removes
 * nothing. A whole-file rewrite charges the WHOLE file even for a
 * one-character change -- the deliberate conservatism of breadth measurement:
 * `write` on a file beyond the bound is never trivial and must take the
 * reviewed path.
 */
export function measureWritePatch(
  oldContent: string | undefined,
  newContent: string,
): TrivialEditPatchShape {
  return {
    files: 1,
    linesAdded: countLines(newContent),
    linesRemoved: oldContent === undefined ? 0 : countLines(oldContent),
  };
}

/**
 * Whether the accumulated line total still fits the trivial bound.
 *
 * `totalLinesAdded` + `totalLinesRemoved` is the current patch PLUS every
 * still-uncovered entry (the caller sums `uncoveredTotals(...).lines` and the
 * measured patch before calling). The bound is on the accumulation: two
 * uncovered 2-line edits leave one line of headroom, and a further 2-line edit
 * is refused until a reviewer approves.
 *
 * `_uncoveredEntries` -- the caller's open-window count -- is deliberately
 * unused here (hence the underscore): the ONE-uncovered-file rule it implies
 * is enforced by the guard, which owns the entry list and the file names. The
 * parameter documents that contract and keeps the guard's call shape
 * self-describing; this function owns the line arithmetic alone and cannot see
 * a second file.
 */
export function withinTrivialBound(
  totalLinesAdded: number,
  totalLinesRemoved: number,
  _uncoveredEntries: number,
): boolean {
  return totalLinesAdded + totalLinesRemoved <= TRIVIAL_EDIT_MAX_CHANGED_LINES;
}

/** Reviewer cover attached to one trivial edit, or why it has none yet. */
export interface TrivialEditCover {
  /** `reviewed` when a reviewer ran; otherwise why the edit is uncovered. */
  status: "reviewed" | "reviewer_unavailable" | "reviewer_failed";
  /** The reviewer run that produced the verdict, when one ran. */
  reviewerRunId?: string;
  /** The reviewer's verdict, when one ran. */
  verdict?: "approved" | "changes_requested";
  /** The number of issues the reviewer reported, when it did and counted. */
  issueCount?: number;
}

/** One trivial direct edit, awaiting or under reviewer cover. */
export interface TrivialEditEntry {
  /** Epoch ms when the edit was measured. */
  ts: number;
  /** Which single-file tool made the edit. */
  tool: "edit" | "write";
  /** The file, as the guard passed it (relative to the target directory). */
  file: string;
  linesAdded: number;
  linesRemoved: number;
  cover: TrivialEditCover;
  /** False until a reviewer approves; only uncovered entries stay in the window. */
  covered: boolean;
}

export interface TrivialEditRecord {
  schemaVersion: 1;
  entries: TrivialEditEntry[];
}

/**
 * Bounded like every capture that can accumulate (issue #388): the record
 * keeps at most this many entries, dropping the OLDEST when exceeded, so a
 * long run cannot grow the file without limit while the window still covers
 * the most recent trivial edits awaiting review.
 */
export const TRIVIAL_EDIT_MAX_ENTRIES = 50;

const TRIVIAL_EDIT_SCHEMA_VERSION = 1;

/** The project store's private root under the target directory (project-store.ts). */
const STORE_ROOT = ".ad-coder";

function emptyRecord(): TrivialEditRecord {
  return { schemaVersion: TRIVIAL_EDIT_SCHEMA_VERSION, entries: [] };
}

/**
 * The record's path RELATIVE to the target directory. `runId` is already
 * validated upstream as file-name-safe; this module re-validates nothing and
 * the callers join the path with the store's target directory.
 */
export function trivialEditRecordPath(runId: string): string {
  return path.join(STORE_ROOT, "runs", "trivial-edits", `${runId}.json`);
}

function trivialEditRecordFile(store: ProjectStore, runId: string): string {
  return path.join(store.layout.targetDir, trivialEditRecordPath(runId));
}

/**
 * The record's value, validated. Absent state is `undefined` (an empty record
 * is the caller's choice); a present record with an unsupported schemaVersion
 * is a HARD error, never a fail-open empty record (issue #388): a future or
 * corrupted schemaVersion means the accumulation window cannot be trusted,
 * and silently starting empty would grant the orchestrator a fresh full
 * allowance it has not earned.
 */
function validatedRecord(
  state: VersionedState<TrivialEditRecord> | undefined,
): TrivialEditRecord | undefined {
  if (state === undefined) return undefined;
  const schemaVersion = state.value?.schemaVersion;
  if (schemaVersion !== TRIVIAL_EDIT_SCHEMA_VERSION) {
    throw new Error(
      `trivial edit record: unsupported schemaVersion ${
        typeof schemaVersion === "number" ? schemaVersion : "missing"
      }`,
    );
  }
  return state.value;
}

/** The versioned state, with an absent file mapped to `undefined`. */
function readTrivialEditState(
  store: ProjectStore,
  runId: string,
): VersionedState<TrivialEditRecord> | undefined {
  try {
    return store.readVersionedJson<TrivialEditRecord>(trivialEditRecordFile(store, runId));
  } catch (error) {
    if (error instanceof ProjectStoreError && error.code === "not_found") return undefined;
    throw error;
  }
}

/**
 * Read the run's record. An absent file is an empty record (nothing uncovered
 * yet); an unsupported schemaVersion throws rather than failing open.
 */
export function readTrivialEditRecord(store: ProjectStore, runId: string): TrivialEditRecord {
  return validatedRecord(readTrivialEditState(store, runId)) ?? emptyRecord();
}

/**
 * The accumulation window's current weight, over UNCOVERED entries only
 * (covered entries were approved and left the window). `lines` is the
 * added+removed total the bound charges; `files` counts DISTINCT files, since
 * several uncovered entries may sit on one file; `entries` is the raw count.
 */
export function uncoveredTotals(record: TrivialEditRecord): {
  lines: number;
  files: number;
  entries: number;
} {
  const uncovered = record.entries.filter((entry) => !entry.covered);
  return {
    lines: uncovered.reduce((sum, entry) => sum + entry.linesAdded + entry.linesRemoved, 0),
    files: new Set(uncovered.map((entry) => entry.file)).size,
    entries: uncovered.length,
  };
}

/**
 * Append one measured trivial edit to the run's record, dropping the OLDEST
 * entries when the append would exceed TRIVIAL_EDIT_MAX_ENTRIES.
 */
export function appendTrivialEditEntry(
  store: ProjectStore,
  runId: string,
  entry: TrivialEditEntry,
): void {
  store.mutateVersionedJson<TrivialEditRecord>(trivialEditRecordFile(store, runId), (current) => {
    const record = validatedRecord(current) ?? emptyRecord();
    const entries = [...record.entries, entry];
    return {
      schemaVersion: TRIVIAL_EDIT_SCHEMA_VERSION,
      entries:
        entries.length > TRIVIAL_EDIT_MAX_ENTRIES
          ? entries.slice(entries.length - TRIVIAL_EDIT_MAX_ENTRIES)
          : entries,
    };
  });
}

/**
 * Apply a reviewer's verdict to every currently-uncovered entry of the run's
 * record. `approved` covers them (covered=true): the window resets and the
 * next edit starts a fresh accumulation. `changes_requested` records the
 * verdict and keeps the entries uncovered: the orchestrator may fix further,
 * and each fix's entry is re-covered by the next verdict. An absent record is
 * a true no-op -- nothing to settle, and no state created.
 */
export function settleTrivialEditCover(
  store: ProjectStore,
  runId: string,
  settle: {
    verdict: "approved" | "changes_requested";
    reviewerRunId: string;
    issueCount?: number;
  },
): void {
  // mutateVersionedJson cannot skip its write, so existence is checked first;
  // the mutation below re-reads under the store lock.
  if (readTrivialEditState(store, runId) === undefined) return;
  const cover: TrivialEditCover =
    settle.verdict === "approved"
      ? { status: "reviewed", reviewerRunId: settle.reviewerRunId, verdict: "approved" }
      : {
          status: "reviewed",
          reviewerRunId: settle.reviewerRunId,
          verdict: "changes_requested",
          ...(settle.issueCount === undefined ? {} : { issueCount: settle.issueCount }),
        };
  const covered = settle.verdict === "approved";
  store.mutateVersionedJson<TrivialEditRecord>(trivialEditRecordFile(store, runId), (current) => {
    const record = validatedRecord(current);
    // The existence check ran moments ago in the same process; if the record
    // vanished anyway, refuse rather than re-create it.
    if (record === undefined) throw new Error("trivial edit record: absent when settling");
    return {
      schemaVersion: TRIVIAL_EDIT_SCHEMA_VERSION,
      entries: record.entries.map((entry) =>
        entry.covered ? entry : { ...entry, cover, covered },
      ),
    };
  });
}

/** One single-file trivial change the guard measured, before it applied. */
export interface TrivialEditChange {
  tool: "edit" | "write";
  file: string;
  linesAdded: number;
  linesRemoved: number;
}

/** The reviewer's settled answer, handed back by the cover callback. */
export interface TrivialEditCoverSettle {
  verdict: "approved" | "changes_requested";
  reviewerRunId: string;
  issueCount?: number;
}

/**
 * The reviewer-cover seam the guard calls AFTER recording a successful edit.
 * An `undefined` return -- or an absent callback -- means no reviewer stage is
 * available for this run, and the entry stays uncovered with
 * `cover.status === "reviewer_unavailable"`. A throw means the reviewer stage
 * was reachable but failed to settle; the guard records
 * `reviewer_failed` and refuses to report success (issue #388).
 */
export type TrivialEditCoverFn = (
  change: TrivialEditChange,
  uncovered: { lines: number; files: number },
) => Promise<TrivialEditCoverSettle | undefined>;

/**
 * Pure wiring decision for the orchestrator: is the guard installed, and is a
 * reviewer reachable to cover it? (issue #388, #386).
 *
 * The guard exists only when the orchestrator can DELEGATE (`groups.length > 0`);
 * the orchestrator-only collapse (#386) edits directly with no bound and no
 * record. Reviewer cover is "available" when the guard is installed and
 * `reviewer` is NOT in `unreachable`: a profile that routes a coder but leaves
 * the reviewer unwritten resolves the seed fine (roles-only -- no pipeline
 * graph is built) and lands `reviewer` in `unreachable`, so the guard stands
 * down to `reviewer_unavailable` instead of wiring a cover that could only
 * fail. The resolver counts only real models as reachability -- the banner's
 * "unrouted" pseudo-group never makes a role reachable (2026-09-19).
 */
export function trivialEditGuardPlan(
  delegatedRoute:
    | { groups: readonly { roles: readonly string[] }[]; unreachable?: readonly string[] }
    | undefined,
): { guard: boolean; reviewerCover: boolean } {
  const guard = delegatedRoute !== undefined && delegatedRoute.groups.length > 0;
  const reviewerCover = guard && !(delegatedRoute?.unreachable ?? []).includes("reviewer");
  return { guard, reviewerCover };
}

/** The tools the guard wraps: only the single-file `edit` and `write` built-ins. */
const GUARDED_TOOL_NAMES = new Set(["edit", "write"]);

export interface TrivialEditGuardDeps {
  env: ExecutionEnv;
  store: ProjectStore;
  runId: string;
  cover?: TrivialEditCoverFn;
  now?: () => number;
}

/**
 * Read the file's PRE-apply content for measurement. An absent file is an
 * empty whole-file measurement for `write` (a fresh file removes nothing); for
 * `edit` the tool itself refuses a missing path, so the read is advisory
 * breadth arithmetic ahead of that refusal -- removed counts obey the spec
 * regardless (issue #388).
 */
async function readContentForMeasure(env: ExecutionEnv, file: string): Promise<string | undefined> {
  try {
    const absolute = await env.absolutePath(file, TODO_CONTEXT);
    if (!absolute.ok) return undefined;
    const read = await env.readTextFile(absolute.value, TODO_CONTEXT);
    if (!read.ok) return undefined;
    return read.value;
  } catch {
    return undefined;
  }
}

type EditToolInput = { path: string; edits: { oldText: string; newText: string }[] };
type WriteToolInput = { path: string; content: string };

/**
 * The machine-measured guard over the orchestrator's direct `edit`/`write`
 * (issue #388). It replaces ONLY those two built-ins in the passed array,
 * leaving `bash`/`read` (and any caller-supplied tool names) untouched.
 *
 * PER CALL, BEFORE the inner tool runs:
 *
 * 1. MEASURE the patch breadth from the file's current content, via
 *    `measureEditPatch`/`measureWritePatch`. The file is the call's path as
 *    given (bounded to the string; this module never resolves what the tool
 *    itself will do).
 * 2. BOUND against the accumulation window: the total changed lines may not
 *    exceed TRIVIAL_EDIT_MAX_CHANGED_LINES, and a second DISTINCT uncovered
 *    file is refused (the one-uncovered-file rule -- the guard owns the file
 *    names, which the arithmetic helpers deliberately cannot see). On refusal
 *    it THROWS before anything applies, naming measured vs bound counts and
 *    paths only -- never file contents (docs/contracts/errors.md).
 * 3. WITHIN bound: call the inner tool. A failure is rethrown unchanged and
 *    records NOTHING (no entry for a failed edit); success appends an entry
 *    with `cover.status` deferred to step 4.
 * 4. COVER: if a cover callback is present, call it; an `approved` verdict
 *    settles the window (accumulation resets), `changes_requested` records the
 *    verdict and keeps entries uncovered. A missing/`undefined`-returning
 *    callback leaves `reviewer_unavailable`; a throwing callback leaves
 *    `reviewer_failed` and the result text states plainly the cover could not
 *    settle -- the work is not closed without one (never fake success,
 *    docs/contracts/tool-observability truthfulness).
 *
 * The inner tool's own result stays intact apart from the appended cover line.
 */
export function createTrivialEditGuard(
  tools: readonly AgentHarnessTool<ExecutionToolContext>[],
  deps: TrivialEditGuardDeps,
): readonly AgentHarnessTool<ExecutionToolContext>[] {
  const guard = (
    inner: AgentHarnessTool<ExecutionToolContext>,
  ): AgentHarnessTool<ExecutionToolContext> => {
    const isEdit = inner.name === "edit";
    return {
      ...inner,
      async execute(toolCallId, rawInput, onUpdate, toolContext, invocation, context) {
        const now = deps.now ?? Date.now;
        const input = rawInput as unknown as EditToolInput | WriteToolInput;
        const file = input.path;
        const oldContent = await readContentForMeasure(deps.env, file);
        const shape = isEdit
          ? measureEditPatch((input as EditToolInput).edits)
          : measureWritePatch(oldContent, (input as WriteToolInput).content);

        const record = readTrivialEditRecord(deps.store, deps.runId);
        const totals = uncoveredTotals(record);
        const totalLines = totals.lines + shape.linesAdded + shape.linesRemoved;

        // ONE-uncovered-file rule (issue #388): the file must already be in the
        // window, or the window must be empty. A DIFFERENT file while one is
        // uncovered is a second uncovered file, over bound regardless of lines.
        const fileAlreadyUncovered = record.entries.some(
          (entry) => !entry.covered && entry.file === file,
        );
        const newFile = totals.files >= 1 && !fileAlreadyUncovered;
        if (newFile || totalLines > TRIVIAL_EDIT_MAX_CHANGED_LINES) {
          throw new Error(
            `trivial edit bound exceeded: measured +${shape.linesAdded}/-${shape.linesRemoved} lines on ${file}, accumulated uncovered ${totals.files} file(s)/${totals.lines} line(s), bound is 1 file / 5 changed lines -- delegate the change to a coder (run_role or a pipeline) instead`,
          );
        }

        // The inner tool applies the edit. A failure is rethrown unchanged and
        // records NOTHING (no entry for a failed edit).
        const result = await inner.execute(
          toolCallId,
          rawInput,
          onUpdate,
          toolContext,
          invocation,
          context,
        );

        const change: TrivialEditChange = {
          tool: isEdit ? "edit" : "write",
          file,
          linesAdded: shape.linesAdded,
          linesRemoved: shape.linesRemoved,
        };

        // The "updated uncovered totals" the cover callback sees = the window
        // SO FAR plus this change, before any settle (compute, don't append,
        // so one entry is recorded exactly once).
        const uncoveredBefore = {
          lines: totals.lines + shape.linesAdded + shape.linesRemoved,
          files: totals.files === 0 ? 1 : totals.files,
        };

        type Outcome =
          | { kind: "unavailable" }
          | { kind: "failed" }
          | { kind: "approved"; reviewerRunId: string }
          | { kind: "changes"; reviewerRunId: string; issueCount?: number };
        let outcome: Outcome;
        if (deps.cover === undefined) {
          outcome = { kind: "unavailable" };
        } else {
          try {
            const settle = await deps.cover(change, uncoveredBefore);
            if (settle === undefined) outcome = { kind: "unavailable" };
            else if (settle.verdict === "approved")
              outcome = { kind: "approved", reviewerRunId: settle.reviewerRunId };
            else
              outcome = {
                kind: "changes",
                reviewerRunId: settle.reviewerRunId,
                ...(settle.issueCount === undefined ? {} : { issueCount: settle.issueCount }),
              };
          } catch {
            outcome = { kind: "failed" };
          }
        }

        const entryBase = {
          ts: now(),
          tool: change.tool,
          file,
          linesAdded: shape.linesAdded,
          linesRemoved: shape.linesRemoved,
        };
        let coverLine: string;
        if (outcome.kind === "approved") {
          appendTrivialEditEntry(deps.store, deps.runId, {
            ...entryBase,
            cover: {
              status: "reviewed",
              reviewerRunId: outcome.reviewerRunId,
              verdict: "approved",
            },
            covered: false,
          });
          // Covers this entry AND every prior uncovered entry: the window resets.
          settleTrivialEditCover(deps.store, deps.runId, {
            verdict: "approved",
            reviewerRunId: outcome.reviewerRunId,
          });
          coverLine = `trivial-edit cover: approved by reviewer ${outcome.reviewerRunId.slice(0, 8)}`;
        } else if (outcome.kind === "changes") {
          appendTrivialEditEntry(deps.store, deps.runId, {
            ...entryBase,
            cover: {
              status: "reviewed",
              reviewerRunId: outcome.reviewerRunId,
              verdict: "changes_requested",
              ...(outcome.issueCount === undefined ? {} : { issueCount: outcome.issueCount }),
            },
            covered: false,
          });
          settleTrivialEditCover(deps.store, deps.runId, {
            verdict: "changes_requested",
            reviewerRunId: outcome.reviewerRunId,
            ...(outcome.issueCount === undefined ? {} : { issueCount: outcome.issueCount }),
          });
          coverLine =
            outcome.issueCount === undefined
              ? "trivial-edit cover: reviewer requested changes -- fix further (each fix is re-covered) or delegate"
              : `trivial-edit cover: reviewer reported ${outcome.issueCount} issue(s) -- fix further (each fix is re-covered) or delegate`;
        } else if (outcome.kind === "failed") {
          appendTrivialEditEntry(deps.store, deps.runId, {
            ...entryBase,
            cover: { status: "reviewer_failed" },
            covered: false,
          });
          coverLine =
            "trivial-edit cover: reviewer cover could NOT settle -- the work may not be considered closed without one";
        } else {
          appendTrivialEditEntry(deps.store, deps.runId, {
            ...entryBase,
            cover: { status: "reviewer_unavailable" },
            covered: false,
          });
          coverLine =
            "trivial-edit cover: no reviewer stage available -- this edit is recorded but not yet covered";
        }

        return {
          ...result,
          content: [...result.content, { type: "text", text: coverLine } as const],
        };
      },
    };
  };

  return tools.map((tool) => (GUARDED_TOOL_NAMES.has(tool.name) ? guard(tool) : tool));
}
