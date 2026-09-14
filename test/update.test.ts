import { expect, test } from "bun:test";
import type { UpdateCommandRunner } from "../src/update/updater";
import { UpdateError, updateCheckout } from "../src/update/updater";

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
