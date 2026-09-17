import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  Type,
} from "@earendil-works/pi-ai";
import { ContextBudgetError } from "../src/context/budget";
import { ContextCompactor, type Summarizer } from "../src/context/compactor";
import { CostAnomalyBlockedError, CostAnomalyDetector } from "../src/economics/cost-anomaly";
import { LEDGER_BASE_DIR } from "../src/ledger/ledger";
import type { ToolActivityRecord } from "../src/observability/tool-activity";
import { StageLimitController, StageLimitError } from "../src/orchestration/stage-limits";
import { ProjectStore } from "../src/project-store/project-store";
import type { Role } from "../src/role";
import { defineRole } from "../src/role";
import { dumpRequest } from "../src/runner/dump-request";
import {
  ConfiguredToolsUnavailableError,
  ProviderLimitError,
  ProviderRejectionError,
  providerLimitFrom,
  providerRejectionStatusFrom,
  RunnerError,
  resolveTargetDir,
} from "../src/runner/errors";
import {
  appendSafeUntrackedDiffProjection,
  measureSafeGitDiffBytes,
  readSafeGitChangedFiles,
  readSafeGitDiffProjection,
  runRole,
} from "../src/runner/runner";
import { defineTool } from "../src/runner/tool";
import { SessionLimitController, SessionLimitError } from "../src/session-limits";

const CONTEXT_WINDOW = 200_000;

test("safe Git diff projection is bounded and redacts credential-like additions", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-diff-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "a.txt"), "password=unchanged-context-secret\nbase\n");
  execFileSync("git", ["add", "a.txt"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: dir });
  fs.writeFileSync(
    path.join(dir, "a.txt"),
    "password=unchanged-context-secret\nbase\nvisible change\napi_key=super-secret-value\n",
  );

  const projected = await readSafeGitDiffProjection(dir, 16 * 1024);
  expect(projected.text).toContain("visible change");
  expect(projected.text).toContain("[REDACTED: possible credential]");
  expect(projected.text).not.toContain("super-secret-value");
  expect(projected.text).not.toContain("unchanged-context-secret");
  expect(projected.redactedLines).toBe(2);
  expect(projected.sha256).toHaveLength(64);
  fs.writeFileSync(path.join(dir, "new.ts"), "export const added = true;\n");
  const changed = await readSafeGitChangedFiles(dir);
  expect(changed.files).toEqual(["a.txt", "new.ts"]);
  expect(changed.untrackedFiles).toEqual(["new.ts"]);
  expect(changed.requiresFullDiff).toBe(true);
  const withUntracked = appendSafeUntrackedDiffProjection(
    dir,
    projected,
    changed.untrackedFiles,
    16 * 1024,
  );
  expect(withUntracked.text).toContain("export const added = true;");
  execFileSync("git", ["add", "a.txt"], { cwd: dir });
  const staged = await readSafeGitDiffProjection(dir, 16 * 1024);
  expect(staged.text).toContain("visible change");
  await expect(readSafeGitDiffProjection(dir, 8)).rejects.toMatchObject({
    code: "diff_metric_failed",
  });
});

/** A faux provider + models pair and the role validated against its window. */
function harnessFixture() {
  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "faux-1", contextWindow: CONTEXT_WINDOW }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel() as Model<Api>;
  const role: Role = defineRole(
    {
      name: "coder",
      provider: "faux",
      modelId: model.id,
      systemPrompt: "You code.",
      activeToolNames: ["bash", "read", "write", "edit"],
      cacheRetention: "none",
      contextBudget: { maxTokens: 100_000, reserveTokens: 10_000, keepRecentTokens: 20_000 },
    },
    model,
  );
  return { faux, models, model, role };
}

/**
 * A custom tool that records every invocation's note into `calls`, so a test can
 * assert both THAT it fired and WITH WHAT arguments. Built via `defineTool` to
 * exercise the same authoring surface a caller uses.
 */
