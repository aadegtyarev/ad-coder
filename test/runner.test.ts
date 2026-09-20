import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, Models } from "@earendil-works/pi-ai";
import {
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  fauxAssistantMessage,
  fauxProvider,
  fauxThinking,
  fauxToolCall,
  Type,
} from "@earendil-works/pi-ai";
import { ContextBudgetError } from "../src/context/budget";
import type { Summarizer } from "../src/context/compactor";
import { CostAnomalyBlockedError, CostAnomalyDetector } from "../src/economics/cost-anomaly";
import { LEDGER_BASE_DIR } from "../src/ledger/ledger";
import type { ToolActivityRecord } from "../src/observability/tool-activity";
import { StageLimitController, StageLimitError } from "../src/orchestration/stage-limits";
import { ProjectStore } from "../src/project-store/project-store";
import type { Role } from "../src/role";
import { defineRole, toHarnessOptions } from "../src/role";
import { dumpRequest } from "../src/runner/dump-request";
import {
  ConfiguredToolsUnavailableError,
  extractProviderCodeToken,
  GenerationTruncatedError,
  ProviderLimitError,
  ProviderQuotaError,
  ProviderRejectionError,
  providerLimitFrom,
  providerQuotaFrom,
  providerRejectionStatusFrom,
  RunnerError,
  resolveTargetDir,
  truncatedGenerationFrom,
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

/** An empty git repo with one commit, so a diff measure can run against it. */
function initEmptyRepo(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "base", "--allow-empty"], { cwd: dir });
  return dir;
}

test("untracked content past the aggregate ceiling truncates UTF-8-safely instead of failing (issue #449)", async () => {
  const dir = initEmptyRepo("ad-coder-untracked-");
  // One unbroken 4-byte codepoint run on a single line: with a 158-byte
  // ceiling the cap lands on the 3rd (continuation) byte of rocket #26, so
  // only the boundary walk-back can keep the cut lossless.
  const rocket = "🚀";
  const big = rocket.repeat(2_000); // 8 000 bytes, no newlines
  fs.writeFileSync(path.join(dir, "b.md"), big);

  const changed = await readSafeGitChangedFiles(dir);
  expect(changed.files).toEqual(["b.md"]);
  const tracked = await readSafeGitDiffProjection(dir, 4096);
  expect(tracked.bytes).toBe(0);

  const projected = appendSafeUntrackedDiffProjection(dir, tracked, changed.untrackedFiles, 158);
  // Bounded: the ceiling caps content instead of throwing the measurement away.
  // The 50-byte file header plus the "+" line opener plus 26 WHOLE rockets:
  // 155 bytes -- the cap walked back off rocket #26's three continuation bytes
  // instead of leaving a partial codepoint, so never 156..158 bytes.
  expect(projected.bytes).toBe(155);
  // UTF-8 boundary safety: the cap never cuts a multi-byte codepoint in half.
  // After the 3 header lines the kept text is the "+" line opener followed by
  // whole rockets only -- no U+FFFD replacement, no partial codepoint.
  const body = projected.text.slice(projected.text.lastIndexOf("\n") + 1);
  expect(body).toMatch(/^\+(?:🚀)+$/u);
  expect(projected.text).not.toContain("\u{FFFD}");
  // The capped file is counted, and the TRUE measured size (8 000 bytes,
  // before truncation) survives as the material signal.
  expect(projected.text).toContain("diff --git a/b.md b/b.md");
  expect(projected.untrackedTruncatedFiles).toBe(1);
  expect(projected.untrackedMeasuredBytes).toBe(Buffer.byteLength(big));
  // The digest still describes the bounded text exactly.
  expect(projected.sha256).toBe(createHash("sha256").update(projected.text).digest("hex"));
});

