#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CalibrationMeasurement, CalibrationTask } from "../../src/evaluation/calibration";
import { measuredRolesOf, scoreCalibrationRun } from "../../src/evaluation/calibration";
import type { LedgerRecord } from "../../src/ledger/types";
import type { ConsoleTurn, OrchestratorReport } from "./report";
import { buildOrchestratorReport, extractJsonArtifact } from "./report";
import type { TaskSource } from "./task-source";
import { assertTaskSource } from "./task-source";

type Task = CalibrationTask & {
  /**
   * What the task is FOR, which is not the same as what it exercises.
   *
   * `calibration` is a task whose result may move a routing cell.
   * `smoke` is a task kept because it proves the harness can still dispatch a
   * role, materialize a fixture and score a diff end to end -- and whose result
   * must never be quoted as evidence about a model.
   *
   * The distinction exists because a saturated task looks exactly like a good
   * one from the outside: three trivial coder tasks scored 9 of 9 at quality 1.00
   * for the cheapest model on the provider, which says nothing about that model
   * except that it is not broken. Kept unlabelled, such a score can justify a
   * routing decision for a tier the task cannot discriminate. Labelling is the
   * cheap half of the fix; the other half is not quoting them.
   */
  purpose?: "calibration" | "smoke";
  fixture?: string;
  scorer?: string;
  scorerInput?: "target" | "artifact" | "report";
  /**
   * Required on every task, including the ones that invented their own problem.
   *
   * Made mandatory rather than optional-for-new-tasks because a grandfather list
   * rots: within two additions nobody remembers which ids predate the rule, and
   * an absent field becomes indistinguishable from an oversight. A task whose
   * shape is this project's own says so with `url: "original"` -- which is a
   * claim someone can dispute, unlike silence.
   */
  source: TaskSource;
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
    assertTaskSource(task.id, task.source);
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

/** Whether the model's answer is JSON a scorer can read at all. */
function isReadableJson(answer: string): boolean {
  const end = Math.max(answer.lastIndexOf("}"), answer.lastIndexOf("]"));
  if (end < 0) return false;
  try {
    JSON.parse(answer.slice(0, end + 1));
    return true;
  } catch {
    return false;
  }
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

/**
 * The routing cell the task declares, as a flag ad-coder will honour.
 *
 * A task names the `(role, complexity)` cell it exists to measure, and the
 * measurement is labelled with that cell -- but nothing used to tell the run
 * about it, so every task routed at the built-in default of `medium`. A trivial
 * task therefore reported a trivial-cell measurement taken on whatever model the
 * medium cell happened to name: not a wrong number, a number about a different
 * model than the one it credits.
 *
 * An explicit `--default-complexity` later in `extra` still wins, since ad-coder
 * takes the last occurrence; that is what lets a caller deliberately run one
 * task against a neighbouring cell.
 */
const complexityFlag = (task: Task): string[] => ["--default-complexity", task.complexity];

function executeRole(task: Task, target: string, extra: string[], timeoutMs: number): Execution {
  const run = spawnAdCoder(
    ["role", task.role, task.prompt, "--target-dir", target, ...complexityFlag(task), ...extra],
    {
      cwd: repoRoot,
      timeoutMs,
    },
  );
  if (run.status !== 0) throw new Error(run.stderr || "ad-coder role failed");
  return { target, ledgerFile: ledgerPathFrom(run.stderr), stdout: run.stdout };
}

function executePipeline(
  task: Task,
  target: string,
  extra: string[],
  timeoutMs: number,
): Execution {
  const run = spawnAdCoder(
    ["drive", task.prompt, "--auto", "--target-dir", target, ...complexityFlag(task), ...extra],
    {
      cwd: repoRoot,
      timeoutMs,
    },
  );
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
    [
      "console",
      "--json",
      "--target-dir",
      target,
      "--workflows",
      "pipeline",
      ...complexityFlag(task),
      ...extra,
    ],
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
    /** Suppress the per-run print, for a repeat loop that reports a summary. */
    quiet?: boolean;
  },
): CalibrationMeasurement {
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
    // An answer the scorer could not read is a fact about the RUN, not only a
    // score: the scorers now fail every check rather than throwing, so without
    // recording it here a model that returned prose would be indistinguishable
    // from one that returned a wrong answer.
    let unreadableAnswer = false;
    if (scorerInput === "target") checks = runScorer(task.scorer, target);
    else {
      const file = path.join(target, scorerInput === "artifact" ? "artifact.json" : "report.json");
      const answer =
        scorerInput === "artifact"
          ? extractJsonArtifact(execution.stdout)
          : `${JSON.stringify(execution.report ?? {}, null, 2)}\n`;
      fs.writeFileSync(file, answer);
      unreadableAnswer = !isReadableJson(answer);
      checks = runScorer(task.scorer, file);
    }
    assertScorerMatchesTask(task, checks);
    const measurement = scoreCalibrationRun({
      task: readJson<CalibrationTask>(taskFile),
      checks,
      ledger: readLedger(execution.ledgerFile),
      inventory: options.inventory,
      thinkingLevel: options.thinkingLevel,
      ...(unreadableAnswer && { harnessOutcome: "unreadable_answer" as const }),
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
    if (options.quiet !== true)
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
    return measurement;
  } finally {
    if (!options.keep) fs.rmSync(target, { recursive: true, force: true });
  }
}

/**
 * Runs a non-target scorer against its checked-in sample artifacts.
 *
 * The samples are hand-written stand-ins for a model answer, not recorded runs:
 * they exist to prove the scorer can still say both yes and no. `.pass.json`
 * must score every check, `.fail.json` must miss at least one.
 *
 * `.gamed.json` is optional and different in kind. Where the other two prove the
 * scorer can discriminate a good answer from a bad one, this one proves it
 * resists the SPECIFIC evasion the task was built to catch -- the plan that
 * pastes a whole contract file, the review that lists its suspicions. Every task
 * whose scorer carries a comment explaining why it checks a thing that way is
 * asserting such a defence; until this sample existed, that assertion was prose.
 * Three of those defences turned out to be wrong when they were finally executed
 * against the evasion they claimed to stop, which is the argument for making the
 * claim run.
 */
function checkSamples(task: Task): void {
  const scorer = task.scorer;
  if (scorer === undefined) throw new Error(`task has no scorer: ${task.id}`);
  for (const kind of ["pass", "fail"] as const) {
    const sample = path.join(root, "samples", `${task.id}.${kind}.json`);
    if (!fs.existsSync(sample))
      throw new Error(`${task.scorerInput} task needs a ${kind} sample: ${task.id}`);
    const checks = runScorer(scorer, sample);
    assertScorerMatchesTask(task, checks);
    const allPassed = checks.every((check) => check.passed);
    if (kind === "pass" && !allPassed)
      throw new Error(`pass sample does not score every check: ${task.id}`);
    if (kind === "fail" && allPassed) throw new Error(`fail sample scores every check: ${task.id}`);
  }
  const gamed = path.join(root, "samples", `${task.id}.gamed.json`);
  if (!fs.existsSync(gamed)) return;
  const checks = runScorer(scorer, gamed);
  assertScorerMatchesTask(task, checks);
  // Scored on the task's own weights rather than on a count, because the evasion
  // is meant to be plausible: it will pass the checks it is not attacking, and
  // the question is whether what it wins is materially less than an honest
  // answer wins.
  const weights = new Map(task.checks.map((check) => [check.id, check.weight]));
  const total = [...weights.values()].reduce((sum, weight) => sum + weight, 0);
  const earned = checks
    .filter((check) => check.passed)
    .reduce((sum, check) => sum + (weights.get(check.id) ?? 0), 0);
  if (earned / total > GAMED_SAMPLE_CEILING)
    throw new Error(
      `gamed sample scores ${(earned / total).toFixed(2)} of 1.00, above the ${GAMED_SAMPLE_CEILING} ceiling: ${task.id}`,
    );
}

/**
 * How much of a task's weight the evasion it defends against may still earn.
 *
 * Not zero: a plausible evasion answers the rest of the task properly, and
 * demanding it score nothing would only select for implausible samples. Two
 * thirds is the line at which the answer is no longer competitive with an honest
 * one -- an evasion scoring more than that is being rewarded for the thing the
 * task exists to catch.
 */
const GAMED_SAMPLE_CEILING = 0.67;

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
        purpose: task.purpose ?? "calibration",
        mode: task.mode,
        fixture: task.fixture ?? null,
        source: task.source.url,
      })),
      null,
      2,
    ),
  );
