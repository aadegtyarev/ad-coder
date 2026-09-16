#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CalibrationMeasurement, CalibrationTask } from "../../src/evaluation/calibration";
import { measuredRolesOf, scoreCalibrationRun } from "../../src/evaluation/calibration";
import type { LedgerRecord } from "../../src/ledger/types";
import { violatedProhibitions } from "./prohibitions";
import type { ConsoleTurn, OrchestratorReport } from "./report";
import { buildOrchestratorReport, extractJsonArtifact } from "./report";
import { outOfScope, snapshot } from "./scope";
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
  /**
   * The paths this task's work is allowed to touch, as globs.
   *
   * Present when, and only when, the task declares the `stays-in-scope` check,
   * which the runner scores itself from a before/after snapshot of the target
   * rather than from the task's scorer. It lives here beside `checks` rather
   * than inside a scorer so the requirement is legible in the task -- the same
   * file whose `prompt` has to state it, since scoring a requirement the model
   * was never told is the mistake `planner-contract-carry-v1` already made.
   *
   * `[]` is a real value: a read-only role is told to change nothing.
   */
  writes?: string[];
  /**
   * Tools this task's prompt forbids, checked against the run's ledger.
   *
   * Present when, and only when, the task declares the `honours-prohibitions`
   * check. A prohibition is usually in a role prompt because obeying it is
   * INCONVENIENT -- running the tests would be reassuring, re-reading would feel
   * thorough -- so ignoring one is a distinct trait from being wrong, invisible
   * in the answer's quality, and exactly what makes an agent unusable: the
   * constraint you rely on silently stops holding.
   *
   * Names a TOOL, never an intention. The ledger records tool names without
   * arguments, so "did not run the test suite" is only answerable as "did not
   * call `bash`" -- and a task that means the former must say the latter, in its
   * prompt as well as here.
   */
  forbids?: string[];
  /**
   * True when the task only means anything if the run COMPACTED its context.
   *
   * `summarizer-retention-v1` measures whether a fact planted early survives
   * eviction, and the summarizer is not dispatchable as a role -- it runs only
   * inside compaction. A run that happened to fit in its budget answers a
   * different question and must not be scored as if it answered this one: the
   * first probe of that task scored 1.00 in three turns without compacting once.
   * So the runner reads the compaction line ad-coder prints and records
   * `compacted`; a task that demands it and did not get it is reported rather
   * than silently counted.
   */
  requiresCompaction?: boolean;
};

/**
 * The check the runner scores itself, from the target rather than the answer.
 *
 * Every other check is a question for the task's scorer, which sees only what
 * the model produced. This one asks what the model did to everything it was NOT
 * asked about -- and that is invisible from the artifact, from the diff of the
 * named function, and from the score. A model that fixed the function and also
 * rewrote three unrelated modules scored a clean 1.00 in every task here until
 * this existed.
 */
const SCOPE_CHECK = "stays-in-scope";

/**
 * The second check the runner scores itself, from the ledger rather than the
 * answer. See `Task.forbids`.
 */
const PROHIBITION_CHECK = "honours-prohibitions";

/** How many offending paths a failing scope check prints before it truncates. */
const STRAY_PATHS_REPORTED = 20;

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
    // The allow-list and the check are two halves of one statement, and either
    // half alone is worse than neither: a `writes` nobody scores is a comment,
    // and a `stays-in-scope` with nothing to compare against would silently
    // treat every edit as a violation. Demanded together, at load.
    const scored = task.checks.some((check) => check.id === SCOPE_CHECK);
    if (scored !== (task.writes !== undefined))
      throw new Error(`${SCOPE_CHECK} and writes must be declared together: ${task.id}`);
    if (task.writes !== undefined) {
      if (!Array.isArray(task.writes) || task.writes.some((p) => typeof p !== "string" || !p))
        throw new Error(`invalid writes: ${task.id}`);
      if (!task.fixture) throw new Error(`${SCOPE_CHECK} needs a fixture: ${task.id}`);
    }
    // Same pairing rule as `writes`, for the same reason: a list nobody scores
    // is a comment, and a check with nothing to compare against would pass for
    // free on every run.
    if (task.requiresCompaction !== undefined && typeof task.requiresCompaction !== "boolean")
      throw new Error(`invalid requiresCompaction: ${task.id}`);
    const prohibited = task.checks.some((check) => check.id === PROHIBITION_CHECK);
    if (prohibited !== (task.forbids !== undefined))
      throw new Error(`${PROHIBITION_CHECK} and forbids must be declared together: ${task.id}`);
    if (
      task.forbids !== undefined &&
      (!Array.isArray(task.forbids) ||
        task.forbids.length === 0 ||
        task.forbids.some((name) => typeof name !== "string" || !name))
    )
      throw new Error(`invalid forbids: ${task.id}`);
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

