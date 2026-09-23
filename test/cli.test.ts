import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AuthInteraction, Models } from "@earendil-works/pi-ai";
import { FileCredentialStore } from "../src/auth/credential-store";
import { projectCliError, renderCliError, renderConfigShowRow } from "../src/cli";
import { renderAuthEvent, runAuthCommand } from "../src/cli/auth";
import { SessionNotAcquiredError } from "../src/conversation/conversation";
import type { DurableRunRecord } from "../src/orchestration/control-plane";
import { ProjectStore } from "../src/project-store/project-store";
import { ProviderUnavailableError } from "../src/runner/errors";
import { UpdateError } from "../src/update/updater";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const CLI = path.join(REPO_ROOT, "src/cli.ts");

/**
 * A config home no developer's machine shares, created once for this file.
 *
 * `runCli` spawns the real binary, which reads the user profile at
 * `$XDG_CONFIG_HOME/ad-coder`. Inheriting the environment therefore made these
 * tests read whatever profile the machine running them happened to have saved,
 * and a profile the CLI rejects failed a test about something else entirely --
 * on one machine and not in CI, which is the least useful shape a failure has.
 */
const CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-cli-config-"));

function runCli(
  args: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): { code: number; stdout: string; stderr: string } {
  const env = { ...(options.env ?? process.env) };
  // A test that points the config home somewhere of its own keeps it; the
  // empty directory is only a floor, so no test silently reads the machine's.
  if (env.XDG_CONFIG_HOME === undefined) env.XDG_CONFIG_HOME = CONFIG_HOME;
  const proc = Bun.spawnSync(["bun", "run", CLI, ...args], {
    cwd: options.cwd ?? REPO_ROOT,
    env,
  });
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

/**
 * Live `background worker` processes whose command serves exactly `target`
 * under exactly `runId`.
 *
 * Why the process table and not a record: `background start` returns as soon as
 * the detached worker has spawned, and nothing durable names its pid (`lease`
 * carries a random `workerId`, not a pid), so the process table is the only
 * place the pid exists. The match is on the argv the launcher built
 * (`background worker --target-dir <target> --id <runId> …`) scoped to this
 * test's own `mkdtemp` target, so a concurrently running suite in another
 * worktree -- which has a different target -- can never be selected by the
 * termination below.
 *
 * The argv is parsed completely rather than probed at the first hit (review
 * round). `--target-dir` is compared against EVERY pair of the flag and its
 * value: `indexOf`-style first-occurrence matching hides this test's own worker
 * whenever the worker's argv carries the flag more than once -- a wrapper that
 * repeats an outer invocation's `--target-dir`, or a launcher that passes a
 * default value first -- because the first pair then holds a different path
 * while the pair that matches sits behind it. Whole-argument comparison is kept
 * either way (`…-cli-abc` never selects `…-cli-abcd`), and `background`/`worker`
 * must be adjacent, so a foreign process merely mentioning both words is not
 * matched.
 *
 * `--id <runId>` is required in the SAME argv when the caller knows the run id
 * (both callers do). Two filters, each closing a different hole: without the
 * target filter a foreign worker is signalled, and without the run-id filter a
 * worker that is NOT this run's -- a stale process from an earlier attempt on a
 * reused path, or another run in the same target -- is counted as a survivor
 * and then killed, while this run's own worker could still be missed by a
 * target spelling this function does not know. The launcher
 * (`createBackgroundHostLauncher`, src/cli.ts) passes both flags verbatim for
 * every worker it spawns, so the pair is always there to match.
 */
async function backgroundWorkerPids(target: string, runId: string): Promise<number[]> {
  // Asynchronous on purpose, and the cost of the synchronous form is a
  // measurement rather than a worry: one `Bun.spawnSync(["ps", "-eo",
  // "pid,args"])` takes 63 ms on an idle box and 245 ms on the same box bound
  // to two loaded cores, and the teardown below could issue ~320 of them per
  // run (the 1 s + 10 s + 5 s of fixed phases, sampled every 50 ms). `bun test`
  // shares one process -- and therefore one event loop -- across test files,
  // so those tens of seconds of blocked loop were spent inside other tests'
  // budgets. That is exactly what CI run 35481736583 on 2ca84f5 shows in both
  // of its failed attempts: `record store > reads an absent record as empty
  // and caps entries, dropping the oldest` (test/trivial-edit.test.ts:112, from
  // #388, unrelated to #419) was reported `this test timed out after 5000ms` at
  // 6832.12 ms, and the run also logged `[test-preload] run root
  // ad-coder-test-94gb7J survived 5 teardown attempts` -- the preload's own
  // `rmSync` series starved by the same loop. Awaiting a spawned `ps` keeps
  // every one of those milliseconds off this thread, so the sampler no longer
  // spends a neighbour's 5-second test budget -- and, since awaiting means a
  // `ps` that never returns would hang the teardown inside the runner's
  // per-test budget, the spawn itself is bounded (see `readProcessTable`).
  const stdout = await readProcessTable();
  // Both spellings of one target: the launcher passes the path it was given
  // (`--target-dir <raw>`), while the comparison is anchored on the realpath so
  // a symlinked tmpdir cannot hide the process by spelling the same directory
  // differently. Any single pair matching either spelling is this target.
  const targetSpellings = new Set([target, fs.realpathSync(target)]);
  const pids: number[] = [];
  for (const line of stdout.split("\n")) {
    const fields = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (fields === null) continue;
    const words = fields[2]!.split(" ");
    const action = words.findIndex(
      (word, index) => word === "background" && words[index + 1] === "worker",
    );
    if (action < 0) continue;
    if (!flagValues(words, "--target-dir").some((value) => targetSpellings.has(value))) continue;
    if (!flagValues(words, "--id").includes(runId)) continue;
    pids.push(Number(fields[1]));
  }
  return pids;
}

/**
 * Every value that follows `flag` in one argv word list.
 *
 * The whole list is scanned rather than the first `indexOf` hit: a single
 * occurrence is what the launcher emits today, but "the first one is the right
 * one" is an assumption about a process command line this test does not own,
 * and getting it wrong fails in the dangerous direction -- the worker that is
 * alive is not seen, so the teardown declares a clean end over a live process.
 */
function flagValues(words: readonly string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < words.length - 1; index += 1) {
    if (words[index] === flag) values.push(words[index + 1]!);
  }
  return values;
}

/**
 * One `ps -eo pid,args` read, bounded by `WORKER_SAMPLE_TIMEOUT_MS` (review
 * round).
 *
 * Awaiting a sample (see `backgroundWorkerPids`) bought the neighbours' event
 * loop back, and it also means a `ps` that never returns holds the teardown
 * open until the RUNNER's timeout -- reported as the bare `timed out after
 * Nms` this file exists to replace, with nothing naming the sampler. Past the
 * bound the process is killed and the sampler throws with the number in it, so
 * a hung sample is attributed to the sample.
 */
async function readProcessTable(): Promise<string> {
  const listing = Bun.spawn(["ps", "-eo", "pid,args"], { stdout: "pipe", stderr: "pipe" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      listing.kill();
      reject(
        new Error(`process-table sampler did not return within ${WORKER_SAMPLE_TIMEOUT_MS} ms`),
      );
    }, WORKER_SAMPLE_TIMEOUT_MS);
  });
  try {
    const [exitCode, stdout, stderr] = await Promise.race([
      Promise.all([
        listing.exited,
        new Response(listing.stdout).text(),
        new Response(listing.stderr).text(),
      ]),
      timedOut,
    ]);
    if (exitCode !== 0) throw new Error(`ps failed: ${stderr.trim() || `exit code ${exitCode}`}`);
    // The header line is returned on purpose: its first field is not a pid and
    // the caller's regex skips it exactly like any other unparseable line.
    return stdout;
  } finally {
    clearTimeout(timer);
  }
}

