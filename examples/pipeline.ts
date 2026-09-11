#!/usr/bin/env bun
/**
 * Run a full plan -> [security] -> code <-> review pipeline on a clean target
 * directory, using DeepSeek for every role. This is the canonical end-to-end
 * demo of ad-coder driving a real feature.
 *
 *   DEEPSEEK_API_KEY=... bun run examples/pipeline.ts "<task>" [targetDir]
 *
 * Credentials come from the process environment (never from the target project).
 * If no targetDir is given a fresh temp directory is created and printed.
 */
import { defineRole, resolvePrompt, resolveRoleModel, runPipeline, MemoryLedgerSink } from "ad-coder";
import { PromptError } from "ad-coder";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const task =
  process.argv[2] ??
  "Create add.js exporting add(a, b) returning a + b via CommonJS (module.exports = { add }). Minimal.";
const targetDir = process.argv[3] ?? fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-"));

const promptsDir = path.join(import.meta.dir, "..", "prompts");
const read = (f: string) => fs.readFileSync(path.join(promptsDir, f), "utf8");
const budget = { maxTokens: 120_000, reserveTokens: 8_000, keepRecentTokens: 24_000 };

// The boundary usage: reference a system prompt BY NAME so a project can ship
// its own <targetDir>/.ad-coder/prompts/<name>.md to override the built-in. The
// inline read() path is kept as a fallback -- if resolvePrompt cannot find the
// name (e.g. a trimmed-down install) the example still runs from the sibling
// prompts/ dir it was invoked from.
function systemPrompt(name: string, promptFile: string): string {
  try {
    return resolvePrompt(name, { projectDir: targetDir });
  } catch (err) {
    if (err instanceof PromptError && err.code === "not_found") {
      return read(promptFile);
    }
    throw err;
  }
}

function role(name: string, promptFile: string, tools: string[]) {
  const input = {
    name,
    provider: "deepseek",
    modelId: "deepseek-v4-flash",
    systemPrompt: systemPrompt(name, promptFile),
    activeToolNames: tools,
    cacheRetention: "short" as const,
    contextBudget: budget,
  };
  const { model, models } = resolveRoleModel(input);
  return { spec: { role: defineRole(input, model), model }, models };
}

const planner = role("planner", "planner.md", ["read", "bash", "submit_plan"]);
const security = role("security", "security.md", ["read", "bash"]);
const coder = role("coder", "coder.md", ["read", "write", "edit", "bash"]);
const reviewer = role("reviewer", "reviewer.md", ["read", "bash", "submit_verdict"]);
const ledger = new MemoryLedgerSink();

console.log(`targetDir: ${targetDir}\ntask: ${task}\n`);

const result = await runPipeline({
  targetDir,
  models: planner.models,
  maxRounds: 2,
  task,
  roles: {
    planner: planner.spec,
    security: security.spec,
    coder: coder.spec,
    reviewer: reviewer.spec,
  },
  ledgerSink: ledger,
});

console.log(`complexity: ${result.complexity} | securitySurface: ${result.securitySurface}`);
console.log(`approved: ${result.approved} | rounds: ${result.rounds}`);
let total = 0;
const byStep: Record<string, number> = {};
for (const r of ledger.records()) {
  const k = `${r.role}/${r.step}`;
  byStep[k] = (byStep[k] ?? 0) + r.usage.cost.total;
  total += r.usage.cost.total;
}
console.log("\ncost by phase:");
for (const [k, c] of Object.entries(byStep)) console.log(`  ${k.padEnd(18)} $${c.toFixed(8)}`);
console.log(`  ${"TOTAL".padEnd(18)} $${total.toFixed(8)}`);
