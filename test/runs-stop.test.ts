import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  inspectStandaloneRun,
  processIsAlive,
  readProcessStat,
} from "../src/orchestration/run-stop";
import { ProjectStore } from "../src/project-store/project-store";

/**
 * `ad-coder runs stop` against real processes (issue #479).
 *
 * Every case drives the real CLI as a child process, and the file centres on
 * the REFUSAL. The measured defect behind the command (2026-09-20,
 * pids 1650952/1650955/1650958) was a stop that matched a command-line pattern
 * across every lane on the machine and killed another lane's run, so a
 * refusal that killed something anyway is the defect this file exists to
 * catch: every refusal case asserts the recorded process is still ALIVE
 * afterwards, not merely that the command printed a refusal.
 *
 * The decoy a record points at is a script invoked exactly as the verifier
 * reads it back through ps -- `bun run <script> role coder --target-dir <dir>`
 * -- started only under /tmp (the CLI itself runs from this worktree), and
 * only pids this file started are ever signalled: by pid, from the recorded
 * identity or a held subprocess handle, never by a command-line pattern.
 */

const CLI = path.join(import.meta.dir, "..", "src", "cli.ts");

const DECOY_SOURCE = `import * as fs from "node:fs";
const ready = process.env.DECOY_READY_FILE;
const marker = process.env.DECOY_TERM_MARKER;
if (marker !== undefined)
  process.on("SIGTERM", () => {
    fs.writeFileSync(marker, "SIGTERM");
    process.exit(0);
  });
if (ready !== undefined) fs.writeFileSync(ready, "up");
await Bun.sleep(Number(process.env.DECOY_SLEEP_MS ?? 60000));
`;

/** A decoy subprocess plus the file it writes once its handler is installed. */
interface Decoy {
  process: ReturnType<typeof Bun.spawn>;
  readyFile: string;
}

let scratch: string;
const decoys: ReturnType<typeof Bun.spawn>[] = [];
let decoySeq = 0;

beforeAll(() => {
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-runs-stop-")));
  fs.writeFileSync(path.join(scratch, "decoy.ts"), DECOY_SOURCE);
});

afterAll(() => {
  // Only pids this file started, by pid; leftover decoys must not outlive the
  // test that owns them.
  for (const decoy of decoys) {
    try {
      decoy.kill("SIGKILL");
    } catch {
      // Already exited.
    }
  }
  fs.rmSync(scratch, { recursive: true, force: true });
});

function makeTarget(name: string): string {
  const target = path.join(scratch, name);
  fs.mkdirSync(target, { mode: 0o700 });
  return target;
}

/** Start a decoy whose argv carries exactly the tokens the verifier reads. */
function startDecoy(target: string, env: Record<string, string> = {}): Decoy {
  const readyFile = path.join(scratch, `ready-${decoySeq++}.txt`);
  const decoy = Bun.spawn(
    [
      process.execPath,
      "run",
      path.join(scratch, "decoy.ts"),
      "role",
      "coder",
      "--target-dir",
      target,
    ],
    {
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env, DECOY_READY_FILE: readyFile, ...env },
    },
  );
  decoys.push(decoy);
  return { process: decoy, readyFile };
}

async function waitFor(what: string, condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}

/**
 * Wait until the decoy is really up: its SIGTERM handler is installed (the
 * ready file is written after `process.on`) and its procfs identity exists
 * and is not a zombie. Waiting on procfs alone would race the handler: a
 * SIGTERM delivered during bun's bootstrap would test the default
 * disposition, not the run-shaped victim the verifier is meant to face.
 */
async function waitUntilUp(decoy: Decoy): Promise<void> {
  await waitFor(`decoy ${decoy.process.pid} to install its handler`, () =>
    fs.existsSync(decoy.readyFile),
  );
  await waitFor(`decoy pid ${decoy.process.pid} to come up`, () => {
    const stat = readProcessStat(decoy.process.pid);
    return stat !== undefined && stat.state !== "Z";
  });
}

/** The identity a live run records about itself: pid, start time, group. */
function identityOf(pid: number): { pid: number; startTime: string; groupId: number } {
  const stat = readProcessStat(pid);
  if (stat === undefined) throw new Error(`decoy pid ${pid} has no procfs identity`);
  return { pid, startTime: stat.startTime, groupId: Number(stat.groupId) };
}

/** Write the standalone record family `runs stop` finds, through the store. */
function writeRunRecord(target: string, runId: string, value: Record<string, unknown>): void {
  const store = new ProjectStore(target);
  store.writeVersionedJson(path.join(store.layout.runs, `standalone-${runId}.json`), value);
}

function witnessPath(target: string, runId: string): string {
  return path.join(target, ".ad-coder", "runs", `stop-${runId}.json`);
}