function recordingTool(name: string, calls: string[]) {
  return defineTool({
    name,
    description: "Record a note for the test to observe.",
    label: "record note",
    parameters: Type.Object({ note: Type.String() }),
    async execute(_toolCallId, params) {
      calls.push(params.note);
      return { content: [{ type: "text", text: "recorded" }], details: undefined };
    },
  });
}

/** Like harnessFixture but with a caller-chosen activeToolNames allow-list. */
function fixtureWithActiveTools(activeToolNames: string[]) {
  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "faux-1", contextWindow: CONTEXT_WINDOW }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel() as Model<Api>;
  const role: Role = defineRole(
    {
      name: "coder",
      provider: "faux",
      modelId: model.id,
      systemPrompt: "You code.",
      activeToolNames,
      cacheRetention: "none",
      contextBudget: { maxTokens: 100_000, reserveTokens: 10_000, keepRecentTokens: 20_000 },
    },
    model,
  );
  return { faux, models, model, role };
}

let targetDir: string;

beforeAll(() => {
  targetDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-runner-")));
});

afterAll(() => {
  fs.rmSync(targetDir, { recursive: true, force: true });
});

test("configured role tools fail with their typed cause before provider dispatch", async () => {
  const { faux, models, model, role } = fixtureWithActiveTools(["missing_project_tool"]);
  faux.setResponses([fauxAssistantMessage("must not dispatch")]);
  const error = await runRole({ role, targetDir, models, model, prompt: "x" }).catch(
    (cause) => cause,
  );
  expect(error).toBeInstanceOf(ConfiguredToolsUnavailableError);
  expect(error.cause).toMatchObject({ code: "configured_tools_unavailable" });
});

test("runRole drives one turn to a settled result and lands the ledger under targetDir", async () => {
  const { faux, models, model, role } = harnessFixture();
  faux.setResponses([fauxAssistantMessage("done")]);

  const result = await runRole({ role, targetDir, models, model, prompt: "do the thing" });

  expect(result.result.status).toBe("completed");
  expect(result.ledgerPath).toBe(path.join(targetDir, LEDGER_BASE_DIR, `${result.runId}.jsonl`));
  expect(result.droppedRecords).toBe(0);
  expect(result.observations?.input).toBe(
    (result.observations?.freshInput ?? 0) + (result.observations?.cachedInput ?? 0),
  );
  expect(result.observations?.contextStrategy).toBe("auto");
  expect(result.observations.requestBytes.systemPrompt).toBeGreaterThan(0);
  expect(result.observations.requestBytes.prompt).toBe(Buffer.byteLength("do the thing"));
  expect(result.observations.requestBytes.toolDefinitions).toBeGreaterThan(0);
  expect(result.observations.requestBytes.total).toBe(
    result.observations.requestBytes.systemPrompt +
      result.observations.requestBytes.prompt +
      result.observations.requestBytes.toolDefinitions,
  );

  // Exactly one after_response record under targetDir, and nothing under cwd.
  const lines = fs
    .readFileSync(result.ledgerPath as string, "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
  expect(lines).toHaveLength(1);
  // The record carries the harness operation runId (event.runId), not the
  // ledger's file-name runId; the file name is what carries result.runId above.
  const record = JSON.parse(lines[0] as string) as { runId: string; role: string; step: string };
  expect(typeof record.runId).toBe("string");
  expect(record.role).toBe("coder");
  expect(record.step).toBe("run");

  const store = new ProjectStore(targetDir);
  const metadata = (await store.listSessions()).find(({ id }) => id === result.runId);
  expect(metadata).toBeDefined();
  expect(fs.statSync(metadata?.path as string).mode & 0o777).toBe(0o600);
  expect(fs.statSync(result.ledgerPath as string).mode & 0o777).toBe(0o600);

  const underCwd = path.join(process.cwd(), LEDGER_BASE_DIR, `${result.runId}.jsonl`);
  expect(fs.existsSync(underCwd)).toBe(false);
});

test("runRole rejects an expired stage before provider dispatch", async () => {
  const { faux, models, model, role } = harnessFixture();
  faux.setResponses([fauxAssistantMessage("must not run")]);
  let now = 0;
  const stageLimitController = new StageLimitController({ maxDurationMs: 5 }, () => now);
  now = 5;
  await expect(
    runRole({
      role,
      targetDir,
      models,
      model,
      prompt: "do the thing",
      stageLimitController,
    }),
  ).rejects.toBeInstanceOf(StageLimitError);
  expect(stageLimitController.snapshot().modelTurns).toBe(0);
});

test("runRole exposes correlated lifecycle events for successful and failed tools", async () => {
  for (const shouldFail of [false, true]) {
    const records: ToolActivityRecord[] = [];
    const { faux, models, model, role } = fixtureWithActiveTools(["observed_tool"]);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("observed_tool", { secret: "never-publish-me" })),
      fauxAssistantMessage("done"),
    ]);
    const tool = defineTool({
      name: "observed_tool",
      description: "Observed lifecycle test tool.",
      label: "observed",
      parameters: Type.Object({ secret: Type.String() }),
      async execute() {
        if (shouldFail) throw new Error("never-publish-me");
        return { content: [{ type: "text", text: "ok" }], details: undefined };
      },
    });

    await runRole({
      role,
      targetDir,
      models,
      model,
      prompt: "use it",
      tools: [tool],
      activityConsumer: (record) => {
        records.push(record);
      },
    });
    const activity = records.filter((record) => record.type === "tool_activity");
    expect(activity.map(({ lifecycle }) => lifecycle)).toEqual([
      "requested",
      "started",
      shouldFail ? "failed" : "completed",
    ]);
    expect(new Set(activity.map(({ runId }) => runId)).size).toBe(1);
    expect(activity[0]?.runId).toMatch(/^run-[0-9]+$/);
    expect(activity.every(({ parentOperation }) => parentOperation === "run")).toBe(true);
    expect(JSON.stringify(activity)).not.toContain("never-publish-me");
  }
});