else if (action === "validate")
  console.log(JSON.stringify({ version: 1, count: tasks.length, valid: true }));
else if (action === "smoke") {
  let scored = 0;
  let sampled = 0;
  let unscored = 0;
  for (const { task } of tasks) {
    if (!task.scorer) {
      unscored++;
      continue;
    }
    if ((task.scorerInput ?? "target") === "target") {
      // A target scorer reads a materialized fixture; without one there is
      // nothing for it to read, so this is a broken task rather than a task
      // smoke may quietly skip.
      if (!task.fixture) throw new Error(`target-scored task has no fixture: ${task.id}`);
      const target = freshTarget(task.id);
      materialize(task.fixture, target);
      try {
        assertScorerMatchesTask(task, runScorer(task.scorer, target));
      } finally {
        fs.rmSync(target, { recursive: true, force: true });
      }
      scored++;
      continue;
    }
    // An artifact/report scorer has no fixture to run against, so until now it
    // was skipped entirely: a scorer that threw on every input, or that passed
    // every input, reached a live run before anyone noticed. Each such task
    // therefore ships two checked-in sample artifacts -- one a model answer that
    // should score everything, one that should not -- and smoke runs both.
    // Requiring the FAILING sample is the half that matters: a scorer stuck at
    // `true` is the failure mode that silently reports every model as perfect.
    checkSamples(task);
    sampled++;
  }
  // `calibration` is what the corpus can say about a model; the rest proves only
  // that the harness still dispatches, materializes and scores. Counted apart so
  // a sweep summary cannot quietly treat a smoke task's perfect score as
  // evidence about a model.
  const calibration = tasks.filter(
    ({ task }) => (task.purpose ?? "calibration") === "calibration",
  ).length;
  console.log(
    JSON.stringify({
      version: 1,
      count: tasks.length,
      calibration,
      smoke: tasks.length - calibration,
      scored,
      sampled,
      unscored,
      valid: true,
    }),
  );
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
  const repeatRaw = flag("--repeat");
  const repeat = repeatRaw === undefined ? 1 : Number(repeatRaw);
  if (!Number.isInteger(repeat) || repeat < 1)
    throw new Error("--repeat must be a positive integer");
  const options = {
    inventory: flag("--inventory") ?? "unspecified",
    thinkingLevel: flag("--thinking-level") ?? "unspecified",
    extra,
    timeoutMs: timeoutRaw === undefined ? 45 * 60_000 : Number(timeoutRaw),
    keep: own.includes("--keep"),
  };
  if (repeat === 1) runTask(entry.task, entry.file, options);
  else {
    // WHY REPEATS ARE A FIRST-CLASS ACTION. One run does not measure a model, it
    // samples one. The same model on the same task produced 0.43, 0.79, an
    // unreadable answer and 1.00 in one sitting -- a routing cell decided from
    // any single one of those is decided by which run happened to come first.
    // So a repeat reports the spread rather than an average that hides it: the
    // worst run is what an operator actually lives with, and a task where every
    // model scores identically is a task that has stopped discriminating.
    const runs: CalibrationMeasurement[] = [];
    for (let index = 0; index < repeat; index++)
      runs.push(runTask(entry.task, entry.file, { ...options, quiet: true }));
    const qualities = runs.map((run) => run.quality);
    const costs = runs.map((run) => run.costUsd);
    const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
    console.log(
      JSON.stringify(
        {
          taskId: entry.task.id,
          model: runs[0]?.model ?? null,
          provider: runs[0]?.provider ?? null,
          complexity: entry.task.complexity,
          thinkingLevel: options.thinkingLevel,
          repeat,
          accepted: runs.filter((run) => run.accepted).length,
          quality: {
            worst: Math.min(...qualities),
            mean: sum(qualities) / qualities.length,
            best: Math.max(...qualities),
          },
          costUsd: { total: sum(costs), mean: sum(costs) / costs.length },
          harnessOutcomes: runs.reduce<Record<string, number>>((counts, run) => {
            counts[run.harnessOutcome] = (counts[run.harnessOutcome] ?? 0) + 1;
            return counts;
          }, {}),
          runs,
        },
        null,
        2,
      ),
    );
  }
} else throw new Error("usage: corpus.ts [list|validate|smoke|run <task-id>]");