/** One teardown's outcome: what the polls found and what they decided. */
type WorkerTeardown = {
  /** Pids still serving the target when the wait ended; empty is a clean end. */
  survivors: number[];
  /** Wall clock since the cancel that opened the teardown, in ms. */
  elapsedMs: number;
  /** The phases the polls passed through, in order, with their numbers. */
  phases: string[];
};

/**
 * Samples the process table until no worker serving `target` is left, driving
 * the signal escalation from what it observes (issue #419).
 *
 * The shape this replaced was three fixed phases -- 1 s of self-exit grace,
 * 10 s after SIGTERM, 5 s after SIGKILL -- where the escalation happened
 * because a sleep had ended rather than because a sample said so, and the
 * phases summed to 16 s of sampling regardless of the observation. One loop
 * now owns the whole teardown against a single ABSOLUTE ceiling
 * (`WORKER_TEARDOWN_CEILING_MS`, 30 s measured from the cancel): SIGTERM only
 * on a sample that still finds workers past the self-exit grace, SIGKILL only
 * on a sample that still finds them past the SIGTERM window, and the loop ends
 * on a sample that finds none or on the ceiling, whichever it observes first.
 * `phases` records each of those observations for the failure message.
 *
 * The sampling gap backs off from 25 ms to 250 ms while consecutive samples
 * report the same state and resets to 25 ms when a signal changes it: a
 * healthy teardown costs a handful of `ps` calls (the old 50 ms cadence over
 * that 16 s cost ~320, see `backgroundWorkerPids`), and the hopeless tail after
 * SIGKILL -- only an unschedulable process produces one -- does not fork `ps`
 * every 25 ms until the ceiling. A signalled worker is not waited for: it was
 * measured gone within 1 ms of SIGTERM under two loaded cores plus six
 * spinners, so the fast cadence is what usually pays off.
 *
 * An empty sample is NOT the end (review round): the loop declares a clean end
 * only after TWO consecutive empty samples, and the confirmation is taken at
 * the MINIMUM cadence -- after the first empty sample it sleeps
 * `WORKER_POLL_MIN_MS` instead of the gap backoff had grown to, so the pair is
 * one observation taken twice 25 ms apart rather than two observations 250 ms
 * apart. That window is what a single empty sample could not rule out: a worker
 * ending (or a re-spawned one appearing) between two widely spaced samples left
 * one empty reading as the last word. The measured pause is recorded in
 * `phases` rather than asserted against: `Date.now()`'s resolution and the
 * timer's own granularity put a healthy 25 ms pause at 25-26 ms on any box, so
 * an assertion there would either flake or (re-pairing forever) spend the whole
 * ceiling on a busy box while proving nothing new -- both samples DID see an
 * empty process table, and by construction they are one minimum cadence apart.
 */
async function waitForBackgroundWorkers(target: string, runId: string): Promise<WorkerTeardown> {
  const startedAt = Date.now();
  const phases: string[] = [];
  let signalStage: 0 | 1 | 2 = 0;
  let signalledAt = 0;
  let gapMs = WORKER_POLL_MIN_MS;
  let samples = 0;
  let emptySamples = 0;
  for (;;) {
    samples += 1;
    const survivors = await backgroundWorkerPids(target, runId);
    const elapsedMs = Date.now() - startedAt;
    if (survivors.length === 0) {
      if (emptySamples === 0) {
        // First empty reading: schedule the confirmation at the minimum
        // cadence -- explicitly not `gapMs`, which the backoff may have grown
        // to 250 ms -- and take it before deciding anything.
        emptySamples = 1;
        const pauseStartedAt = Date.now();
        await Bun.sleep(WORKER_POLL_MIN_MS);
        phases.push(
          `first empty sample at ${elapsedMs} ms; confirmation scheduled after the ` +
            `measured ${Date.now() - pauseStartedAt} ms minimum cadence`,
        );
        continue;
      }
      emptySamples += 1;
      phases.push(`${emptySamples} consecutive empty samples at ${elapsedMs} ms`);
      return { survivors, elapsedMs, phases };
    }
    emptySamples = 0;
    if (elapsedMs >= WORKER_TEARDOWN_CEILING_MS) {
      phases.push(
        `absolute ceiling ${WORKER_TEARDOWN_CEILING_MS} ms reached with ` +
          `${survivors.length} worker(s) alive after ${samples} sample(s)`,
      );
      return { survivors, elapsedMs, phases };
    }
    let signalled = false;
    if (signalStage === 0 && elapsedMs >= WORKER_SELF_EXIT_MS) {
      signalWorkers(survivors, "SIGTERM");
      signalStage = 1;
      signalledAt = elapsedMs;
      signalled = true;
      phases.push(
        `SIGTERM to ${survivors.length} worker(s) [${survivors.join(",")}] after ` +
          `${elapsedMs} ms of self-exit grace`,
      );
    } else if (signalStage === 1 && elapsedMs - signalledAt >= WORKER_SIGTERM_MS) {
      signalWorkers(survivors, "SIGKILL");
      signalStage = 2;
      signalled = true;
      phases.push(
        `SIGKILL to ${survivors.length} worker(s) [${survivors.join(",")}] after ` +
          `${elapsedMs - signalledAt} ms of SIGTERM window`,
      );
    }
    gapMs = signalled ? WORKER_POLL_MIN_MS : Math.min(gapMs * 2, WORKER_POLL_MAX_MS);
    await Bun.sleep(gapMs);
  }
}

function signalWorkers(pids: readonly number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // ESRCH is the ONE expected failure: the worker exited between the sample
      // and this line, which is the outcome the caller is waiting for anyway.
      // Everything else is rethrown with its code -- swallowing the catch-all
      // was a promise the comment above could not keep: EPERM (a pid that is
      // not this user's, e.g. a recycled pid or a worker started by another
      // account) means the process was NOT signalled and the teardown must not
      // go on to report a bound it never actually tested.
      if (code === "ESRCH") continue;
      throw new Error(`cannot send ${signal} to pid ${pid}: ${code ?? "unknown error"}`);
    }
  }
}

/** Grace for a worker that was already ending on its own before it is signalled. */
const WORKER_SELF_EXIT_MS = 1_000;
/** Window after SIGTERM before SIGKILL. Measured: a worker disappears within
 * 1 ms of the SIGTERM under two loaded cores plus six spinners, so the rest is
 * headroom for a box that is worse than the one this was measured on -- and it
 * is a WINDOW, not a sleep: the escalation happens on the first sample past it. */
const WORKER_SIGTERM_MS = 5_000;
/**
 * The absolute bound on one teardown, from the cancel to giving up: 30 s.
 *
 * It replaces the old 1 s + 10 s + 5 s of fixed phases. Those summed to 16 s of
 * waiting WHETHER OR NOT anything was still alive, and the sum was not a bound
 * -- the phases were walks through `Bun.sleep`, so a starved loop stretched
 * them by however long its samples took. This ceiling is the only clock the
 * teardown answers to, it covers the post-SIGKILL tail (a process the kernel
 * cannot schedule is the one case no signal ends), and it is deliberately
 * larger than the 16 s it replaces: a longer bound that is actually enforced
 * says more than a shorter one that is not.
 */
