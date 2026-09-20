// Adversarial tests for test-run temp hygiene (issue #419), review-mandated.
// The sweep itself lives in `test/tmp-hygiene.ts` so these tests exercise the
// exact implementation the preload uses. A per-test scratch base avoids
// touching the real system tmpdir at all except where a test explicitly wants
// the real path (the preload-redirect test), and each one cleans up after
// itself.
import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  MARKERLESS_MAX_AGE_MS,
  ORPHAN_MAX_AGE_MS,
  RUN_ROOT_PREFIX,
  readOwnerState,
  sweepOrphanedRunRoots,
} from "./tmp-hygiene";

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const SCRATCH_PREFIX = "tmp-hygiene-spec-";

// The same write-side precondition `readOwnerState` gates on: where
// `/proc/self/stat` is readable the preload can (and does) write an ownership
// marker, so a missing one is positive proof of absence; everywhere else it is
// silence and must stay under the long rule. Probed in the TEST too, so the
// expectations below pin the rule instead of restating the platform.
const MARKER_CAPABLE = (() => {
  try {
    fs.readFileSync("/proc/self/stat", "utf8");
    return true;
  } catch {
    return false;
  }
})();

const bases: string[] = [];

function freshBase(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), SCRATCH_PREFIX));
  bases.push(dir);
  return dir;
}

// An entry's age is compared against its own mtime; set it explicitly (off the
// real clock, not the entry's current mtime, so re-aging an entry ages it
// forward from now) instead of waiting out the 4-hour threshold.
function ageMtime(target: string, ms: number): void {
  const now = Date.now();
  void fs.lstatSync(target); // fail fast on a bad path, like statSync would
  const past = new Date(now - ms);
  fs.utimesSync(target, past, past);
}

afterAll(() => {
  for (const dir of bases) fs.rmSync(dir, { recursive: true, force: true });
});

test("sweep removes an old strict-prefix orphan and leaves fresh and foreign entries untouched", () => {
  const base = freshBase();
  const old = path.join(base, `${RUN_ROOT_PREFIX}oldorphan`);
  const fresh = path.join(base, `${RUN_ROOT_PREFIX}freshorphan`);
  const smoke = path.join(base, "ad-coder-artifact-smoke-x");
  const resolver = path.join(base, "ad-coder-auto-resolver-x");
  for (const dir of [old, fresh, smoke, resolver]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "keepme.txt"), "data");
    ageMtime(dir, 5 * HOUR_MS);
  }
  ageMtime(fresh, 1 * HOUR_MS);

  const report = sweepOrphanedRunRoots(base, { maxAgeMs: 4 * HOUR_MS });

  expect(fs.existsSync(old)).toBe(false); // 5h old, strict prefix: swept
  expect(fs.existsSync(fresh)).toBe(true); // 1h old: kept
  expect(fs.existsSync(smoke)).toBe(true); // product/smoke prefix, not ours: kept
  expect(fs.existsSync(resolver)).toBe(true); // foreign prefix: kept
  expect(report.removed).toEqual([old]);
  expect(report.failed).toEqual([]);
});

test("sweep skips symlink entries: the link is untouched and its target intact", () => {
  const base = freshBase();
  const target = path.join(base, "sweep-target-marker");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "canary.txt"), "canary");
  ageMtime(target, 5 * HOUR_MS); // wrong enough for a stat-following bug to fire
  fs.symlinkSync(target, path.join(base, `${RUN_ROOT_PREFIX}link`));

  const report = sweepOrphanedRunRoots(base, {});

  expect(fs.existsSync(path.join(target, "canary.txt"))).toBe(true);
  expect(fs.existsSync(path.join(base, `${RUN_ROOT_PREFIX}link`))).toBe(true);
  expect(report.removed).toEqual([]);
  expect(report.failed).toEqual([]);
});

