import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  Type,
} from "@earendil-works/pi-ai";
import { ContextBudgetError } from "../src/context/budget";
import type { Summarizer } from "../src/context/compactor";
import { LEDGER_BASE_DIR } from "../src/ledger/ledger";
import type { Role } from "../src/role";
import { defineRole } from "../src/role";
import { RunnerError, resolveTargetDir } from "../src/runner/errors";
import { runRole } from "../src/runner/runner";
import { defineTool } from "../src/runner/tool";
import { SessionLimitController, SessionLimitError } from "../src/session-limits";

const CONTEXT_WINDOW = 200_000;

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

test("runRole drives one turn to a settled result and lands the ledger under targetDir", async () => {
  const { faux, models, model, role } = harnessFixture();
  faux.setResponses([fauxAssistantMessage("done")]);

  const result = await runRole({ role, targetDir, models, model, prompt: "do the thing" });

  expect(result.result.status).toBe("completed");
  expect(result.ledgerPath).toBe(path.join(targetDir, LEDGER_BASE_DIR, `${result.runId}.jsonl`));
  expect(result.droppedRecords).toBe(0);

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

  const underCwd = path.join(process.cwd(), LEDGER_BASE_DIR, `${result.runId}.jsonl`);
  expect(fs.existsSync(underCwd)).toBe(false);
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

test("runRole does not invoke the summarizer when the turn fits the budget", async () => {
  const { faux, models, model, role } = harnessFixture();
  faux.setResponses([fauxAssistantMessage("done")]);
  const summarizer: Summarizer = () => {
    throw new Error("summarizer must not run under budget");
  };

  const result = await runRole({ role, targetDir, models, model, prompt: "small", summarizer });
  expect(result.result.status).toBe("completed");
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