const WORKER_TEARDOWN_CEILING_MS = 30_000;
/** Sampling gap after a signal, in ms: the observation that matters most is the
 * one right after SIGTERM, which the measured worker answers in ~1 ms. */
const WORKER_POLL_MIN_MS = 25;
/** Sampling gap once consecutive samples keep reporting the same state, in ms:
 * a teardown that is not converging must not fork a `ps` every 25 ms. */
const WORKER_POLL_MAX_MS = 250;
/**
 * Bound on ONE process-table sample, in ms (review round).
 *
 * The sample is awaited, so a `ps` that never returns used to hold the
 * teardown open until the runner's per-test timeout and be reported as a bare
 * `timed out after Nms` -- indistinguishable from a slow teardown and naming
 * nothing. Past this bound the child is killed and `readProcessTable` throws
 * `process-table sampler did not return within 5000 ms`, so a hang lands on the
 * sampler with its number in the message.
 */
const WORKER_SAMPLE_TIMEOUT_MS = 5_000;
/** Runner headroom, in ms: process startup, `bun run src/cli.ts` for the cancel,
 * the target's `rmSync` and the scheduler's own slack on a loaded box. */
const WORKER_TEARDOWN_RUNNER_HEADROOM_MS = 5_000;
/**
 * Budget for the two tests that end a real worker, in ms.
 *
 * `bun test`'s default is 5 s, which is SHORTER than the teardown ceiling
 * below: a teardown that legitimately used its full bound would be killed by
 * the runner and reported as a bare `timed out after 5000ms` -- the shape of
 * output this issue exists to replace -- instead of as the named failure with
 * pids, states, etimes and passed phases. Nothing else changes with this
 * number: the zero-worker and no-residue assertions stay hard, and the run is
 * still red. It only decides whether the red run says WHY.
 *
 * The budget is the SUM of what the teardown can actually consume, not a round
 * number with room to hide in (review round: 30 s + 20 s of "spare" let a
 * hanging teardown spend 20 s nobody could account for and still be reported as
 * a runner timeout):
 *
 *   ceiling (30 s)                       the teardown's own absolute bound
 * + one sampler timeout (5 s)            a sample is awaited, then the ceiling
 *                                        is compared, so one over-long sample
 *                                        lands past the bound
 * + one poll gap (0.25 s)                the sleep between two samples
 * + runner headroom (5 s)                see above
 * = 40.25 s
 *
 * A hang is therefore not what this budget is for: it is caught by the sampler
 * in 5 s (or by the ceiling), and every second past those sums is the runner's.
 */
const WORKER_TEARDOWN_TEST_TIMEOUT_MS =
  WORKER_TEARDOWN_CEILING_MS +
  WORKER_SAMPLE_TIMEOUT_MS +
  WORKER_POLL_MAX_MS +
  WORKER_TEARDOWN_RUNNER_HEADROOM_MS;

/**
 * `test` with the worker-teardown budget attached.
 *
 * The budget is a named constant rather than a literal, and the formatter only
 * hugs `test(name, async () => …, <ms>)` when that last argument is a literal:
 * a constant there re-indents both test bodies wholesale. A two-argument call
 * keeps the two tests the same shape as every other test in this file.
 */
function testBudget(name: string, body: () => Promise<void>): void {
  test(name, body, WORKER_TEARDOWN_TEST_TIMEOUT_MS);
}

/**
 * Ends the detached run a test started, waits for its process to actually
 * disappear, and removes the test's own `mkdtemp` target (issue #419).
 *
 * `background cancel` alone is not enough, and that is measured rather than
 * assumed: cancellation is an in-memory flag of whichever `BackgroundRunManager`
 * runs the pipeline, and the detached worker reads it only between stages, so an
 * external cancel reaches the record and never the process -- observed as the
 * record flipping from `cancelled` back to `started` on the worker's own lease
 * heartbeat while the process lived on. The durable way to end it is the signal
 * an operator's `kill` sends, so the cancel is still issued (it is the
 * operator-facing record transition, and its success proves the record is
 * addressable by that owner) and the pid is then awaited, then SIGTERM, then
 * SIGKILL -- each transition decided by what a sample of the process table
 * found, all of them inside the absolute ceiling, and none of them read off a
 * fixed sleep (see `waitForBackgroundWorkers`).
 *
 * A cancelled run whose worker outlives an external stop is the product
 * question, not this file's: it is ticketed as #459 (with #426 for the record
 * side) and is NOT fixed here. What this teardown owes is an attributed
 * failure: if a worker survives, the message names each pid, its state read
 * from `/proc/<pid>/stat`, its `etime`, the elapsed milliseconds, the phases
 * that were passed -- and `see #459`, so the next reader finds the reproduction
 * instead of a silent flake.
 *
 * The target is removed only AFTER the process is provably gone: a live writer
 * re-creates `<target>/.ad-coder/runs/background/<id>.json` with a recursive
 * `mkdir`, and with it every deleted parent -- including the test run's
 * `ad-coder-test-…` tmpdir root, which is exactly the leaked directory whose
 * record carried no `run-pid` marker.
 */
async function endBackgroundRun(
  target: string,
  runId: string,
  ownerArgs: readonly string[] = [],
): Promise<void> {
  const cancelled = runCli([
    "background",
    "cancel",
    "--target-dir",
    target,
    ...ownerArgs,
    "--id",
    runId,
  ]);
  expect(cancelled.code).toBe(0);
  const teardown = await waitForBackgroundWorkers(target, runId);
  // A leak must be red in the run that caused it, not recovered later by a
  // sweep: the whole point of the fix is that no worker outlives its test.
  // The message carries the numbers the reproducibility claim rests on.
  expect(
    teardown.survivors,
    `background worker teardown for ${target} ended with ` +
      `${teardown.survivors.length} live worker(s) after ${teardown.elapsedMs} ms ` +
      `(absolute ceiling ${WORKER_TEARDOWN_CEILING_MS} ms, ` +
      `phases: ${teardown.phases.join(" -> ")}): ` +
      `${teardown.survivors.map(describeWorker).join(", ")}; ` +
      "a worker of a cancelled run outliving an external stop is tracked in see #459",
  ).toEqual([]);
  fs.rmSync(target, { recursive: true, force: true });
  // The residue half of the same check, and the reason the process check is
  // first: inside the test run's root, THIS test owns exactly one directory,
  // and a worker that is still writing re-creates its `.ad-coder/runs/...`
  // parents `rmSync` just deleted. Sampled after the workers are provably gone,
  // so an absence here is a statement about the worker rather than about the
  // deletion; the parent root itself belongs to the run and to `test/preload.ts`
  // (#419) and is not this test's to remove or to assert on.
  expect(fs.existsSync(target), `test target ${target} still exists after removal`).toBe(false);
}

/**
 * `pid <n> (state S, etime 12.3 s)` for one surviving worker.
 *
 * The state comes from field 3 of `/proc/<pid>/stat` and `etime` is derived
 * from field 22 (starttime) against `/proc/uptime`: `comm` (field 2) can carry
 * spaces and parentheses, so fields are counted from the LAST `)` -- field 3
 * (state) is first there and starttime is index 19. `/proc/<pid>/stat` times
 * are in USER_HZ, which the kernel fixes at 100 on every Linux architecture.
 * Unreadable procfs (a pid gone between the sample and this line, or a platform
 * without `/proc`) is reported as `unreadable` rather than guessed at.
 */