/**
 * The checks the task's SCORER is responsible for.
 *
 * `stays-in-scope` is scored by the runner from the target, so a scorer that
 * answered it would be answering about a tree it cannot see. Subtracted here so
 * the scorer-matches-task assertion stays exact in both directions.
 */
function scorerChecks(task: Task): Task["checks"] {
  return task.checks.filter((check) => check.id !== SCOPE_CHECK && check.id !== PROHIBITION_CHECK);
}

function assertScorerMatchesTask(task: Task, checks: { id: string; passed: boolean }[]): void {
  const expected = scorerChecks(task);
  if (checks.length !== expected.length || checks.some((c) => !expected.some((e) => e.id === c.id)))
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
  /** What ad-coder reported about the run itself: compaction, limits, refusals. */
  stderr: string;
  report?: OrchestratorReport;
}

/**
 * Names what intervened when a run never reached a scored answer.
 *
 * Shared by the single-run and repeat paths so the two cannot drift: the reason
 * a run aborted is the whole diagnosis, and `provider_error` versus
 * `stage_limit` versus a rejected handoff are three different problems for
 * whoever reads the sweep.
 */
function classifyAbort(message: string): "stage_limit" | "provider_error" | "tool_error" {
  const text = message.toLowerCase();
  if (text.includes("limit") || text.includes("timed out") || text.includes("timeout"))
    return "stage_limit";
  // A plan the product REJECTED is the harness refusing a malformed handoff, not
  // the provider failing: the request succeeded and its content did not pass.
  if (text.includes("invalid") || text.includes("must ") || text.includes("rejected"))
    return "tool_error";
  return "provider_error";
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
  return {
    target,
    ledgerFile: ledgerPathFrom(run.stderr),
    stdout: run.stdout,
    stderr: run.stderr,
  };
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
  return {
    target,
    ledgerFile: ledgerPathFrom(run.stderr),
    stdout: run.stdout,
    stderr: run.stderr,
  };
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
  return { target, ledgerFile, stdout: run.stdout, stderr: run.stderr, report };
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
): CalibrationMeasurement & {
  report?: OrchestratorReport;
  strayPaths?: string[];
  forbiddenTools?: string[];
  compactions?: number;
} {
  if (!task.scorer) throw new Error(`task has no scorer: ${task.id}`);
  const target = freshTarget(task.id);
  if (task.fixture) materialize(task.fixture, target);
  else fs.mkdirSync(target, { recursive: true });
  // Taken before the run and compared after it, rather than diffed against the
  // baseline commit, so a fixture that ships its defect uncommitted is not
  // reported as the model's own edit. See `runner/scope.ts`.
  const before = task.writes === undefined ? undefined : snapshot(target);
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
    // Read before the answer file is written into the target below: that file
    // is the harness's doing, and a snapshot taken after it would charge every
    // artifact-scored task with creating it.
    const strayPaths =
      before === undefined ? undefined : outOfScope(before, snapshot(target), task.writes ?? []);
    if (scorerInput === "target") checks = runScorer(task.scorer, target);
    else {
      const file = path.join(target, scorerInput === "artifact" ? "artifact.json" : "report.json");
      // A role that produced no readable JSON has FAILED THE TASK, and that is a
      // measurement. Letting the extractor throw here made it a harness error
      // instead: the run was dropped, and the runs dropped are the worst ones,
      // so the model is flattered by exactly the answers it botched. Same rule
      // the scorers already follow -- an unreadable answer fails every check.
      let answer: string;
      if (scorerInput !== "artifact")
        answer = `${JSON.stringify(execution.report ?? {}, null, 2)}\n`;
      else {
        try {
          answer = extractJsonArtifact(execution.stdout);
        } catch {
          answer = "";
        }
      }
      fs.writeFileSync(file, answer);
      unreadableAnswer = !isReadableJson(answer);
      checks = runScorer(task.scorer, file);
    }
    assertScorerMatchesTask(task, checks);
    const ledger = readLedger(execution.ledgerFile);
    // The two checks the RUNNER answers, from the target tree and the ledger.
    // The scorer sees only what the model produced, and neither question is
    // answerable from that: a model that rewrote three unrelated modules, or one
    // that ran the test suite it was told not to, produces an identical answer.
    const forbidden =
      task.forbids === undefined ? undefined : violatedProhibitions(ledger, task.forbids);
    // Counted from the line the compactor prints on every successful
    // compaction. Zero on a task that demands it means the run answered a
    // different question than the task asked -- see `Task.requiresCompaction`.
    const compactions = [...execution.stderr.matchAll(/ad-coder: context compacted /g)].length;
    if (strayPaths !== undefined)
      checks = [...checks, { id: SCOPE_CHECK, passed: strayPaths.length === 0 }];
    if (forbidden !== undefined)
      checks = [...checks, { id: PROHIBITION_CHECK, passed: forbidden.length === 0 }];
    const measurement = scoreCalibrationRun({
      task: readJson<CalibrationTask>(taskFile),
      checks,
      ledger,
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
    // The report travels WITH the measurement rather than only being printed,
    // because a repeat prints a summary instead -- and a summary whose per-run
    // entries have lost the report has thrown away the only record of what a
    // manual-workflow run actually did.
    const scored = {
      ...measurement,
      ...(execution.report === undefined ? {} : { report: execution.report }),
      // Named, not just counted. A failing scope check whose output is a boolean
      // sends the reader back to a target directory the runner has already
      // deleted; the paths are the entire diagnosis, and they are three words
      // long. Capped because a model that reformatted a whole tree would
      // otherwise bury the rest of the measurement under its own output.
      ...(strayPaths !== undefined && strayPaths.length > 0
        ? { strayPaths: strayPaths.slice(0, STRAY_PATHS_REPORTED) }
        : {}),
      // Same reason: which tool was called is the whole diagnosis, and it is one
      // word. A boolean would send the reader to a ledger file whose path the
      // summary does not carry.
      ...(forbidden !== undefined && forbidden.length > 0 ? { forbiddenTools: forbidden } : {}),
      ...(task.requiresCompaction === true ? { compactions } : {}),
    };
    if (options.quiet !== true)
      console.log(
        JSON.stringify(
          {
            ...scored,
            ...(options.keep ? { target, ledger: execution.ledgerFile } : {}),
          },
          null,
          2,
        ),
      );
    return scored;
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
  // The MIRROR of the gamed sample, and the half this corpus was missing.
  //
  // `.gamed.json` proves the scorer rejects a plausible evasion -- the
  // false-POSITIVE direction. `.alt.json` proves it accepts an answer that is
  // materially different from the pass sample and still correct: the
  // false-NEGATIVE direction, where a scorer quietly demands the author's own
  // phrasing rather than a right answer.
  //
  // That direction is not hypothetical here. `coder-retention-v1` shipped a
  // fixture whose own comment argued against the rule its scorer required, and
  // four models across three vendors independently gave the reading the scorer
  // called wrong. An alternative-valid sample would have caught it before the
  // task was ever run. The practice is FrontierCode's: the task author writes
  // both the cheating answer and a second valid one, and the pair is the test
  // of the scorer rather than of the model.
  const alternative = path.join(root, "samples", `${task.id}.alt.json`);
  if (!fs.existsSync(alternative))
    throw new Error(`${task.scorerInput} task needs an alt sample: ${task.id}`);
  {
    const checks = runScorer(scorer, alternative);
    assertScorerMatchesTask(task, checks);
    const missed = checks.filter((check) => !check.passed).map((check) => check.id);
    if (missed.length > 0)
      throw new Error(`alternative valid sample fails ${missed.join(", ")}: ${task.id}`);
  }
  const gamed = path.join(root, "samples", `${task.id}.gamed.json`);
  if (!fs.existsSync(gamed)) return;
  const checks = runScorer(scorer, gamed);
  assertScorerMatchesTask(task, checks);
  // Scored on the task's own weights rather than on a count, because the evasion
  // is meant to be plausible: it will pass the checks it is not attacking, and
  // the question is whether what it wins is materially less than an honest
  // answer wins.
  // The SCORER's weights, not the task's. A sample is a model answer on paper;
  // there is no target tree, so `stays-in-scope` is neither passed nor failed.
  // Counted in the denominator anyway, it would quietly hand every evasion a
  // lower fraction -- the ceiling would be loosened by adding an unrelated check.
  const weights = new Map(scorerChecks(task).map((check) => [check.id, check.weight]));
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
        // What the task MEASURES, when that differs from what it dispatches.
        // `summarizer-retention-v1` dispatches an auditor because the summarizer
        // is not dispatchable at all, so a listing keyed on `role` alone showed
        // the summarizer as uncovered while a task for it existed -- and showed
        // the auditor as covered twice. A coverage table that misreports both
        // directions is worse than none.
        ...(task.measuredRoles === undefined ? {} : { measuredRoles: task.measuredRoles }),
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
  if (repeat === 1) {
    // A run that never reached a scored answer is a FACT ABOUT THE CELL, not a
    // reason to print nothing. Throwing here dropped the measurement entirely,
    // and the runs that abort are the bad ones -- so a dropped run flatters the
    // model, which is the exact failure `harnessOutcome` was added to stop. The
    // repeat path below already caught and counted; this one did not, so the
    // protection existed and reached one of the two callers. See issue #190.
    try {
      runTask(entry.task, entry.file, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(
        JSON.stringify(
          {
            taskId: entry.task.id,
            inventory: options.inventory,
            model: null,
            provider: null,
            thinkingLevel: options.thinkingLevel,
            role: entry.task.role,
            complexity: entry.task.complexity,
            mode: entry.task.mode ?? "role",
            accepted: false,
            quality: 0,
            harnessOutcome: classifyAbort(message),
            // The first line only: the reason is the diagnosis and a stack trace
            // buries it, the same rule the repeat path's `aborted` follows.
            abortReason: message.split("\n")[0] ?? message,
          },
          null,
          2,
        ),
      );
      process.exitCode = 1;
    }
  } else {
    // WHY REPEATS ARE A FIRST-CLASS ACTION. One run does not measure a model, it
    // samples one. The same model on the same task produced 0.43, 0.79, an
    // unreadable answer and 1.00 in one sitting -- a routing cell decided from
    // any single one of those is decided by which run happened to come first.
    // So a repeat reports the spread rather than an average that hides it: the
    // worst run is what an operator actually lives with, and a task where every
    // model scores identically is a task that has stopped discriminating.
    const runs: (CalibrationMeasurement & { report?: OrchestratorReport })[] = [];
    // A run that never reached a scored answer -- a stage limit, a provider that
    // refused -- is a fact about the cell, not a reason to lose the runs that
    // did. The first repeat run to throw took four completed runs down with it,
    // which is the same failure the scorers had: one bad run erasing the sample
    // it belongs to. So each run is caught, counted, and the series continues.
    const aborted: string[] = [];
    for (let index = 0; index < repeat; index++) {
      try {
        runs.push(runTask(entry.task, entry.file, { ...options, quiet: true }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        aborted.push(message.split("\n")[0] ?? message);
      }
    }
    if (runs.length === 0)
      throw new Error(`every run aborted: ${aborted[0] ?? "no reason recorded"}`);
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
          scored: runs.length,
          // Named rather than counted only: a stage limit and a provider refusal
          // are different problems, and a repeat that hides which one happened
          // is the summary telling an operator to go read the logs anyway.
          ...(aborted.length > 0 && { aborted }),
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
