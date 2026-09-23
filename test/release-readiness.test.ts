import { expect, test } from "bun:test";
import {
  type RegistryCommandRunner,
  RegistryPropagationPendingError,
  waitForRegistryReadiness,
} from "../scripts/wait-registry-readiness";

function reply(stdout: string, exitCode = 0) {
  return { exitCode, stdout, stderr: "not found" };
}

test("registry readiness waits for both the exact version and latest dist-tag", async () => {
  const calls: string[][] = [];
  let exactLookups = 0;
  const run: RegistryCommandRunner = async (argv) => {
    calls.push(argv);
    if (argv[2]?.includes("@0.181.21")) {
      exactLookups += 1;
      return reply('"0.181.21"');
    }
    return reply(exactLookups < 2 ? '"0.181.20"' : '"0.181.21"');
  };
  const sleeps: number[] = [];
  await expect(
    waitForRegistryReadiness({
      packageName: "ad-coder-dev",
      version: "0.181.21",
      maxAttempts: 3,
      delayMs: 7,
      run,
      sleep: async (delay) => void sleeps.push(delay),
    }),
  ).resolves.toEqual({ attempts: 2 });
  expect(calls).toEqual([
    ["npm", "view", "ad-coder-dev@0.181.21", "version", "--json"],
    ["npm", "view", "ad-coder-dev", "dist-tags.latest", "--json"],
    ["npm", "view", "ad-coder-dev@0.181.21", "version", "--json"],
    ["npm", "view", "ad-coder-dev", "dist-tags.latest", "--json"],
  ]);
  expect(sleeps).toEqual([7]);
});

test("registry readiness times out without attempting another publish", async () => {
  const calls: string[][] = [];
  const run: RegistryCommandRunner = async (argv) => {
    calls.push(argv);
    return reply("", 1);
  };
  const failure = await waitForRegistryReadiness({
    packageName: "ad-coder-dev",
    version: "0.181.21",
    maxAttempts: 2,
    delayMs: 0,
    run,
    sleep: async () => undefined,
  }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(RegistryPropagationPendingError);
  expect((failure as RegistryPropagationPendingError).message).toContain("will not be republished");
  expect(calls).toHaveLength(4);
  expect(calls.flat()).not.toContain("publish");
});

test("registry readiness rejects an unbounded or invalid retry configuration", async () => {
  const run: RegistryCommandRunner = async () => reply('"0.181.21"');
  await expect(
    waitForRegistryReadiness({
      packageName: "ad-coder-dev",
      version: "0.181.21",
      maxAttempts: 0,
      delayMs: 0,
      run,
    }),
  ).rejects.toThrow("maxAttempts");
});