/** Drive the real CLI as a child process. */
function runStop(args: string[]): { exitCode: number | null; stdout: string; stderr: string } {
  const result = Bun.spawnSync([process.execPath, "run", CLI, "runs", "stop", ...args]);
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function runInspect(args: string[]): { exitCode: number | null; stdout: string; stderr: string } {
  const result = Bun.spawnSync([process.execPath, "run", CLI, "runs", "inspect", ...args]);
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function assertAlive(pid: number): void {
  const stat = readProcessStat(pid);
  // Not a zombie either: a reaped-but-unharvested process is gone as far as
  // its run is concerned, and "refused but dead" is the defect.
  expect(stat?.state).not.toBe("Z");
  expect(processIsAlive(pid)).toBe(true);
}

test("a record whose pid belongs to another target's run is refused with exit 3, and that process stays alive", async () => {
  const laneA = makeTarget("lane-a");
  const laneB = makeTarget("lane-b");
  const decoy = startDecoy(laneA);
  await waitUntilUp(decoy);
  // The record lives under lane B but names a process started for lane A --
  // the cross-lane shape the 2026-09-20 incident turned into a kill.
  const runId = `cross-target-${crypto.randomUUID()}`;
  writeRunRecord(laneB, runId, {
    schemaVersion: 2,
    runId,
    role: "coder",
    status: "running",
    process: identityOf(decoy.process.pid),
  });

  const result = runStop([runId, "--target-dir", laneB]);

  expect(result.exitCode).toBe(3);
  expect(result.stderr).toContain("does not carry the target directory");
  expect(result.stderr).toContain("nothing was signalled");
  // The heart of the refusal rule: a refusal that killed something anyway is
  // the defect, so liveness is asserted, not assumed.
  assertAlive(decoy.process.pid);
  // And the command wrote nothing that reads as a signal: no stop-request
  // witness exists for a stop that never happened.
  expect(fs.existsSync(witnessPath(laneB, runId))).toBe(false);
});

test("a dead pid is already gone: exit 1, nothing signalled, no crash", async () => {
  const target = makeTarget("dead-pid");
  // A process the test starts and lets exit, whose identity was read while it
  // was alive, so the record is truthful about everything except its liveness.
  const doomed = startDecoy(target, { DECOY_SLEEP_MS: "150" });
  await waitUntilUp(doomed);
  const identity = identityOf(doomed.process.pid);
  await doomed.process.exited;
  const runId = `dead-${crypto.randomUUID()}`;
  writeRunRecord(target, runId, {
    schemaVersion: 2,
    runId,
    role: "coder",
    status: "running",
    process: identity,
  });

  const result = runStop([runId, "--target-dir", target]);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("already gone");
  expect(result.stderr).toContain("nothing was signalled");
});

test("runs inspect exposes a SIGKILLed standalone owner without claiming a provider failure", async () => {
  const target = makeTarget("owner-lost-inspect");
  const doomed = startDecoy(target);
  await waitUntilUp(doomed);
  const identity = identityOf(doomed.process.pid);
  doomed.process.kill("SIGKILL");
  await doomed.process.exited;
  const runId = `owner-lost-${crypto.randomUUID()}`;
  writeRunRecord(target, runId, {
    schemaVersion: 2,
    runId,
    role: "coder",
    status: "running",
    process: identity,
  });

  expect(inspectStandaloneRun(target, runId)).toMatchObject({
    status: "owner_lost",
    pid: identity.pid,
    reason: "pid_not_alive",
  });
  const result = runInspect([runId, "--target-dir", target, "--json"]);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    status: "owner_lost",
    runId,
    pid: identity.pid,
    reason: "pid_not_alive",
  });
  expect(result.stdout).not.toContain("provider");
  expect(result.stderr).toBe("");
});

test("a record with no process identity is refused with exit 3", () => {
  const target = makeTarget("no-pid");
  const runId = `no-pid-${crypto.randomUUID()}`;
  writeRunRecord(target, runId, { schemaVersion: 2, runId, role: "coder", status: "running" });

  const result = runStop([runId, "--target-dir", target]);

  expect(result.exitCode).toBe(3);
  expect(result.stderr).toContain("carries no process identity");
  expect(result.stderr).toContain("nothing was signalled");
});

test("a recorded start time the live pid does not match is refused as pid reuse", async () => {
  const target = makeTarget("pid-reuse");
  const decoy = startDecoy(target);
  await waitUntilUp(decoy);
  const identity = identityOf(decoy.process.pid);
  // The pid is the decoy's and alive; only the start time is wrong -- exactly
  // what a reused pid looks like to a record left behind by its predecessor.
  const runId = `reuse-${crypto.randomUUID()}`;
  writeRunRecord(target, runId, {
    schemaVersion: 2,
    runId,
    role: "coder",
    status: "running",
    process: { pid: identity.pid, startTime: "1", groupId: identity.groupId },
  });

  const result = runStop([runId, "--target-dir", target]);

  expect(result.exitCode).toBe(3);
  expect(result.stderr).toContain("the pid was reused");
  expect(result.stderr).toContain("nothing was signalled");
  assertAlive(decoy.process.pid);
});

