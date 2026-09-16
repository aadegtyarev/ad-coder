import { expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
): Promise<string[]> {
  spawned.length = 0;
  const launcher = backgroundHostLauncherFor(BOUNDARY_TARGET, ownerId, buildFlags(flagPairs));
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