test("sweep survives an undeletable entry (EACCES, sticky-/tmp analogue), reports it, keeps sweeping", () => {
  const base = freshBase();
  const stuck = path.join(base, `${RUN_ROOT_PREFIX}stuck`);
  fs.mkdirSync(stuck);
  fs.writeFileSync(path.join(stuck, "junk.txt"), "junk");
  ageMtime(stuck, 5 * HOUR_MS);
  fs.chmodSync(stuck, 0o500); // no write permission -> emptying the dir fails
  const deletable = path.join(base, `${RUN_ROOT_PREFIX}other`);
  fs.mkdirSync(deletable, { recursive: true });
  ageMtime(deletable, 5 * HOUR_MS);

  const report = sweepOrphanedRunRoots(base, { maxAgeMs: 4 * HOUR_MS });

  // Nothing threw out of the sweep; the undeletable entry is reported under
  // its own name with an errno code, and the neighbour was still removed.
  expect(report.removed).toEqual([deletable]);
  expect(report.failed).toHaveLength(1);
  expect(report.failed[0]?.name).toBe("ad-coder-test-stuck");
  expect(typeof report.failed[0]?.code).toBe("string");

  // Restore so the shared afterAll can actually remove the scratch base.
  fs.chmodSync(stuck, 0o700);
});

test("sweep target follows the passed-in tmpdir, not the env-mutated TMPDIR", () => {
  // Counter-regression for review Finding 1: muting `process.env.TMPDIR` (as
  // some env tests do without restoring) must not redirect destructive paths —
  // in real runs the sweep never consults `os.tmpdir()` for the target, and
  // here we prove the exported function behaves the same under a muted env.
  const base = freshBase();
  const capture = os.tmpdir(); // under bun test: the preload's run root
  const previous = process.env.TMPDIR;
  const bait = path.join(base, "bait-dir");
  fs.mkdirSync(bait, { recursive: true });
  fs.writeFileSync(path.join(bait, "bait-canary.txt"), "bait");
  ageMtime(bait, 5 * HOUR_MS);
  const selfcheck = path.join(capture, `${RUN_ROOT_PREFIX}selfcheckorphan`);
  fs.mkdirSync(selfcheck, { recursive: true });
  fs.writeFileSync(path.join(selfcheck, "orphan.txt"), "orphan");
  ageMtime(selfcheck, 5 * HOUR_MS);
  process.env.TMPDIR = bait; // muted and NOT restored before the sweep runs
  try {
    const report = sweepOrphanedRunRoots(capture, { maxAgeMs: 4 * HOUR_MS });
    // The muted env did not redirect the target: the real capture tmpdir was
    // swept (the seeded orphan was removed) while the bait stayed intact.
    expect(report.removed).toContain(selfcheck);
    expect(report.removed).not.toContain(bait);
    expect(fs.existsSync(path.join(bait, "bait-canary.txt"))).toBe(true);
    expect(fs.existsSync(selfcheck)).toBe(false);
  } finally {
    process.env.TMPDIR = previous;
  }
});

