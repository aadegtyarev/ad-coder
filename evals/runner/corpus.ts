#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CalibrationTask } from "../../src/evaluation/calibration";
import { measuredRolesOf, scoreCalibrationRun } from "../../src/evaluation/calibration";
import type { LedgerRecord } from "../../src/ledger/types";
import type { ConsoleTurn, OrchestratorReport } from "./report";
import { buildOrchestratorReport, extractJsonArtifact } from "./report";

type Task = CalibrationTask & {
  fixture?: string;
  scorer?: string;
  scorerInput?: "target" | "artifact" | "report";
  /**
   * Ordered console inputs for a manual-workflow task. Splitting the work into
   * turns is what makes ORDER observable: a claim the model makes in turn one
   * demonstrably precedes the delegation it performs in turn two, and the
   * runner checks that rather than taking the model's word for the sequence.
   */
  prompts?: string[];
};

const root = path.resolve(import.meta.dir, "..");
const repoRoot = path.resolve(root, "..");
const cli = path.join(repoRoot, "src", "cli.ts");

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function loadTasks(): { file: string; task: Task }[] {
  const corpus = readJson<{ version: number; tasks: string[] }>(path.join(root, "corpus.json"));
  if (
    corpus.version !== 1 ||
    !Array.isArray(corpus.tasks) ||
    new Set(corpus.tasks).size !== corpus.tasks.length
  )
    throw new Error("invalid corpus manifest");
  const loaded = corpus.tasks.map((rel) => {
    const file = path.resolve(root, rel);
    if (!file.startsWith(`${root}${path.sep}`)) throw new Error("task escapes corpus");
    return { file, task: readJson<Task>(file) };
  });
  for (const { task } of loaded) {
    if (!task.id || !task.prompt || !task.checks?.length)
      throw new Error(`invalid task: ${task.id ?? "unknown"}`);
    if (task.fixture && !fs.statSync(path.join(root, "fixtures", task.fixture)).isDirectory())
      throw new Error(`missing fixture: ${task.id}`);
    if (
      task.scorerInput !== undefined &&
      !["target", "artifact", "report"].includes(task.scorerInput)
    )
      throw new Error(`invalid scorer input: ${task.id}`);
    if (task.scorer && !fs.statSync(path.join(root, "scorers", task.scorer)).isFile())
      throw new Error(`missing scorer: ${task.id}`);
    if (task.prompts !== undefined) {
      if (!Array.isArray(task.prompts) || task.prompts.some((p) => typeof p !== "string" || !p))
        throw new Error(`invalid prompts: ${task.id}`);
      if (task.mode !== "manual-workflow")
        throw new Error(`prompts require manual-workflow mode: ${task.id}`);
    }
    // A pipeline task's `role` is the synthetic dispatch label "pipeline", which
    // no ledger row ever carries -- so without `measuredRoles` its measurement
    // would silently report no model at all. Demanded here, at load, rather than
    // discovered as a null in a scored result hours later.
    if (task.mode === "automatic-pipeline" && task.measuredRoles === undefined)
      throw new Error(`automatic-pipeline task must declare measuredRoles: ${task.id}`);
    measuredRolesOf(task);
  }
  return loaded;
}