test("provider limit classification uses only structured codes and validated delays", () => {
  const limited = providerLimitFrom({
    status: 429,
    retryAfterMs: 2_500,
    message: "secret provider body",
    headers: { authorization: "secret" },
  });
  expect(limited).toBeInstanceOf(ProviderLimitError);
  expect(limited?.retryAfterMs).toBe(2_500);
  expect(JSON.stringify(limited)).not.toContain("secret");
  expect(providerLimitFrom({ code: "insufficient_quota", retryAfterMs: -1 })?.retryAfterMs).toBe(
    undefined,
  );
  expect(providerLimitFrom({ status: 429, retry_after: 1.25 })?.retryAfterMs).toBe(1_250);
  expect(providerLimitFrom({ status: 429, resetAtMs: 12_000 }, 10_000)?.retryAfterMs).toBe(2_000);
  expect(
    providerLimitFrom({ status: 429, retryAfterMs: 86_400_001 })?.retryAfterMs,
  ).toBeUndefined();
  expect(providerLimitFrom({ status: 401, code: "authentication_error" })).toBeUndefined();
});

test("provider rejection is attributed from a status and never carries a body", () => {
  // Structured status: the shape pi-agent-core's OperationError exposes.
  expect(providerRejectionStatusFrom({ status: 400 })).toBe(400);
  expect(providerRejectionStatusFrom({ statusCode: 422 })).toBe(422);
  // Message shape 1, `formatProviderError`: "<status>: <body>" and the
  // prefixed "<prefix> (<status>): <body>" variant.
  expect(
    providerRejectionStatusFrom({
      message: '400: {"error":{"message":"one of `type`, `anyOf` field is required"}}',
    }),
  ).toBe(400);
  expect(providerRejectionStatusFrom({ message: "OpenAI API error (404): no such model" })).toBe(
    404,
  );
  // Credential and capacity statuses stay OUT: 401/403 are what EmptyTurnError
  // already names, 429 is providerLimitFrom's, and 5xx is not about the request.
  expect(providerRejectionStatusFrom({ status: 401 })).toBeUndefined();
  expect(providerRejectionStatusFrom({ status: 403 })).toBeUndefined();
  expect(providerRejectionStatusFrom({ status: 429 })).toBeUndefined();
  expect(providerRejectionStatusFrom({ status: 503 })).toBeUndefined();
  expect(providerRejectionStatusFrom({ message: "assistant stopped with error" })).toBeUndefined();
  expect(providerRejectionStatusFrom(undefined)).toBeUndefined();

  // Message shape 2, the provider SDK's own `APIError.message`: "<status>
  // <body>", a SPACE and no colon. `anthropic-messages` -- one of the three
  // `ApiKind`s this registry resolves, and what OpenRouter's dual-api models
  // override to -- never calls `formatProviderError`; its catch block assigns
  // the raw SDK message. Reading only shape 1 left every Anthropic-native
  // rejection falling through to `EmptyTurnError`, telling the operator to
  // check credentials about a request refused on its merits.
  expect(
    providerRejectionStatusFrom({
      code: "assistant_error",
      message:
        '400 {"type":"error","error":{"message":"tools.0.custom.input_schema: JSON schema is invalid"}}',
    }),
  ).toBe(400);
  // Body-less is still a refusal: the status is this function's whole output,
  // and excluding it would hand the run back to the credential advice.
  expect(providerRejectionStatusFrom({ message: "400 status code (no body)" })).toBe(400);
  // The same exclusions hold for shape 2, which the SDK composes identically
  // for every status.
  expect(providerRejectionStatusFrom({ message: '401 {"error":{"message":"bad key"}}' })).toBe(
    undefined,
  );
  expect(providerRejectionStatusFrom({ message: '429 {"error":{"message":"slow down"}}' })).toBe(
    undefined,
  );
  expect(providerRejectionStatusFrom({ message: '503 {"error":{"message":"overloaded"}}' })).toBe(
    undefined,
  );
  // A three-digit run inside prose is not a status: shape 2 is anchored at the
  // start, and a longer number fails because the fourth digit sits where the
  // space must be.
  expect(providerRejectionStatusFrom({ message: "Request failed after 400 attempts" })).toBe(
    undefined,
  );
  expect(providerRejectionStatusFrom({ message: "2024 was a year of provider outages" })).toBe(
    undefined,
  );

  const rejected = new ProviderRejectionError("run-1", 400);
  expect(rejected.code).toBe("provider_rejected");
  expect(rejected.status).toBe(400);
  expect(rejected.message).toContain("HTTP 400");
  // The message must point at the request, not at credentials.
  expect(rejected.message).not.toContain("authentication");
  // Only identifiers and the number survive: the provider body that produced
  // the status is read for it and dropped, never stored on the error.
  const carried = providerRejectionStatusFrom({
    status: 400,
    message: '400: {"error":{"message":"never-publish-me"}}',
  });
  expect(carried).toBe(400);
  expect(JSON.stringify({ ...new ProviderRejectionError("run-1", carried ?? 0) })).not.toContain(
    "never-publish-me",
  );
});

