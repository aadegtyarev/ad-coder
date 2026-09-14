import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AuthInteraction, Models } from "@earendil-works/pi-ai";
import { FileCredentialStore } from "../src/auth/credential-store";
import { renderAuthEvent, runAuthCommand } from "../src/cli/auth";
import type { DurableRunRecord } from "../src/orchestration/control-plane";
import { ProjectStore } from "../src/project-store/project-store";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const CLI = path.join(REPO_ROOT, "src/cli.ts");

function runCli(
  args: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): { code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["bun", "run", CLI, ...args], {
    cwd: options.cwd ?? REPO_ROOT,
    env: options.env ?? process.env,
  });
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

test("background start propagates an explicit owner to the detached worker", async () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-background-cli-"));
  const ownerId = `fresh-owner-${Date.now()}`;
  const started = runCli([
    "background",
    "start",
    "detached regression task",
    "--target-dir",
    target,
    "--owner-id",
    ownerId,
  ]);
  expect(started.code).toBe(0);
  const runId = JSON.parse(started.stdout).runId as string;
  let lifecycle = "requested";
  const recordPath = path.join(target, ".ad-coder", "runs", "background", `${runId}.json`);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await Bun.sleep(100);
    try {
      const stored = JSON.parse(fs.readFileSync(recordPath, "utf8"));
      lifecycle = (stored.value ?? stored).lifecycle as string;
    } catch {
      // The detached worker may be between its atomic record writes.
    }
    if (["started", "failed", "cancelled", "timed_out", "completed"].includes(lifecycle)) break;
  }
  expect(lifecycle).not.toBe("requested");
  expect(["started", "failed", "cancelled", "timed_out", "completed"]).toContain(lifecycle);
  const status = runCli([
    "background",
    "status",
    "--target-dir",
    target,
    "--owner-id",
    ownerId,
    "--id",
    runId,
  ]);
  expect(status.code).toBe(0);
  // A detached worker can settle between the sampled record and this separate
  // status process. Status is authoritative after reconciliation, so require a
  // valid observed lifecycle rather than a stale byte-for-byte snapshot.
  expect(["started", "failed", "cancelled", "timed_out", "completed"]).toContain(
    JSON.parse(status.stdout).lifecycle,
  );
});

test("target dotenv cannot supply provider credentials", () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-target-env-"));
  fs.writeFileSync(path.join(target, ".env"), "DEEPSEEK_API_KEY=target-owned-value\n");
  const env = { ...process.env };
  delete env.DEEPSEEK_API_KEY;
  delete env.OPENROUTER_API_KEY;

  const result = runCli(
    ["role", "planner", "test", "--provider", "deepseek", "--target-dir", target],
    { cwd: target, env },
  );
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("environment credentials disabled");
  expect(result.stderr).toContain('environment variable "DEEPSEEK_API_KEY"');
  expect(result.stderr).not.toContain("target-owned-value");

  const explicitEnv = { ...env, DEEPSEEK_API_KEY: "operator-owned-value" };
  const external = runCli(
    ["config", "show", "--provider", "deepseek", "--target-dir", target, "--json"],
    { cwd: REPO_ROOT, env: explicitEnv },
  );
  expect(external.code).toBe(0);
  expect(external.stderr).toContain('provider destination "deepseek"');
  expect(external.stderr).not.toContain("operator-owned-value");
});