test("zero remaining budget caps an untracked file to nothing without reading it (issue #449)", () => {
  const dir = initEmptyRepo("ad-coder-untracked-budget-");
  // Non-UTF-8 content: with no budget left it is never read, so the bounded
  // projection stays a success -- the path is kept and the cap is counted.
  fs.writeFileSync(path.join(dir, "blob.bin"), Buffer.from([0xff, 0xfe, 0x00, 0x01]));
  const base = { text: "x".repeat(4096), bytes: 4096, sha256: "", redactedLines: 0 };
  const projected = appendSafeUntrackedDiffProjection(dir, base, ["blob.bin"], 4096);
  expect(projected.text).toBe(base.text);
  expect(projected.bytes).toBe(4096);
  expect(projected.untrackedTruncatedFiles).toBe(1);
  expect(projected.untrackedMeasuredBytes).toBe(4);
});

test("a truncated untracked projection recounts redaction markers on the KEPT text (issue #449)", () => {
  const dir = initEmptyRepo("ad-coder-untracked-redact-");
  const secretLine = "password: supersecret9";
  fs.writeFileSync(
    path.join(dir, "sec.md"),
    `${"a".repeat(300)}\n${secretLine}\n${"b".repeat(300)}\n`,
  );
  // The projected file is header (56) + "aaa..." line (301) + the redaction
  // marker (32) + "bbb..." line. A 370-byte ceiling cuts INSIDE the marker
  // line, so no marker line is fully visible and the count must be 0.
  const cut = appendSafeUntrackedDiffProjection(
    dir,
    { text: "", bytes: 0, sha256: "", redactedLines: 0 },
    ["sec.md"],
    370,
  );
  expect(cut.bytes).toBeLessThanOrEqual(370);
  expect(cut.redactedLines).toBe(0);
  // With room for the whole marker line the count is the truthful 1.
  const whole = appendSafeUntrackedDiffProjection(
    dir,
    { text: "", bytes: 0, sha256: "", redactedLines: 0 },
    ["sec.md"],
    400,
  );
  expect(whole.redactedLines).toBe(1);
  expect(whole.text).toContain("+[REDACTED: possible credential]");
});