test("runRole rejects missing authentication before provider generation", async () => {
  const { faux, models, model, role } = harnessFixture();
  faux.setResponses([fauxAssistantMessage("must remain pending")]);
  const unauthenticated = new Proxy(models, {
    get(target, property, receiver) {
      if (property === "getAuth") return async () => undefined;
      return Reflect.get(target, property, receiver);
    },
  }) as Models;

  await expect(
    runRole({ role, targetDir, models: unauthenticated, model, prompt: "do not dispatch" }),
  ).rejects.toMatchObject({
    code: "authentication_required",
    detail: "faux",
  });
  expect(faux.getPendingResponseCount()).toBe(1);
});

test("runRole roots the execution tools at targetDir", async () => {
  const { faux, models, model, role } = harnessFixture();
  // The bash tool runs in env.cwd; a relative write proves that cwd is targetDir.
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: "echo rooted > marker.txt" })),
    fauxAssistantMessage("done"),
  ]);

  await runRole({ role, targetDir, models, model, prompt: "write a marker" });

  const marker = path.join(targetDir, "marker.txt");
  expect(fs.existsSync(marker)).toBe(true);
  expect(fs.readFileSync(marker, "utf8").trim()).toBe("rooted");
});

test("runRole observes only safe successful dedicated reads once", async () => {
  const observedPath = path.join(targetDir, "observed.txt");
  const misleadingPath = path.join(targetDir, "unsafe\u202Etxt");
  fs.writeFileSync(observedPath, "observed", "utf8");
  fs.writeFileSync(misleadingPath, "misleading", "utf8");
  const { faux, models, model, role } = harnessFixture();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("read", { path: "observed.txt" })),
    fauxAssistantMessage(fauxToolCall("read", { path: "observed.txt" })),
    fauxAssistantMessage(fauxToolCall("read", { path: "missing.txt" })),
    fauxAssistantMessage(fauxToolCall("read", { path: misleadingPath })),
    fauxAssistantMessage(fauxToolCall("bash", { command: "cat observed.txt" })),
    fauxAssistantMessage("done"),
  ]);

  const result = await runRole({ role, targetDir, models, model, prompt: "read files" });

  expect(result.observations?.readFiles).toEqual(["observed.txt"]);
  expect(result.observations?.readFilesTotal).toBe(1);
  expect(result.observations?.readFilesTruncated).toBe(0);
});

