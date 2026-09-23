import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  type RegistryCommandRunner,
  RegistryPropagationPendingError,
  registryReadinessTarget,
  waitForRegistryReadiness,
} from "../scripts/wait-registry-readiness";

function reply(stdout: string, exitCode = 0) {
  return { exitCode, stdout, stderr: "not found" };
}

const tarballBytes = new TextEncoder().encode("tarball");
const matchingDist = JSON.stringify({
  tarball: "https://registry.npmjs.org/ad-coder-dev/-/ad-coder-dev-0.181.21.tgz",
  integrity: `sha512-${createHash("sha512").update(tarballBytes).digest("base64")}`,
});

test("registry readiness requires the exact published coordinates", () => {
  expect(
    registryReadinessTarget(["--package-name", "ad-coder-dev", "--version", "0.181.47-dev.137"]),
  ).toEqual({ packageName: "ad-coder-dev", version: "0.181.47-dev.137" });
  expect(registryReadinessTarget(["--package-name", "ad-coder", "--version", "0.181.47"])).toEqual({
    packageName: "ad-coder",
    version: "0.181.47",
  });
  for (const argv of [
    [],
    ["--package-name", "ad-coder", "--version"],
    ["--package-name", "ad-coder", "--version", ""],
    ["--package-name", "ad-coder\nforged=true", "--version", "0.181.47"],
  ])
    expect(() => registryReadinessTarget(argv)).toThrow();
});

test("release workflow preserves dev and stable publish coordinates for readiness", () => {
  const workflow = Bun.file(new URL("../.github/workflows/release.yml", import.meta.url)).text();
  return workflow.then((source) => {
    const actionsExpression = "$" + "{{";
    expect(source).toContain("if: steps.channel.outputs.dev == 'true'");
    expect(source).toContain(
      `bun run scripts/dev-package.ts "${actionsExpression} steps.channel.outputs.tag }}"`,
    );
    expect(source).toContain("id: package");
    expect(source).toContain('const { name, version } = require("./package.json")');
    expect(source).toContain(`--package-name "${actionsExpression} steps.package.outputs.name }}"`);
    expect(source).toContain(`--version "${actionsExpression} steps.package.outputs.version }}"`);
    expect(source.indexOf("id: package")).toBeLessThan(
      source.indexOf("bun run scripts/publish-registry-package.ts --tag latest"),
    );
    expect(source.indexOf("id: package")).toBeLessThan(
      source.indexOf("bun run scripts/publish-registry-package.ts\n"),
    );
  });
});

test("registry readiness waits for both the exact version and latest dist-tag", async () => {
  const calls: string[][] = [];
  let exactLookups = 0;
  const run: RegistryCommandRunner = async (argv) => {
    calls.push(argv);
    if (argv[3] === "dist") return reply(matchingDist);
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
      fetchTarball: async () => ({ ok: true, status: 200, bytes: tarballBytes }),
      sleep: async (delay) => void sleeps.push(delay),
    }),
  ).resolves.toEqual({ attempts: 2 });
  expect(calls).toEqual([
    ["npm", "view", "ad-coder-dev@0.181.21", "version", "--json", "--prefer-online"],
    ["npm", "view", "ad-coder-dev", "dist-tags.latest", "--json", "--prefer-online"],
    ["npm", "view", "ad-coder-dev@0.181.21", "version", "--json", "--prefer-online"],
    ["npm", "view", "ad-coder-dev", "dist-tags.latest", "--json", "--prefer-online"],
    ["npm", "view", "ad-coder-dev@0.181.21", "dist", "--json", "--prefer-online"],
  ]);
  expect(sleeps).toEqual([7]);
});

test("registry readiness accepts one complete JSON string amid npm warning lines", async () => {
  const run: RegistryCommandRunner = async (argv) =>
    argv[3] === "dist"
      ? reply(matchingDist)
      : reply(
          'npm warn cli npm v11.5.1 does not support Node.js v20.18.0\n"0.181.22"\nnpm warn Unknown user config "always-auth"\n',
        );
  await expect(
    waitForRegistryReadiness({
      packageName: "ad-coder-dev",
      version: "0.181.22",
      maxAttempts: 1,
      delayMs: 0,
      run,
      fetchTarball: async () => ({ ok: true, status: 200, bytes: tarballBytes }),
    }),
  ).resolves.toEqual({ attempts: 1 });
});