test.skipIf(process.platform !== "linux")(
  "ownerCheck disposes of a dead owner's root immediately; a marker-less root takes the SHORT rule, an unknown marker the long one (Linux /proc probe)",
  () => {
    const base = freshBase();
    const dead = path.join(base, `${RUN_ROOT_PREFIX}deadowner`);
    // A pid far above the kernel's pid_max range: /proc/<pid>/stat cannot exist
    // for it, so readOwnerState proves death without spawning or killing anyone.
    const UNRUNNABLE = 4194304;
    fs.mkdirSync(dead, { recursive: true });
    fs.writeFileSync(path.join(dead, "run-pid"), `${UNRUNNABLE} 0`);
    ageMtime(dead, 1 * HOUR_MS); // fresh — only the dead-owner proof removes it
    const unmarked = path.join(base, `${RUN_ROOT_PREFIX}unmarked`);
    fs.mkdirSync(unmarked, { recursive: true });
    ageMtime(unmarked, 0); // the mkdtempSync->marker micro-window: kept by the SHORT rule
    const unknown = path.join(base, `${RUN_ROOT_PREFIX}unknownmarker`);
    fs.mkdirSync(unknown, { recursive: true });
    fs.writeFileSync(path.join(unknown, "run-pid"), "not-a-pid at all");
    ageMtime(unknown, 1 * HOUR_MS); // unparseable marker => "unknown" keeps the long rule

    // The statuses themselves, not just the sweep outcome: an absent marker on
    // a marker-capable platform is the positive statement "no-marker".
    expect(readOwnerState(unmarked)).toBe("no-marker");
    expect(readOwnerState(dead)).toBe("dead");
    expect(readOwnerState(unknown)).toBe("unknown");

    const report = sweepOrphanedRunRoots(base, {
      maxAgeMs: Number.MAX_SAFE_INTEGER, // age rule alone would KEEP all of them
      ownerCheck: readOwnerState,
    });

    expect(fs.existsSync(dead)).toBe(false);
    expect(fs.existsSync(unmarked)).toBe(true);
    expect(fs.existsSync(unknown)).toBe(true);
    expect(report.removed).toEqual([dead]);
    expect(report.failed).toEqual([]);
  },
);

test("a run-pid marker without a Linux /proc probe is 'unknown', never 'dead' (macOS portability)", () => {
  const base = freshBase();
  const root = path.join(base, `${RUN_ROOT_PREFIX}noprocfresh`);
  // A syntactically valid marker for a pid that cannot exist anywhere. On
  // Linux the /proc probe proves this owner dead and the root is disposed of
  // even while fresh; on any other platform the answer must be "unknown" —
  // missing procfs is NOT proof of death, or a concurrent run's live root
  // could be swept by a parallel run on macOS.
  const UNRUNNABLE = 4194304;
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "run-pid"), `${UNRUNNABLE} 0`);
  ageMtime(root, 1 * HOUR_MS); // fresh: only a dead-owner proof may remove it

  const isLinux = process.platform === "linux";
  if (isLinux) {
    expect(readOwnerState(root)).toBe("dead");
  } else {
    expect(readOwnerState(root)).toBe("unknown");
  }

  // The same proof through the sweep, with the real reader wired in exactly
  // as the preload does: on Linux the fresh dead-owner root goes, on macOS
  // the root is "unknown" and the age rule keeps a fresh root alive.
  const report = sweepOrphanedRunRoots(base, {
    maxAgeMs: 4 * HOUR_MS,
    ownerCheck: readOwnerState,
  });

  if (isLinux) {
    expect(report.removed).toEqual([root]);
    expect(fs.existsSync(root)).toBe(false);
  } else {
    expect(report.removed).toEqual([]);
    expect(fs.existsSync(root)).toBe(true);
  }
  expect(report.failed).toEqual([]);
});

test("an 'unknown' ownerCheck answer never disposes a fresh root — the age rule keeps it (pure substituted reader)", () => {
  const base = freshBase();
  const fresh = path.join(base, `${RUN_ROOT_PREFIX}unknownfresh`);
  fs.mkdirSync(fresh, { recursive: true });
  ageMtime(fresh, 1 * HOUR_MS);

  // Reader substituted, no /proc dependency: exactly the branch a non-Linux
  // readOwnerState takes. A fresh root with unknown liveness stays.
  const report = sweepOrphanedRunRoots(base, {
    maxAgeMs: 4 * HOUR_MS,
    ownerCheck: () => "unknown",
  });

  expect(report.removed).toEqual([]);
  expect(fs.existsSync(fresh)).toBe(true);
  expect(report.failed).toEqual([]);
});