test("read observation deduplicates paths omitted after the report sample fills", async () => {
  fs.writeFileSync(path.join(targetDir, "first.txt"), "first", "utf8");
  fs.writeFileSync(path.join(targetDir, "second.txt"), "second", "utf8");
  const { faux, models, model, role } = harnessFixture();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("read", { path: "first.txt" })),
    fauxAssistantMessage(fauxToolCall("read", { path: "second.txt" })),
    fauxAssistantMessage(fauxToolCall("read", { path: "second.txt" })),
    fauxAssistantMessage("done"),
  ]);

  const result = await runRole({
    role,
    targetDir,
    models,
    model,
    prompt: "read files",
    observability: { maxReadPaths: 1 },
  });

  expect(result.observations?.readFiles).toEqual(["first.txt"]);
  expect(result.observations?.readFilesTotal).toBe(2);
  expect(result.observations?.readFilesTruncated).toBe(1);
});

test("safe diff measurement disables repository fsmonitor hooks and reports bytes only", async () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-safe-diff-"));
  const marker = path.join(repository, "fsmonitor-ran");
  const hook = path.join(repository, "fsmonitor.sh");
  fs.writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
  execFileSync("git", ["init", "-q"], { cwd: repository });
  execFileSync("git", ["config", "core.fsmonitor", hook], { cwd: repository });
  fs.writeFileSync(path.join(repository, "tracked.txt"), "base\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: repository });
  execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base"],
    {
      cwd: repository,
    },
  );
  fs.rmSync(marker, { force: true });
  fs.writeFileSync(path.join(repository, "tracked.txt"), "changed\n");

  const expected = execFileSync(
    "git",
    ["-c", "core.fsmonitor=false", "diff", "--no-ext-diff", "--no-textconv", "HEAD", "--"],
    { cwd: repository },
  ).byteLength;
  expect(await measureSafeGitDiffBytes(repository)).toBe(expected);
  expect(fs.existsSync(marker)).toBe(false);
});

test("safe diff measurement streams bytes with the exact fixed git argv", async () => {
  const processEvents = new EventEmitter();
  const stdout = new EventEmitter();
  let invocation:
    | { command: string; args: readonly string[]; shell: boolean | undefined }
    | undefined;
  const spawnGit = ((command: string, args: readonly string[], options: { shell?: boolean }) => {
    invocation = { command, args, shell: options.shell };
    queueMicrotask(() => {
      stdout.emit("data", Buffer.alloc(7));
      stdout.emit("data", Buffer.alloc(5));
      processEvents.emit("close", 0);
    });
    return Object.assign(processEvents, { stdout });
  }) as unknown as Parameters<typeof measureSafeGitDiffBytes>[1];

  expect(await measureSafeGitDiffBytes(targetDir, spawnGit)).toBe(12);
  expect(invocation).toEqual({
    command: "git",
    args: ["diff", "--no-ext-diff", "--no-textconv", "HEAD", "--"],
    shell: false,
  });
});

