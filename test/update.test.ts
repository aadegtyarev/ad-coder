import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { UpdateCommandRunner, UpdateErrorCode } from "../src/update/updater";
import {
  readInstalledRevision,
  UpdateError,
  updateAdCoder,
  updateCheckout,
} from "../src/update/updater";

const checkoutDir = process.cwd();

function runner(
  overrides: Record<string, { exitCode?: number; stdout?: string; stderr?: string }> = {},
) {
  const calls: string[][] = [];
  const run: UpdateCommandRunner = async (argv) => {
    calls.push([...argv]);
    const key = argv.join(" ");
    const defaults: Record<string, { exitCode?: number; stdout?: string; stderr?: string }> = {
      "git rev-parse --show-toplevel": { stdout: checkoutDir },
      "git status --porcelain=v1 --untracked-files=normal": { stdout: "" },
      "git symbolic-ref --quiet --short HEAD": { stdout: "main" },
      "git rev-parse --abbrev-ref --symbolic-full-name @{upstream}": { stdout: "origin/main" },
      "git rev-parse HEAD": {
        stdout:
          calls.filter((call) => call.join(" ") === "git rev-parse HEAD").length === 1
            ? "old"
            : "new",
      },
    };
    const value = overrides[key] ?? defaults[key] ?? { stdout: "" };
    return {
      exitCode: value.exitCode ?? 0,
      stdout: value.stdout ?? "",
      stderr: value.stderr ?? "",
    };
  };
  return { run, calls };
}

test("updates a clean tracked checkout with fixed non-shell argv", async () => {
  const fake = runner();
  const steps: string[] = [];
  const result = await updateCheckout({
    checkoutDir,
    run: fake.run,
    onStep: (step) => steps.push(step),
  });
  expect(result).toMatchObject({
    mode: "linked-checkout",
    branch: "main",
    upstream: "origin/main",
    previousRevision: "old",
    revision: "new",
    changed: true,
  });
  expect(fake.calls).toContainEqual(["git", "pull", "--ff-only"]);
  expect(fake.calls).toContainEqual(["bun", "install", "--frozen-lockfile", "--ignore-scripts"]);
  expect(fake.calls).toContainEqual(["bun", "link"]);
  expect(steps).toEqual(["pull", "install", "link"]);
});

test("updates a global install from the exact GitHub main revision", async () => {
  const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-global-update-"));
  const revision = "a".repeat(40);
  const calls: string[][] = [];
  const run: UpdateCommandRunner = async (argv) => {
    calls.push([...argv]);
    return {
      exitCode: 0,
      stdout: argv[1] === "ls-remote" ? `${revision}\trefs/heads/main\n` : "",
      stderr: "",
    };
  };
  try {
    const result = await updateAdCoder({
      checkoutDir: packageDir,
      run,
      readInstalledRevision: () => revision.slice(0, 7),
    });
    expect(result).toMatchObject({ mode: "global-github", revision, branch: "main" });
    expect(calls).toContainEqual([
      "bun",
      "add",
      "--global",
      "--force",
      `github:aadegtyarev/ad-coder#${revision}`,
    ]);
  } finally {
    fs.rmSync(packageDir, { recursive: true, force: true });
  }
});

test("refuses a dirty checkout before mutation", async () => {
  const fake = runner({
    "git status --porcelain=v1 --untracked-files=normal": { stdout: " M src/cli.ts" },
  });
  await expect(updateCheckout({ checkoutDir, run: fake.run })).rejects.toMatchObject({
    code: "dirty_checkout",
  });
  expect(fake.calls).not.toContainEqual(["git", "pull", "--ff-only"]);
});

test("reports detached heads, missing upstreams, and failed pulls", async () => {
  await expect(
    updateCheckout({
      checkoutDir,
      run: runner({ "git symbolic-ref --quiet --short HEAD": { exitCode: 1 } }).run,
    }),
  ).rejects.toMatchObject({ code: "detached_head" });
  await expect(
    updateCheckout({
      checkoutDir,
      run: runner({
        "git rev-parse --abbrev-ref --symbolic-full-name @{upstream}": { exitCode: 1 },
      }).run,
    }),
  ).rejects.toMatchObject({ code: "missing_upstream" });
  await expect(
    updateCheckout({
      checkoutDir,
      run: runner({ "git pull --ff-only": { exitCode: 1, stderr: "not fast-forward" } }).run,
    }),
  ).rejects.toBeInstanceOf(UpdateError);
});