function describeWorker(pid: number): string {
  let state = "unreadable";
  let etime = "unreadable";
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const tail = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    state = tail[0] ?? "unreadable";
    const starttimeTicks = Number(tail[19]);
    const uptimeSeconds = Number(fs.readFileSync("/proc/uptime", "utf8").split(" ")[0]);
    if (Number.isFinite(starttimeTicks) && Number.isFinite(uptimeSeconds))
      etime = `${Math.max(0, uptimeSeconds - starttimeTicks / 100).toFixed(1)} s`;
  } catch {
    // Left as `unreadable`: naming a vanished pid is still a reproduction step.
  }
  return `pid ${pid} (state ${state}, etime ${etime})`;
}

testBudget("background start propagates an explicit owner to the detached worker", async () => {
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
    if (["started", "paused", "failed", "cancelled", "timed_out", "completed"].includes(lifecycle))
      break;
  }
  expect(lifecycle).not.toBe("requested");
  expect(["started", "paused", "failed", "cancelled", "timed_out", "completed"]).toContain(
    lifecycle,
  );
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
  expect(["started", "paused", "failed", "cancelled", "timed_out", "completed"]).toContain(
    JSON.parse(status.stdout).lifecycle,
  );
  // Assertions above, teardown below: cancelling earlier would have satisfied
  // `not requested` with this test's own cancel instead of the worker's state.
  await endBackgroundRun(target, runId, ["--owner-id", ownerId]);
});

testBudget("the default background owner is stable across processes for one target", async () => {
  // The default owner used to embed the target path, which the manager rejects
  // (`^[A-Za-z0-9._:-]{1,128}$`), so every ownerless background command failed
  // invalid_request before it could reach a record.
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-default-owner-"));
  const started = runCli([
    "background",
    "start",
    "ownerless regression task",
    "--target-dir",
    target,
  ]);
  expect(started.code).toBe(0);
  const runId = JSON.parse(started.stdout).runId as string;

  // A separate process derives the same owner from the same target, so the
  // record admitted above is addressable rather than foreign.
  const status = runCli(["background", "status", "--target-dir", target, "--id", runId]);
  expect(status.code).toBe(0);
  expect(JSON.parse(status.stdout).runId).toBe(runId);

  // No `--owner-id` here on purpose: the default the second process derives
  // from the target must address the record the worker is still writing, which
  // is the stability this test exists for. The worker itself is then ended and
  // awaited, so the run holds nothing on the shared tmpfs after the test.
  await endBackgroundRun(target, runId);
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
  // The banner names the selection and the role->model ladder once (issue #501):
  // the old per-provider plumbing line (host and credential variable name) is
  // gone, so what proves the deepseek route here is the banner's own selection.
  expect(external.stderr).toContain('ad-coder: provider "deepseek"');
  expect(external.stderr).toContain("deepseek-chat");
  expect(external.stderr).not.toContain("operator-owned-value");
});

