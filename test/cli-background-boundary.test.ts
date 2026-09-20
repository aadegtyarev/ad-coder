import { expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ResolvePipelineConfigOptions } from "../src/cli/resolve-config";
import { DEFAULT_BACKGROUND_RUN_LIMITS } from "../src/orchestration/background-runs";

// The launcher points the detached worker at process.argv[1], which in this
// test process is this very file. Re-executed as a worker there is no CLI to
// dispatch; the recorder below spawns it for real, so leave immediately.
if (process.argv[2] === "background") process.exit(0);

/**
 * Capability switches cross the process boundary inside the detached worker's
 * command: `docs/contracts/config.md` requires an explicit off to reach every
 * process, and issue #245 was filed because `--no-skills` stopped at the
 * console. Observed here by invoking the seam every background front builds
 * its launcher through, recording the argv `spawn` was called with and then
 * DELEGATING to the real spawn, so everything else keeps its shouted real
 * behavior. The reread entrypoint at the top of this file exits immediately.
 */
type SpawnCall = { args: readonly string[]; env: Record<string, unknown> | undefined };
const spawned: SpawnCall[] = [];

mock.module("node:child_process", () => {
  // Every exported symbol stays real; `spawn` records and delegates.
  const actual = require("node:child_process") as typeof import("node:child_process");
  const { spawn: realSpawn } = actual;
  return {
    ...actual,
    spawn: (
      first: string,
      rest: readonly string[],
      options?: import("node:child_process").SpawnOptions,
    ) => {
      spawned.push({
        args: [first, ...rest],
        env: options?.env as Record<string, unknown> | undefined,
      });
      return realSpawn(first, rest, options ?? {});
    },
  };
});

// Imported after the mock, so src/cli.ts binds the observing fake.
const cli: typeof import("../src/cli") = await import("../src/cli");
const { backgroundHostLauncherFor } = cli;

const RUN_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OWNER = "boundary-owner";
const BOUNDARY_TARGET = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-boundary-"));

/** Flag table from `command run` input, like parseArgs produces it. */
const buildFlags = (pairs: ReadonlyArray<[string, string]>): Record<string, string | undefined> =>
  Object.fromEntries([...pairs, ["--json", ""], ["--target-dir", BOUNDARY_TARGET]]);

/** The launch words the detached worker sees, past bun, the entrypoint, and the action. */
async function workerWords(
  flagPairs: ReadonlyArray<[string, string]>,
  ownerId = OWNER,
  configOptions?: Omit<ResolvePipelineConfigOptions, "task">,
): Promise<string[]> {
  spawned.length = 0;
  const launcher = backgroundHostLauncherFor(
    BOUNDARY_TARGET,
    ownerId,
    buildFlags(flagPairs),
    configOptions,
  );
  await launcher({
    runId: RUN_ID,
    task: "boundary task",
    limits: DEFAULT_BACKGROUND_RUN_LIMITS,
  });
  expect(spawned.length).toBe(1);
  // [bun, <entrypoint>, "background", "worker", ...flags]
  const [call] = spawned;
  if (call === undefined) return [];
  return call.args.slice(4);
}

test("the worker command shape is admitted-and-launched as before", async () => {
  expect(await workerWords([])).toEqual([
    "--target-dir",
    BOUNDARY_TARGET,
    "--id",
    RUN_ID,
    "--owner-id",
    OWNER,
  ]);
});

test("the explicit skills off reaches the worker command", async () => {
  const words = await workerWords([["--no-skills", ""]]);
  // No pin, and the off is present -- issue #245 failed exactly this sentence.
  expect(words).toContain("--no-skills");
  expect(words).not.toContain("--skills");
});

test("a pin still reaches the worker command verbatim", async () => {
  const words = await workerWords([["--skills", "repository-navigation,acceptance-review"]]);
  expect(words).toContain("--skills");
  expect(words).toContain("repository-navigation,acceptance-review");
  expect(words).not.toContain("--no-skills");
});

test("the workflows off reaches the worker command", async () => {
  const words = await workerWords([["--workflows", "false"]]);
  expect(words).toEqual(
    expect.arrayContaining([
      "--target-dir",
      expect.any(String),
      "--id",
      RUN_ID,
      "--owner-id",
      expect.any(String),
      "--workflows",
      "false",
    ]),
  );
});

test("the plugins off reaches the worker command", async () => {
  const words = await workerWords([["--plugins", "none"]]);
  expect(words).toEqual(expect.arrayContaining(["--plugins", "none"]));
});

test("an explicit off plus a selected member stays verbatim, not defaulted", async () => {
  const words = await workerWords([
    ["--workflows", "^pipeline"],
    ["--plugins", "explore"],
  ]);
  expect(words).toEqual(
    expect.arrayContaining(["--workflows", "^pipeline", "--plugins", "explore"]),
  );
});

test("the profile off reaches the worker command without a flag", async () => {
  // The persistent setting is re-read by the worker on its own, so the flag
  // need not travel; the launcher must not override the setting with a
  // built-in default, though -- which an explicit false would do.
  const words = await workerWords([]);
  expect(words).not.toContain("--skills");
  expect(words).not.toContain("--no-skills");
});

// ---------------------------------------------------------------------------
// (#453) the operator's typed routing/credential selection crosses the
// boundary into the detached worker verbatim -- and only when typed. An
// absent flag stays absent so the worker's own default-file resolution
// stays its own.

const ROUTING_CREDENTIAL_FLAGS = [
  "--models-config",
  "--settings-config",
  // The two JSON-inventory flags this table carried were retired with the JSON
  // route (issue #513) and are refused as unknown options now; the routing
  // selection is `--models-profile`, a profile inside the models.yaml the seam
  // already reads.
  "--models-profile",
  "--registry-config",
  "--profile-config",
  "--credential-path",
  "--provider",
] as const;

for (const flag of ROUTING_CREDENTIAL_FLAGS) {
  // These values are launch WORDS to carry, not a config the launcher must
  // resolve: this table proves the boundary's verbatim translation, so the
  // launcher is handed a minimal injected config and reads no file. Going
  // through the console's own resolution instead needs a REAL document per
  // JSON flag -- `readJsonConfig` exits when the path cannot be read -- and a
  // `--provider` that names a shipped provider, both of which are different
  // subjects with their own tests. Paths stay under the temp root the
  // neighbouring tests already derive theirs from.
  const TRANSLATION_ONLY: Omit<ResolvePipelineConfigOptions, "task"> = {
    targetDir: BOUNDARY_TARGET,
  };

  test(`(#453) the typed ${flag} reaches the worker command verbatim`, async () => {
    const value = path.join(BOUNDARY_TARGET, `${flag.slice(2)}.example`);
    const words = await workerWords([[flag, value]], OWNER, TRANSLATION_ONLY);
    expect(words).toEqual(expect.arrayContaining([flag, value]));
  });

  test(`(#453) an absent ${flag} is not invented by the launcher`, async () => {
    const words = await workerWords([], OWNER, TRANSLATION_ONLY);
    expect(words).not.toContain(flag);
  });
}
