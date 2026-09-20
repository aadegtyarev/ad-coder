// Pure helpers for test-run temp hygiene (issue #419). Kept side-effect free
// and exportable so the adversarial tests (`test/tmp-hygiene.test.ts`) exercise
// this exact code instead of re-deriving it; `test/preload.ts` orchestrates it.
import * as fs from "node:fs";
import * as path from "node:path";

// Strict prefix of run roots created by the test preload. Deliberately does NOT
// cover any other `ad-coder-*` prefix (product runs, artifact smoke, boundary
// scratch) — sweeping must never touch anything outside this suite's own
// scratch space.
export const RUN_ROOT_PREFIX = "ad-coder-test-";

// Sweep age threshold for a root whose owner cannot be disproved. One named
// constant rather than a setting (quality: clean-check #308): `test/` is not in
// the package's `files`, so no product user ever reaches this code and no
// config surface is invented.
export const ORPHAN_MAX_AGE_MS = 4 * 60 * 60 * 1000;

// Short threshold for a root whose owner marker is PROVABLY absent
// (`readOwnerState` => "no-marker", Linux with a readable procfs). Two facts
// make a minute safe: (a) a live run's root carries its marker within
// microseconds of `mkdtempSync`, so an unmarked root can only be that
// micro-window — pathological scheduler delay aside, not a minute; (b) the
// observed leak after #419's first cut was a LATE WRITER re-creating the old
// root (`mkdir -p <oldRoot>/<scratch>` from a detached child still holding the
// pre-swap TMPDIR) after the run's own teardown deleted it — such a root never
// gets a marker and would otherwise live for the full four hours and breed.
// Deliberately short, deliberately named: the long rule stays for roots whose
// silence is not proof (`unknown`, i.e. no procfs at all).
export const MARKERLESS_MAX_AGE_MS = 60_000;

/** Ownership verdict for a run root. `"no-marker"` is the one positive
 * statement about absence — the marker could have been written here and is not
 * there — and is therefore the only status that may use the short threshold. */
export type OwnerState = "alive" | "dead" | "no-marker" | "unknown";

/**
 * True exactly where the preload could have written an ownership marker: it
 * derives `<pid> <starttime>` from `/proc/<pid>/stat`, so a readable
 * `/proc/self/stat` is the write-side precondition. Without procfs (macOS, or
 * a Linux without /proc mounted) a missing marker proves nothing and every
 * verdict stays `"unknown"` — a concurrent run's LIVE root must never be swept
 * merely because its platform cannot record ownership.
 */
function canWriteOwnerMarker(): boolean {
  try {
    fs.readFileSync("/proc/self/stat", "utf8");
    return true;
  } catch {
    return false;
  }
}

export interface SweepFailure {
  name: string;
  code: string;
}

export interface SweepReport {
  /** Directories removed. Full paths; the caller never re-derives paths. */
  removed: string[];
  /** Entries under the prefix that were left in place, names + errno only. */
  failed: SweepFailure[];
}

/**
 * Removes orphaned run roots (directories with the strict `ad-coder-test-`
 * prefix, older than `maxAgeMs`, under the caller-supplied tmpdir). A run
 * killed by SIGKILL leaves its root behind; the next run sweeps it.
 *
 * Hard requirements from the security review: only `lstat`-directories with
 * the strict prefix on the entry name are considered (symlinks named like a
 * root are skipped, so no link target is ever reached); every entry is guarded
 * individually — a foreign sticky-bit entry (EPERM) or a benign
 * `readdir`/`stat` race (ENOENT) must never abort a run; `protectedNames`
 * excludes this run's own root name so no operation order can self-delete.
 */