test("a verified global install reports the revision it replaced", async () => {
  const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-global-update-"));
  const revision = "a".repeat(40);
  const steps: string[] = [];
  let installed = "b".repeat(7);
  const run: UpdateCommandRunner = async (argv) => {
    if (argv[1] === "add") installed = revision.slice(0, 7);
    return {
      exitCode: 0,
      stdout: argv[1] === "ls-remote" ? `${revision}\trefs/heads/main\n` : "",
      stderr: "",
    };
  };
  try {
    const result = await updateAdCoder({
      checkoutDir: packageDir,
      run,
      onStep: (step) => steps.push(step),
      readInstalledRevision: () => installed,
    });
    expect(result).toMatchObject({
      mode: "global-github",
      previousRevision: "b".repeat(7),
      revision,
      changed: true,
    });
    expect(steps).toEqual(["resolve", "install", "verify"]);
  } finally {
    fs.rmSync(packageDir, { recursive: true, force: true });
  }
});

test("a global install already at the resolved revision is not reported as changed", async () => {
  const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-global-update-"));
  const revision = "a".repeat(40);
  const run: UpdateCommandRunner = async (argv) => ({
    exitCode: 0,
    stdout: argv[1] === "ls-remote" ? `${revision}\trefs/heads/main\n` : "",
    stderr: "",
  });
  try {
    const result = await updateAdCoder({
      checkoutDir: packageDir,
      run,
      readInstalledRevision: () => revision.slice(0, 7),
    });
    expect(result.changed).toBe(false);
    expect(result.previousRevision).toBe(revision.slice(0, 7));
  } finally {
    fs.rmSync(packageDir, { recursive: true, force: true });
  }
});