test("registry readiness does not report success until the advertised tarball downloads", async () => {
  const calls: string[][] = [];
  const failure = await waitForRegistryReadiness({
    packageName: "ad-coder-dev",
    version: "0.181.21",
    maxAttempts: 1,
    delayMs: 0,
    run: async (argv) => {
      calls.push(argv);
      return argv[3] === "dist" ? reply(matchingDist) : reply('"0.181.21"');
    },
    fetchTarball: async () => ({ ok: false, status: 404, bytes: new Uint8Array() }),
  }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(RegistryPropagationPendingError);
  expect((failure as RegistryPropagationPendingError).message).toContain(
    "tarball fetch returned HTTP 404",
  );
  expect(calls).toEqual([
    ["npm", "view", "ad-coder-dev@0.181.21", "version", "--json", "--prefer-online"],
    ["npm", "view", "ad-coder-dev", "dist-tags.latest", "--json", "--prefer-online"],
    ["npm", "view", "ad-coder-dev@0.181.21", "dist", "--json", "--prefer-online"],
  ]);
});

test("registry readiness rejects a downloaded tarball whose bytes disagree with npm integrity", async () => {
  const failure = await waitForRegistryReadiness({
    packageName: "ad-coder-dev",
    version: "0.181.21",
    maxAttempts: 1,
    delayMs: 0,
    run: async (argv) => (argv[3] === "dist" ? reply(matchingDist) : reply('"0.181.21"')),
    fetchTarball: async () => ({ ok: true, status: 200, bytes: new TextEncoder().encode("wrong") }),
  }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(RegistryPropagationPendingError);
  expect((failure as RegistryPropagationPendingError).message).toContain(
    "tarball integrity mismatched",
  );
});

test("registry readiness does not reflect a tarball fetch exception into logs", async () => {
  const fetcherSecret = "https://token:registry-secret@example.invalid/private-tarball";
  const failure = await waitForRegistryReadiness({
    packageName: "ad-coder-dev",
    version: "0.181.21",
    maxAttempts: 1,
    delayMs: 0,
    run: async (argv) => (argv[3] === "dist" ? reply(matchingDist) : reply('"0.181.21"')),
    fetchTarball: async () => {
      throw new Error(`network refused ${fetcherSecret}`);
    },
  }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(RegistryPropagationPendingError);
  const message = (failure as RegistryPropagationPendingError).message;
  expect(message).toContain("tarball fetch failed before an HTTP response");
  expect(message).not.toContain(fetcherSecret);
  expect(message).not.toContain("network refused");
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

test("slow propagation reports each exact-version and latest observation", async () => {
  const pending: Array<{ attempt: number; status: string }> = [];
  let lookups = 0;
  const run: RegistryCommandRunner = async () => {
    lookups += 1;
    if (lookups <= 4)
      return lookups % 2 === 1
        ? { exitCode: 1, stdout: "", stderr: "npm error code E404\n" }
        : reply('"0.181.23-dev.122"');
    if (lookups === 7) return reply(matchingDist);
    return reply('"0.181.24-dev.123"');
  };
  await expect(
    waitForRegistryReadiness({
      packageName: "ad-coder-dev",
      version: "0.181.24-dev.123",
      maxAttempts: 3,
      delayMs: 0,
      run,
      fetchTarball: async () => ({ ok: true, status: 200, bytes: tarballBytes }),
      sleep: async () => undefined,
      onPending: (attempt, status) => pending.push({ attempt, status }),
    }),
  ).resolves.toEqual({ attempts: 3 });
  expect(pending).toEqual([
    { attempt: 1, status: 'exact lookup failed (E404); latest returned "0.181.23-dev.122"' },
    { attempt: 2, status: 'exact lookup failed (E404); latest returned "0.181.23-dev.122"' },
  ]);
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