test.skipIf(process.platform !== "linux")(
  "ownerCheck keeps a live owner's root the age rule would have removed (Linux /proc probe)",
  () => {
    const base = freshBase();
    const live = path.join(base, `${RUN_ROOT_PREFIX}liveowner`);
    // Our own pid + its real starttime (field 22 of /proc/self/stat; after the
    // possibly spacey comm field the tail starts at field 3, so field 22 is
    // index 19 of the tail): a proof of life the sweep must respect even
    // with the age threshold at zero and nothing protected.
    const stat = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8");
    const tail = stat.slice(stat.lastIndexOf(")") + 2);
    const starttime = tail.split(" ")[19]?.trim() ?? "";
    fs.mkdirSync(live, { recursive: true });
    fs.writeFileSync(path.join(live, "run-pid"), `${process.pid} ${starttime}`);
    ageMtime(live, 0); // indefinitely old: the age rule alone would remove it

    const report = sweepOrphanedRunRoots(base, {
      maxAgeMs: 0,
      // The short marker-less threshold at zero too: an ALIVE owner must be
      // out of reach of every age rule, not merely of the long one.
      markerlessMaxAgeMs: 0,
      ownerCheck: readOwnerState,
    });

    expect(fs.existsSync(live)).toBe(true);
    expect(report.removed).toEqual([]);
    expect(report.failed).toEqual([]);
  },
);

test("the marker-less threshold is a named, SHORT constant beside the long one", () => {
  // The pair IS the rule: one minute against the other rule's four hours. Both
  // named, so a later edit cannot quietly swap which status gets which age.
  expect(MARKERLESS_MAX_AGE_MS).toBe(60_000);
  expect(MARKERLESS_MAX_AGE_MS).toBeLessThan(ORPHAN_MAX_AGE_MS);
});

test("readOwnerState: an absent marker is 'no-marker' where markers are writable, and never 'dead'", () => {
  const base = freshBase();
  const root = path.join(base, `${RUN_ROOT_PREFIX}nomarker`);
  fs.mkdirSync(root, { recursive: true });

  const state = readOwnerState(root);
  // Absence of a marker is NOT proof of death: where the marker could have been
  // written it is proof of no owner ("no-marker", the short rule); where it
  // could not (no procfs) it proves nothing at all ("unknown", the long rule).
  expect(state).toBe(MARKER_CAPABLE ? "no-marker" : "unknown");
  expect(state).not.toBe("dead");
});

test("readOwnerState: an UNREADABLE marker is 'unknown', not 'no-marker' — only ENOENT proves absence", () => {
  const base = freshBase();
  const root = path.join(base, `${RUN_ROOT_PREFIX}markerunreadable`);
  // A directory in the marker's place: the read fails with EISDIR while the
  // root is right there, so this failure must NOT be read as "the marker is
  // absent" — the long rule (and, without procfs, every marker-less root) stays.
  fs.mkdirSync(path.join(root, "run-pid"), { recursive: true });

  expect(readOwnerState(root)).toBe("unknown");
});

test("sweep: a marker-less root past the SHORT threshold goes, a fresh one stays", () => {
  const base = freshBase();
  const stale = path.join(base, `${RUN_ROOT_PREFIX}markerlessstale`);
  const fresh = path.join(base, `${RUN_ROOT_PREFIX}markerlessfresh`);
  fs.mkdirSync(stale, { recursive: true });
  fs.writeFileSync(path.join(stale, "scratch.txt"), "scratch");
  fs.mkdirSync(fresh, { recursive: true });
  ageMtime(stale, 5 * MINUTE_MS); // older than MARKERLESS_MAX_AGE_MS
  ageMtime(fresh, 0); // the mkdtempSync->marker micro-window: age ~0

  // Default thresholds on purpose (`maxAgeMs` omitted => the long rule, which
  // could not dispose of `stale`): the root goes because the SHORT rule fired.
  const report = sweepOrphanedRunRoots(base, {
    markerlessMaxAgeMs: MARKERLESS_MAX_AGE_MS,
    ownerCheck: () => "no-marker",
  });

  expect(fs.existsSync(stale)).toBe(false); // stale and provably unowned: swept
  expect(fs.existsSync(fresh)).toBe(true); // micro-window lookalike: kept
  expect(report.removed).toEqual([stale]);
  expect(report.failed).toEqual([]);
});