test("an install Bun swallowed fails instead of reporting success", async () => {
  const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-global-update-"));
  const revision = "a".repeat(40);
  const stale = "9e8c433";
  const run: UpdateCommandRunner = async (argv) => ({
    exitCode: 0,
    stdout: argv[1] === "ls-remote" ? `${revision}\trefs/heads/main\n` : "",
    stderr: "",
  });
  try {
    // `bun add` exits 0 while a stale lockfile pin keeps the old revision installed.
    const failure = await updateAdCoder({
      checkoutDir: packageDir,
      run,
      readInstalledRevision: () => stale,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(UpdateError);
    const error = failure as UpdateError;
    expect(error.code).toBe("install_mismatch");
    expect(error.detail).toBe(stale);
    expect(error.message).toContain(stale);
    expect(error.retryable).toBe(false);
    expect(error.nextAction).toContain("bun.lock");
  } finally {
    fs.rmSync(packageDir, { recursive: true, force: true });
  }
});

test("an unreadable installed revision fails rather than assuming the install landed", async () => {
  const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-global-update-"));
  const revision = "a".repeat(40);
  const run: UpdateCommandRunner = async (argv) => ({
    exitCode: 0,
    stdout: argv[1] === "ls-remote" ? `${revision}\trefs/heads/main\n` : "",
    stderr: "",
  });
  try {
    const failure = await updateAdCoder({
      checkoutDir: packageDir,
      run,
      readInstalledRevision: () => null,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(UpdateError);
    const error = failure as UpdateError;
    expect(error.code).toBe("install_unverifiable");
    expect(error.retryable).toBe(false);
    expect(error.nextAction).toContain("bun add --global --force");
  } finally {
    fs.rmSync(packageDir, { recursive: true, force: true });
  }
});

test("readInstalledRevision reads a revision from the Bun tag, or reports none", () => {
  const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-bun-tag-"));
  try {
    expect(readInstalledRevision(packageDir)).toBeNull();
    fs.writeFileSync(path.join(packageDir, ".bun-tag"), "aadegtyarev-ad-coder-9d926c5\n");
    expect(readInstalledRevision(packageDir)).toBe("9d926c5");
    fs.writeFileSync(path.join(packageDir, ".bun-tag"), "ad-coder-v0.4.0\n");
    expect(readInstalledRevision(packageDir)).toBeNull();
  } finally {
    fs.rmSync(packageDir, { recursive: true, force: true });
  }
});

test("an install whose prior revision is unknown is reported as changed, never as current", async () => {
  const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-global-update-"));
  const revision = "a".repeat(40);
  let installed: string | null = null;
  const run: UpdateCommandRunner = async (argv) => {
    if (argv[1] === "add") installed = revision.slice(0, 7);
    return {
      exitCode: 0,
      stdout: argv[1] === "ls-remote" ? `${revision}\trefs/heads/main\n` : "",
      stderr: "",
    };
  };
  try {
    const result = await updateAdCoder({
      checkoutDir: packageDir,
      run,
      readInstalledRevision: () => installed,
    });
    // An unreadable previous revision is not evidence the install was current.
    expect(result.previousRevision).toBe("unknown");
    expect(result.changed).toBe(true);
  } finally {
    fs.rmSync(packageDir, { recursive: true, force: true });
  }
});

test("every update failure carries a code, retryability, and a recovery action", async () => {
  const revision = "a".repeat(40);
  const cases: Array<{ code: UpdateErrorCode; options: Parameters<typeof updateCheckout>[0] }> = [
    {
      code: "dirty_checkout",
      options: {
        checkoutDir,
        run: runner({
          "git status --porcelain=v1 --untracked-files=normal": { stdout: " M src/cli.ts" },
        }).run,
      },
    },
    {
      code: "detached_head",
      options: {
        checkoutDir,
        run: runner({ "git symbolic-ref --quiet --short HEAD": { exitCode: 1 } }).run,
      },
    },
    {
      code: "missing_upstream",
      options: {
        checkoutDir,
        run: runner({
          "git rev-parse --abbrev-ref --symbolic-full-name @{upstream}": { exitCode: 1 },
        }).run,
      },
    },
    {
      code: "command_failed",
      options: {
        checkoutDir,
        run: runner({ "git pull --ff-only": { exitCode: 1, stderr: "not fast-forward" } }).run,
      },
    },
  ];
  for (const { code, options } of cases) {
    const failure = (await updateCheckout(options).catch((error: unknown) => error)) as UpdateError;
    expect(failure).toBeInstanceOf(UpdateError);
    expect(failure.code).toBe(code);
    // A recovery exists for every one of these, so every one must project it.
    expect(failure.nextAction).toBeDefined();
    expect((failure.nextAction as string).length).toBeGreaterThan(0);
    // The action is a next step, not a restatement of the failure.
    expect(failure.message).not.toContain(failure.nextAction as string);
  }

  const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-global-update-"));
  try {
    const invalid = (await updateAdCoder({
      checkoutDir: packageDir,
      run: async () => ({ exitCode: 0, stdout: "not-a-sha\trefs/heads/main\n", stderr: "" }),
    }).catch((error: unknown) => error)) as UpdateError;
    expect(invalid.code).toBe("invalid_revision");
    expect(invalid.retryable).toBe(true);
    expect(invalid.nextAction).toContain("git ls-remote");
    expect(revision).toHaveLength(40);
  } finally {
    fs.rmSync(packageDir, { recursive: true, force: true });
  }
});

test("a runner that cannot spawn is translated at the boundary with its cause kept", async () => {
  const cause = new Error("spawn git ENOENT");
  const failure = (await updateCheckout({
    checkoutDir,
    run: async () => {
      throw cause;
    },
  }).catch((error: unknown) => error)) as UpdateError;
  expect(failure).toBeInstanceOf(UpdateError);
  expect(failure.code).toBe("command_failed");
  expect(failure.retryable).toBe(false);
  expect(failure.nextAction).toContain("on PATH");
  // The causal error reaches programmatic callers; the projection stays safe.
  expect(failure.cause).toBe(cause);
  expect(failure.message).not.toContain("ENOENT");
});

test("an UpdateError defaults to not retryable rather than inviting a doomed retry", () => {
  const error = new UpdateError("not_checkout", "/somewhere", "no checkout");
  expect(error.retryable).toBe(false);
  expect(error.nextAction).toBeUndefined();
  expect(error.cause).toBeUndefined();
});