test("profile CLI previews and applies a portable import before exporting it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-profile-cli-"));
  try {
    const profilePath = path.join(root, "private", "profile.json");
    const inputPath = path.join(root, "portable.json");
    const portable = {
      version: 1,
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
      creates: [],
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

test("profile CLI previews conflicts and rejects applying them", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-profile-cli-conflict-"));
  try {
    const profilePath = path.join(root, "private", "profile.json");
    const localPath = path.join(root, "local.json");
    const conflictPath = path.join(root, "conflict.json");
    const routing = {
      modelsProfile: "daily",
      profile: { entries: [{ role: "coder", complexity: "medium", model: "gpt" }] },
      observedOn: "2026-09-20",
      source: "benchmark",
      confidence: "measured",
    };
    const record = {
      id: "price-1",
      observedAt: "2026-09-13T00:00:00.000Z",
      provider: "openai",
      model: "gpt",
      kind: "price",
      value: 2.5,
      unit: "USD/1M tokens",
      source: "https://example.test/pricing",
      confidence: "official",
    };
    const document = {
      version: 1,
      calibratedRouting: [routing],
      economicRecords: [record],
      subscriptionCapacityRanges: [],
    };
    fs.writeFileSync(localPath, JSON.stringify(document));
    const seed = runCli([
      "profile",
      "import-apply",
      "--input",
      localPath,
      "--mode",
      "merge",
      "--profile-path",
      profilePath,
    ]);
    expect(seed.code).toBe(0);
    fs.writeFileSync(
      conflictPath,
      JSON.stringify({ ...document, economicRecords: [{ ...record, value: 99 }] }),
    );
    const args = ["--input", conflictPath, "--mode", "merge", "--profile-path", profilePath];
    const preview = runCli(["profile", "import-preview", ...args]);
    expect(preview.code).toBe(0);
    expect(JSON.parse(preview.stdout).conflicts).toContain("economicRecord:price-1");
    const apply = runCli(["profile", "import-apply", ...args]);
    expect(apply.code).toBe(1);
    expect(JSON.parse(apply.stderr).error.code).toBe("conflict");
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

test("profile CLI snapshots a models.yaml profile, and refuses an ambiguous source", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-profile-models-"));
  try {
    const profilePath = path.join(root, "profile.json");
    const modelsPath = path.join(root, "models.yaml");
    const inputPath = path.join(root, "portable.json");
    fs.writeFileSync(
      modelsPath,
      [
        "providers:",
        "  opencode-go:",
        "    enabled: true",
        "    api: openai-completions",
        "    baseUrl: https://opencode.example.com",
        "    credential: OPENCODE_API_KEY",
        "    models:",
        "      glm-5.3-flash: {input: 0.15, output: 0.5}",
        "default: daily",
        "profiles:",
        "  daily:",
        "    coder: opencode-go:glm-5.3-flash",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      inputPath,
      JSON.stringify({
        version: 1,
        inventories: [],
        calibratedRouting: [
          {
            modelsProfile: "daily",
            profile: {
              entries: [{ role: "coder", complexity: "trivial", model: "glm-5.3-flash" }],
            },
            observedOn: "2026-09-20",
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

    const snapshot = runCli([
      "profile",
      "snapshot",
      "--profile-path",
      profilePath,
      "--target-dir",
      root,
      "--models-profile",
      "daily",
      "--models-config",
      modelsPath,
    ]);
    expect(snapshot.code).toBe(0);
    // The command answers with the path it wrote, and the file is there: the
    // inventory-named variant of this test (retired with the JSON route, issue
    // #513) was the only place that asserted the reported path, so it moved here
    // rather than leaving with its route.
    expect(JSON.parse(snapshot.stdout).file).toBe(path.join(root, ".ad-coder", "calibration.json"));
    expect(fs.existsSync(path.join(root, ".ad-coder", "calibration.json"))).toBe(true);
    const written = JSON.parse(
      fs.readFileSync(path.join(root, ".ad-coder", "calibration.json"), "utf8"),
    );
    // The committed snapshot names the models.yaml profile, in its namespace.
    expect(written).toMatchObject({ modelsProfile: "daily" });
    expect(written).not.toHaveProperty("inventory");

    const bad = (args: string[]) =>
      runCli(["profile", "snapshot", "--profile-path", profilePath, "--target-dir", root, ...args]);
    // One source, named once: both is ambiguous, neither has nothing to build.
    // A usage refusal is the CLI's `usage` front (exit 2); a source the profile
    // or the models file cannot supply is a typed refusal (exit 1).
    const refusals: Array<[string[], number]> = [
      [[], 2],
      [["--inventory", "work", "--models-profile", "daily"], 2],
      [["--models-profile", "daily", "--models-config", path.join(root, "absent.yaml")], 2],
      [["--models-profile", "missing", "--models-config", modelsPath], 1],
    ];
    for (const [args, code] of refusals) {
      const result = bad(args);
      expect(result.code).toBe(code);
      expect(result.stderr.length).toBeGreaterThan(0);
    }
    // The retired flag's refusal NAMES the replacement (issue #513), asserted
    // apart from the loop above because the loop reads the exit code only. A
    // usage error that names the flag it refuses and no route forward leaves
    // the operator holding a command that stopped working -- and after this
    // branch there is no other surface left that reads this text.
    const retired = bad(["--inventory", "work", "--models-profile", "daily"]);
    expect(retired.stderr).toContain("--inventory");
    expect(retired.stderr).toContain("--models-profile");
    expect(retired.stderr).toContain("models.yaml");
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
    expect(stdout).toContain(
      "update  Update the global install (npm or GitHub) or a linked Git checkout",
    );
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
    ["update", "--json", "--provider"],
    ["auth", "<status|login|logout>", "--auto"],
    ["operations", "ldo-resume", "<script.ts>"],
    ["run", "<script.ts>", "--provider"],
    // The orchestrator is a runnable role like any other (issue #306); this list
    // is rendered from ROLE_NAMES, so it cannot drift from what `role` accepts.
    ["role", "<orchestrator|planner|researcher|coder|reviewer|auditor|security>", "--auto"],
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
  // `profile` is not in the table above -- it carries a positional -- so its
  // help is read here for the routing pair this branch changed (issue #513).
  // The replacement is advertised...
  const profileHelp = runCli(["profile", "--help"]);
  expect(profileHelp.code).toBe(0);
  expect(profileHelp.stdout).toContain("--models-profile");
  // ...and the retired flag is still DECLARED, saying so. Both halves matter:
  // the option table is the parse table, so a flag deleted from it no longer
  // reaches the typed refusal and comes back as a bare "unknown option" that
  // names nothing instead (measured: dropping this entry made that same
  // `--inventory` invocation answer `unknown option: --inventory`), while a
  // flag left advertised as "Inventory to snapshot." sends the operator to an
  // option that cannot work.
  expect(profileHelp.stdout).toContain("Retired (issue #513)");
  expect(profileHelp.stdout).not.toContain("--inventory-profile");
}, 10_000);

test("the retired config action and the JSON inventory options are refused, not merely gone", () => {
  // Issue #513 deleted the `config migrate` action and the `--inventory-config`
  // and `--inventory-profile` options. An absence is a contract only if
  // RESTORING the surface fails a test, so every assertion below was measured
  // against a tree with the surface put back (counts in the commit message).
  // Exit codes alone would not carry it: an option restored to the table is
  // parsed and then dies on its own missing file, which reads exactly like a
  // refusal from the outside. The text is the sharper half -- "unknown option"
  // is what the parse table says when it does not know a name.
  const configHelp = runCli(["config", "--help"]);
  expect(configHelp.code).toBe(0);
  // One action, and the usage line offers exactly that one.
  expect(configHelp.stdout).toContain("usage: ad-coder config <show>");
  // It also says out loud that `migrate` left, rather than dropping the word:
  // the operator who typed it finds out why instead of hunting a flag that no
  // longer exists on any surface.
  expect(configHelp.stdout).toContain("was removed with the JSON inventory route");
  expect(configHelp.stdout).not.toContain("--inventory-config");

  const migrated = runCli(["config", "migrate"]);
  expect(migrated.code).toBe(2);
  expect(migrated.stdout).toBe("");
  expect(migrated.stderr).toContain("config requires exactly one action: show");

  const retired: ReadonlyArray<readonly [string[], string]> = [
    [
      ["config", "show", "--inventory-config", path.join(CONFIG_HOME, "inventory.json")],
      "--inventory-config",
    ],
    [["profile", "snapshot", "--inventory-profile", "work"], "--inventory-profile"],
  ];
  for (const [args, flag] of retired) {
    const refused = runCli(args);
    expect(refused.code).toBe(2);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain(`unknown option: ${flag}`);
  }
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

test("auth login rejects an empty OpenRouter API key without claiming success", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-empty-openrouter-auth-"));
  const priorConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = root;
  const targetDir = path.join(root, "project");
  const credentialPath = path.join(root, "private", "credentials.json");
  fs.mkdirSync(targetDir);
  let output = "";
  try {
    await expect(
      runAuthCommand({
        action: "login",
        provider: "openrouter",
        credentialPath,
        targetDir,
        interaction: { prompt: async () => "   ", notify: () => undefined },
        write: (text) => {
          output += text;
        },
      }),
    ).rejects.toThrow("cannot be empty");
    expect(output).not.toContain("authenticated");
    expect(
      await new FileCredentialStore({ path: credentialPath }).read("openrouter"),
    ).toBeUndefined();
  } finally {
    if (priorConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = priorConfigHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** A declared env-var provider id shared across the auth declared-provider tests. */
const DECLARED_PROVIDER_ID = "myprovider";

/** A minimal models.yaml declaring the same env-var provider. */
function declaredModelsYamlFile(dir: string): string {
  const file = path.join(dir, "models.yaml");
  const routes = [
    "orchestrator",
    "planner",
    "researcher",
    "coder",
    "reviewer",
    "auditor",
    "security",
    "summarizer",
  ]
    .map((role) => `    ${role}: ${DECLARED_PROVIDER_ID}:my-model`)
    .join("\n");
  const yaml = `providers:
  ${DECLARED_PROVIDER_ID}:
    enabled: true
    api: openai-completions
    baseUrl: https://myprovider.example.com/v1
    credential: MYPROVIDER_API_KEY
    models:
      my-model: {input: 0.1, output: 0.1}
default: declared
profiles:
  declared:
${routes}
`;
  fs.writeFileSync(file, yaml);
  return file;
}

test("auth manages a declared env-var provider: login stores, status hides the value, logout removes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-declared-auth-"));
  const priorConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = root;
  const targetDir = path.join(root, "project");
  const credentialPath = path.join(root, "private", "credentials.json");
  fs.mkdirSync(targetDir);
  const modelsConfigPath = declaredModelsYamlFile(root);
  const secret = "sk-test-declared-key";
  let output = "";
  try {
    await runAuthCommand({
      action: "login",
      provider: DECLARED_PROVIDER_ID,
      modelsConfigPath,
      credentialPath,
      targetDir,
      interaction: { prompt: async () => secret, notify: () => undefined },
      write: (text) => {
        output += text;
      },
    });
    // The key was stored under the DECLARED id, and never echoed.
    expect(output).toContain(`${DECLARED_PROVIDER_ID}: authenticated`);
    expect(output).not.toContain(secret);
    const stored = await new FileCredentialStore({ path: credentialPath }).read(
      DECLARED_PROVIDER_ID,
    );
    expect(stored).toEqual({ type: "api_key", key: secret });

    // Status reports the type without exposing any value.
    output = "";
    await runAuthCommand({
      action: "status",
      provider: DECLARED_PROVIDER_ID,
      modelsConfigPath,
      credentialPath,
      targetDir,
      write: (text) => {
        output += text;
      },
    });
    expect(output).toContain(`${DECLARED_PROVIDER_ID}: authenticated (api_key)`);
    expect(output).not.toContain(secret);

    // Logout removes the key and reports which provider.
    output = "";
    await runAuthCommand({
      action: "logout",
      provider: DECLARED_PROVIDER_ID,
      modelsConfigPath,
      credentialPath,
      targetDir,
      write: (text) => {
        output += text;
      },
    });
    expect(output).toContain(`${DECLARED_PROVIDER_ID}: logged out`);
    expect(
      await new FileCredentialStore({ path: credentialPath }).read(DECLARED_PROVIDER_ID),
    ).toBeUndefined();
  } finally {
    if (priorConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = priorConfigHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("auth resolves a declared provider from models.yaml (models.yaml-first)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-declared-yaml-auth-"));
  const priorConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = root;
  const targetDir = path.join(root, "project");
  const credentialPath = path.join(root, "private", "credentials.json");
  fs.mkdirSync(targetDir);
  const modelsConfigPath = declaredModelsYamlFile(root);
  const secret = "stored-test-key";
  try {
    await runAuthCommand({
      action: "login",
      provider: DECLARED_PROVIDER_ID,
      modelsConfigPath,
      credentialPath,
      targetDir,
      interaction: { prompt: async () => secret, notify: () => undefined },
      write: () => undefined,
    });
    const stored = await new FileCredentialStore({ path: credentialPath }).read(
      DECLARED_PROVIDER_ID,
    );
    expect(stored).toEqual({ type: "api_key", key: secret });
  } finally {
    if (priorConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = priorConfigHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("auth --provider validates against models.yaml-declared ids too", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-unknown-yaml-provider-cli-"));
  const priorConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = root;
  const targetDir = path.join(root, "project");
  const credentialPath = path.join(root, "private", "credentials.json");
  fs.mkdirSync(targetDir);
  try {
    const configDir = path.join(root, "ad-coder");
    fs.mkdirSync(configDir, { recursive: true });
    declaredModelsYamlFile(configDir);
    const result = runCli([
      "auth",
      "status",
      "--provider",
      "not-declared",
      "--target-dir",
      targetDir,
      "--credential-path",
      credentialPath,
    ]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("openai-codex");
    expect(result.stderr).toContain("openrouter");
    expect(result.stderr).toContain(DECLARED_PROVIDER_ID);
    expect(result.stderr).not.toContain("MYPROVIDER_API_KEY");
    // The refusal names ids, never the operator's config directory: the
    // retired-route variant of this test carried this assertion (issue #513)
    // and the path-leak rule outlives the route it was written for.
    expect(result.stderr).not.toContain(configDir);
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

test("project-store config accepts default lock retry policy in the CLI", () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-lock-retry-cli-"));
  const config = path.join(target, "config.json");
  const run = () =>
    runCli([
      "operations",
      "control-list",
      "--target-dir",
      target,
      "--project-store-config",
      config,
      "--json",
    ]);

  fs.writeFileSync(config, JSON.stringify({ lockRetry: {} }), { mode: 0o600 });
  expect(run().code).toBe(0);

  fs.writeFileSync(config, JSON.stringify({ lockRetry: { delaysMs: [] } }), { mode: 0o600 });
  const empty = run();
  expect(empty.code).toBe(2);
  expect(empty.stderr).toContain('"code":"invalid_config"');
  expect(empty.stderr).toContain("lockRetry.delaysMs");

  fs.writeFileSync(config, JSON.stringify({ lockRetry: { unexpected: true } }), { mode: 0o600 });
  const unknown = run();
  expect(unknown.code).toBe(2);
  expect(unknown.stderr).toContain('"code":"invalid_config"');

  fs.writeFileSync(config, "{ malformed", { mode: 0o600 });
  const malformed = run();
  expect(malformed.code).toBe(2);
  expect(malformed.stderr).toContain('"code":"invalid_config"');
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
    // The console constructs a background run manager too, so its admission
    // flags must be declared here rather than only on `background`.
    "--owner-id <id>",
    "--background-max-active <n>",
    "--same-target-policy <allow|reject|serialize>",
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
}, 30_000);

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

test("a machine front projects an update failure with its code, retryability, and action", () => {
  const mismatch = new UpdateError("install_mismatch", "9e8c433", "left 9e8c433 installed", {
    retryable: false,
    nextAction: "remove the stale entry from ~/.bun/install/global/bun.lock",
  });
  expect(projectCliError(mismatch)).toEqual({
    code: "install_mismatch",
    detail: "9e8c433",
    text: "left 9e8c433 installed",
    retryable: false,
    nextAction: "remove the stale entry from ~/.bun/install/global/bun.lock",
  });

  // An error without a recovery omits the key rather than projecting an empty one.
  const bare = new UpdateError("not_checkout", "/dir", "no checkout");
  expect(projectCliError(bare)).toEqual({
    code: "not_checkout",
    detail: "/dir",
    text: "no checkout",
    retryable: false,
  });

  // An unrecognized failure never leaks its text into the machine record.
  expect(projectCliError(new Error("secret internals"))).toEqual({ code: "internal_error" });
  const unavailable = new ProviderUnavailableError("run-9f2a");
  expect(projectCliError(unavailable)).toEqual({
    code: "provider_unavailable",
    detail: "run-9f2a",
    text: unavailable.message,
    retryable: true,
    nextAction: "retry the run, or select another configured model or provider",
  });
});

test("a human front states the update failure and its recovery action on one line", () => {
  const failure = new UpdateError("install_mismatch", "9e8c433", "left 9e8c433 installed", {
    retryable: false,
    nextAction: "repair the global lockfile",
  });
  expect(renderCliError(failure)).toBe(
    "ad-coder: left 9e8c433 installed; repair the global lockfile\n",
  );
  // An error carrying no action renders exactly as it did before, with no stray separator.
  expect(renderCliError(new Error("plain failure"))).toBe("ad-coder: plain failure\n");
  expect(renderCliError(new UpdateError("not_checkout", "/dir", "no checkout"))).toBe(
    "ad-coder: no checkout\n",
  );
});

test("a human front projects a session that was never acquired with its authored text and action", () => {
  const error = new SessionNotAcquiredError("run-9f2a");
  expect(renderCliError(error)).toBe(
    `ad-coder: ${error.message}; ${SessionNotAcquiredError.NEXT_ACTION}\n`,
  );
  // The record carries the class code as well, though the human line never does.
  expect(SessionNotAcquiredError.CODE).toBe("session_not_acquired");
  // An error with no action renders with no stray separator.
  expect(renderCliError(new Error("plain failure"))).toBe("ad-coder: plain failure\n");
});

test("a machine front projects a session that was never acquired with its code, detail, and action", () => {
  const error = new SessionNotAcquiredError("run-9f2a");
  expect(projectCliError(error)).toEqual({
    code: SessionNotAcquiredError.CODE,
    detail: error.runId,
    text: error.message,
    retryable: false,
    nextAction: SessionNotAcquiredError.NEXT_ACTION,
  });
});

test("a usage error under a machine front stays machine-readable instead of printing help", () => {
  for (const args of [
    ["update", "--json", "stray"],
    ["console", "--json", "stray"],
  ]) {
    const { code, stdout, stderr } = runCli(args);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(JSON.parse(stderr.trim()).error).toMatchObject({ code: "usage" });
    // The root help would corrupt a caller parsing stderr as JSON.
    expect(stderr).not.toContain("usage: ad-coder <command> [options]");
  }
  // A human front keeps the help text it has always printed.
  expect(runCli(["update", "stray"]).stderr).toContain("usage: ad-coder <command> [options]");
});

test("workflow modules ship enabled, and --workflows selects, excludes, or disables", () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-workflows-flag-"));
  const show = (...args: string[]) =>
    runCli(["config", "show", "--target-dir", target, "--json", ...args]);

  // Unset: the built-in default — every shipped module ON, and never silent.
  const unset = show();
  expect(unset.code).toBe(0);
  expect(JSON.parse(unset.stdout).workflows).toEqual({
    value: "pipeline",
    source: "built-in-default",
  });

  // An exact selection is recorded as such.
  const selected = show("--workflows", "pipeline");
  expect(JSON.parse(selected.stdout).workflows).toEqual({ value: "pipeline", source: "cli" });

  // Excluding the only shipped module and explicit off resolve to the same
  // empty set, both by explicit choice.
  for (const argv of [
    ["--workflows", "^pipeline"],
    ["--workflows", "false"],
    ["--workflows", "off"],
  ]) {
    const result = show(...argv);
    expect(JSON.parse(result.stdout).workflows).toEqual({ value: "none", source: "cli" });
  }

  // An unknown member fails HERE with the available list, not later.
  const unknown = show("--workflows", "nope");
  expect(unknown.code).toBe(2);
  expect(unknown.stderr).toContain("--workflows expects comma-separated pipeline");
  const unknownExclude = show("--workflows", "^nope");
  expect(unknownExclude.code).toBe(2);
});

test("--no-skills is the explicit off and never shares a line with a selection", () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-no-skills-"));
  const show = (...args: string[]) =>
    runCli(["config", "show", "--target-dir", target, "--json", ...args]);
  // The off alone resolves: every command that runs a role shares the flag via
  // the pipeline options, so the capability truly turns off everywhere.
  expect(show("--no-skills").code).toBe(0);
  // Pin and off are mutually exclusive; neither silently wins.
  const conflict = show("--no-skills", "--skills", "repository-navigation");
  expect(conflict.code).toBe(2);
  expect(conflict.stderr).toContain("--no-skills cannot be combined with --skills");
});

test("profile.capabilities.skills=false is the persistent off, and explicit flags beat it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-skills-setting-"));
  const home = path.join(root, "home");
  const xdg = path.join(home, ".config");
  const profileDir = path.join(xdg, "ad-coder");
  // The store itself creates private directories; a test-held profile must
  // meet the same 0o700 receipt, otherwise the read correctly fails.
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(profileDir, 0o700);
  fs.writeFileSync(
    path.join(profileDir, "profile.json"),
    `${JSON.stringify({
      version: 1,
      inventories: [],
      calibratedRouting: [],
      economicRecords: [],
      subscriptionCapacityRanges: [],
      capabilities: { skills: false },
    })}\n`,
  );
  // Same private-file receipt the store itself enforces.
  fs.chmodSync(path.join(profileDir, "profile.json"), 0o600);
  const target = path.join(root, "project");
  fs.mkdirSync(target, { recursive: true });
  const show = (...args: string[]) =>
    runCli(["config", "show", "--target-dir", target, "--json", ...args], {
      env: { ...process.env, XDG_CONFIG_HOME: xdg },
    });

  // The setting alone is the persistent off: every command that runs a role
  // resolves no skill capability without any launch parameter.
  const unset = JSON.parse(show().stdout).skills as {
    value: { enabled: boolean; skills: unknown[] };
    source: string;
  };
  expect(unset.source).toBe("profile");
  // The row says the capability is OFF, not merely that the set is empty.
  expect(unset.value).toEqual({ enabled: false, skills: [] });

  // An explicit `--skills` pin beats the setting in its own direction...
  const pinned = JSON.parse(show("--skills", "repository-navigation").stdout).skills as {
    value: { enabled: boolean; skills: { id: string }[] };
    source: string;
  };
  expect(pinned.value.enabled).toBe(true);
  // ...and the explicit `--no-skills` mirrors the setting (same off).
  expect(show("--no-skills").code).toBe(0);
  expect(pinned.value.skills.map((entry) => entry.id)).toEqual(["repository-navigation"]);

  // Mode permission sanity: an unreadable profile is not silently default.
  const broken = path.join(root, "broken-home");
  const brokenXdg = path.join(broken, ".config");
  fs.mkdirSync(path.join(brokenXdg, "ad-coder"), { recursive: true });
  fs.writeFileSync(path.join(brokenXdg, "ad-coder", "profile.json"), "not json\n");
  const brokenResult = runCli(["config", "show", "--target-dir", target, "--json"], {
    env: { ...process.env, XDG_CONFIG_HOME: brokenXdg },
  });
  expect(brokenResult.code).toBe(1);
  expect(brokenResult.stderr).toContain("profile");
});

test("config show reports the resolved skill set with version, source tier, and digest", () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-skills-show-"));
  const show = (...args: string[]) =>
    runCli(["config", "show", "--target-dir", target, "--json", ...args]);

  // Unset: the built-in default says ON and enumerates the reach set with digests.
  const unset = JSON.parse(show().stdout).skills as {
    value: {
      enabled: boolean;
      skills: { id: string; version: string; source: string; sha256: string }[];
    };
    source: string;
  };
  expect(unset.source).toBe("built-in-default");
  expect(unset.value.enabled).toBe(true);
  expect(unset.value.skills.length).toBeGreaterThan(0);
  for (const entry of unset.value.skills) {
    expect(entry).toMatchObject({ id: expect.any(String), version: expect.any(String) });
    expect(entry.source).toMatch(/^(builtin|project)$/);
    expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
  }
  const ids = unset.value.skills.map((entry) => entry.id);
  expect(new Set(ids).size).toBe(ids.length);

  // A pin reports exactly those ids, resolved, flagged as operator-set.
  const pinned = JSON.parse(show("--skills", "repository-navigation").stdout).skills as {
    value: { enabled: boolean; skills: { id: string }[] };
    source: string;
  };
  expect(pinned.source).toBe("cli");
  expect(pinned.value.enabled).toBe(true);
  expect(pinned.value.skills.map((entry) => entry.id)).toEqual(["repository-navigation"]);

  // The explicit off says OFF, not just an empty list: an empty pin would
  // otherwise be indistinguishable from a switched capability.
  const off = JSON.parse(show("--no-skills").stdout).skills as {
    value: { enabled: boolean; skills: unknown[] };
    source: string;
  };
  expect(off.value).toEqual({ enabled: false, skills: [] });
  expect(off.source).toBe("cli");
});

test("config show's pinned skill row applies the requires filter the run applies", () => {
  // A pin whose `requires` this launch cannot honour is dropped from the paste
  // silently (skills/role-kit.ts), so the row must drop it too -- otherwise the
  // row advertises a capability no run reaches (docs/contracts/skills.md,
  // 2026-09-17).
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-skills-pinned-row-"));
  const pin = (id: string, manifest: Record<string, unknown>): void => {
    const at = path.join(target, ".ad-coder", "skills", id);
    fs.mkdirSync(at, { recursive: true });
    fs.writeFileSync(
      path.join(at, "skill.json"),
      JSON.stringify({ id, version: "1", roles: ["planner"], ...manifest }),
    );
    fs.writeFileSync(path.join(at, "instructions.md"), `${id} body`);
  };
  pin("pinned-met", {
    description: "needs only the resolved pipeline workflow",
    requires: { workflows: ["pipeline"] },
  });
  pin("pinned-unmet", {
    description: "needs the vision plugin",
    requires: { plugins: ["vision"] },
  });
  const rowIds = (...args: string[]): string[] => {
    const show = runCli(["config", "show", "--target-dir", target, "--json", ...args]);
    expect(show.code).toBe(0);
    return (
      JSON.parse(show.stdout).skills as { value: { skills: { id: string }[] } }
    ).value.skills.map((entry) => entry.id);
  };

  // The built-in composition registers explore, web and vision and resolves the
  // pipeline workflow: both pins are reachable and both are rows.
  expect(rowIds("--skills", "pinned-met,pinned-unmet")).toEqual(["pinned-met", "pinned-unmet"]);
  // `--plugins none` is what this launch registers, so the vision-requiring pin
  // is unreachable: exactly one row remains, the same set pin mode pastes.
  expect(rowIds("--skills", "pinned-met,pinned-unmet", "--plugins", "none")).toEqual([
    "pinned-met",
  ]);
  // The other composition axis filters the other way, so this is the shared
  // dependency rule and not a blanket drop of pinned rows.
  expect(rowIds("--skills", "pinned-met,pinned-unmet", "--workflows", "false")).toEqual([
    "pinned-unmet",
  ]);
  // A pin still resolves loudly: the dependency filter must not swallow the
  // typed failure for an id that is not installed.
  const unknown = runCli([
    "config",
    "show",
    "--target-dir",
    target,
    "--json",
    "--skills",
    "pinned-met,not-installed",
  ]);
  expect(unknown.code).toBe(1);
  expect(unknown.stderr).toContain("skill resolution failed");
});

test("config show's human skills row prints the enabled state and count, never a placeholder", () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-skills-human-row-"));
  const human = (...args: string[]) => runCli(["config", "show", "--target-dir", target, ...args]);

  // The built-in catalogue's ids cannot fit one row, so the human line is the
  // count and the winning layer -- the exact #416 shape. The human row and the
  // --json row must describe the SAME resolved set: the human front only
  // renders what the resolver already decided.
  const unset = human();
  expect(unset.code).toBe(0);
  const effective = JSON.parse(human("--json").stdout) as Record<
    string,
    { value: unknown; source: string }
  >;
  const jsonRow = effective.skills as {
    value: { enabled: boolean; skills: { id: string }[] };
    source: string;
  };
  expect(jsonRow.value.enabled).toBe(true);
  const row = unset.stdout.split("\n").find((line) => line.startsWith("skills="));
  expect(row).toBe(`skills=${jsonRow.value.skills.length} skills enabled (${jsonRow.source})`);
  // The leak class, asserted over EVERY resolved row: a set-valued capability
  // without a human renderer reds here instead of printing `[object Object]`.
  for (const [name, entry] of Object.entries(effective)) {
    if (typeof entry.value !== "object" || entry.value === null) continue;
    expect(name).toBe("skills");
  }
  expect(unset.stdout).not.toContain("[object Object]");

  // A pin whose ids fit the row budget lists them, the workflows row's
  // comma-list rule; the layer names the operator's flag as the winner.
  const pinned = human("--skills", "repository-navigation");
  expect(pinned.code).toBe(0);
  expect(pinned.stdout).toContain("skills=1 skills enabled: repository-navigation (cli)");

  // The explicit off says OFF in the human front too, not a silent empty set.
  const off = human("--no-skills");
  expect(off.code).toBe(0);
  expect(off.stdout).toContain("skills=disabled (cli)");
  expect(off.stdout).not.toContain("[object Object]");
});

test("renderConfigShowRow renders set-valued rows and fails loudly on one it cannot render", () => {
  // Scalar rows pass through untouched: the fix is scoped to set-valued values.
  expect(renderConfigShowRow("workflows", "none", "cli")).toBe("workflows=none (cli)");
  expect(renderConfigShowRow("maxRounds", 3, "built-in-default")).toBe(
    "maxRounds=3 (built-in-default)",
  );

  // Issue #416: a set-valued value used to print as `[object Object]`.
  expect(
    renderConfigShowRow("skills", { enabled: true, skills: [{ id: "a" }, { id: "b" }] }, "cli"),
  ).toBe("skills=2 skills enabled: a,b (cli)");
  // A known empty reach set says the switch is ON, with its count: an empty
  // pin must stay distinguishable from the explicit off.
  expect(renderConfigShowRow("skills", { enabled: true, skills: [] }, "cli")).toBe(
    "skills=0 skills enabled (cli)",
  );
  // No supplied reach set: the switch says ON and claims no count it lacks.
  expect(renderConfigShowRow("skills", { enabled: true, skills: null }, "built-in-default")).toBe(
    "skills=enabled (built-in-default)",
  );
  // The explicit off says OFF whatever the reach set holds.
  expect(renderConfigShowRow("skills", { enabled: false, skills: [{ id: "a" }] }, "cli")).toBe(
    "skills=disabled (cli)",
  );

  // Ids join the row only while the WHOLE row fits the budget: two 44-char ids
  // land the row exactly on 120 columns and stay; one more column drops the
  // ids without truncating them.
  const rowFor = (ids: string[]): string =>
    renderConfigShowRow("skills", { enabled: true, skills: ids.map((id) => ({ id })) }, "cli");
  const exactFit = rowFor(["b".repeat(44), "c".repeat(44)]);
  expect(exactFit).toBe(`skills=2 skills enabled: ${"b".repeat(44)},${"c".repeat(44)} (cli)`);
  expect(exactFit.length).toBe(120);
  expect(rowFor(["b".repeat(45), "c".repeat(44)])).toBe("skills=2 skills enabled (cli)");

  // A future set-valued capability without a branch fails the row loudly,
  // naming the KEY only -- the value must never reach the diagnostic.
  const exit = process.exit;
  const stderrWrite = process.stderr.write;
  let exitCode: number | undefined;
  let stderr = "";
  process.exit = ((code?: number) => {
    exitCode = code;
    throw new Error("exit-stub");
  }) as typeof process.exit;
  process.stderr.write = ((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    expect(() =>
      renderConfigShowRow("futureCapability", { planned: "VALUE-LEAK-MARKER" }, "cli"),
    ).toThrow("exit-stub");
  } finally {
    process.exit = exit;
    process.stderr.write = stderrWrite;
  }
  expect(exitCode).toBe(2);
  expect(stderr).toContain("futureCapability");
  expect(stderr).toContain("renderConfigShowRow");
  expect(stderr).not.toContain("VALUE-LEAK-MARKER");
  expect(stderr).not.toContain("[object Object]");
});

test("the session-manager front lists sessions as JSON and refuses a bad invocation (#365)", () => {
  // The layer-2 front is claimed as THIN and reachable through the single
  // command registry (CHANGELOG, docs/contracts/session-manager.md "Front
  // capability parity"), and nothing else in the suite spawns it: every other
  // session-manager test imports the library modules directly, so the front
  // could be dropped from the registry -- or start writing state on a refused
  // invocation -- with the suite green.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-sm-front-"));
  const stateDir = path.join(root, "state");
  try {
    const list = runCli([
      "session-manager",
      "list",
      "--state-dir",
      stateDir,
      "--allowed-roots",
      root,
    ]);
    expect(list.code).toBe(0);
    expect(JSON.parse(list.stdout)).toEqual([]);
    expect(list.stderr).toBe("");
    // A usage refusal is the CLI's `usage` front (exit 2), and it happens
    // BEFORE anything is started or written: no action at all, two actions, and
    // a root that is not absolute.
    for (const args of [
      ["session-manager"],
      ["session-manager", "serve", "list", "--state-dir", stateDir],
      ["session-manager", "list", "--state-dir", stateDir, "--allowed-roots", "relative/dir"],
    ]) {
      const refused = runCli(args);
      expect(refused.code).toBe(2);
      expect(refused.stderr.length).toBeGreaterThan(0);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
