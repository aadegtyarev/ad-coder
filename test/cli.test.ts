import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const CLI = path.join(REPO_ROOT, "src/cli.ts");

function runCli(args: string[]): { code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["bun", "run", CLI, ...args], { cwd: REPO_ROOT });
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

test("root help succeeds on stdout and failure usage is registry-derived", () => {
  for (const flag of ["--help", "-h"]) {
    const { code, stdout, stderr } = runCli([flag]);
    expect(code).toBe(0);
    expect(stdout).toContain("usage: ad-coder <command> [options]");
    expect(stdout).toContain("run     Run a workflow module.");
    expect(stdout).toContain("role    Run one pipeline role once.");
    expect(stdout).toContain("drive   Interactively drive the built-in pipeline.");
    expect(stdout).toContain("console Chat with the persistent orchestrator session.");
    expect(stderr).toBe("");
  }

  for (const args of [[], ["unknown"], ["run", "example.ts", "--provider", "x"]]) {
    const { code, stdout, stderr } = runCli(args);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("usage: ad-coder <command> [options]");
  }
});

test("each command renders its own help before validating required input", () => {
  const commandHelps: ReadonlyArray<readonly [string, string, string]> = [
    ["run", "<script.ts>", "--provider"],
    ["role", "<planner|coder|reviewer|security>", "--auto"],
    ["drive", "--auto", "<planner|coder|reviewer|security>"],
    ["console", "--max-input-bytes", "<planner|coder|reviewer|security>"],
  ];
  for (const [command, expected, absent] of commandHelps) {
    for (const flag of ["--help", "-h"]) {
      const { code, stdout, stderr } = runCli([command, flag]);
      expect(code).toBe(0);
      expect(stdout).toContain(`usage: ad-coder ${command}`);
      expect(stdout).toContain(expected);
      expect(stdout).not.toContain(absent);
      expect(stderr).toBe("");
    }
  }
  const { code, stdout, stderr } = runCli(["role", "planner", "--help"]);
  expect(code).toBe(0);
  expect(stdout).toContain("Role to run.");
  expect(stderr).toBe("");
});

test("console help is registry-derived and invalid input limits fail before provider access", () => {
  const help = runCli(["console", "--help"]);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("usage: ad-coder console --target-dir <dir> [options]");
  for (const option of [
    "--target-dir <dir> (required)",
    "--json",
    "--max-input-bytes <n>",
    "--provider <provider>",
    "--strong-model <name>",
    "--max-rounds <n>",
    "--default-complexity <complexity>",
  ]) {
    expect(help.stdout).toContain(option);
  }

  expect(runCli(["console"]).stderr).toContain("--target-dir is required");
  for (const value of ["0", "-1", "1.5", "", "nope"]) {
    const result = runCli(["console", "--target-dir", ".", `--max-input-bytes=${value}`]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("invalid --max-input-bytes");
  }
  expect(runCli(["console", "--unknown"]).stderr).toContain("unknown option");
  expect(runCli(["console", "extra"]).stderr).toContain("accepts no positional arguments");
});

test("running the example workflow prints its result and exits 0", () => {
  const { code, stdout } = runCli(["run", "examples/hello.workflow.ts"]);
  expect(code).toBe(0);
  const result = JSON.parse(stdout) as { greeting: string; runId: string };
  expect(result.greeting).toBe("hello from ad-coder");
  expect(result.runId).toMatch(/^[0-9a-f-]{36}$/);
});

test("a missing command, a missing file and a URL specifier each exit 2", () => {
  for (const args of [
    [],
    ["run"],
    ["plan", "x.ts"],
    ["run", "./nope.ts"],
    ["run", "https://evil.example/x.ts"],
  ]) {
    const { code, stdout, stderr } = runCli(args);
    expect(code).toBe(2);
    expect(stderr).toContain("usage: ad-coder <command> [options]");
    expect(stdout).toBe("");
  }
  expect(runCli(["run", "https://evil.example/x.ts"]).stderr).toContain("URL specifier");
});

test("a directory argument is refused rather than imported", () => {
  const { code, stderr } = runCli(["run", "examples"]);
  expect(code).toBe(2);
  expect(stderr).toContain("not a regular file");
});

test("a module without the workflow shape exits 2 with a clear message", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-cli-"));
  try {
    const bad = path.join(dir, "bad.workflow.ts");
    fs.writeFileSync(bad, "export default { name: 42 };\n", { mode: 0o600 });
    const { code, stderr } = runCli(["run", bad]);
    expect(code).toBe(2);
    expect(stderr).toContain("must default-export");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("without --target-dir ctx.runRole is absent; with it the workflow sees a runner", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-cli-"));
  try {
    const probe = path.join(dir, "probe.workflow.ts");
    fs.writeFileSync(
      probe,
      "export default { name: 'probe', async run(ctx) { return { hasRunRole: typeof ctx.runRole?.runRole === 'function' }; } };\n",
      { mode: 0o600 },
    );

    const target = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-target-"));
    try {
      const without = runCli(["run", probe]);
      expect(without.code).toBe(0);
      expect((JSON.parse(without.stdout) as { hasRunRole: boolean }).hasRunRole).toBe(false);

      const withTarget = runCli(["run", probe, "--target-dir", target]);
      expect(withTarget.code).toBe(0);
      expect((JSON.parse(withTarget.stdout) as { hasRunRole: boolean }).hasRunRole).toBe(true);
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a workflow that throws exits 1 with only the error message", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-cli-"));
  try {
    const boom = path.join(dir, "boom.workflow.ts");
    fs.writeFileSync(
      boom,
      "export default { name: 'boom', async run() { throw new Error('provider exploded'); } };\n",
      { mode: 0o600 },
    );
    const { code, stderr } = runCli(["run", boom]);
    expect(code).toBe(1);
    expect(stderr).toContain("provider exploded");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