test("an untracked file that vanished mid-measurement is a typed failure, not a crash (issue #449)", () => {
  const dir = initEmptyRepo("ad-coder-untracked-vanish-");
  let thrown: unknown;
  try {
    appendSafeUntrackedDiffProjection(
      dir,
      { text: "", bytes: 0, sha256: "", redactedLines: 0 },
      ["ghost.txt"],
      4096,
    );
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(RunnerError);
  expect((thrown as RunnerError).code).toBe("diff_metric_failed");
  expect((thrown as RunnerError).message).toContain("untracked file is unreadable");
});

test("a non-UTF-8 untracked file is still a typed measurement failure (issue #449)", () => {
  const dir = initEmptyRepo("ad-coder-untracked-bin-");
  fs.writeFileSync(path.join(dir, "blob.bin"), Buffer.from([0xff, 0xfe, 0x00, 0x01]));
  let thrown: unknown;
  try {
    appendSafeUntrackedDiffProjection(
      dir,
      { text: "", bytes: 0, sha256: "", redactedLines: 0 },
      ["blob.bin"],
      4096,
    );
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(RunnerError);
  expect((thrown as RunnerError).code).toBe("diff_metric_failed");
  expect((thrown as RunnerError).message).toContain("untracked diff is not UTF-8");
});

/** A rejected runRole: plain Error with the harness `code` field attached. */
function isCodedError(error: unknown): error is Error & { code?: string } {
  return error instanceof Error && "code" in error;
}

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

test("a message-embedded 429 is classified as quota from both message shapes", () => {
  // Shape 1, `formatProviderError`: "<status>: <body>".
  expect(
    providerQuotaFrom({
      code: "assistant_error",
      message: '429: {"error":{"type":"weekly_usage_limit_exceeded","message":"resets in 2 days"}}',
    }),
  ).toEqual({ status: 429, providerCode: "weekly_usage_limit_exceeded" });
  // Shape 2, the provider SDK's own `APIError.message`: "<status> <body>".
  expect(
    providerQuotaFrom({
      code: "assistant_error",
      message: '429 {"type":"error","error":{"type":"insufficient_quota","message":"slow down"}}',
    }),
  ).toEqual({ status: 429, providerCode: "insufficient_quota" });
  // A structured status of 429 is also honoured.
  expect(providerQuotaFrom({ status: 429 })).toEqual({ status: 429 });
  // Non-429 statuses are not quota. 401/403 stay with the credential wording,
  // 5xx stays out, and a no-status message is not quota either.
  expect(providerQuotaFrom({ message: '401: {"error":{"message":"bad key"}}' })).toBeUndefined();
  expect(providerQuotaFrom({ message: '403: {"error":{"message":"forbidden"}}' })).toBeUndefined();
  expect(providerQuotaFrom({ message: '503: {"error":{"message":"overloaded"}}' })).toBeUndefined();
  expect(providerQuotaFrom({ message: "assistant stopped with error" })).toBeUndefined();
  expect(providerQuotaFrom(undefined)).toBeUndefined();
  expect(providerQuotaFrom({ status: 400 })).toBeUndefined();
});

test("quota token extraction returns a bounded token and never body prose", () => {
  // The real code/type is extracted.
  expect(extractProviderCodeToken('{"error":{"type":"weekly_usage_limit"}}')).toBe(
    "weekly_usage_limit",
  );
  expect(extractProviderCodeToken('{"error":{"code":"quota_exceeded"}}')).toBe("quota_exceeded");
  expect(extractProviderCodeToken('{"error_type":"insufficient_quota"}')).toBe(
    "insufficient_quota",
  );
  // The Anthropic envelope discriminator "error" is skipped, and the nested
  // type is found instead.
  expect(extractProviderCodeToken('{"type":"error","error":{"type":"rate_limit_error"}}')).toBe(
    "rate_limit_error",
  );
  // Prose, URLs and long identifiers never cross: the value must match the
  // strict charset exactly and be length-capped.
  expect(
    extractProviderCodeToken('{"error":{"message":"You have exceeded your weekly usage limit"}}'),
  ).toBeUndefined();
  expect(
    extractProviderCodeToken('{"error":{"url":"https://example.com/upgrade"}}'),
  ).toBeUndefined();
  expect(extractProviderCodeToken(`{"error":{"code":"${"a".repeat(65)}"}}`)).toBeUndefined();
  // A token exactly at the 64-char bound is kept.
  expect(extractProviderCodeToken(`{"error":{"code":"${"b".repeat(64)}"}}`)).toBe("b".repeat(64));
});

test("quota errors are typed, bounded, and carry a reset window when supplied", () => {
  const quota = new ProviderQuotaError("run-1", "quota_exceeded", 120_000);
  expect(quota.code).toBe("provider_quota");
  expect(quota.status).toBe(429);
  expect(quota.providerCode).toBe("quota_exceeded");
  expect(quota.retryAfterMs).toBe(120_000);
  // The message names the status, the provider token, the reset window, and
  // waits/checks-plan advice -- never "authentication" or "inspect the request".
  expect(quota.message).toContain("HTTP 429");
  expect(quota.message).toContain("quota_exceeded");
  expect(quota.message).toContain("resets in");
  expect(quota.message).toContain("wait for the reset window");
  expect(quota.message).not.toContain("authentication");
  expect(quota.message).not.toContain("inspect the request");
  // Without a token or reset window the fields are simply absent; the body
  // that produced them never appears on the error.
  const bare = new ProviderQuotaError("run-1");
  expect(bare.providerCode).toBeUndefined();
  expect(bare.retryAfterMs).toBeUndefined();
  expect(JSON.stringify(bare)).not.toContain("weekly_usage_limit");
  expect(JSON.stringify(bare)).not.toContain("resets in 2 days");
  expect(JSON.stringify(quota)).not.toContain("never-publish-me");
});

test("#356: a message-embedded 429 quota refusal surfaces as a typed quota outcome", async () => {
  const { faux, models, model, role } = harnessFixture();
  // The incident body: a 429 whose structured error names a quota exhaustion
  // ("insufficient_quota"), which pi-ai classifies non-retryable so it settles
  // as a failed operation with the message-embedded status -- the exact shape
  // that was collapsing into EmptyTurnError.
  faux.setResponses([
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage:
        '429: {"error":{"type":"insufficient_quota","message":"Weekly usage limit reached, resets in 2 days, enable usage from available balance"}}',
    }),
  ]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-quota-"));
  await expect(
    runRole({ role, targetDir: tmp, models, model, prompt: "do it" }),
  ).rejects.toMatchObject({
    code: "provider_quota",
    status: 429,
    providerCode: "insufficient_quota",
  });
});

test("#418: a non-allow-list provider status still names its cause in the empty-turn fallback", async () => {
  const { faux, models, model, role } = harnessFixture();
  // The incident shape: every preset of the provider refused with the same
  // billing status, embedded in a settled error the rejection allow-list
  // does not own (402 is neither a rejection nor a quota nor a credential
  // status). The fallback EmptyTurnError currently carries only the harness
  // code and the misdirecting credential advice, so the operator is told to
  // "verify authentication" about a key that is fine.
  faux.setResponses([
    () => {
      throw new Error(
        '402: {"error":{"code":"insufficient_credits","message":"PROBE never-publish-me"}}',
      );
    },
  ]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-418-"));
  const thrown = await runRole({ role, targetDir: tmp, models, model, prompt: "do it" }).catch(
    (error: unknown) => error as unknown,
  );
  if (!isCodedError(thrown)) throw new Error("runRole should have rejected with a coded error");
  expect(thrown.code).toBe("empty_turn");
  expect(thrown).toMatchObject({ providerStatus: 402, providerErrorCode: "insufficient_credits" });
  // A named provider status replaces the credential misdirection: the message
  // must not advise an auth check the `auth status` already disproves.
  expect(thrown.message).not.toContain("verify authentication");
  expect(thrown.message).toContain("HTTP 402");
  expect(thrown.message).toContain("insufficient_credits");
  // Bounded fields only: the uncontrolled body never crosses the error text.
  expect(JSON.stringify(thrown)).not.toContain("never-publish-me");
});

test("#418: a 401/403-embedded empty turn keeps the credential wording (errors 2026-09-19)", async () => {
  const { faux, models, model, role } = harnessFixture();
  faux.setResponses([
    () => {
      throw new Error(
        '401: {"error":{"code":"invalid_api_key","message":"PROBE never-publish-me"}}',
      );
    },
  ]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-418-"));
  const thrown = await runRole({ role, targetDir: tmp, models, model, prompt: "do it" }).catch(
    (error: unknown) => error as unknown,
  );
  if (!isCodedError(thrown)) throw new Error("runRole should have rejected with a coded error");
  expect(thrown.code).toBe("empty_turn");
  // The status is recorded (provenance, not classification), but the message
  // stays exactly the credential advice the 2026-09-19 boundary pinned.
  expect(thrown).toMatchObject({ providerStatus: 401, providerErrorCode: "invalid_api_key" });
  expect(thrown.message).toContain("verify authentication and retry");
  expect(thrown.message).not.toContain("HTTP 401");
});

test("truncatedGenerationFrom classifies silence and spares usable content", () => {
  // The #368 incident evidence, read as a structural slice: the model spent
  // ~99.8% of the output budget on thinking, was truncated mid-reasoning, and
  // emitted no text and no tool call.
  expect(
    truncatedGenerationFrom({
      role: "assistant",
      stopReason: "length",
      content: [{ type: "thinking", thinking: "never finished" }],
      usage: { output: 16384, reasoning: 16347 },
    }),
  ).toEqual({ stopReason: "length", outputTokens: 16384, reasoningTokens: 16347 });
  // Usable content never classifies: answer text (even a partial one) and a
  // tool call are both something the caller can act on.
  expect(
    truncatedGenerationFrom({
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "answer" }],
    }),
  ).toBeUndefined();
  expect(
    truncatedGenerationFrom({
      role: "assistant",
      stopReason: "length",
      content: [{ type: "text", text: "   " }],
    }),
  ).toEqual({ stopReason: "length" });
  expect(
    truncatedGenerationFrom({
      role: "assistant",
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: {} }],
    }),
  ).toBeUndefined();
  // Failure markers are owned by the settled-FAILURE classifications: an
  // error/aborted stop is not a settled generation that came up short, and
  // re-labelling a credential refusal (which arrives error-stopped) as a
  // truncation would trade one wrong cause for another.
  expect(
    truncatedGenerationFrom({ role: "assistant", stopReason: "error", content: [] }),
  ).toBeUndefined();
  expect(
    truncatedGenerationFrom({
      role: "assistant",
      stopReason: "aborted",
      content: [{ type: "thinking", thinking: "cut off" }],
    }),
  ).toBeUndefined();
  // pi-agent-core's exhausted length-recovery marker: the retry truncated
  // again and the committed message was rewritten to an error stop. That IS
  // the truncated generation -- thinking ran, no answer -- and the reported
  // stop reason is the `length` the recovery was recovering.
  expect(
    truncatedGenerationFrom({
      role: "assistant",
      stopReason: "error",
      errorMessage: "Assistant request exceeded the context window",
      content: [{ type: "thinking", thinking: "cut off twice" }],
      usage: { output: 8000, reasoning: 7963 },
    }),
  ).toEqual({ stopReason: "length", outputTokens: 8000, reasoningTokens: 7963 });
  // The marker needs pi's exact wording AND generation content: a provider's
  // own overflow wording, or an error-stopped message with nothing on it,
  // stays with the failure classifications.
  expect(
    truncatedGenerationFrom({
      role: "assistant",
      stopReason: "error",
      errorMessage: "prompt is too long: 213462 tokens > 200000 maximum",
      content: [{ type: "thinking", thinking: "cut off" }],
    }),
  ).toBeUndefined();
  expect(
    truncatedGenerationFrom({
      role: "assistant",
      stopReason: "error",
      errorMessage: "Assistant request exceeded the context window",
      content: [],
    }),
  ).toBeUndefined();
  // A non-assistant message and a missing message are not evidence.
  expect(truncatedGenerationFrom(undefined)).toBeUndefined();
  expect(
    truncatedGenerationFrom({ role: "user", stopReason: "length", content: [] }),
  ).toBeUndefined();
  // A hostile stop reason never crosses, and fractional/negative counts drop.
  expect(
    truncatedGenerationFrom({
      role: "assistant",
      stopReason: "length; drop table users",
      content: [{ type: "thinking", thinking: "cut" }],
      usage: { output: 1.5, reasoning: -3 },
    }),
  ).toEqual({});
  // Silence WITHOUT evidence of a cut is the silent no-op the workflow layer
  // already classifies: an empty settled answer with no reasoning and no named
  // output limit is not a truncation.
  expect(
    truncatedGenerationFrom({ role: "assistant", stopReason: "stop", content: [] }),
  ).toBeUndefined();
  expect(
    truncatedGenerationFrom({
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "" }],
    }),
  ).toBeUndefined();
  // But the provider's own `length` stop is evidence by itself, even with
  // nothing to show for the spent budget.
  expect(truncatedGenerationFrom({ role: "assistant", stopReason: "length", content: [] })).toEqual(
    { stopReason: "length" },
  );
});

