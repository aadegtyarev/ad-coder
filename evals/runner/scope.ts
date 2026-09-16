import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Glob } from "bun";

/**
 * Paths the HARNESS writes into every target, which no task may be charged for.
 *
 * `.ad-coder/` holds the ledger, the run checkpoints and the session transcript
 * of the very run being measured. It is in the target because ad-coder put it
 * there, so counting it against the model would fail every task at once.
 */
const HARNESS_PATHS = [".ad-coder", ".ad-coder/**"];

/** Every file in the target, with a digest of its contents. */
export type Snapshot = Map<string, string>;

/**
 * The target's files as git sees them: tracked, plus untracked and not ignored.
 *
 * WHY GIT AND NOT A TREE WALK. A fixture's own `.gitignore` is its statement of
 * what is build output rather than source -- `target/` for Cargo, `__pycache__`
 * for Python -- and a task that legitimately compiles or runs its tests must not
 * be charged for producing it. Asking git honours that statement instead of
 * restating it here, one guess per language.
 */
function listedFiles(target: string): string[] {
  const result = spawnSync(
    "git",
    ["-C", target, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr?.trim() || "git ls-files failed");
  return (result.stdout ?? "").split("\0").filter(Boolean);
}

/**
 * What the target looks like right now.
 *
 * A file whose contents are changed and then restored is NOT a change, and that
 * is deliberate: `reviewer.md` instructs the Reviewer to revert a diff, run the
 * test, and restore the tree exactly as it found it. Scoring that as scope creep
 * would punish a role for following its own prompt.
 *
 * Taken from the working tree after materialization rather than from the
 * baseline commit, because a fixture may ship its seeded defect as an
 * uncommitted change -- the reviewer fixture does exactly that, so the role
 * under test can read it as a `git diff`. Compared against the commit, that
 * seeded diff would be reported as the model's own edit on every run.
 */
export function snapshot(target: string): Snapshot {
  const files: Snapshot = new Map();
  for (const file of listedFiles(target)) {
    let contents: Buffer;
    try {
      contents = fs.readFileSync(path.join(target, file));
    } catch {
      // Listed but unreadable -- a dangling symlink, a file removed between the
      // listing and the read. Recorded as absent rather than thrown, because a
      // scope violation is a fact about the run and must not be able to destroy
      // the measurement it belongs to.
      continue;
    }
    // The executable bit travels with the digest. `chmod +x` on a source file
    // changes nothing a scorer reads and is still the model altering the tree
    // outside its brief; it is also the only mode git itself tracks, so
    // including it keeps the snapshot's notion of "changed" aligned with the
    // repository's.
    const executable = (fs.statSync(path.join(target, file)).mode & 0o111) !== 0 ? "x" : "-";
    const digest = crypto.createHash("sha256").update(contents).digest("hex");
    files.set(file, `${executable}${digest}`);
  }
  return files;
}

/** Paths that differ between two snapshots: added, removed or rewritten. */
export function changedPaths(before: Snapshot, after: Snapshot): string[] {
  const changed = new Set<string>();
  for (const [file, digest] of after) if (before.get(file) !== digest) changed.add(file);
  for (const file of before.keys()) if (!after.has(file)) changed.add(file);
  return [...changed].sort();
}

/**
 * The changed paths the task did not permit.
 *
 * WHY AN ALLOW-LIST AND NOT A DENY-LIST. The interesting failure is the file
 * nobody anticipated -- a logging framework pulled in, a neighbouring module
 * reformatted, a scratch file left behind. A deny-list can only name what
 * someone thought of first, which is the wrong side of that asymmetry.
 *
 * An empty allow-list is a statement rather than a missing value: the read-only
 * roles are told to change nothing, and `[]` is how a task says so checkably.
 */
export function outOfScope(before: Snapshot, after: Snapshot, allow: readonly string[]): string[] {
  const globs = [...allow, ...HARNESS_PATHS].map((pattern) => new Glob(pattern));
  return changedPaths(before, after).filter((file) => !globs.some((glob) => glob.match(file)));
}