/** A fresh empty path; `calibration-materialize` insists on creating it itself. */
function freshTarget(id: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ad-coder-${id}-`));
  fs.rmSync(dir, { recursive: true });
  return dir;
}

function materialize(fixture: string, target: string): void {
  const result = spawnSync(
    "bun",
    [
      path.join(repoRoot, "scripts", "calibration-materialize.ts"),
      path.join(root, "fixtures", fixture),
      target,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr || "materialize failed");
}

function runScorer(scorer: string, argument: string): { id: string; passed: boolean }[] {
  const result = spawnSync("bun", [path.join(root, "scorers", scorer), argument], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr || `scorer failed: ${scorer}`);
  return JSON.parse(result.stdout) as { id: string; passed: boolean }[];
}

function assertScorerMatchesTask(task: Task, checks: { id: string; passed: boolean }[]): void {
  if (
    checks.length !== task.checks.length ||
    checks.some((c) => !task.checks.some((e) => e.id === c.id))
  )
    throw new Error(`scorer mismatch: ${task.id}`);
}

/**
 * The ledger path ad-coder prints on stderr.
 *
 * Read rather than reconstructed: the run id is minted inside the process, so
 * guessing the file name here would silently score the WRONG run whenever the
 * front changes how it names one.
 */
function ledgerPathFrom(stderr: string): string {
  const match = /ledger=(\S+)/.exec(stderr);
  if (!match?.[1] || match[1] === "custom")
    throw new Error("ad-coder did not report a ledger path");
  return match[1];
}

function readLedger(file: string): LedgerRecord[] {
  if (!fs.existsSync(file)) throw new Error(`ledger file is missing: ${file}`);
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LedgerRecord);
}

/**
 * The newest coordinator checkpoint under the target.
 *
 * A manual workflow writes one per run it drives; the orchestrator may have
 * begun several, and only the one it carried to a verdict answers "approved".
 */
function latestCheckpoint(target: string): Record<string, unknown> | undefined {
  const runs = path.join(target, ".ad-coder", "runs");
  if (!fs.existsSync(runs)) return undefined;
  const files = fs
    .readdirSync(runs)
    .filter((name) => name.startsWith("coordinator-") && name.endsWith(".json"))
    .map((name) => path.join(runs, name));
  if (files.length === 0) return undefined;
  const newest = files
    .map((file) => ({ file, mtime: fs.statSync(file).mtimeMs }))
    .sort((left, right) => right.mtime - left.mtime)[0];
  return newest === undefined ? undefined : readJson<Record<string, unknown>>(newest.file);
}

function spawnAdCoder(
  args: string[],
  options: { cwd: string; input?: string; timeoutMs: number },
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync("bun", [cli, ...args], {
    cwd: options.cwd,
    encoding: "utf8",
    timeout: options.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    ...(options.input === undefined ? {} : { input: options.input }),
  });
  if (result.error) throw result.error;
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
}

/** One executed task: where its evidence lives and what the model produced. */
interface Execution {
  target: string;
  ledgerFile: string;
  stdout: string;
  report?: OrchestratorReport;
}

function executeRole(task: Task, target: string, extra: string[], timeoutMs: number): Execution {
  const run = spawnAdCoder(["role", task.role, task.prompt, "--target-dir", target, ...extra], {
    cwd: repoRoot,
    timeoutMs,
  });
  if (run.status !== 0) throw new Error(run.stderr || "ad-coder role failed");
  return { target, ledgerFile: ledgerPathFrom(run.stderr), stdout: run.stdout };
}

function executePipeline(
  task: Task,
  target: string,
  extra: string[],
  timeoutMs: number,
): Execution {
  const run = spawnAdCoder(["drive", task.prompt, "--auto", "--target-dir", target, ...extra], {
    cwd: repoRoot,
    timeoutMs,
  });
  if (run.status !== 0) throw new Error(run.stderr || "ad-coder drive failed");
  return { target, ledgerFile: ledgerPathFrom(run.stderr), stdout: run.stdout };
}

function executeManualWorkflow(
  task: Task,
  target: string,
  extra: string[],
  timeoutMs: number,
): Execution {
  const prompts = task.prompts ?? [task.prompt];
  const run = spawnAdCoder(
    ["console", "--json", "--target-dir", target, "--workflows", "pipeline", ...extra],
    { cwd: repoRoot, input: `${prompts.join("\n")}\n`, timeoutMs },
  );
  if (run.status !== 0) throw new Error(run.stderr || "ad-coder console failed");
  const turns = run.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ConsoleTurn);
  const ledgerFile = ledgerPathFrom(run.stderr);
  const ledger = readLedger(ledgerFile);
  const checkpoint = latestCheckpoint(target);
  const report = buildOrchestratorReport({
    taskId: task.id,
    turns,
    ledger,
    ...(checkpoint?.workflowState === undefined
      ? {}
      : { workflowState: checkpoint.workflowState as { complexity?: string; approved?: boolean } }),
  });
  return { target, ledgerFile, stdout: run.stdout, report };
}

function runTask(
  task: Task,
  taskFile: string,
  options: {
    inventory: string;
    thinkingLevel: string;
    extra: string[];
    timeoutMs: number;
    keep: boolean;
  },
): void {
  if (!task.scorer) throw new Error(`task has no scorer: ${task.id}`);
  const target = freshTarget(task.id);
  if (task.fixture) materialize(task.fixture, target);
  else fs.mkdirSync(target, { recursive: true });
  const started = Date.now();
  let execution: Execution | undefined;
  try {
    execution =
      task.mode === "role"
        ? executeRole(task, target, options.extra, options.timeoutMs)
        : task.mode === "automatic-pipeline"
          ? executePipeline(task, target, options.extra, options.timeoutMs)
          : executeManualWorkflow(task, target, options.extra, options.timeoutMs);
    const durationMs = Date.now() - started;
    const scorerInput = task.scorerInput ?? "target";
    let checks: { id: string; passed: boolean }[];
    if (scorerInput === "target") checks = runScorer(task.scorer, target);
    else {
      const file = path.join(target, scorerInput === "artifact" ? "artifact.json" : "report.json");
      fs.writeFileSync(
        file,
        scorerInput === "artifact"
          ? extractJsonArtifact(execution.stdout)
          : `${JSON.stringify(execution.report ?? {}, null, 2)}\n`,
      );
      checks = runScorer(task.scorer, file);
    }
    assertScorerMatchesTask(task, checks);
    const measurement = scoreCalibrationRun({
      task: readJson<CalibrationTask>(taskFile),
      checks,
      ledger: readLedger(execution.ledgerFile),
      inventory: options.inventory,
      thinkingLevel: options.thinkingLevel,
      durationMs,
      ...(execution.report?.predictedComplexity !== null &&
        execution.report?.predictedComplexity !== undefined && {
          orchestratorComplexity: execution.report
            .predictedComplexity as CalibrationTask["complexity"],
        }),
      ...(execution.report?.plannerComplexity !== null &&
        execution.report?.plannerComplexity !== undefined && {
          plannerComplexity: execution.report.plannerComplexity as CalibrationTask["complexity"],
        }),
    });
    console.log(
      JSON.stringify(
        {
          ...measurement,
          ...(execution.report === undefined ? {} : { report: execution.report }),
          ...(options.keep ? { target, ledger: execution.ledgerFile } : {}),
        },
        null,
        2,
      ),
    );
  } finally {
    if (!options.keep) fs.rmSync(target, { recursive: true, force: true });
  }
}

const argv = process.argv.slice(2);
const action = argv[0] ?? "list";
const tasks = loadTasks();

if (action === "list")
  console.log(
    JSON.stringify(
      tasks.map(({ task }) => ({
        id: task.id,
        role: task.role,
        complexity: task.complexity,
        mode: task.mode,
        fixture: task.fixture ?? null,
      })),
      null,
      2,
    ),
  );
else if (action === "validate")
  console.log(JSON.stringify({ version: 1, count: tasks.length, valid: true }));
else if (action === "smoke") {
  let scored = 0;
  for (const { task } of tasks) {
    if (!task.fixture || !task.scorer || task.scorerInput !== "target") continue;
    const target = freshTarget(task.id);
    materialize(task.fixture, target);
    try {
      assertScorerMatchesTask(task, runScorer(task.scorer, target));
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
    scored++;
  }
  console.log(JSON.stringify({ version: 1, count: tasks.length, scored, valid: true }));
} else if (action === "run") {
  const id = argv[1];
  if (!id) throw new Error("usage: corpus.ts run <task-id> [options] [-- <ad-coder flags>]");
  const entry = tasks.find(({ task }) => task.id === id);
  if (entry === undefined) throw new Error(`unknown task: ${id}`);
  const separator = argv.indexOf("--", 2);
  const own = separator < 0 ? argv.slice(2) : argv.slice(2, separator);
  const extra = separator < 0 ? [] : argv.slice(separator + 1);
  const flag = (name: string): string | undefined => {
    const index = own.indexOf(name);
    return index < 0 ? undefined : own[index + 1];
  };
  const timeoutRaw = flag("--timeout-ms");
  runTask(entry.task, entry.file, {
    inventory: flag("--inventory") ?? "unspecified",
    thinkingLevel: flag("--thinking-level") ?? "unspecified",
    extra,
    timeoutMs: timeoutRaw === undefined ? 45 * 60_000 : Number(timeoutRaw),
    keep: own.includes("--keep"),
  });
} else throw new Error("usage: corpus.ts [list|validate|smoke|run <task-id>]");
