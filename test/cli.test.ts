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

test("running the example workflow prints its result and exits 0", () => {
  const { code, stdout } = runCli(["run", "examples/hello.workflow.ts"]);
  expect(code).toBe(0);
  const result = JSON.parse(stdout) as { greeting: string; runId: string };
  expect(result.greeting).toBe("hello from ad-coder");
  expect(result.runId).toMatch(/^[0-9a-f-]{36}$/);
});

test("a missing command, a missing file and a URL specifier each exit 2", () => {
  for (const args of [[], ["run"], ["plan", "x.ts"], ["run", "./nope.ts"], ["run", "https://evil.example/x.ts"]]) {
    const { code, stdout, stderr } = runCli(args);
    expect(code).toBe(2);
    expect(stderr).toContain("usage: ad-coder run <script.ts>");
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
