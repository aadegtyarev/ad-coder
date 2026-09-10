import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { Api } from "@earendil-works/pi-ai";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { LEDGER_BASE_DIR } from "../src/ledger/ledger";
import { defineRole } from "../src/role";
import type { Role } from "../src/role";
import { RunnerError, resolveTargetDir } from "../src/runner/errors";
import { runRole } from "../src/runner/runner";
import type { Summarizer } from "../src/context/compactor";

const CONTEXT_WINDOW = 200_000;

/** A faux provider + models pair and the role validated against its window. */
function harnessFixture() {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: CONTEXT_WINDOW }] });
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