export function sweepOrphanedRunRoots(
  systemTmp: string,
  options: {
    /** Age threshold for entries whose ownership is `"unknown"` (or unread). */
    maxAgeMs?: number;
    /** Age threshold for entries read as `"no-marker"` — shorter by design
     * (see `MARKERLESS_MAX_AGE_MS`). Never applies to any other answer. */
    markerlessMaxAgeMs?: number;
    protectedNames?: readonly string[];
    now?: number;
    /** Extra disposal proof: "dead" removes the root immediately (dead owner,
     * pid gone or recycled) and "alive" keeps it, both regardless of age;
     * "no-marker" falls through to the SHORT age rule and "unknown" (including
     * a broken or unreadable marker) to the long one. Absent => unchanged. */
    ownerCheck?: (rootDir: string) => OwnerState;
  } = {},
): SweepReport {
  const ownerCheck = options.ownerCheck;
  const now = options.now ?? Date.now();
  const cutoff = now - (options.maxAgeMs ?? ORPHAN_MAX_AGE_MS);
  const markerlessCutoff = now - (options.markerlessMaxAgeMs ?? MARKERLESS_MAX_AGE_MS);
  const protectedNames = new Set(options.protectedNames ?? []);
  const report: SweepReport = { removed: [], failed: [] };
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(systemTmp, { withFileTypes: true });
  } catch (error) {
    // Nothing destructive happened, and throwing out of a preload must be
    // impossible; the caller reports this with its own one-line message.
    report.failed.push({
      name: "*",
      code: (error as NodeJS.ErrnoException).code ?? "unknown",
    });
    return report;
  }
  for (const entry of entries) {
    // Strict comparison on the readdir name itself — no user-controlled input
    // is concatenated anywhere.
    if (!entry.name.startsWith(RUN_ROOT_PREFIX)) continue;
    if (protectedNames.has(entry.name)) continue;
    // `Dirent` is lstat-based: a symlink named `ad-coder-test-…` is not a
    // directory and is skipped outright, so no path outside the system tmpdir
    // is ever reached and mtime is never read through a link.
    if (!entry.isDirectory()) continue;
    const target = path.join(systemTmp, entry.name);
    try {
      // Dead-owner disposal: a run killed so hard its `afterAll` never fired
      // leaves a marker; a provably dead owner (pid gone or recycled) means
      // the root goes now regardless of age, while a provably ALIVE one is
      // never touched (concurrent runs share this tmpfs). "unknown" (incl. no
      // or broken marker) falls through to the age rule — nothing changes
      // there.
      const owner = ownerCheck?.(target);
      if (owner === "dead") {
        fs.rmSync(target, { recursive: true, force: true });
        report.removed.push(target);
        continue;
      }
      if (owner === "alive") continue;
      // Ages apart by verdict: a provably unowned root uses the short
      // threshold, an unprovable one (`"unknown"`, or no reader wired in at
      // all) the long rule — never the other way round, so the short rule can
      // never reach a root this platform cannot prove ownerless.
      const entryCutoff = owner === "no-marker" ? markerlessCutoff : cutoff;
      // lstat (not stat) again: refuse to descend through a symlink swapped
      // in between readdir and stat.
      if (fs.lstatSync(target).mtimeMs > entryCutoff) continue;
      fs.rmSync(target, { recursive: true, force: true });
      report.removed.push(target);
    } catch (error) {
      report.failed.push({
        name: entry.name,
        code: (error as NodeJS.ErrnoException).code ?? "unknown",
      });
    }
  }
  return report;
}

/**
 * Ownership proof for a run root: reads `<rootDir>/run-pid` (`<pid> <starttime>`
 * of its creator, written by the preload) and checks `/proc/<pid>/stat`. Field
 * 22 (starttime, ticks since boot) pins the pid against recycling. The procfs
 * probe gates the WHOLE function: where markers cannot be written (macOS has
 * no `/proc/<pid>/stat`) there is nothing to distinguish "absent" from
 * "unwritten", so every answer is `"unknown"` and a concurrent run's LIVE root
 * can never be swept on a platform that cannot record ownership. Only there,
 * `ENOENT` on the marker is a positive statement of absence (`"no-marker"`, the
 * status that unlocks the short threshold); every other read failure (EACCES,
 * EISDIR, a symlink swapped in mid-read) is not proof and stays `"unknown"`.
 * The path is derived only from the rootDir the sweep already lstat-checked,
 * and marker reads are unthrowing.
 */
export function readOwnerState(rootDir: string): OwnerState {
  if (!canWriteOwnerMarker()) return "unknown";
  const markerPath = path.join(rootDir, "run-pid");
  let marker: string;
  try {
    marker = fs.readFileSync(markerPath, "utf8");
  } catch (error) {
    // ENOENT is the single failure that PROVES the marker is absent: the root
    // exists (the sweep lstat-checked it) and the marker write happens right
    // after `mkdtempSync`, so this is either the micro-window of a live run or
    // a root rebuilt by a late writer that never writes one. Anything else is
    // unreadable rather than absent.
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "no-marker" : "unknown";
  }
  const separator = marker.indexOf(" ");
  if (separator < 0) return "unknown";
  const pid = Number(marker.slice(0, separator));
  const starttime = marker.slice(separator + 1).trim();
  if (!Number.isSafeInteger(pid) || pid <= 0 || starttime.length === 0) return "unknown";
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    // comm (field 2) may contain spaces/parens; everything after the last `)`
    // is fixed fields, so the tail starts at field 3 (state) at index 0 and
    // starttime is field 22 => index 19 of the tail.
    const tail = stat.slice(stat.lastIndexOf(")") + 2);
    const starttimeField = tail.split(" ")[19]?.trim();
    if (starttimeField === undefined) return "unknown";
    return starttimeField === starttime ? "alive" : "dead";
  } catch {
    // /proc/<pid> unreadable on Linux => the owner is gone: dead, immediately
    // cleanable (the platform guard above keeps this branch Linux-only).
    return "dead";
  }
}