test("runRole does not invoke the summarizer when the turn fits the budget", async () => {
  const { faux, models, model, role } = harnessFixture();
  faux.setResponses([fauxAssistantMessage("done")]);
  const summarizer: Summarizer = () => {
    throw new Error("summarizer must not run under budget");
  };

  const result = await runRole({ role, targetDir, models, model, prompt: "small", summarizer });
  expect(result.result.status).toBe("completed");
});

test("runRole supplies the active runtime context window to the compactor health check", async () => {
  const { faux, models, model } = harnessFixture();
  const role = defineRole(
    {
      name: "coder",
      provider: model.provider,
      modelId: model.id,
      systemPrompt: "You code.",
      activeToolNames: [],
      cacheRetention: "none",
      contextBudget: { maxTokens: 1100, reserveTokens: 100, keepRecentTokens: 250 },
    },
    model,
  );
  const smallerRuntimeModel = { ...model, contextWindow: 500 } as Model<Api>;
  const originalAssertHealthy = ContextCompactor.prototype.assertHealthy;
  let receivedContextWindow: number | undefined;
  ContextCompactor.prototype.assertHealthy = function (roleName, contextWindow) {
    receivedContextWindow = contextWindow;
    return originalAssertHealthy.call(this, roleName, contextWindow);
  };
  faux.setResponses([fauxAssistantMessage("done")]);
  try {
    await runRole({
      role,
      targetDir,
      models,
      model: smallerRuntimeModel,
      prompt: "small",
      summarizer: async () => "summary",
    });
  } finally {
    ContextCompactor.prototype.assertHealthy = originalAssertHealthy;
  }
  expect(receivedContextWindow).toBe(smallerRuntimeModel.contextWindow);
  expect(faux.state.callCount).toBe(1);
});

test("runRole rethrows a shared controller rejection after a tool follow-up", async () => {
  const { faux, models, model, role } = harnessFixture();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: "printf one" })),
    fauxAssistantMessage("must not dispatch"),
  ]);
  const controller = new SessionLimitController({ maxTurns: 1 });

  await expect(
    runRole({
      role,
      targetDir,
      models,
      model,
      prompt: "use the tool",
      sessionLimitController: controller,
    }),
  ).rejects.toBeInstanceOf(SessionLimitError);
  expect(faux.state.callCount).toBe(1);
  expect(controller.snapshot().admittedTurns).toBe(1);
});

test("a blocked price scope refuses the run at the Models boundary, before a turn is spent", async () => {
  // The block must bite at the ONE seam every generation path goes through.
  // Enforcing it in a front would leave the core startable around it, which
  // docs/contracts/cost-anomaly.md forbids -- a front renders the decision, it
  // does not make it.
  const { faux, models, model, role } = harnessFixture();
  faux.setResponses([fauxAssistantMessage("must not dispatch")]);
  const detector = new CostAnomalyDetector();
  const scope = { provider: model.provider, model: model.id, expectedUsd: 0.002 };
  for (let index = 0; index < 3; index += 1) detector.observe({ ...scope, chargedUsd: 0.002 });
  detector.observe({ ...scope, chargedUsd: 0.01 });
  detector.observe({ ...scope, chargedUsd: 0.01 });

  const sessionLimitController = new SessionLimitController({ maxTurns: 5 });
  await expect(
    runRole({
      role,
      targetDir,
      models,
      model,
      prompt: "spend money",
      costAnomalyDetector: detector,
      sessionLimitController,
    }),
  ).rejects.toBeInstanceOf(CostAnomalyBlockedError);
  // Nothing was sent, so nothing was charged...
  expect(faux.state.callCount).toBe(0);
  // ...and a refused start did not consume one of the session's counted turns.
  expect(sessionLimitController.snapshot().admittedTurns).toBe(0);
});