test("generation truncation errors are typed, bounded, and name a budget remedy", () => {
  const truncated = new GenerationTruncatedError("run-1", "length", 16384, 16347);
  expect(truncated.code).toBe("generation_truncated");
  expect(truncated.stopReason).toBe("length");
  expect(truncated.outputTokens).toBe(16384);
  expect(truncated.reasoningTokens).toBe(16347);
  // The message names the exhausted budget and a remedy that can work -- never
  // "verify authentication", and the thinking prose that produced the
  // truncation is never on the error.
  expect(truncated.message).toContain("output-token limit");
  expect(truncated.message).toContain("16384 output tokens");
  expect(truncated.message).toContain("16347 on reasoning");
  expect(truncated.message).toContain("raise the output budget or bound thinking, then retry");
  expect(truncated.message).not.toContain("authentication");
  // A non-length stop reason and no counts still classify, honestly.
  const bare = new GenerationTruncatedError("run-1");
  expect(bare.stopReason).toBeUndefined();
  expect(bare.outputTokens).toBeUndefined();
  expect(bare.message).toContain("no answer and no tool call");
  expect(bare.message).toContain("raise the output budget or bound thinking");
  // The constructor bounds its own fields: a hostile token and a fractional or
  // negative count are dropped, never truncated and never carried.
  const hostile = new GenerationTruncatedError("run-1", "length; drop table users", 1.5, -3);
  expect(hostile.stopReason).toBeUndefined();
  expect(hostile.outputTokens).toBeUndefined();
  expect(hostile.reasoningTokens).toBeUndefined();
  expect(JSON.stringify(hostile)).not.toContain("drop table");
});