test("sweep: the caller's marker-less threshold is honoured (zero removes even the fresh root)", () => {
  const base = freshBase();
  const fresh = path.join(base, `${RUN_ROOT_PREFIX}markerlessthreshold`);
  fs.mkdirSync(fresh, { recursive: true });
  ageMtime(fresh, 0);

  const report = sweepOrphanedRunRoots(base, {
    maxAgeMs: Number.MAX_SAFE_INTEGER, // the long rule would never fire here
    markerlessMaxAgeMs: 0,
    ownerCheck: () => "no-marker",
  });

  expect(report.removed).toEqual([fresh]);
  expect(fs.existsSync(fresh)).toBe(false);
  expect(report.failed).toEqual([]);
});

test("sweep: an 'unknown' root keeps the LONG rule even where the short threshold would have disposed of it", () => {
  const base = freshBase();
  const root = path.join(base, `${RUN_ROOT_PREFIX}unknownshortrule`);
  fs.mkdirSync(root, { recursive: true });
  ageMtime(root, 1 * HOUR_MS); // past the short threshold, well inside the long one

  // Exactly the branch a platform without procfs takes on a marker-less root:
  // an hour old, and it must SURVIVE — the short rule may never reach a root
  // whose ownership this platform cannot disprove.
  const report = sweepOrphanedRunRoots(base, {
    maxAgeMs: ORPHAN_MAX_AGE_MS,
    ownerCheck: () => "unknown",
  });

  expect(fs.existsSync(root)).toBe(true);
  expect(report.removed).toEqual([]);
  expect(report.failed).toEqual([]);
});

test.skipIf(!MARKER_CAPABLE)(
  "sweep with the real reader: stale marker-less root swept; fresh, live and unknown-marker roots survive",
  () => {
    const base = freshBase();
    const stale = path.join(base, `${RUN_ROOT_PREFIX}realstale`);
    const fresh = path.join(base, `${RUN_ROOT_PREFIX}realfresh`);
    const live = path.join(base, `${RUN_ROOT_PREFIX}reallive`);
    const unknown = path.join(base, `${RUN_ROOT_PREFIX}realunknown`);
    // The late-writer wreckage as observed after #419's first cut: a bare root
    // holding an old test scratch and no marker at all.
    fs.mkdirSync(path.join(stale, "ad-coder-default-owner-x"), { recursive: true });
    fs.mkdirSync(fresh, { recursive: true });
    // A live run's root (our own pid) older than the SHORT threshold: proof of
    // life must outrank age, or a run whose marker write raced the sweep would
    // lose its scratch mid-flight.
    const stat = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8");
    const tail = stat.slice(stat.lastIndexOf(")") + 2);
    const starttime = tail.split(" ")[19]?.trim() ?? "";
    fs.mkdirSync(live, { recursive: true });
    fs.writeFileSync(path.join(live, "run-pid"), `${process.pid} ${starttime}`);
    // An unparseable marker: "unknown", so the long rule still holds it.
    fs.mkdirSync(unknown, { recursive: true });
    fs.writeFileSync(path.join(unknown, "run-pid"), "not-a-pid at all");
    ageMtime(stale, 5 * MINUTE_MS);
    ageMtime(live, 5 * MINUTE_MS);
    ageMtime(unknown, 5 * MINUTE_MS);
    ageMtime(fresh, 0);

    // Default thresholds, real reader — the preload's exact wiring.
    const report = sweepOrphanedRunRoots(base, { ownerCheck: readOwnerState });

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(live)).toBe(true);
    expect(fs.existsSync(unknown)).toBe(true);
    expect(report.removed).toEqual([stale]);
    expect(report.failed).toEqual([]);
  },
);