test("profile CLI previews and applies a portable import before exporting it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-profile-cli-"));
  try {
    const profilePath = path.join(root, "private", "profile.json");
    const inputPath = path.join(root, "portable.json");
    const portable = {
      version: 1,
      inventories: [{ name: "work", providers: [{ id: "codex", models: ["codex-terra"] }] }],
      calibratedRouting: [],
      economicRecords: [],
      subscriptionCapacityRanges: [],
    };
    fs.writeFileSync(inputPath, `${JSON.stringify(portable)}\n`);
    const args = ["--input", inputPath, "--mode", "merge", "--profile-path", profilePath];
    const preview = runCli(["profile", "import-preview", ...args]);
    expect(preview.code).toBe(0);
    expect(JSON.parse(preview.stdout)).toMatchObject({
      mode: "merge",
      creates: ["inventory:work"],
    });
    expect(fs.existsSync(profilePath)).toBe(false);

    const apply = runCli(["profile", "import-apply", ...args]);
    expect(apply.code).toBe(0);
    expect(JSON.parse(apply.stdout)).toEqual(portable);
    const exported = runCli(["profile", "export", "--profile-path", profilePath]);
    expect(exported.code).toBe(0);
    expect(JSON.parse(exported.stdout)).toEqual(portable);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("profile CLI appends a server-reported credit balance observation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-profile-credit-"));
  try {
    const profilePath = path.join(root, "private", "profile.json");
    const inputPath = path.join(root, "credit.json");
    fs.writeFileSync(
      inputPath,
      JSON.stringify({
        id: "codex-credit-balance-2026-09-14",
        observedAt: "2026-09-14T00:00:00.000Z",
        provider: "openai-codex",
        model: "gpt-5.6-terra",
        kind: "credit_balance",
        value: 500,
        unit: "credits",
        source: "provider-measurement",
        confidence: "provider_reported",
      }),
    );
    const result = runCli([
      "profile",
      "record",
      "--input",
      inputPath,
      "--profile-path",
      profilePath,
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).record).toMatchObject({
      kind: "credit_balance",
      value: 500,
      unit: "credits",
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("profile CLI writes a bounded project calibration snapshot", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-profile-snapshot-"));
  try {
    const profilePath = path.join(root, "profile.json");
    const inputPath = path.join(root, "portable.json");
    fs.writeFileSync(
      inputPath,
      JSON.stringify({
        version: 1,
        inventories: [{ name: "work", providers: [{ id: "codex", models: ["luna"] }] }],
        calibratedRouting: [
          {
            inventory: "work",
            profile: { entries: [{ role: "coder", complexity: "trivial", model: "luna" }] },
            observedOn: "2026-09-13",
            source: "benchmark",
            confidence: "measured",
          },
        ],
        economicRecords: [],
        subscriptionCapacityRanges: [],
      }),
    );
    expect(
      runCli([
        "profile",
        "import-apply",
        "--input",
        inputPath,
        "--mode",
        "replace",
        "--profile-path",
        profilePath,
      ]).code,
    ).toBe(0);
    const result = runCli([
      "profile",
      "snapshot",
      "--profile-path",
      profilePath,
      "--target-dir",
      root,
      "--inventory",
      "work",
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).file).toBe(path.join(root, ".ad-coder", "calibration.json"));
    expect(fs.existsSync(path.join(root, ".ad-coder", "calibration.json"))).toBe(true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("profile CLI returns stable JSON errors for invalid input, conflicts, and unsafe stores", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-profile-errors-"));
  try {
    const profilePath = path.join(root, "private", "profile.json");
    const runImport = (name: string, contents: string, action = "import-preview") => {
      const input = path.join(root, name);
      fs.writeFileSync(input, contents);
      return runCli([
        "profile",
        action,
        "--input",
        input,
        "--mode",
        "merge",
        "--profile-path",
        profilePath,
      ]);
    };
    for (const result of [runImport("bad-json", "{"), runImport("bad-profile", "{}")]) {
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stderr).error.code).toBe("invalid_profile");
    }

    const first = JSON.stringify({
      version: 1,
      inventories: [{ name: "work", providers: [{ id: "codex", models: ["terra"] }] }],
      calibratedRouting: [],
      economicRecords: [],
      subscriptionCapacityRanges: [],
    });
    expect(runImport("first", first, "import-apply").code).toBe(0);
    const conflicting = first.replace('"terra"', '"sol"');
    const conflict = runImport("conflict", conflicting);
    expect(conflict.code).toBe(0);
    expect(JSON.parse(conflict.stdout).conflicts).toEqual(["inventory:work"]);
    const applyConflict = runImport("conflict-apply", conflicting, "import-apply");
    expect(applyConflict.code).toBe(1);
    expect(JSON.parse(applyConflict.stderr).error.code).toBe("conflict");

    const unsafe = runCli(["profile", "show", "--profile-path", root]);
    expect(unsafe.code).toBe(1);
    expect(JSON.parse(unsafe.stderr).error.code).toBe("unsafe_file");

    const unreadable = path.join(root, "unreadable.json");
    fs.writeFileSync(unreadable, "{}", { mode: 0o000 });
    const ioFailure = runCli([
      "profile",
      "import-preview",
      "--input",
      unreadable,
      "--mode",
      "merge",
      "--profile-path",
      profilePath,
    ]);
    expect(ioFailure.code).toBe(1);
    expect(JSON.parse(ioFailure.stderr).error.code).toBe("io_error");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function cliLdoPlan(id: string): Record<string, unknown> {
  return {
    version: 1,
    id,
    root: "/historical/project",
    baseHead: "abc123",
    createdAt: "2026-09-12T00:00:00.000Z",
    task: "Imported CLI task",
    plan: {
      complexity: "medium",
      security_surface: "low",
      summary: "saved",
      steps: [{ what: "code", files: ["src/a.ts"], acceptance: "passes", user_facing: false }],
      risks: [],
      codebase_context: {
        stack: "TypeScript",
        conventions: "strict",
        relevant_files: [],
        test_command: "bun test",
        test_command_scoped: null,
        run_command: "bun test",
      },
    },
    security: null,
    usage: [],
  };
}

function cliCompletedRun(id: string): Record<string, unknown> {
  const source = cliLdoPlan(id);
  return {
    version: 1,
    id,
    root: source.root,
    baseHead: source.baseHead,
    task: source.task,
    plan: source.plan,
    security: null,
    status: "completed",
    startedAt: "2026-09-12T00:00:00.000Z",
    usage: [],
    completed: {
      coder: {
        summary: "coded",
        files_changed: [],
        tests: { result: "passed", command: "bun test" },
        docs_updated: [],
        deviations: [],
      },
      reviewer1: {
        status: "approved",
        summary: "approved",
        issues: [],
        verification: { verdict: "verified", criteria: [], blockers: [] },
        attacks: [],
      },
    },
    tokenUsage: {
      status: "unavailable",
      input_tokens: null,
      cache_creation_input_tokens: null,
      cached_input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      stages: [],
    },
    completedAt: "2026-09-12T00:01:00.000Z",
    approved: true,
    backlog: { destination: "none", file: null, count: 0 },
  };
}

test("root help succeeds on stdout and failure usage is registry-derived", () => {
  for (const flag of ["--help", "-h"]) {
    const { code, stdout, stderr } = runCli([flag]);
    expect(code).toBe(0);
    expect(stdout).toContain("usage: ad-coder <command> [options]");
    expect(stdout).toContain("auth    Manage persistent provider authentication.");
    expect(stdout).toContain("operations Run a project-operations action and emit JSON.");
    expect(stdout).toContain("run     Run a workflow module.");
    expect(stdout).toContain("role    Run one shipped role once.");
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
    ["auth", "<status|login|logout>", "--auto"],
    ["operations", "ldo-resume", "<script.ts>"],
    ["run", "<script.ts>", "--provider"],
    ["role", "<planner|researcher|coder|reviewer|auditor|security>", "--auto"],
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
  expect(runCli(["drive", "--help"]).stdout).toContain("--retry-research");
}, 10_000);

test("drive research retry requires a durable run id", () => {
  const result = runCli([
    "drive",
    "retry research",
    "--target-dir",
    import.meta.dir,
    "--retry-research",
  ]);
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("--retry-research requires --resume-run");
});

test("auth status and logout are scriptable and credential output is secret-free", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-auth-cli-"));
  const priorConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = root;
  const target = path.join(root, "project");
  const credentialPath = path.join(root, "private", "credentials.json");
  fs.mkdirSync(target);
  try {
    const status = runCli([
      "auth",
      "status",
      "--json",
      "--target-dir",
      target,
      "--credential-path",
      credentialPath,
    ]);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout)).toEqual({
      providerId: "openai-codex",
      authenticated: false,
    });
    expect(`${status.stdout}${status.stderr}`).not.toContain("access");
    expect(`${status.stdout}${status.stderr}`).not.toContain("refresh");

    const logoutResult = runCli([
      "auth",
      "logout",
      "--json",
      "--target-dir",
      target,
      "--credential-path",
      credentialPath,
    ]);
    expect(logoutResult.code).toBe(0);
    expect(JSON.parse(logoutResult.stdout)).toEqual({
      providerId: "openai-codex",
      authenticated: false,
    });

    const invalid = runCli(["auth", "status", "--credential-path", "relative.json"]);
    expect(invalid.code).not.toBe(0);
    expect(invalid.stdout).toBe("");
  } finally {
    if (priorConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = priorConfigHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("auth login selects browser and device-code flows without exposing credentials", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-auth-login-cli-"));
  const priorConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = root;
  const targetDir = path.join(root, "project");
  const credentialPath = path.join(root, "private", "credentials.json");
  fs.mkdirSync(targetDir);
  const selected: string[] = [];
  const secret = "sentinel-access-token";
  const refresh = "sentinel-refresh-token";
  const models = {
    getProvider: () => ({}),
    login: async (_providerId: string, _type: string, interaction: AuthInteraction) => {
      selected.push(
        await interaction.prompt({
          type: "select",
          message: "Choose login method",
          options: [
            { id: "browser", label: "Browser" },
            { id: "device_code", label: "Device code" },
          ],
        }),
      );
      interaction.notify({
        type: "auth_url",
        url: "https://auth.example.test/authorize",
        instructions: "Complete authorization",
      });
      interaction.notify({
        type: "device_code",
        verificationUri: "https://auth.example.test/device",
        userCode: "SAFE-CODE",
      });
      return { type: "oauth", access: secret, refresh, expires: Date.now() + 60_000 };
    },
  } as unknown as Models;

  try {
    for (const method of ["browser", "device_code"] as const) {
      let output = "";
      const write = (text: string) => {
        output += text;
      };
      const interaction: AuthInteraction = {
        prompt: async () => "ignored",
        notify: (event) => renderAuthEvent(event, write),
      };
      await runAuthCommand({
        action: "login",
        credentialPath,
        targetDir,
        method,
        interaction,
        models,
        providerId: "openai-codex",
        write,
      });
      expect(output).toContain("authenticated");
      expect(output).toContain("https://auth.example.test/authorize");
      expect(output).toContain("SAFE-CODE");
      expect(output).not.toContain(secret);
      expect(output).not.toContain(refresh);
    }
    expect(selected).toEqual(["browser", "device_code"]);
  } finally {
    if (priorConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = priorConfigHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("auth login stores an OpenRouter API key without exposing it", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-openrouter-auth-"));
  const priorConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = root;
  const targetDir = path.join(root, "project");
  const credentialPath = path.join(root, "private", "credentials.json");
  fs.mkdirSync(targetDir);
  const secret = "sentinel-openrouter-key";
  let output = "";
  try {
    await runAuthCommand({
      action: "login",
      provider: "openrouter",
      credentialPath,
      targetDir,
      interaction: { prompt: async () => secret, notify: () => undefined },
      write: (text) => {
        output += text;
      },
    });
    expect(output).toContain("openrouter: authenticated");
    expect(output).not.toContain(secret);
    const stored = await new FileCredentialStore({ path: credentialPath }).read("openrouter");
    expect(stored).toEqual({ type: "api_key", key: secret });
  } finally {
    if (priorConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = priorConfigHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("operations exposes FollowUp, documentation, and backlog APIs as JSON", () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-operations-cli-"));
  fs.mkdirSync(path.join(target, "docs"));
  fs.writeFileSync(path.join(target, "docs", "NOTES.md"), "# Notes\n");
  const input = path.join(target, "candidate.json");
  fs.writeFileSync(
    input,
    JSON.stringify({
      kind: "backlog",
      title: "novel-credential-format-Z9y8x7w6",
      evidence: [{ summary: "novel-credential-format-Z9y8x7w6", path: "src/a.ts" }],
      provenance: [{ producer: "reviewer", runId: "run-1", branch: "feature/ops" }],
    }),
  );

  const validated = runCli([
    "operations",
    "followup-validate",
    "--target-dir",
    target,
    "--input",
    input,
    "--json",
  ]);
  expect(validated.code).toBe(0);
  expect(JSON.parse(validated.stdout).kind).toBe("backlog");

  const created = runCli([
    "operations",
    "backlog-create",
    "--target-dir",
    target,
    "--input",
    input,
    "--id",
    "cli-item",
  ]);
  expect(created.code).toBe(0);
  expect(JSON.parse(created.stdout).value.candidate.title).toBe("Redacted backlog candidate");
  const listed = runCli(["operations", "backlog-list", "--target-dir", target]);
  expect(JSON.parse(listed.stdout)).toHaveLength(1);

  const noteInput = path.join(target, "note.json");
  const value = JSON.parse(fs.readFileSync(input, "utf8"));
  fs.writeFileSync(noteInput, JSON.stringify({ ...value, kind: "note" }));
  const routed = runCli([
    "operations",
    "documentation-route",
    "--target-dir",
    target,
    "--input",
    noteInput,
  ]);
  expect(JSON.parse(routed.stdout).destination).toBe(path.join(target, "docs", "NOTES.md"));

  const invalid = runCli([
    "operations",
    "backlog-transition",
    "--target-dir",
    target,
    "--id",
    "cli-item",
    "--state",
    "done",
    "--json",
  ]);
  expect(invalid.code).toBe(2);
  expect(JSON.parse(invalid.stderr)).toEqual({
    error: {
      code: "usage",
      detail: "--owner, --run-id, and --branch are required for this operations action",
    },
  });
});

test("operations exposes strict repository publishing preflight as JSON", () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-publish-cli-"));
  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.name", "CLI Test"],
    ["config", "user.email", "cli@example.invalid"],
  ])
    expect(Bun.spawnSync(["git", ...args], { cwd: target }).exitCode).toBe(0);
  fs.writeFileSync(path.join(target, "base.txt"), "base\n");
  expect(Bun.spawnSync(["git", "add", "--", "base.txt"], { cwd: target }).exitCode).toBe(0);
  expect(Bun.spawnSync(["git", "commit", "-m", "base"], { cwd: target }).exitCode).toBe(0);
  const config = path.join(target, "config.json");
  fs.writeFileSync(
    config,
    JSON.stringify({ projectOperations: { publishing: { mode: "local", gate: "manual" } } }),
  );
  fs.chmodSync(config, 0o600);
  const result = runCli([
    "operations",
    "publish-preflight",
    "--target-dir",
    target,
    "--project-store-config",
    config,
    "--json",
  ]);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    phase: "preflight",
    gate: "manual",
    mode: "local",
    base: "main",
  });
  expect(fs.existsSync(path.join(target, ".ad-coder"))).toBe(false);
  expect(fs.existsSync(path.join(target, ".ad-coder"))).toBe(false);
  fs.writeFileSync(
    config,
    JSON.stringify({ projectOperations: { publishing: { surprise: true } } }),
  );
  const invalid = runCli([
    "operations",
    "publish-preflight",
    "--target-dir",
    target,
    "--project-store-config",
    config,
    "--json",
  ]);
  expect(invalid.code).toBe(2);
  expect(JSON.parse(invalid.stderr).error.code).toBe("usage");
});

test("operations exposes all LDO actions as one-result JSON commands", () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-ldo-cli-"));
  const runs = path.join(target, ".codex", "ldo", "runs");
  fs.mkdirSync(runs, { recursive: true });
  fs.writeFileSync(path.join(runs, "cli-run.json"), JSON.stringify(cliCompletedRun("cli-run")));

  const detect = runCli(["operations", "ldo-detect", "--target-dir", target, "--json"]);
  expect(detect.code).toBe(0);
  expect(JSON.parse(detect.stdout)).toMatchObject({ detected: true, runs: ".codex/ldo/runs" });

  const preview = runCli(["operations", "ldo-preview", "--target-dir", target, "--json"]);
  expect(preview.code).toBe(0);
  const previewValue = JSON.parse(preview.stdout);
  expect(previewValue).toMatchObject({ writes: false, items: [{ status: "importable" }] });
  expect(fs.existsSync(path.join(target, ".ad-coder"))).toBe(false);

  const trustInput = path.join(target, "trust.json");
  fs.writeFileSync(trustInput, JSON.stringify({ trustDigests: [previewValue.items[0].sha256] }));
  const imported = runCli([
    "operations",
    "ldo-import",
    "--target-dir",
    target,
    "--input",
    trustInput,
    "--json",
  ]);
  expect(imported.code).toBe(0);
  expect(JSON.parse(imported.stdout).imported).toHaveLength(1);

  const inspect = runCli([
    "operations",
    "ldo-inspect",
    "--target-dir",
    target,
    "--id",
    "run:cli-run",
    "--json",
  ]);
  expect(inspect.code).toBe(0);
  expect(JSON.parse(inspect.stdout)).toMatchObject({ terminal: true, approved: true });

  const resumed = runCli([
    "operations",
    "ldo-resume",
    "--target-dir",
    target,
    "--id",
    "run:cli-run",
    "--provider",
    "openai-codex",
    "--json",
  ]);
  expect(resumed.code).toBe(0);
  expect(JSON.parse(resumed.stdout)).toMatchObject({ status: "complete" });

  const invalid = runCli([
    "operations",
    "ldo-inspect",
    "--target-dir",
    target,
    "--id",
    "../secret payload",
    "--json",
  ]);
  expect(invalid.code).not.toBe(0);
  expect(invalid.stderr).not.toContain("secret payload");
});

test("operations validates retry policy and emits stage metrics in control reports", () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-control-cli-"));
  const config = path.join(target, "config.json");
  const input = path.join(target, "input.json");
  fs.writeFileSync(
    input,
    JSON.stringify({ requestKey: "cli-retry", task: "work", mode: "manual" }),
  );
  const writeConfig = (controlPlane: Record<string, number>) => {
    fs.writeFileSync(config, JSON.stringify({ projectOperations: { controlPlane } }), {
      mode: 0o600,
    });
  };
  const start = () =>
    runCli([
      "operations",
      "control-start",
      "--target-dir",
      target,
      "--project-store-config",
      config,
      "--input",
      input,
      "--json",
    ]);

  writeConfig({ retryIntervalMs: 0, maxAutomaticRetryAttempts: 0 });
  const disabled = start();
  expect(disabled.code).toBe(0);
  const runId = JSON.parse(disabled.stdout).id as string;
  const store = new ProjectStore(target);
  const recordPath = path.join(store.layout.runs, `control-${runId}.json`);
  const persisted = store.readVersionedJson<DurableRunRecord>(recordPath);
  const stageMetrics = [
    {
      stage: "code:1",
      input: 13,
      cachedInput: 5,
      freshInput: 8,
      output: 3,
      readFiles: ["src/operator-visible.ts"],
      readFilesTotal: 1,
      readFilesTruncated: 0,
      diffBytes: 42,
      contextStrategy: "auto" as const,
    },
  ];
  store.writeVersionedJson(
    recordPath,
    {
      ...persisted.value,
      status: "paused",
      externalLimit: {
        source: "provider",
        state: "exhausted",
        resumable: true,
        retryAfterMs: 2_500,
      },
      result: {
        outcome: "approved",
        approved: true,
        rounds: 1,
        verdicts: [],
        runIds: [],
        stageMetrics,
      },
    },
    persisted.version,
  );
  const report = runCli([
    "operations",
    "control-report",
    "--target-dir",
    target,
    "--project-store-config",
    config,
    "--id",
    runId,
    "--json",
  ]);
  expect(report.code).toBe(0);
  expect(JSON.parse(report.stdout)).toMatchObject({
    stageMetrics,
    run: {
      externalLimit: {
        source: "provider",
        state: "exhausted",
        resumable: true,
        retryAfterMs: 2_500,
      },
    },
  });

  writeConfig({ retryIntervalMs: 1_000, maxAutomaticRetryAttempts: 3 });
  expect(
    runCli([
      "operations",
      "control-list",
      "--target-dir",
      target,
      "--project-store-config",
      config,
      "--json",
    ]).code,
  ).toBe(0);
  for (const invalid of [
    { retryIntervalMs: -1 },
    { retryIntervalMs: 1.5 },
    { retryIntervalMs: 86_400_001 },
    { maxAutomaticRetryAttempts: 101 },
  ]) {
    writeConfig(invalid);
    expect(start().code).toBe(2);
  }
});

test("console help is registry-derived and invalid input limits fail before provider access", () => {
  const help = runCli(["console", "--help"]);
  expect(help.stdout).toContain("--skills <names>");
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("usage: ad-coder console [options]");
  for (const option of [
    "--target-dir <dir>",
    "--json",
    "--max-input-bytes <n>",
    "--console-page-size <n>",
    "--escape-sequence-timeout-ms <n>",
    "--max-session-turns <n>",
    "--max-session-cost-usd <amount>",
    "--provider <provider>",
    "--strong-model <name>",
    "--registry-config <file.json>",
    "--planner-model <name>",
    "--orchestrator-model <name>",
    "--orchestrator-thinking-level <level>",
    "--tool-activity-event-bytes <n>",
    "--tool-activity-string-bytes <n>",
    "--tool-activity-grouping-ms <n>",
    "--summarizer-model <name>",
    "--role-budget-percents <file.json>",
    "--max-rounds <n>",
    "--default-complexity <complexity>",
  ]) {
    expect(help.stdout).toContain(option);
  }

  expect(runCli(["console", "--max-input-bytes", "0"]).stderr).toContain(
    "invalid --max-input-bytes: 0 (expected a positive integer)",
  );
  const unsafeActivityLimit = runCli([
    "console",
    "--target-dir",
    ".",
    "--tool-activity-event-bytes=0",
  ]);
  expect(unsafeActivityLimit.code).toBe(2);
  expect(unsafeActivityLimit.stderr).toContain(
    "maxEventBytes is outside its safe configured range",
  );
  for (const value of ["0", "-1", "1.5", "", "nope"]) {
    const result = runCli(["console", "--target-dir", ".", `--max-input-bytes=${value}`]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("invalid --max-input-bytes");
  }
  for (const option of ["--console-page-size", "--escape-sequence-timeout-ms"]) {
    const result = runCli(["console", "--target-dir", ".", `${option}=0`]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(option);
    expect(result.stderr).toContain("positive integer");
  }
  for (const value of ["-1", "1.5", "", " 1", "1e2", "NaN", "Infinity"]) {
    const result = runCli(["console", "--target-dir", ".", `--max-session-turns=${value}`]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("invalid --max-session-turns");
  }
  for (const value of ["-1", "", ".5", " 1", "1e2", "NaN", "Infinity"]) {
    const result = runCli(["console", "--target-dir", ".", `--max-session-cost-usd=${value}`]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("invalid --max-session-cost-usd");
  }
  expect(runCli(["console", "--unknown"]).stderr).toContain("unknown option");
  expect(runCli(["console", "extra"]).stderr).toContain("accepts no positional arguments");

  const acceptedThinking = runCli([
    "console",
    "--target-dir",
    ".",
    "--orchestrator-thinking-level",
    "low",
    "--provider",
    "unknown",
  ]);
  expect(acceptedThinking.code).toBe(2);
  expect(acceptedThinking.stderr).toContain("unknown provider: unknown");
  expect(acceptedThinking.stderr).not.toContain("invalid --orchestrator-thinking-level");

  const invalidThinking = runCli([
    "console",
    "--target-dir",
    ".",
    "--orchestrator-thinking-level",
    "deep",
  ]);
  expect(invalidThinking.code).toBe(2);
  expect(invalidThinking.stderr).toContain("invalid --orchestrator-thinking-level");
}, 15_000);

test("running the example workflow prints its result and exits 0", () => {
  const { code, stdout } = runCli(["run", "examples/hello.workflow.ts"]);
  expect(code).toBe(0);
  const result = JSON.parse(stdout) as { greeting: string; runId: string };
  expect(result.greeting).toBe("hello from ad-coder");
  expect(result.runId).toMatch(/^[0-9a-f-]{36}$/);
});

test("console projects code-specific actionable skill errors", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-cli-skills-"));
  const skills = path.join(root, ".ad-coder", "skills");
  fs.mkdirSync(skills, { recursive: true });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-cli-skill-outside-"));
  fs.symlinkSync(outside, path.join(skills, "escaping"));
  const oversized = path.join(skills, "oversized");
  fs.mkdirSync(oversized);
  fs.writeFileSync(
    path.join(oversized, "skill.json"),
    JSON.stringify({ id: "oversized", version: "1", description: "x", roles: ["planner"] }),
  );
  fs.writeFileSync(path.join(oversized, "instructions.md"), "x".repeat(16_385));
  const cases = [
    ["not-installed", "missing", "choose an installed skill ID or remove it from --skills"],
    ["bad/id", "malformed", "fix the selected skill manifest or requested skill IDs"],
    ["escaping", "escaping", "replace symlinks with files inside the configured skill directory"],
    ["oversized", "oversized", "reduce the selected skill manifest or instructions"],
  ] as const;
  for (const [id, code, nextAction] of cases) {
    const result = runCli(["console", "--target-dir", root, "--skills", id, "--json"], {
      cwd: path.dirname(root),
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).error).toMatchObject({
      code: `skill_${code}`,
      retryable: false,
      nextAction,
    });
  }
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
