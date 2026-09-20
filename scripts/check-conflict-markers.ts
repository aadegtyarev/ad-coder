// Conflict-marker gate (issue #474). A rebase was resolved in CHANGELOG.md and
// the resolution left `<<<<<<<` / `=======` / `>>>>>>>` in the file; the tree
// was committed in that state and EVERY gate stayed green -- the marker text
// satisfies check:release's heading/version checks, check:docs has no marker
// rule, the test suite never reads those bytes, and stamp:check digests
// exactly the bytes that were committed. A mechanical slip a grep catches in
// milliseconds was caught only by a paid, non-deterministic review round. This
// gate is that grep, wired as a step in ci.yml and release.yml next to the
// other checks.
//
// The projection is the INDEX (`git grep --cached`): the tree that is about to
// be committed -- what a rebase resolution leaves behind, and the tree the
// ticket calls the `git ls-files` projection. One measured edge, stated
// because it shapes the gate: against an index still holding an UNRESOLVED
// (stage 1/2/3) entry, `git grep --cached` answers no matches with exit 1 --
// an in-flight conflict is rebase machinery's loud state to fail, not this
// gate's; the defect class here is the RESOLVED blob whose markers were
// staged, and that is a stage-0 entry, which is scanned.

import { spawnSync } from "node:child_process";

// The pattern the ticket asked for, kept verbatim: any line that OPENS with a
// conflict marker. Deliberately not narrowed to `^=======+$`: the narrower
// form still matches an 8-equals run, but an exact-line anchor would miss a
// separator line with trailing content -- `=======` followed by a leftover
// note or whitespace -- which is still a marker inside a real conflict
// region. The one legitimate shape the pattern could over-match -- a Markdown
// setext underline -- is measured to not occur in this tree (the measurement
// is recorded on EXCEPTIONS below).
const MARKER_PATTERN = "^(<<<<<<<|=======|>>>>>>>)";

// Paths the gate never reports, path-exact and root-relative. Deliberately
// EMPTY, and the emptiness is a measurement, not a hope: on origin/main
// 29daa38 (this branch's base, re-measured on the branch), `git grep -l -I -E
// '^(<<<<<<<|=======|>>>>>>>)'` over the tracked tree returns 0 files, and the
// legitimate-shape probe `git grep -l -I -E '^=======+$'` returns 0 files
// too -- no fixture needs excluding today. A future legitimate occurrence
// must be added HERE, BY NAME, never by weakening MARKER_PATTERN above.
const EXCEPTIONS: readonly string[] = [];

// Bounded output. The quality contract mandates "positive safety ceilings"
// for gate output, whose content "enters model or report contexts"
// (docs/contracts/quality.md, 2026-09-12; in-run capture applies its own
// `maxOutputChars` ceiling, src/gates/runner.ts). This cap bounds what the
// script itself emits: every hit is counted, only the first MAX_PRINTED_HITS
// are printed, and the summary states the total so nothing is hidden by the
// cap.
const MAX_PRINTED_HITS = 50;

interface MarkerHit {
  path: string;
  line: number;
  text: string;
}

function runGit(argv: string[], cwd: string): { status: number; stdout: string; stderr: string } {
  const proc = spawnSync("git", argv, { cwd, encoding: "utf8" });
  if (proc.error !== undefined)
    throw new Error(`git ${argv.join(" ")} could not be spawned: ${proc.error.message}`);
  return { status: proc.status ?? 1, stdout: proc.stdout, stderr: proc.stderr };
}

// The repo root is resolved, not assumed (`git rev-parse --show-toplevel`), so
// the gate works from any cwd inside the repo; git grep is then run WITH the
// root as cwd so the printed paths are root-relative and stable.
const topLevel = runGit(["rev-parse", "--show-toplevel"], process.cwd());
if (topLevel.status !== 0)
  throw new Error(
    "check-conflict-markers must run inside a git repository: " +
      `git rev-parse --show-toplevel failed: ${topLevel.stderr.trim()}`,
  );
const repoRoot = topLevel.stdout.trim();

// `git grep --cached` over the index is preferred over `git ls-files | xargs
// grep`: ONE process instead of one per file, NUL-safe on odd paths, and -I
// skips binary blobs. -z makes the record fields unambiguous (`path\0line\0
// text`, measured on git 2.43), so a path containing a colon or a space cannot
// corrupt the parse; -n keeps the line numbers the report names.
const scan = runGit(["grep", "--cached", "-n", "-I", "-z", "-E", MARKER_PATTERN], repoRoot);
// git grep: 0 = matches, 1 = no matches, >= 2 = an error (fatal errors are 128).
if (scan.status > 1) throw new Error(`git grep --cached failed: ${scan.stderr.trim()}`);

// Exit 1 is "clean"; anything git printed must parse. A record that does not
// split into path/line/text is a gate failure, never a silently dropped hit.
const hits: MarkerHit[] = [];
for (const record of scan.stdout.split("\n")) {
  if (record.length === 0) continue;
  const fields = record.split("\0");
  const hitPath = fields[0];
  const lineField = fields[1];
  if (hitPath === undefined || lineField === undefined)
    throw new Error(`git grep produced an unparseable record: ${JSON.stringify(record)}`);
  const line = Number(lineField);
  if (!Number.isInteger(line) || line < 1)
    throw new Error(`git grep produced an unparseable line number in: ${JSON.stringify(record)}`);
  hits.push({ path: hitPath, line, text: fields.slice(2).join("\0") });
}

const reported = hits.filter((hit) => !EXCEPTIONS.includes(hit.path));

if (reported.length > 0) {
  const files = new Set(reported.map((hit) => hit.path)).size;
  const printed = reported
    .slice(0, MAX_PRINTED_HITS)
    .map((hit) => `${hit.path}:${hit.line}:${hit.text}`);
  const hidden = reported.length - printed.length;
  throw new Error(
    "conflict markers in the index (the tree about to be committed): " +
      `${files} file(s), ${reported.length} hit(s), printing first ${printed.length}` +
      (hidden > 0 ? ` of ${reported.length}` : "") +
      `:\n${printed.join("\n")}`,
  );
}

process.stdout.write("conflict markers: clean (0 hits in the index projection)\n");