test("a target directory that is a prefix of the real one is refused: argv tokens are exact", async () => {
  const prefix = makeTarget("near");
  const real = makeTarget("near-miss");
  // The exact-token hazard, stated: the strings share a prefix, and a stop
  // keyed on a path CONTAINS or STARTS-WITH match would signal across it.
  expect(real.startsWith(prefix)).toBe(true);
  const decoy = startDecoy(real);
  await waitUntilUp(decoy);
  // The record sits under the PREFIX target and is otherwise fully truthful
  // about the process: alive, right start time, right role witness.
  const runId = `near-miss-${crypto.randomUUID()}`;
  writeRunRecord(prefix, runId, {
    schemaVersion: 2,
    runId,
    role: "coder",
    status: "running",
    process: identityOf(decoy.process.pid),
  });

  const result = runStop([runId, "--target-dir", prefix]);

  expect(result.exitCode).toBe(3);
  expect(result.stderr).toContain("does not carry the target directory");
  expect(result.stderr).toContain("nothing was signalled");
  assertAlive(decoy.process.pid);
});

test("a corrupt run record is a refusal, not a crash (issue #479)", () => {
  const target = makeTarget("corrupt");
  const store = new ProjectStore(target);
  const runId = `corrupt-${crypto.randomUUID()}`;
  // Corrupt the bytes behind the store's back, as a torn or hand-mangled
  // record would be.
  fs.writeFileSync(path.join(store.layout.runs, `standalone-${runId}.json`), "{corrupted");

  const result = runStop([runId, "--target-dir", target]);

  // A record that cannot be read cannot be tied to anything: exit 3 with the
  // checks named -- never a raw parse error crashing out of the command.
  expect(result.exitCode).toBe(3);
  expect(result.stderr).toContain("could not be read");
  expect(result.stderr).toContain("nothing was signalled");
});

test("a verified stop delivers SIGTERM to exactly the recorded pid", async () => {
  const target = makeTarget("verified");
  const marker = path.join(scratch, "terminated.marker");
  const decoy = startDecoy(target, { DECOY_TERM_MARKER: marker });
  await waitUntilUp(decoy);
  const runId = `verified-${crypto.randomUUID()}`;
  writeRunRecord(target, runId, {
    schemaVersion: 2,
    runId,
    role: "coder",
    status: "running",
    process: identityOf(decoy.process.pid),
  });

  const result = runStop([runId, "--target-dir", target, "--json"]);

  expect(result.exitCode).toBe(0);
  const parsed = JSON.parse(result.stdout) as {
    status: string;
    runId: string;
    pid: number;
    signal: string;
    kind: string;
  };
  expect(parsed).toMatchObject({
    status: "signalled",
    runId,
    pid: decoy.process.pid,
    signal: "SIGTERM",
    kind: "standalone role run",
  });
  // The signal reached THE process: the decoy's own SIGTERM handler wrote the
  // marker, so this is delivery to the verified pid, not inference from a
  // dead pid.
  await waitFor("the SIGTERM marker", () => fs.existsSync(marker));
  expect(fs.readFileSync(marker, "utf8")).toBe("SIGTERM");
  await waitFor("the decoy to be reaped", () => !processIsAlive(decoy.process.pid));
  // The witness was on disk BEFORE the signal. This victim died without
  // recording anything, so the request legitimately remains: the only witness
  // that a stop was asked (an unconfirmed death is never cleaned up as if
  // confirmed).
  expect(fs.existsSync(witnessPath(target, runId))).toBe(true);
});

test("no record for the id is exit 3 and leaves the project untouched", () => {
  const target = makeTarget("unknown-id");
  const result = runStop([`nosuchrunid`, "--target-dir", target, "--json"]);
  expect(result.exitCode).toBe(3);
  expect(result.stdout).toBe("");
  const refusal = JSON.parse(result.stderr) as {
    error: {
      code: string;
      detail: string;
      checked: { targetDir: string; runsDir: string; names: string[] };
    };
  };
  expect(refusal.error.code).toBe("run_not_found");
  expect(refusal.error.detail).toContain("checked directories/names");
  expect(refusal.error.checked).toEqual({
    targetDir: target,
    runsDir: path.join(target, ".ad-coder", "runs"),
    names: [
      path.join(target, ".ad-coder", "runs", "standalone-nosuchrunid.json"),
      path.join(target, ".ad-coder", "runs", "background", "nosuchrunid.json"),
    ],
  });
  // A stop against a mistyped id must not create a store in the target or
  // write a stop witness: no process was identified, so nothing was signalled.
  expect(fs.existsSync(path.join(target, ".ad-coder"))).toBe(false);
});
