// Test-run temp hygiene (issue #419). Loaded before any test via `bunfig.toml`
// (`[test] preload`). `bun test` historically left every per-test
// `mkdtempSync(path.join(os.tmpdir(), "ad-coder-…"))` behind — hundreds of
// directories in tmpfs per run. Redirecting `TMPDIR` at one run root here
// redirects all of them at that root without touching the 177 call sites, and
// the root is removed at the end of the run by an `afterAll` that retries and
// then, if a run-root-shaped directory is still there, FAILS the run (see the
// teardown below).
//
// Security posture (review-mandated): this file runs before any test, so it
// stays sterile — only `node:fs`/`node:path`/`node:os`/`bun:test` are touched,
// no environment secrets are read, no network calls are made, and nothing
// about directory contents is logged (only entry names and errno codes).
// Destructive paths are never re-derived after the `TMPDIR` swap: cleanup
// targets are the captured constants below, never a fresh `os.tmpdir()` call.
//
// Residual risk, stated as measured rather than assumed: the hook DOES fire
// under `bun test` (`process.on("exit")`/`beforeExit` do not; the `afterAll`
// route was verified experimentally), so a run deletes its own root. What
// survives is a root RE-CREATED after that deletion by a late writer — a
// detached child or a test file still finishing that holds the old `TMPDIR`
// and runs `mkdir -p <oldRoot>/<scratch>` (measured in a full run: ~100 ms
// after the deletion). Such a root has no `run-pid` marker, so the second line
// of defence is the sweep below: the next run removes it once it is older than
// `MARKERLESS_MAX_AGE_MS`, and on platforms where a missing marker proves
// nothing the old four-hour rule still applies (see `tmp-hygiene.ts`). The
// FIRST line is no longer only "a run tries to delete its root": the run
// compares the system tmpdir against the names it saw before its root existed
// and fails when a name with the run-root prefix is left -- unless the sweep's
// own owner verdict proves it belongs to a live concurrent run, and then the
// run keeps that name and says so on stderr. A writer slower than the teardown's
// own bound is the only leak the sweep still owns.
import { afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RUN_ROOT_PREFIX, readOwnerState, sweepOrphanedRunRoots } from "./tmp-hygiene";

// Captured up front. Sweeping through `os.tmpdir()` after the swap below
// would scan the fresh (mostly empty) run root instead of the system tmpdir,
// and re-deriving cleanup targets after tests may have muted `TMPDIR` must
// be impossible by construction.
const systemTmp = os.tmpdir();

// Names in the system tmpdir as they were BEFORE this run created anything in
// it, taken before the run root exists on purpose: the root created on the next
// line is therefore NOT in the snapshot, so a root that outlives the run is
// provable as the run's own leak rather than something a snapshot might have
// excused. Only names are read -- never contents, never file metadata.
const tmpdirNamesBefore = new Set(fs.readdirSync(systemTmp));

// The run root is created before the sweep so the sweep can exclude it under
// any operation order (self-deletion must be impossible, not merely unlikely).
const runRoot = fs.mkdtempSync(path.join(systemTmp, RUN_ROOT_PREFIX));

// Ownership marker (pid + /proc starttime, field 22): lets the next run's
// sweep dispose of this root if a crash skips the `afterAll`. Only the write
// is guarded — a root without a marker stays cleanable via the age rule.
try {
  const stat = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8");
  const tail = stat.slice(stat.lastIndexOf(")") + 2);
  // Tail starts at field 3 (state) at index 0, so starttime (field 22) is
  // index 19 of the tail.
  const starttime = tail.split(" ")[19]?.trim();
  if (starttime !== undefined) {
    fs.writeFileSync(path.join(runRoot, "run-pid"), `${process.pid} ${starttime}`);
  }
} catch {}

process.env.TMPDIR = runRoot;

const report = sweepOrphanedRunRoots(systemTmp, {
  protectedNames: [path.basename(runRoot)],
  // Pid-based disposal of a dead owner's root regardless of age (bounded:
  // strict prefix + ownership proof only; live lena roots are never touched).
  ownerCheck: readOwnerState,
});

// Per-entry errors were already contained inside the sweep; nothing here can
// throw out of the preload and abort the run.
for (const failure of report.failed) {
  process.stderr.write(`[test-preload] orphan sweep skipped ${failure.name} (${failure.code})\n`);
}

