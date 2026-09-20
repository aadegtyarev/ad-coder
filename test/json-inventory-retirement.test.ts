import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * THE RETIREMENT ITSELF, pinned as an absence (issue #513).
 *
 * The surviving routes' behaviour is pinned where it lives: the CLI refusals in
 * `test/cli.test.ts`, the snapshot refusal in `test/project-calibration.test.ts`,
 * the script's retired flag in `test/check-prices.test.ts`. What none of those
 * sees is a REVERT of the change, and the branch's reviewer measured exactly
 * that (round 3): restoring the seven deleted modules left the suite at
 * 55 pass / 0 fail, restoring the deleted committed snapshot left it there too,
 * and restoring the five documentation files left `bun run check:docs` valid --
 * because a refusal pins the REPLACEMENT's behaviour, which a restore does not
 * disturb.
 *
 * So the absence is asserted here, directly. The claim is the one
 * `docs/contracts/config.md` states for #513: `models.yaml` is the ONLY routing
 * source, and the routed JSON inventory is gone from the code rather than merely
 * unselected. Every assertion below was measured against a tree with the
 * surface put back before it was claimed; the counts are in the commit message.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "..");

/** The modules a JSON route lived in, every one of them deleted by this change. */
const RETIRED_MODULES = [
  "src/inventory/types.ts",
  "src/inventory/validate.ts",
  "src/inventory/resolve.ts",
  "src/inventory/store.ts",
  "src/inventory/errors.ts",
  "src/inventory/default-config.ts",
  "src/config/migrate.ts",
] as const;

test("the retired JSON inventory modules are gone from the code, not merely unimported (#513)", () => {
  // Absent FILES, not merely unwired ones: an unimported module still
  // compiles, still reads as a route, and is one import away from being alive
  // again -- which is the state this branch exists to leave behind.
  const present = RETIRED_MODULES.filter((relative) =>
    fs.existsSync(path.join(REPO_ROOT, relative)),
  );
  expect(present).toEqual([]);
});

test("this repository commits no routing override of its own (#513)", () => {
  // The deletion's other half. The mechanism SURVIVES -- a project may commit
  // `.ad-coder/calibration.json` to pin its routing ahead of `models.yaml` --
  // and this repository deliberately does not, so that a profile edit takes
  // effect everywhere instead of being outranked by a stale copy of the old
  // ladder (the exact trap the deleted fossil walked into).
  // TRACKED, not merely present: the claim is about what the repository
  // carries, and a stray file some run left in a working tree is not that.
  const listed = Bun.spawnSync(["git", "ls-files", "--", ".ad-coder/calibration.json"], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(listed.exitCode).toBe(0);
  expect(listed.stdout.toString().trim()).toBe("");
});

/**
 * The documentation half.
 *
 * `CHANGELOG.md` and `docs/contracts/*.md` are append-only logs: their older
 * entries keep the words they were written with -- twelve retired-flag or
 * `config migrate` mentions each on this tree -- so a pattern check over them
 * would fail on a CORRECT tree, and the claim they carry is the retirement
 * entry itself (asserted below). The live documents keep no such history, and
 * each pattern here is an advertising sentence this change deleted from one of
 * them: measured on the pre-change tree, 1-2 hits each, spread across all
 * three files; 0 on this tree.
 */
const LIVE_DOCS = ["README.md", "docs/ARCHITECTURE.md", "docs/ROADMAP.md"] as const;

const RETIRED_CLAIMS: ReadonlyArray<readonly [string, RegExp]> = [
  ["the deleted migration action", /\bconfig migrate\b/],
  [
    "a copyable invocation of a retired flag",
    /\bad-coder[^\n`]*--inventory(?:-config|-profile)?\b/,
  ],
  ["the `inventory route` a run could take", /\binventory route\b/i],
  ["named model inventories as a subsystem", /\bnamed model inventories\b/i],
  ["an inventory wide enough to span providers", /\binventories may span\b/i],
  ["routing confined to the operator-authored inventory", /operator-authored inventory\b/i],
];

test("no live document advertises the retired JSON routing route (#513)", () => {
  const offenders: string[] = [];
  for (const file of LIVE_DOCS) {
    const text = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
    for (const [claim, pattern] of RETIRED_CLAIMS)
      if (pattern.test(text)) offenders.push(`${file}: ${claim}`);
  }
  expect(offenders).toEqual([]);
});

test("the append-only logs state the retirement a revert would delete (#513)", () => {
  // The weaker half, and deliberately so: a log cannot be checked for absence,
  // because absence of a phrase is what all of its history looks like. What a
  // revert of these two files DOES delete is the entry that says the route is
  // gone, so that is what is pinned.
  const changelog = fs.readFileSync(path.join(REPO_ROOT, "CHANGELOG.md"), "utf8");
  expect(changelog).toContain("is gone from the code, not merely unselected");
  const contract = fs.readFileSync(path.join(REPO_ROOT, "docs/contracts/config.md"), "utf8");
  expect(contract).toContain("is the ONLY routing source");
});