test("a provider that reports no charge runs, and leaves its scope unmeasured", async () => {
  const { faux, models, model, role } = harnessFixture();
  faux.setResponses([fauxAssistantMessage("done")]);
  const detector = new CostAnomalyDetector();

  const result = await runRole({
    role,
    targetDir,
    models,
    model,
    prompt: "work",
    costAnomalyDetector: detector,
  });
  expect(result.result.status).toBe("completed");
  // The faux provider reports no billed amount, which is the same position
  // OpenCode Zen is in. The run proceeds -- an unmeasurable price is never a
  // reason to refuse work -- and the scope says so rather than reporting a
  // "normal" it never checked.
  expect(detector.status(model.provider, model.id)).toEqual({
    state: "no_charge_data",
    acceptedRatio: 1,
  });
});

test("runRole preserves a typed stage rejection across the harness boundary", async () => {
  const { faux, models, model, role } = harnessFixture();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: "printf one" })),
    fauxAssistantMessage("must not dispatch"),
  ]);
  const controller = new StageLimitController({ maxModelTurns: 1 });

  await expect(
    runRole({
      role,
      targetDir,
      models,
      model,
      prompt: "use the tool",
      stageLimitController: controller,
    }),
  ).rejects.toMatchObject({ code: "stage_limit", reason: "model_turns" });
  expect(faux.state.callCount).toBe(1);
  expect(controller.snapshot().modelTurns).toBe(1);
});

test("stage closeout removes tools for the reserved final model turn", async () => {
  const { faux, models, model, role } = harnessFixture();
  let finalTurnTools: number | undefined;
  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall("bash", { command: "printf one" }, { id: "first" }),
      fauxToolCall("read", { path: "package.json" }, { id: "second" }),
    ]),
    (context) => {
      finalTurnTools = context.tools?.length ?? 0;
      return fauxAssistantMessage("final synthesis");
    },
  ]);
  const controller = new StageLimitController({
    maxModelTurns: 4,
    finalResponseReserveModelTurns: 2,
  });

  const result = await runRole({
    role,
    targetDir,
    models,
    model,
    prompt: "attempt a batch, then finish",
    stageLimitController: controller,
  });

  expect(finalTurnTools).toBe(0);
  expect(faux.state.callCount).toBe(2);
  expect(controller.snapshot()).toMatchObject({ modelTurns: 2, toolTurns: 2 });
  expect(result.result.status).toBe("completed");
});

test("disabled compaction rejects an oversized turn before calling the provider", async () => {
  const { faux, models, model } = harnessFixture();
  const role = defineRole(
    {
      name: "coder",
      provider: model.provider,
      modelId: model.id,
      systemPrompt: "You code.",
      activeToolNames: [],
      cacheRetention: "none",
      contextBudget: { maxTokens: 1000, reserveTokens: 100, keepRecentTokens: 200 },
    },
    model,
  );
  faux.setResponses([fauxAssistantMessage("must remain queued")]);
  await expect(
    runRole({
      role,
      targetDir,
      models,
      model,
      prompt: "x".repeat(5000),
      compaction: { mode: "disabled-then-halt" },
    }),
  ).rejects.toBeInstanceOf(ContextBudgetError);
  expect(faux.state.callCount).toBe(0);
  expect(faux.getPendingResponseCount()).toBe(1);
});

test("resolveTargetDir throws a typed RunnerError for missing, nonexistent and non-directory paths", () => {
  const missing = () => resolveTargetDir(undefined);
  expect(missing).toThrow(RunnerError);
  try {
    missing();
  } catch (error) {
    expect((error as RunnerError).code).toBe("missing");
  }

  const empty = () => resolveTargetDir("   ");
  expect(empty).toThrow(RunnerError);
  try {
    empty();
  } catch (error) {
    expect((error as RunnerError).code).toBe("missing");
  }

  const nonexistent = path.join(targetDir, "no", "such", "dir");
  try {
    resolveTargetDir(nonexistent);
    throw new Error("expected a throw");
  } catch (error) {
    expect(error).toBeInstanceOf(RunnerError);
    expect((error as RunnerError).code).toBe("not_found");
  }

  const file = path.join(targetDir, "a-file");
  fs.writeFileSync(file, "x", { mode: 0o600 });
  try {
    resolveTargetDir(file);
    throw new Error("expected a throw");
  } catch (error) {
    expect(error).toBeInstanceOf(RunnerError);
    expect((error as RunnerError).code).toBe("not_a_directory");
  }
});