test("#368: a generation truncated at the output limit surfaces as a typed truncated outcome", async () => {
  const { faux, models, model, role } = harnessFixture();
  // The incident shape: the model spent the whole output budget on thinking
  // (the faux provider estimates output from content, so the thinking below is
  // long enough to reach the 16384-token limit), was truncated mid-reasoning,
  // and emitted no text and no tool call. At the limit pi-agent-core sees no
  // recoverable length stop and settles the turn `completed` -- so the failure
  // classifications above the boundary never fired and the caller saw an empty
  // success with isError false.
  const marker = "reasoning-that-never-finished";
  faux.setResponses([
    fauxAssistantMessage([fauxThinking(`${marker} `.repeat(100_000 / 28 + 1))], {
      stopReason: "length",
    }),
  ]);
  const error = await runRole({ role, targetDir, models, model, prompt: "do it" }).catch(
    (cause) => cause,
  );
  expect(error).toMatchObject({ code: "generation_truncated", stopReason: "length" });
  expect(error.message).toContain("output-token limit");
  expect(error.message).toContain("raise the output budget or bound thinking");
  expect(error.message).not.toContain("authentication");
  // The truncated thinking is evidence in the session, never on the error.
  expect(error.message).not.toContain(marker);
});

test("#368: a length stop pi-agent-core retried into a second truncation is still typed, not an authentication claim", async () => {
  const { faux, models, model, role } = harnessFixture();
  // When the stop came BELOW the intended limit, pi-agent-core makes one
  // bounded compact-and-retry attempt; the queued summary feeds that retry, and
  // the retry truncates below the limit again, settling the turn `failed` with
  // the generic `assistant_error`. The empty-turn fallback would have told the
  // operator to verify authentication about a generation that ran twice.
  faux.setResponses([
    fauxAssistantMessage([fauxThinking("first truncated reasoning")], { stopReason: "length" }),
    fauxAssistantMessage("summary of the conversation so far"),
    fauxAssistantMessage([fauxThinking("second truncated reasoning")], { stopReason: "length" }),
  ]);
  const error = await runRole({ role, targetDir, models, model, prompt: "do it" }).catch(
    (cause) => cause,
  );
  expect(error).toMatchObject({ code: "generation_truncated", stopReason: "length" });
  expect(error.message).toContain("raise the output budget or bound thinking");
  expect(error.message).not.toContain("authentication");
  expect(error.message).not.toContain("second truncated reasoning");
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

test("runRole delivers settled text when the diff metric fails on a commit-less target", async () => {
  // A `git init` with no commits makes `git diff HEAD` exit 128 ("bad revision"),
  // which is neither 0 (measured) nor 129 (no worktree), so measureSafeGitDiffBytes
  // throws diff_metric_failed. The diff metric is observability, not the
  // deliverable (issue #363): a completed coder stage must still deliver its
  // settled text instead of being destroyed.
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-no-commit-"));
  execFileSync("git", ["init", "-q"], { cwd: repository });
  const { faux, models, model, role } = harnessFixture();
  faux.setResponses([fauxAssistantMessage("the settled coder report")]);

  const result = await runRole({ role, targetDir: repository, models, model, prompt: "fix it" });

  expect(result.result.status).toBe("completed");
  expect(result.observations?.diffBytes).toBe(0);
  // The strongest available survival signal, and why: the pre-fix code threw
  // AFTER the turn settled, so the caller got a RunnerError instead of any
  // record, and the settled deliverable was unreachable from the return
  // value. runRole's return shape does not expose the final text
  // (`OperationResultRecord` carries status/tip ids only), so the deliverable
  // is read back from the durable session the run wrote: the settled text
  // itself must have survived, not just a record shell.
  const store = new ProjectStore(repository);
  const sessions = await store.listSessions();
  expect(sessions).toHaveLength(1);
  const readable = await store.resumeSession(sessions[0]!.id);
  try {
    // Mirrors the workflow's own final-text extraction: scan newest-first for
    // the first assistant message and join its text blocks.
    const entries = await readable.findEntries(
      { type: "message", order: "desc", limit: 20 },
      BACKGROUND_CONTEXT,
    );
    let text = "";
    for (const entry of entries) {
      if (entry.type !== "message") continue;
      if (entry.message.role !== "assistant") continue;
      text = entry.message.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("");
      break;
    }
    expect(text).toContain("the settled coder report");
  } finally {
    await readable.close(BACKGROUND_CONTEXT);
  }
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

test("the harness compaction threshold is derived from the RUNTIME window", () => {
  // The threshold is what makes a role's own budget meaningful when it is paired
  // with a model other than the one it was defined against: ad-coder compacts at
  // `maxTokens - reserveTokens`, the harness at `contextWindow - reserveTokens`,
  // and only the derived reserve makes the two the same number.
  const { models, model } = harnessFixture();
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
  const session = {} as Parameters<typeof toHarnessOptions>[1]["session"];
  const atOwnWindow = toHarnessOptions(role, { session, models, model });
  expect(atOwnWindow.compaction).toEqual({
    enabled: true,
    // 200_000 - (1100 - 100), so the harness fires at 1000 -- the role's own
    // threshold, on a window 200x its budget.
    reserveTokens: 199_000,
    keepRecentTokens: 250,
  });
  const narrower = { ...model, contextWindow: 500 } as Model<Api>;
  expect(toHarnessOptions(role, { session, models, model: narrower }).compaction).toEqual({
    enabled: true,
    // maxTokens - reserve exceeds the runtime window, so the reserve clamps to 0
    // and the threshold lands AT the window instead of below it.
    reserveTokens: 0,
    keepRecentTokens: 250,
  });
  // A disabled role compacts nothing: every upstream field is zero, so no
  // threshold can fire and no entry is ever committed.
  expect(
    toHarnessOptions(role, { session, models, model, compactionMode: "disabled-then-halt" })
      .compaction,
  ).toEqual({ enabled: false, reserveTokens: 0, keepRecentTokens: 0 });
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

/**
 * Like harnessFixture, but responses arrive with EXACT provider usage
 * (input/cacheRead/output/reasoning/cost) instead of the faux provider's
 * re-estimated totals, which would erase anything a test writes. The pi-ai
 * provider surface is implemented directly over `createProvider`; each stream
 * ends immediately with the next scripted message.
 */
function usageFixture(steps: Array<AssistantMessage | (() => AssistantMessage)>) {
  let consumed = 0;
  const model = {
    id: "usage-faux-1",
    name: "Usage Faux 1",
    api: "usage-faux",
    provider: "usage-faux",
    baseUrl: "http://localhost:0",
    reasoning: true,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: CONTEXT_WINDOW,
    maxTokens: 16384,
  } as Model<Api>;
  const singleStream = () => {
    const events = createAssistantMessageEventStream();
    const step = steps[consumed++] ?? fauxAssistantMessage("done");
    events.end(typeof step === "function" ? step() : step);
    return events;
  };
  const provider = createProvider({
    id: "usage-faux",
    auth: { apiKey: { name: "UsageFaux", resolve: async () => ({ auth: {} }) } },
    models: [model],
    api: {
      stream: singleStream,
      streamSimple: singleStream,
    },
  });
  const models = createModels();
  models.setProvider(provider);
  const role = defineRole(
    {
      name: "coder",
      provider: "usage-faux",
      modelId: model.id,
      systemPrompt: "You code.",
      activeToolNames: ["bash", "read", "write", "edit"],
      cacheRetention: "none",
      contextBudget: { maxTokens: 100_000, reserveTokens: 10_000, keepRecentTokens: 20_000 },
    },
    model,
  );
  return { models, model, role };
}

/** An exact-usage assistant message: the runner hook's numeric seams. */
function messageWithUsage(usage: {
  input?: number;
  cacheRead?: number;
  output: number;
  reasoning?: number;
  costTotal?: number;
}): AssistantMessage {
  const message = fauxAssistantMessage("done");
  const total = (usage.input ?? 0) + (usage.cacheRead ?? 0) + usage.output + (usage.reasoning ?? 0);
  message.usage = {
    input: usage.input ?? 0,
    output: usage.output,
    cacheRead: usage.cacheRead ?? 0,
    cacheWrite: 0,
    ...(usage.reasoning !== undefined && { reasoning: usage.reasoning }),
    totalTokens: total,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage.costTotal ?? 0 },
  };
  return message;
}

test("#469: a reasoning>output anomaly is clamped down, not fatal, and the paid round finishes", async () => {
  // The anomalous pair is the provider's own accounting: `output` is
  // `completion_tokens` and already contains `reasoning_tokens`, so reasoning
  // 250 vs output 100 cannot both be true. Before #469 this threw inside the
  // after_response hook and re-threw after the verdict, discarding the round.
  const { models, model, role } = usageFixture([
    messageWithUsage({ input: 10, output: 100, reasoning: 250 }),
  ]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-469-"));
  const result = await runRole({ role, targetDir: tmp, models, model, prompt: "do it" });
  expect(result.result.status).toBe("completed");
  // Accumulation stays on the clamped numbers: reasoning no longer exceeds
  // output, and the excess is absorbed, not propagated.
  expect(result.observations.output).toBe(100);
  expect(result.observations.reasoning).toBe(100);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("#469: every other bounded-usage violation still kills the round", async () => {
  // The clamp owns ONLY the reasoning>output anomaly; hostile numbers stay
  // fatal. NaN reasoning trips boundedUsageInteger and still poisons the run.
  for (const hostileReasoning of [Number.NaN, -1, 1.5, 2_000_000_000_000]) {
    const { models, model, role } = usageFixture([
      messageWithUsage({ input: 10, output: 100, reasoning: hostileReasoning }),
    ]);
    await expect(
      runRole({ role, targetDir, models, model, prompt: "do it" }),
    ).rejects.toBeInstanceOf(RangeError);
  }
});
