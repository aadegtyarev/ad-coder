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

test("registry readiness accepts one complete JSON string amid npm warning lines", async () => {
  const run: RegistryCommandRunner = async () =>
    reply(
      'npm warn cli npm v11.5.1 does not support Node.js v20.18.0\n"0.181.22"\nnpm warn Unknown user config "always-auth"\n',
    );
  await expect(
    waitForRegistryReadiness({
      packageName: "ad-coder-dev",
      version: "0.181.22",
      maxAttempts: 1,
      delayMs: 0,
      run,
    }),
  ).resolves.toEqual({ attempts: 1 });
});

test("registry readiness rejects malformed, ambiguous, and non-string noisy JSON", async () => {
  for (const stdout of [
    'npm warn cli\n"0.181.22\n',
    'npm warn cli\n"0.181.22"\n"0.181.22"\n',
    'npm warn cli\n["0.181.22"]\n',
  ]) {
    const failure = await waitForRegistryReadiness({
      packageName: "ad-coder-dev",
      version: "0.181.22",
      maxAttempts: 1,
      delayMs: 0,
      run: async () => reply(stdout),
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RegistryPropagationPendingError);
    expect((failure as RegistryPropagationPendingError).message).toContain("returned invalid JSON");
  }
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