// Removes exactly the captured absolute path of the run root — never a path
// recomputed from `os.tmpdir()` at hook time (a test may have pointed `TMPDIR`
// elsewhere without restoring it; the target under that path must survive).
// Verified experimentally: `afterAll` registered from a preload fires under
// `bun test`, while `process.on("exit")` does not.
//
// The teardown is a bounded series rather than a single `rmSync` because the
// failure mode that actually leaked roots is a WRITER RACING the deletion: in
// a measured full run the late child re-created the run root about 100 ms
// AFTER the first `rmSync` removed it, so a delete-then-check returns "clean"
// inside exactly the window that leaks. The series therefore runs to its bound
// (five attempts, 50 ms apart) and re-deletes whatever appeared; only a writer
// slower than that bound can still slip through, and that residue is what the
// marker-less short threshold in the sweep above is for. `bun test` awaits an
// async `afterAll` (verified experimentally), so the bound is real; the first
// `rmSync` is synchronous either way.
//
// Whatever survives that series is a FAILURE of the run, not a note (issue
// #419, review round): the property this file exists for is "a `bun test` run
// leaves no `ad-coder-test-*` behind", and until now only one scenario of it
// was proven (`test/tmp-hygiene-preload.test.ts`), while the run itself -- the
// thing the CI reproduction measured -- could end green with its own root still
// in tmpfs. The comparison below is against the names captured before the root
// existed, so it covers every writer inside this run: the run's own late child
// re-creating the root (`test/cli.test.ts`'s detached workers are the measured
// case), any test that builds a directory with the run-root prefix directly in
// the system tmpdir, and the root itself. Names and errno-free counts only.
//
// Stated limitation with its price, not a silent one: a CONCURRENT `bun test`
// in another worktree shares this system tmpdir, and its live root appears here
// as a new name. That name is exempted -- but on evidence, and on exactly the
// verdict the sweep above already trusts (`readOwnerState`, one implementation,
// no second copy of the rule): `"alive"` (marker read, pid present, starttime
// matching) means a live run owns the root, so this run stays green and writes
// ONE stderr line naming the held root -- an exemption is never silent. Every
// other verdict is a LEAK, because a gate has no business passing on evidence
// it does not have: `"no-marker"` (the root is there and its marker is provably
// not, which is the shape a late writer leaves), `"dead"` (nobody owns it any
// more), and `"unknown"`.
//
// The price sits in that last verdict, and it is the conservative side by
// choice: on a platform without procfs (macOS, or a Linux without /proc) a live
// concurrent run's root CANNOT be proven alive, so it is NOT exempted and the
// run FAILS, naming a foreign live root as the leak. Preferring the opposite
// would mean a green run built on an absence the platform cannot read. The same
// rule has a narrow residual cost where procfs IS readable: between a foreign
// run's `mkdtempSync` and its marker write its root answers `"no-marker"` for
// microseconds, so a teardown landing exactly in that window reads a live root
// as a leak. The sweep below spends a whole minute on that window; this gate
// cannot, because the verdict it would have to excuse was 'no marker'.
const TEARDOWN_ATTEMPTS = 5;
const TEARDOWN_RETRY_MS = 50;

afterAll(async () => {
  for (let attempt = 0; attempt < TEARDOWN_ATTEMPTS; attempt += 1) {
    fs.rmSync(runRoot, { recursive: true, force: true });
    await new Promise((resolve) => setTimeout(resolve, TEARDOWN_RETRY_MS));
  }
  const ownRootSurvived = fs.existsSync(runRoot);
  const ownRootName = path.basename(runRoot);
  const newNames = fs
    .readdirSync(systemTmp)
    .filter((name) => name.startsWith(RUN_ROOT_PREFIX) && !tmpdirNamesBefore.has(name));
  // Verdict per new name, in the sweep's own terms. This run's root is a leak
  // whatever a marker says about it -- the `run-pid` inside it holds THIS
  // process's pid, so `readOwnerState` would answer "alive" and release the one
  // name that is never someone else's. Every other name is released only on the
  // same positive proof of a LIVE owner that keeps a concurrent run's root out
  // of the sweep; `no-marker`, `dead` and `unknown` (including a platform
  // without procfs) all leak, so the gate never passes on evidence it lacks.
  const leaked: string[] = [];
  const heldByLiveRun: string[] = [];
  for (const name of newNames) {
    if (name === ownRootName) {
      leaked.push(name);
      continue;
    }
    if (readOwnerState(path.join(systemTmp, name)) === "alive") {
      heldByLiveRun.push(name);
      continue;
    }
    leaked.push(name);
  }
  // The exemption is reported rather than silent: a `bun test` that skips a
  // name in its own tmpdir must say which name it skipped and on whose behalf.
  for (const name of heldByLiveRun) {
    process.stderr.write(
      `[test-preload] tmpdir hold: ${name} belongs to a live concurrent run, not to this one\n`,
    );
  }
  if (leaked.length === 0) return;
  // One line, the style of the orphan-sweep note above, with the numbers the
  // repro rests on: how many leaked, their names, and whether the run's own
  // root is one of them (it is, in the measured CI case, so it is not excused).
  const detail = ownRootSurvived
    ? `own run root ${path.basename(runRoot)} survived ${TEARDOWN_ATTEMPTS} teardown attempts`
    : `own run root ${path.basename(runRoot)} was removed by the ${TEARDOWN_ATTEMPTS} teardown attempts`;
  process.stderr.write(
    `[test-preload] tmpdir hygiene: leaked ${leaked.length} new ${RUN_ROOT_PREFIX}* entr` +
      `${leaked.length === 1 ? "y" : "ies"} in ${systemTmp} (${leaked.join(", ")}); ${detail}\n`,
  );
  throw new Error(
    `test tmpdir hygiene: ${leaked.length} new ${RUN_ROOT_PREFIX}* entr` +
      `${leaked.length === 1 ? "y" : "ies"} under ${systemTmp} after this run ` +
      `(${leaked.join(", ")}); ${detail}. The run fails instead of reporting a green ` +
      "suite that left test scratch in the system tmpdir.",
  );
});