test("runRole rejects a malformed runId before building a ledger path", async () => {
  const { faux, models, model, role } = harnessFixture();
  faux.setResponses([fauxAssistantMessage("done")]);
  await expect(
    runRole({ role, targetDir, models, model, prompt: "x", runId: "../escape" }),
  ).rejects.toBeInstanceOf(RunnerError);
});

test("(a,b) runRole invokes a supplied custom tool and captures its arguments", async () => {
  const calls: string[] = [];
  const { faux, models, model, role } = fixtureWithActiveTools([
    "bash",
    "read",
    "write",
    "edit",
    "record_note",
  ]);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("record_note", { note: "hello-from-model" })),
    fauxAssistantMessage("done"),
  ]);

  const result = await runRole({
    role,
    targetDir,
    models,
    model,
    prompt: "record a note",
    tools: [recordingTool("record_note", calls)],
  });

  expect(result.result.status).toBe("completed");
  // (a) the side effect fired exactly once; (b) with the args the model passed.
  expect(calls).toEqual(["hello-from-model"]);
});

test("(c) a custom tool colliding with a built-in throws RunnerError tool_name_collision", async () => {
  const calls: string[] = [];
  const { faux, models, model, role } = harnessFixture();
  faux.setResponses([fauxAssistantMessage("done")]);

  try {
    await runRole({
      role,
      targetDir,
      models,
      model,
      prompt: "x",
      tools: [recordingTool("bash", calls)],
    });
    throw new Error("expected a throw");
  } catch (error) {
    expect(error).toBeInstanceOf(RunnerError);
    expect((error as RunnerError).code).toBe("tool_name_collision");
    expect((error as RunnerError).path).toBe("bash");
  }
});

test("(d) activeToolNames still filters the combined set: a custom tool it excludes never fires", async () => {
  const calls: string[] = [];
  // The role allows only the built-ins; the custom tool is supplied but its name
  // is absent from the allow-list, so the harness must not register it.
  const { faux, models, model, role } = fixtureWithActiveTools(["bash", "read", "write", "edit"]);
  faux.setResponses([fauxAssistantMessage("done")]);

  const result = await runRole({
    role,
    targetDir,
    models,
    model,
    prompt: "do nothing with the custom tool",
    tools: [recordingTool("record_note", calls)],
  });

  expect(result.result.status).toBe("completed");
  expect(calls).toEqual([]);
});

test("(e) runRole with no tools param settles exactly as today", async () => {
  const { faux, models, model, role } = harnessFixture();
  faux.setResponses([fauxAssistantMessage("done")]);

  const result = await runRole({ role, targetDir, models, model, prompt: "no custom tools" });

  expect(result.result.status).toBe("completed");
  expect(result.droppedRecords).toBe(0);
});

test("the request dump is off by default and writes what was sent when asked", () => {
  // Sizes on the ledger answer "did a prompt arrive"; only the text answers "was
  // it the right one" (issue #317). Off unless asked, because a request carries
  // the task and whatever the role has read.
  const target = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-dump-")));
  const store = new ProjectStore(target);
  const file = dumpRequest(store, {
    runId: "11111111-2222-4333-8444-555555555555",
    role: "coder",
    step: "code:1",
    systemPrompt: "You are the Coder.",
    prompt: "do the thing",
    toolNames: ["read", "edit"],
  });
  if (file === undefined) throw new Error("dump did not write a file");
  const body = fs.readFileSync(file, "utf8");
  expect(body).toContain("# role: coder");
  expect(body).toContain("You are the Coder.");
  expect(body).toContain("do the thing");
  // Tool NAMES only: the definitions are large and their shapes live in source.
  expect(body).toContain("# tools: read, edit");
  // Private: a dump holds task text and project content.
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  fs.rmSync(target, { recursive: true, force: true });
});
