import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  formatStageCloseoutNotice,
  formatStandaloneResumeInstruction,
  runReviewWithSubmissionRetry,
  runRoleStandalone,
  standaloneSystemPrompt,
} from "../src/cli";
import { MemoryLedgerSink } from "../src/ledger/ledger";
import { PLANNER_SUBMISSION_RESTART, plannerRetryTask } from "../src/orchestration/plan";
import {
  inspectStandaloneRun,
  type RunProcessIdentity,
  stopRequestPath,
  writeRunStopRequest,
} from "../src/orchestration/run-stop";
import { StageLimitError } from "../src/orchestration/stage-limits";
import {
  buildSubmitVerdictTool,
  REVIEW_SUBMISSION_RESTART,
  REVIEW_SUBMISSION_RETRY,
  reviewRetryTask,
} from "../src/orchestration/verdict";
import { ProjectStore } from "../src/project-store/project-store";
import { ProjectStoreError } from "../src/project-store/types";
import type { Role } from "../src/role";
import { defineRole } from "../src/role";
import { ProviderUnavailableError, RunInterruptedError } from "../src/runner/errors";

const CONTEXT_WINDOW = 200_000;
const BUDGET = { maxTokens: 100_000, reserveTokens: 10_000, keepRecentTokens: 20_000 } as const;

let targetDir: string;

beforeAll(() => {
  targetDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-cli-role-")));
});

afterAll(() => {
  fs.rmSync(targetDir, { recursive: true, force: true });
});

/** A faux-backed reviewer: no network, no key, one queued assistant message. */
function fixture() {
  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "faux-1", contextWindow: CONTEXT_WINDOW }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel() as Model<Api>;
  const role: Role = defineRole(
    {
      name: "reviewer",
      provider: "faux",
      modelId: model.id,
      systemPrompt: "You review.",
      activeToolNames: ["read", "bash"],
      cacheRetention: "none",
      contextBudget: { ...BUDGET },
    },
    model,
  );
  return { faux, models, model, role };
}

function processStartTime(pid: number): string {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  const startTime = stat
    .slice(stat.lastIndexOf(")") + 2)
    .trim()
    .split(" ")[19];
  if (startTime === undefined) throw new Error("missing process start time");
  return startTime;
}

test("runRoleStandalone drives one faux turn and returns the assistant text plus a numeric cost", async () => {
  const { faux, models, model, role } = fixture();
  faux.setResponses([fauxAssistantMessage("looks good to me")]);
  const ledgerSink = new MemoryLedgerSink();
  const runId = `durable-result-${crypto.randomUUID()}`;

  const { text, cost } = await runRoleStandalone({
    role,
    model,
    models,
    targetDir,
    task: "review the change",
    runId,
    ledgerSink,
  });

  expect(text).toContain("looks good to me");
  expect(typeof cost).toBe("number");
  expect(cost).toBeGreaterThanOrEqual(0);
  const durable = JSON.parse(
    fs.readFileSync(path.join(targetDir, ".ad-coder", "runs", `standalone-${runId}.json`), "utf8"),
  ).value;
  expect(durable).toMatchObject({
    status: "complete",
    result: { text: expect.stringContaining("looks good to me"), cost },
  });
  // The standalone owner supplied the session to `runRole`, so it also must
  // release that facade before it reopens the session to extract the result.
  // A retained lease made a completed live role fail its own result-read and
  // stranded the next `--resume-run` behind "managed state is locked".
  expect(fs.existsSync(path.join(targetDir, ".ad-coder", "tmp", `session-${runId}.lease`))).toBe(
    false,
  );
  // The ledger recorded the turn, and the cost is summed from it.
  expect(ledgerSink.records().length).toBeGreaterThan(0);
});

test("standalone closeout merges a checkpoint advanced while its model turn is in flight", async () => {
  const { faux, models, model, role } = fixture();
  const runId = `checkpoint-race-${crypto.randomUUID()}`;
  const store = new ProjectStore(targetDir);
  const checkpointPath = path.join(store.layout.runs, `standalone-${runId}.json`);
  // A progress observer writes the checkpoint before the provider dispatch.
  // Simulate a second, durable observer completing while that dispatch is in
  // flight. Before this regression fix, the normal closeout then tried to
  // write its stale version and stranded the run as `running`.
  faux.setResponses([
    () => {
      const current = store.readVersionedJson<Record<string, unknown>>(checkpointPath);
      store.writeVersionedJson(checkpointPath, current.value, current.version);
      return fauxAssistantMessage("durably settled");
    },
  ]);

  const result = await runRoleStandalone({
    role,
    model,
    models,
    targetDir,
    task: "review the raced checkpoint",
    runId,
  });

  expect(result.text).toContain("durably settled");
  expect(store.readVersionedJson<{ status: string }>(checkpointPath).value.status).toBe("complete");
});

test("standalone roles enforce the same stage budgets as pipeline roles", async () => {
  const { faux, models, model, role } = fixture();
  // `fauxAssistantMessage` shares ONE module-global usage object across the
  // process; split it before mutating so this file cannot rewire the default
  // usage other files' faux messages see.
  const response = {
    ...fauxAssistantMessage("too expensive"),
    usage: { ...fauxAssistantMessage("too expensive").usage },
  };
  response.usage.input = 2;
  faux.setResponses([response]);
  await expect(
    runRoleStandalone({
      role,
      model,
      models,
      targetDir,
      task: "review the change",
      ledgerSink: new MemoryLedgerSink(),
      stageLimits: { maxInputTokens: 1 },
    }),
  ).rejects.toBeInstanceOf(StageLimitError);
});

test("an interrupted standalone role persists a resumable pause and releases its session", async () => {
  const { faux, models, model, role } = fixture();
  const runId = `interrupted-${crypto.randomUUID()}`;
  const task = "review the interrupted change";
  const abortController = new AbortController();
  abortController.abort();

  await expect(
    runRoleStandalone({
      role,
      model,
      models,
      targetDir,
      task,
      runId,
      abortSignal: abortController.signal,
    }),
  ).rejects.toBeInstanceOf(RunInterruptedError);

  const store = new ProjectStore(targetDir);
  const checkpointPath = path.join(store.layout.runs, `standalone-${runId}.json`);
  expect(
    store.readVersionedJson<{ status: string; pause?: { code: string } }>(checkpointPath).value,
  ).toMatchObject({
    status: "paused",
    pause: { code: "interrupted" },
  });

  faux.setResponses([fauxAssistantMessage("resumed after interruption")]);
  const resumed = await runRoleStandalone({
    role,
    model,
    models,
    targetDir,
    task,
    runId,
    resumeExisting: true,
  });
  expect(resumed.text).toContain("resumed after interruption");
  expect(store.readVersionedJson<{ status: string }>(checkpointPath).value.status).toBe("complete");
});

test("resume reclaims a new-format session lease left by a dead standalone worker", async () => {
  const { faux, models, model, role } = fixture();
  const runId = `dead-worker-${crypto.randomUUID()}`;
  const task = "review after a worker died";
  const abortController = new AbortController();
  abortController.abort();

  await expect(
    runRoleStandalone({
      role,
      model,
      models,
      targetDir,
      task,
      runId,
      abortSignal: abortController.signal,
    }),
  ).rejects.toBeInstanceOf(RunInterruptedError);

  const store = new ProjectStore(targetDir);
  const lease = path.join(store.layout.tmp, `session-${runId}.lease`);
  const worker = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
  const identity = {
    pid: worker.pid,
    startTime: processStartTime(worker.pid),
    token: crypto.randomUUID(),
  };
  fs.writeFileSync(lease, `${JSON.stringify(identity)}\n`, { mode: 0o600 });
  worker.kill();
  await worker.exited;

  faux.setResponses([fauxAssistantMessage("reconnected safely")]);
  const resumed = await runRoleStandalone({
    role,
    model,
    models,
    targetDir,
    task,
    runId,
    resumeExisting: true,
  });

  expect(resumed.text).toContain("reconnected safely");
  expect(fs.existsSync(lease)).toBe(false);
  expect(
    store.readVersionedJson<{ status: string }>(
      path.join(store.layout.runs, `standalone-${runId}.json`),
    ).value.status,
  ).toBe("complete");
});

test("SIGKILLed standalone owner is diagnosed and leaves a recovery witness before resume", async () => {
  const { faux, models, model, role } = fixture();
  const runId = `sigkill-owner-${crypto.randomUUID()}`;
  const task = "resume after a host killed the worker";
  const aborted = new AbortController();
  aborted.abort();
  await expect(
    runRoleStandalone({ role, model, models, targetDir, task, runId, abortSignal: aborted.signal }),
  ).rejects.toBeInstanceOf(RunInterruptedError);

  const ready = path.join(targetDir, `${runId}.ready`);
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `import * as fs from "node:fs";
import { ProjectStore } from ${JSON.stringify(path.join(import.meta.dir, "..", "src", "project-store", "project-store.ts"))};
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
const store = new ProjectStore(process.env.OWNER_LOST_TARGET);
await store.resumeSession(process.env.OWNER_LOST_RUN, BACKGROUND_CONTEXT);
fs.writeFileSync(process.env.OWNER_LOST_READY, "ready");
await Bun.sleep(60_000);`,
    ],
    {
      stdout: "ignore",
      stderr: "ignore",
      env: {
        ...process.env,
        OWNER_LOST_TARGET: targetDir,
        OWNER_LOST_RUN: runId,
        OWNER_LOST_READY: ready,
      },
    },
  );
  try {
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(ready)) {
      if (Date.now() > deadline)
        throw new Error("timed out waiting for child to hold the session lease");
      await Bun.sleep(25);
    }
    const store = new ProjectStore(targetDir);
    const checkpointPath = path.join(store.layout.runs, `standalone-${runId}.json`);
    const checkpoint = store.readVersionedJson<Record<string, unknown>>(checkpointPath);
    const identity = {
      pid: child.pid,
      startTime: processStartTime(child.pid),
      groupId: child.pid,
    };
    store.writeVersionedJson(
      checkpointPath,
      { ...checkpoint.value, status: "running", process: identity },
      checkpoint.version,
    );
    child.kill("SIGKILL");
    await child.exited;

    expect(inspectStandaloneRun(targetDir, runId)).toMatchObject({
      status: "owner_lost",
      reason: "pid_not_alive",
      pid: child.pid,
    });
    faux.setResponses([fauxAssistantMessage("recovered after SIGKILL")]);
    await expect(
      runRoleStandalone({ role, model, models, targetDir, task, runId, resumeExisting: true }),
    ).resolves.toMatchObject({ text: expect.stringContaining("recovered after SIGKILL") });
    expect(
      store.readVersionedJson<{ lastRecovery?: Record<string, unknown> }>(checkpointPath).value,
    ).toMatchObject({
      lastRecovery: {
        code: "owner_lost",
        reason: "pid_not_alive",
        previousProcess: identity,
      },
    });
    expect(inspectStandaloneRun(targetDir, runId)).toMatchObject({
      status: "recorded",
      lastRecovery: { code: "owner_lost", previousPid: child.pid },
    });
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // The expected path already reaped it.
    }
  }
});

test("a competing resume leaves the paused checkpoint owned by the original run", async () => {
  const { models, model, role } = fixture();
  const runId = `live-owner-${crypto.randomUUID()}`;
  const task = "review after a competing resume";
  const abortController = new AbortController();
  abortController.abort();

  await expect(
    runRoleStandalone({
      role,
      model,
      models,
      targetDir,
      task,
      runId,
      abortSignal: abortController.signal,
    }),
  ).rejects.toBeInstanceOf(RunInterruptedError);

  const store = new ProjectStore(targetDir);
  const checkpointPath = path.join(store.layout.runs, `standalone-${runId}.json`);
  const before = store.readVersionedJson<{
    status: string;
    process?: RunProcessIdentity;
    pause?: { code: string };
  }>(checkpointPath).value;
  // Model the first launcher still draining after its external stop.  The
  // second CLI invocation must not claim its checkpoint merely because it was
  // asked to resume; the managed session lease is the ownership boundary.
  const original = await store.resumeSession(runId);
  try {
    await expect(
      runRoleStandalone({
        role,
        model,
        models,
        targetDir,
        task,
        runId,
        resumeExisting: true,
      }),
    ).rejects.toMatchObject({ code: "version_conflict" });
  } finally {
    await original.close(BACKGROUND_CONTEXT);
  }

  expect(store.readVersionedJson<typeof before>(checkpointPath).value).toEqual(before);
});

test("a statusless provider failure settles its standalone run with safe recovery evidence", async () => {
  const { faux, models, model, role } = fixture();
  const runId = `empty-turn-${crypto.randomUUID()}`;
  // This is the real failure shape from a provider adapter: the thrown source
  // becomes a settled `assistant_error` with no provider status or code. The
  // standalone owner must close its durable record before it lets that error
  // cross the CLI boundary.
  faux.setResponses([
    () => {
      throw new Error("provider failed without a response");
    },
  ]);

  await expect(
    runRoleStandalone({
      role,
      model,
      models,
      targetDir,
      task: "review the change",
      runId,
    }),
  ).rejects.toBeInstanceOf(ProviderUnavailableError);

  const store = new ProjectStore(targetDir);
  const checkpointPath = path.join(store.layout.runs, `standalone-${runId}.json`);
  expect(
    store.readVersionedJson<{
      status: string;
      failure?: { code: string; message: string };
    }>(checkpointPath).value,
  ).toMatchObject({
    status: "failed",
    failure: {
      code: "provider_unavailable",
      message: expect.stringContaining("without a usable answer or HTTP status"),
    },
  });
});

test("a started standalone run records its own process identity in the checkpoint", async () => {
  const { faux, models, model, role } = fixture();
  faux.setResponses([fauxAssistantMessage("done")]);
  const runId = `process-identity-${crypto.randomUUID()}`;

  await runRoleStandalone({
    role,
    model,
    models,
    targetDir,
    task: "review the change",
    runId,
  });

  const store = new ProjectStore(targetDir);
  const checkpointPath = path.join(store.layout.runs, `standalone-${runId}.json`);
  const identity = store.readVersionedJson<{ process?: RunProcessIdentity }>(checkpointPath).value
    .process;
  // Issue #479: the run's own start writes the pid, the /proc start time that
  // pins it against reuse, and the process group. The pid is THIS process's
  // because runRoleStandalone records itself, wherever it runs.
  expect(identity?.pid).toBe(process.pid);
  expect(typeof identity?.startTime).toBe("string");
  expect(typeof identity?.groupId).toBe("number");
});

test("resuming a standalone run re-records the identity of the process that resumed", async () => {
  const { faux, models, model, role } = fixture();
  const runId = `resume-identity-${crypto.randomUUID()}`;
  const task = "review the change";
  const abortController = new AbortController();
  abortController.abort();
  await expect(
    runRoleStandalone({
      role,
      model,
      models,
      targetDir,
      task,
      runId,
      abortSignal: abortController.signal,
    }),
  ).rejects.toBeInstanceOf(RunInterruptedError);

  const store = new ProjectStore(targetDir);
  const checkpointPath = path.join(store.layout.runs, `standalone-${runId}.json`);
  // Stand in for the dead predecessor's identity: a resume must OVERWRITE it
  // with its own pid, or `runs stop` would aim at a pid that no longer runs.
  const stale = store.readVersionedJson<{ process?: RunProcessIdentity }>(checkpointPath);
  store.writeVersionedJson(
    checkpointPath,
    { ...stale.value, process: { pid: 999_999_999, startTime: "1", groupId: 999_999_999 } },
    stale.version,
  );

  faux.setResponses([fauxAssistantMessage("took over")]);
  await runRoleStandalone({
    role,
    model,
    models,
    targetDir,
    task,
    runId,
    resumeExisting: true,
  });
  expect(
    store.readVersionedJson<{ process?: RunProcessIdentity }>(checkpointPath).value.process?.pid,
  ).toBe(process.pid);
});

test("resume recovers running standalone checkpoints whose owner is absent, dead, or mismatched", async () => {
  const cases: Array<[string, RunProcessIdentity | undefined]> = [
    ["absent", undefined],
    ["dead", { pid: 999_999_999, startTime: "1", groupId: 999_999_999 }],
    // A reused pid is not this run. The start-time witness makes that a
    // positive mismatch rather than a risky guess based on pid alone.
    ["mismatched", { pid: process.pid, startTime: "0", groupId: process.pid }],
    // Even an otherwise current process is not this role unless its argv
    // carries the exact target and `role <name>` witness pair.
    ["argv", { pid: process.pid, startTime: processStartTime(process.pid), groupId: process.pid }],
  ];
  for (const [kind, processIdentity] of cases) {
    const { faux, models, model, role } = fixture();
    const runId = `orphaned-running-${kind}-${crypto.randomUUID()}`;
    const task = "recover the orphaned role";
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      runRoleStandalone({
        role,
        model,
        models,
        targetDir,
        task,
        runId,
        abortSignal: aborted.signal,
      }),
    ).rejects.toBeInstanceOf(RunInterruptedError);

    const store = new ProjectStore(targetDir);
    const checkpointPath = path.join(store.layout.runs, `standalone-${runId}.json`);
    const stale = store.readVersionedJson<Record<string, unknown>>(checkpointPath);
    const { pause: _pause, process: _process, ...running } = stale.value;
    store.writeVersionedJson(
      checkpointPath,
      {
        ...running,
        status: "running",
        ...(processIdentity === undefined ? {} : { process: processIdentity }),
      },
      stale.version,
    );

    faux.setResponses([fauxAssistantMessage(`recovered ${kind}`)]);
    await expect(
      runRoleStandalone({ role, model, models, targetDir, task, runId, resumeExisting: true }),
    ).resolves.toMatchObject({ text: expect.stringContaining(`recovered ${kind}`) });
    expect(store.readVersionedJson<{ status: string }>(checkpointPath).value.status).toBe(
      "complete",
    );
  }
});

test("an external stop's pause names the signal and the stop request, and consumes the witness", async () => {
  const { models, model, role } = fixture();
  const runId = `stop-requested-${crypto.randomUUID()}`;
  const abortController = new AbortController();
  abortController.abort();

  // The stopper writes the witness BEFORE it signals (issue #479); here the
  // write precedes the run entirely, the same fact the stop path guarantees.
  const store = new ProjectStore(targetDir);
  const request = writeRunStopRequest(store, runId, "SIGTERM");

  await expect(
    runRoleStandalone({
      role,
      model,
      models,
      targetDir,
      task: "review the change",
      runId,
      abortSignal: abortController.signal,
      interruptSignal: () => "SIGTERM",
    }),
  ).rejects.toBeInstanceOf(RunInterruptedError);

  const checkpoint = store.readVersionedJson<{
    status: string;
    pause?: {
      code: string;
      signal?: string;
      stopRequest?: { requestedAt: number; requesterPid: number };
    };
  }>(path.join(store.layout.runs, `standalone-${runId}.json`)).value;
  expect(checkpoint.status).toBe("paused");
  expect(checkpoint.pause).toMatchObject({
    code: "interrupted",
    signal: "SIGTERM",
    stopRequest: { requestedAt: request.requestedAt, requesterPid: request.requesterPid },
  });
  // The witness is consumed by the pause that recorded it: a stale request
  // must not brand a later unrelated interruption of the same runId.
  expect(fs.existsSync(stopRequestPath(store, runId))).toBe(false);
});

test("an interruption without a stop request records the signal alone", async () => {
  const { models, model, role } = fixture();
  const runId = `signal-only-${crypto.randomUUID()}`;
  const abortController = new AbortController();
  abortController.abort();

  await expect(
    runRoleStandalone({
      role,
      model,
      models,
      targetDir,
      task: "review the change",
      runId,
      abortSignal: abortController.signal,
      interruptSignal: () => "SIGINT",
    }),
  ).rejects.toBeInstanceOf(RunInterruptedError);

  const checkpoint = store_read(targetDir, runId);
  expect(checkpoint.status).toBe("paused");
  expect(checkpoint.pause).toEqual({ code: "interrupted", signal: "SIGINT" });
});

/** A paused checkpoint's pause, read through the store. */
function store_read(
  target: string,
  runId: string,
): {
  status: string;
  pause?: Record<string, unknown>;
} {
  const store = new ProjectStore(target);
  return store.readVersionedJson<{
    status: string;
    pause?: Record<string, unknown>;
  }>(path.join(store.layout.runs, `standalone-${runId}.json`)).value;
}

test("a stage-limit pause carries neither a signal nor a stop request", async () => {
  const { faux, models, model, role } = fixture();
  const response = {
    ...fauxAssistantMessage("too expensive"),
    usage: { ...fauxAssistantMessage("too expensive").usage },
  };
  response.usage.input = 2;
  faux.setResponses([response]);
  const runId = `stage-limit-pause-${crypto.randomUUID()}`;

  await expect(
    runRoleStandalone({
      role,
      model,
      models,
      targetDir,
      task: "review the change",
      runId,
      ledgerSink: new MemoryLedgerSink(),
      stageLimits: { maxInputTokens: 1 },
    }),
  ).rejects.toBeInstanceOf(StageLimitError);

  const checkpoint = store_read(targetDir, runId);
  expect(checkpoint.status).toBe("paused");
  // The distinct fact (issue #479): a limit pause is nobody's signal and no
  // stop asked for it -- exactly what "killed" and "fell over" must not
  // collapse into.
  expect(checkpoint.pause).toMatchObject({ code: "stage_limit" });
  expect(checkpoint.pause).not.toHaveProperty("signal");
  expect(checkpoint.pause).not.toHaveProperty("stopRequest");
});

test("standalone role resumes the same durable run only after its exhausted budget changes", async () => {
  const { faux, models, model, role } = fixture();
  fs.writeFileSync(path.join(targetDir, "resume.txt"), "safe\n");
  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall("read", { path: "resume.txt" }),
      fauxToolCall("read", { path: "resume.txt" }),
    ]),
  ]);
  const runId = `resume-${crypto.randomUUID()}`;
  const task = "review the resumable change";

  await expect(
    runRoleStandalone({
      role,
      model,
      models,
      targetDir,
      task,
      runId,
      stageLimits: { maxToolTurns: 1 },
    }),
  ).rejects.toBeInstanceOf(StageLimitError);

  const store = new ProjectStore(targetDir);
  const checkpointPath = path.join(store.layout.runs, `standalone-${runId}.json`);
  expect(store.readVersionedJson<{ status: string }>(checkpointPath).value.status).toBe("paused");

  await expect(
    runRoleStandalone({
      role,
      model,
      models,
      targetDir,
      task,
      runId,
      resumeExisting: true,
      stageLimits: { maxToolTurns: 1 },
    }),
  ).rejects.toBeInstanceOf(ProjectStoreError);

  await expect(
    runRoleStandalone({
      role,
      model: { ...model, id: "different-model" },
      models,
      targetDir,
      task,
      runId,
      resumeExisting: true,
      stageLimits: { maxToolTurns: 3 },
    }),
  ).rejects.toBeInstanceOf(ProjectStoreError);

  await expect(
    runRoleStandalone({
      role,
      model,
      models: createModels(),
      targetDir,
      task,
      runId,
      resumeExisting: true,
      stageLimits: { maxToolTurns: 3 },
    }),
  ).rejects.toThrow();
  expect(
    store.readVersionedJson<{
      status: string;
      cumulativeUsage: { toolTurns: number };
    }>(checkpointPath).value,
  ).toMatchObject({ status: "failed", cumulativeUsage: { toolTurns: 1 } });

  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall("read", { path: "resume.txt" }),
      fauxToolCall("read", { path: "resume.txt" }),
    ]),
  ]);
  await expect(
    runRoleStandalone({
      role,
      model,
      models,
      targetDir,
      task,
      runId,
      resumeExisting: true,
      stageLimits: { maxToolTurns: 2 },
    }),
  ).rejects.toBeInstanceOf(StageLimitError);
  expect(
    store.readVersionedJson<{ cumulativeUsage: { toolTurns: number } }>(checkpointPath).value
      .cumulativeUsage.toolTurns,
  ).toBe(2);

  faux.setResponses([fauxAssistantMessage("completed review")]);
  const resumed = await runRoleStandalone({
    role,
    model,
    models,
    targetDir,
    task,
    runId,
    resumeExisting: true,
    stageLimits: { maxToolTurns: 4 },
  });

  expect(resumed.text).toContain("completed review");
  expect(store.readVersionedJson<{ status: string }>(checkpointPath).value.status).toBe("complete");
  expect(resumed.ledgerPath).toBe(path.join(store.layout.ledger, `${runId}.jsonl`));
});

test("legacy standalone checkpoint restores conservative input prediction", async () => {
  const { faux, models, model, role } = fixture();
  fs.writeFileSync(path.join(targetDir, "legacy-resume.txt"), "safe\n");
  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall("read", { path: "legacy-resume.txt" }),
      fauxToolCall("read", { path: "legacy-resume.txt" }),
    ]),
  ]);
  const runId = `legacy-resume-${crypto.randomUUID()}`;
  const task = "review legacy resume";

  await expect(
    runRoleStandalone({
      role,
      model,
      models,
      targetDir,
      task,
      runId,
      stageLimits: { maxToolTurns: 1 },
    }),
  ).rejects.toBeInstanceOf(StageLimitError);

  const store = new ProjectStore(targetDir);
  const checkpointPath = path.join(store.layout.runs, `standalone-${runId}.json`);
  const legacy = store.readVersionedJson<Record<string, unknown>>(checkpointPath);
  const cumulativeUsage: Record<string, unknown> = {
    ...(legacy.value.cumulativeUsage as Record<string, unknown>),
    inputTokens: 100,
  };
  delete cumulativeUsage.lastInputTokens;
  store.writeVersionedJson(checkpointPath, { ...legacy.value, cumulativeUsage }, legacy.version);

  let resumedTools: number | undefined;
  faux.setResponses([
    (context) => {
      resumedTools = context.tools?.length ?? 0;
      return fauxAssistantMessage("legacy resume completed");
    },
  ]);
  const resumed = await runRoleStandalone({
    role,
    model,
    models,
    targetDir,
    task,
    runId,
    resumeExisting: true,
    stageLimits: {
      maxToolTurns: 4,
      maxInputTokens: 300,
      finalResponseReserveInputTokens: 100,
    },
  });

  expect(resumed.text).toContain("legacy resume completed");
  expect(resumedTools).toBe(0);
  expect(
    store.readVersionedJson<{ cumulativeUsage: { lastInputTokens: number } }>(checkpointPath).value
      .cumulativeUsage.lastInputTokens,
  ).toBeGreaterThan(0);
});

test("standalone roles persist usage and emit semantic tool activity by default", async () => {
  const { faux, models, model, role } = fixture();
  fs.writeFileSync(path.join(targetDir, "observed.txt"), "hello\n");
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("read", { path: "observed.txt" })),
    fauxAssistantMessage("reviewed"),
  ]);
  const activity: string[] = [];

  const result = await runRoleStandalone({
    role,
    model,
    models,
    targetDir,
    task: "review the change",
    runId: "standalone-observed",
    activityConsumer: (record) => {
      if (record.type === "tool_activity") activity.push(`${record.activity}:${record.lifecycle}`);
    },
  });

  expect(result.ledgerPath).toBe(
    path.join(targetDir, ".ad-coder", "ledger", "standalone-observed.jsonl"),
  );
  expect(fs.existsSync(result.ledgerPath as string)).toBe(true);
  expect(result.observations.input).toBeGreaterThanOrEqual(0);
  expect(activity).toContain("Read:requested");
  expect(activity).toContain("Read:completed");
});

test("standalone prompt overrides a role rule that reserves the result for a submit tool", () => {
  // The Planner ends its prompt this way, and it is not decoration: without an
  // override that names the rule, a standalone Planner is told both to withhold
  // the plan from assistant text and to return it there. It then obeys whichever
  // instruction it weighs higher, which is not a thing a bench can score.
  const planner =
    "Do not emit the plan or a JSON copy in assistant text: `submit_plan` is the sole canonical handoff.";
  const amended = standaloneSystemPrompt(planner);
  expect(amended.startsWith(`${planner}\n\n`)).toBe(true);
  expect(amended).toContain("does not apply to this run");
  expect(amended).toContain("withhold the result from assistant text");
  // A task that asks for a specific shape must still win, or every
  // artifact-scored role task would be fighting this paragraph instead.
  expect(amended).toContain("that format governs");
});

test("the standalone override keeps a registered submission tool instead of denying it", () => {
  // The reviewer's prompt tells it to submit through `submit_verdict`, and the
  // standalone path now registers that tool (issue #283). Telling the model the
  // tool is absent while handing it the tool is the same contradiction the
  // planner override exists to prevent, pointed the other way -- and a reviewer
  // that believes it cannot submit answers in prose, which no stamp can be
  // derived from.
  const reviewer = "When your review is complete, submit your verdict by calling submit_verdict.";
  const amended = standaloneSystemPrompt(reviewer, "submit_verdict");
  expect(amended.startsWith(`${reviewer}\n\n`)).toBe(true);
  expect(amended).toContain("submit_verdict IS available");
  expect(amended).not.toContain("are NOT available here");
  // The roles whose tool really is absent keep the original override.
  expect(standaloneSystemPrompt(reviewer)).toContain("are NOT available here");
});

test("the standalone review retry keeps the first attempt's review and charges both", async () => {
  // The first attempt holds the review; the retry is asked only to submit
  // (issue #283). Returning the retry alone would drop the findings the
  // operator reads, and charging one attempt would understate what the run cost.
  let submitted = false;
  const tasks: string[] = [];
  const runIds: string[] = [];
  const result = await runReviewWithSubmissionRetry({
    run: async (runId, task) => {
      runIds.push(runId);
      tasks.push(task);
      // Leading and trailing whitespace on purpose: the wiring carries the
      // attempt's text itself, and a `.trim()` at the call site leaves every
      // assertion that only asks "is the review in there" green (measured in
      // review round 5). The exact bytes are asserted below.
      if (runIds.length === 1) return { text: "\n  the review itself  \n", cost: 0.02 };
      submitted = true;
      return { text: "submitted", cost: 0.005 };
    },
    firstRunId: "first",
    task: "review it",
    retries: true,
    submitted: () => submitted,
    newRunId: () => "second",
  });
  expect(result.text).toBe("\n  the review itself  \n\n\nsubmitted");
  expect(result.cost).toBeCloseTo(0.025, 10);
  // A fresh run id per attempt: a turn is keyed by run id in the session store,
  // so re-asking under the first is rejected as an existing session.
  expect(runIds).toEqual(["first", "second"]);
  expect(tasks[1]).toContain("Your review stands; submit it now");
  // And the retry can SEE the review it is told stands (issue #525): a fresh
  // run id means a fresh session, so the prompt's "your review" is only the
  // review the caller carried into the task. Nothing in it names a response
  // this session never made.
  expect(tasks[1]).toContain("the review itself");
  expect(tasks[1]).not.toContain("did not call submit_verdict");
  expect(tasks[1]).not.toContain("Your preceding");
  // The WIRING's bytes, not just "the review is in there": `carried` is the
  // first attempt's text passed straight through, so a `.trim()` at the call
  // site satisfies every assertion above and fails only this one.
  expect(tasks[1]).toContain(`Your review so far, verbatim:\n\n\n  the review itself  \n\n`);
});

test("a retry after a silent first attempt is asked to review, not to submit", async () => {
  // The same wiring on the empty branch: with nothing to carry, the retry task
  // must be the fresh-review requirement -- the standalone path is one of the
  // three surfaces #525 is about, so the branch is asserted where it is wired,
  // not only where the sentence is built.
  let submitted = false;
  const tasks: string[] = [];
  await runReviewWithSubmissionRetry({
    run: async (_runId, task) => {
      tasks.push(task);
      if (tasks.length === 1) return { text: "", cost: 0.01 };
      submitted = true;
      return { text: "submitted", cost: 0.005 };
    },
    firstRunId: "first",
    task: "review it",
    retries: true,
    submitted: () => submitted,
    newRunId: () => "second",
  });
  expect(tasks[1]).toBe(`review it\n\n${REVIEW_SUBMISSION_RESTART}`);
  expect(tasks[1]).not.toContain(REVIEW_SUBMISSION_RETRY);
  // The requirement that reaches the WIRING, not only the constant: the retry
  // opens a fresh run id, so a clause naming the reader's own prior response is
  // a premise it cannot check. Pinned as a forbidden PATTERN as well as through
  // the constant, because a `toBe(\`...${RESTART}\`)` follows the constant
  // wherever its text is reverted to (review of #525, round 4).
  expect(tasks[1]).not.toContain("Your preceding");
  expect(tasks[1]).not.toContain("did not call");
});

test("a retry with nothing carried asks for the review, never for a submission", () => {
  // An attempt that produced no prose leaves no review to hand over. It must
  // NOT be told "your review stands": that is the #525 premise, and told to a
  // fresh session with nothing in it, the retry resolves it by inventing the
  // review. The empty case is where the false sentence used to survive, so the
  // assertion is on the ABSENCE of the submission retry, not only on the
  // presence of a restart prompt.
  const silent = reviewRetryTask("review it", "");
  expect(silent).toBe(`review it\n\n${REVIEW_SUBMISSION_RESTART}`);
  expect(silent).not.toContain(REVIEW_SUBMISSION_RETRY);
  expect(silent).not.toContain("Your review stands");
  // Not merely "a different sentence": every clause naming the reader's own
  // history is forbidden, which is what makes this an assertion about the
  // DEFECT rather than about one wording of the fix (review of #525, round 4).
  expect(silent).not.toContain("Your preceding");
  expect(silent).not.toContain("did not call");
  // Whitespace is not a review either.
  expect(reviewRetryTask("review it", "   \n  ")).toBe(silent);
});

test("a carried review travels exactly as the attempt wrote it", () => {
  // "Verbatim" is the contract (docs/contracts/product-change.md, 2026-09-20),
  // so trimming is allowed to DECIDE the branch and never to edit the payload.
  const prior = "  blocker: exit 1, not 3  \n";
  const carried = reviewRetryTask("review it", prior);
  expect(carried.startsWith("review it\n\nYour review so far, verbatim:\n\n")).toBe(true);
  // The exact bytes, indentation and trailing newline included: nothing between
  // the header and the requirement but what the attempt produced.
  expect(carried).toContain(`\n\nYour review so far, verbatim:\n\n${prior}\n\n`);
  expect(carried.endsWith(REVIEW_SUBMISSION_RETRY)).toBe(true);
  // The non-empty requirement still says the review stands -- which is true
  // HERE, because the review is in the session that reads it.
  expect(carried).toContain("Your review stands");
});

test("a carried plan-so-far travels exactly as the attempt wrote it (#525)", () => {
  // The twin of the review carry above, on the other surface this issue
  // touched: the planner handoff re-asks under a fresh run id too, and its
  // "verbatim" is the same contract (docs/contracts/product-change.md,
  // 2026-09-20). The pipeline test asserts the prose is present -- which a
  // TRIMMED payload also satisfies: measured in review round 5, changing
  // `${priorText}` to `${priorText.trim()}` in `plannerRetryTask` left every
  // planner assertion green. Only the exact bytes catch it.
  const prior = "  step 1: rename the column  \n";
  const carried = plannerRetryTask("plan it", prior);
  expect(carried.startsWith("plan it\n\nYour plan so far, verbatim:\n\n")).toBe(true);
  // Nothing between the header and the requirement but what the attempt wrote,
  // indentation and trailing newline included.
  expect(carried).toContain(`\n\nYour plan so far, verbatim:\n\n${prior}\n\n`);
  expect(carried.endsWith(PLANNER_SUBMISSION_RESTART)).toBe(true);
  // Whitespace is not a plan: trimming still decides WHICH branch is taken --
  // it is only forbidden to edit the payload the branch carries.
  expect(plannerRetryTask("plan it", "   \n  ")).toBe(plannerRetryTask("plan it", ""));
});

test("the standalone review retry does not run when the verdict already arrived", async () => {
  let calls = 0;
  const result = await runReviewWithSubmissionRetry({
    run: async () => {
      calls += 1;
      return { text: "done", cost: 0.01 };
    },
    firstRunId: "only",
    task: "review it",
    retries: true,
    submitted: () => true,
  });
  expect(calls).toBe(1);
  expect(result.cost).toBeCloseTo(0.01, 10);
  // And a role with no verdict tool registered never retries at all.
  let bare = 0;
  await runReviewWithSubmissionRetry({
    run: async () => {
      bare += 1;
      return { text: "prose", cost: 0.01 };
    },
    firstRunId: "only",
    task: "summarise it",
    retries: false,
    submitted: () => false,
  });
  expect(bare).toBe(1);
});

test("every attempt ending in prose still charges every attempt", async () => {
  // The caller reports the missing verdict and writes no stamp; the cost of
  // having asked twice is still the cost of this run.
  let calls = 0;
  const result = await runReviewWithSubmissionRetry({
    run: async () => {
      calls += 1;
      return { text: `attempt ${calls}`, cost: 0.01 };
    },
    firstRunId: "first",
    task: "review it",
    retries: true,
    submitted: () => false,
  });
  expect(calls).toBe(2);
  expect(result.cost).toBeCloseTo(0.02, 10);
  expect(result.text).toBe("attempt 1");
});

test("an unknown role is refused before a start is announced", () => {
  // `withCliProgress` prints "started role X; waiting for provider" the moment it
  // is entered, so validating inside the command produced a success line followed
  // by a failure (issue #306). Anything reading the first line -- a person
  // glancing at output, a log tail, a wrapper script -- saw a run that had begun.
  const result = Bun.spawnSync([
    process.execPath,
    "run",
    path.join(import.meta.dir, "..", "src", "cli.ts"),
    "role",
    "nosuchrole",
    "some task",
    "--target-dir",
    targetDir,
  ]);
  const stderr = result.stderr.toString();
  expect(stderr).toContain("unknown role: nosuchrole");
  expect(stderr).not.toContain("started role");
  // The orchestrator is a configured role with its own prompt and profile row,
  // so it belongs in the accepted set rather than being reachable only through
  // an interactive console.
  expect(stderr).toContain("orchestrator");
});

test("a standalone run that settles inside the closeout reserve relays the fact", async () => {
  const { faux, models, model, role } = fixture();
  fs.writeFileSync(path.join(targetDir, "closeout.txt"), "safe\n");
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("read", { path: "closeout.txt" })),
    fauxAssistantMessage("partial review"),
  ]);
  const runId = `closeout-${crypto.randomUUID()}`;

  const result = await runRoleStandalone({
    role,
    model,
    models,
    targetDir,
    task: "review the closing change",
    runId,
    ledgerSink: new MemoryLedgerSink(),
    stageLimits: { maxToolTurns: 2, finalResponseReserveToolTurns: 1 },
  });

  expect(result.stageCloseout).toEqual({
    code: "stage_closeout",
    reason: "tool_turns",
    detail: expect.any(String),
  });
  expect(result.stageCloseout?.detail.length).toBeGreaterThan(0);
  const durable = JSON.parse(
    fs.readFileSync(path.join(targetDir, ".ad-coder", "runs", `standalone-${runId}.json`), "utf8"),
  ).value;
  expect(durable.status).toBe("paused");
  expect(durable.pause).toMatchObject({
    code: "stage_closeout",
    reason: "tool_turns",
    limit: 2,
    observed: 1,
  });
  expect(durable.result.stageCloseout).toEqual(result.stageCloseout);

  // Closeout has a usable partial answer, but never silently claims that the
  // original task finished. A raised ceiling resumes the same durable session
  // and admits a fresh continuation after the settled closeout turn.
  faux.setResponses([fauxAssistantMessage("completed after the raised limit")]);
  await expect(
    runRoleStandalone({
      role,
      model,
      models,
      targetDir,
      task: "review the closing change",
      runId,
      resumeExisting: true,
      stageLimits: { maxToolTurns: 2, finalResponseReserveToolTurns: 1 },
    }),
  ).rejects.toBeInstanceOf(ProjectStoreError);
  const resumed = await runRoleStandalone({
    role,
    model,
    models,
    targetDir,
    task: "review the closing change",
    runId,
    resumeExisting: true,
    stageLimits: { maxToolTurns: 4, finalResponseReserveToolTurns: 1 },
  });
  expect(resumed.text).toContain("completed after the raised limit");
  expect(store_read(targetDir, runId).status).toBe("complete");
});

test("a submitted standalone verdict survives a post-submit limit and a fresh-process resume", async () => {
  const { faux, models, model, role } = fixture();
  const reviewerRole = defineRole(
    { ...role, activeToolNames: [...(role.activeToolNames ?? []), "submit_verdict"] },
    model,
  );
  const runId = `durable-verdict-${crypto.randomUUID()}`;
  const task = "review the durable verdict";
  const firstCapture = {};
  // The first tool accepts the verdict, then the following tool in the same
  // response reaches the hard stage limit.  This deterministically puts the
  // submission before a failed closeout without depending on a provider race.
  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall("submit_verdict", {
        status: "approved",
        issues: [],
        summary: "checked",
      }),
      fauxToolCall("read", { path: "not-reached.txt" }),
    ]),
  ]);
  const first = await runRoleStandalone({
    role: reviewerRole,
    model,
    models,
    targetDir,
    task,
    runId,
    verdictCapture: firstCapture,
    tools: [buildSubmitVerdictTool(firstCapture, runId)],
    stageLimits: { maxToolTurns: 1 },
  });
  expect(firstCapture).toMatchObject({ verdict: { status: "approved", summary: "checked" } });
  const checkpointPath = path.join(targetDir, ".ad-coder", "runs", `standalone-${runId}.json`);
  expect(JSON.parse(fs.readFileSync(checkpointPath, "utf8")).value).toMatchObject({
    status: "complete",
    verdict: { status: "approved", summary: "checked" },
  });

  // A new capture represents a new CLI process.  It has no queued faux
  // response: resume must hydrate the durable verdict and settle it without a
  // second provider request or submit_verdict call.
  const resumedCapture = {};
  const resumed = await runRoleStandalone({
    role: reviewerRole,
    model,
    models,
    targetDir,
    task,
    runId,
    resumeExisting: true,
    verdictCapture: resumedCapture,
    tools: [buildSubmitVerdictTool(resumedCapture, runId)],
  });
  expect(resumedCapture).toMatchObject({ verdict: { status: "approved", summary: "checked" } });
  expect(resumed.cost).toBe(first.cost);
});

test("a normal standalone run carries no stageCloseout", async () => {
  const { faux, models, model, role } = fixture();
  faux.setResponses([fauxAssistantMessage("clean pass")]);
  const result = await runRoleStandalone({
    role,
    model,
    models,
    targetDir,
    task: "review the clean change",
    runId: `normal-${crypto.randomUUID()}`,
    ledgerSink: new MemoryLedgerSink(),
  });
  expect(result.stageCloseout).toBeUndefined();
});

test("a bounded standalone reviewer pauses for closeout, then resumes without replaying it", async () => {
  const { faux, models, model, role } = fixture();
  const runId = `reviewer-closeout-${crypto.randomUUID()}`;
  const task = "review the bounded diff";
  // The first turn explores. The second enters the model-turn reserve and
  // receives a tool-free closeout request rather than another exploration turn.
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("read", { path: "changed.ts" })),
    fauxAssistantMessage("partial review; closeout requested"),
  ]);
  const first = await runRoleStandalone({
    role,
    model,
    models,
    targetDir,
    task,
    runId,
    stageLimits: { maxModelTurns: 3, finalResponseReserveModelTurns: 2 },
  });
  expect(first.stageCloseout).toMatchObject({ code: "stage_closeout", reason: "model_turns" });
  expect(store_read(targetDir, runId)).toMatchObject({
    status: "paused",
    pause: { code: "stage_closeout", reason: "model_turns" },
  });

  faux.setResponses([fauxAssistantMessage("completed after bounded closeout")]);
  const resumed = await runRoleStandalone({
    role,
    model,
    models,
    targetDir,
    task,
    runId,
    resumeExisting: true,
    stageLimits: { maxModelTurns: 6, finalResponseReserveModelTurns: 2 },
  });
  expect(resumed.text).toContain("completed after bounded closeout");
  expect(store_read(targetDir, runId).status).toBe("complete");
});

test("interrupted standalone resume advice does not demand adjusted limits", () => {
  expect(
    formatStandaloneResumeInstruction({ role: "reviewer", runId: "run-1", adjustLimits: false }),
  ).toBe("ad-coder: resume with role reviewer <same-task> --resume-run run-1\n");
  expect(
    formatStandaloneResumeInstruction({ role: "reviewer", runId: "run-1", adjustLimits: true }),
  ).toContain("and adjusted limits");
});

test("the stderr closeout notice names the reason and the detail (issue #327)", () => {
  expect(
    formatStageCloseoutNotice({
      code: "stage_closeout",
      reason: "tool_turns",
      detail: "1/2 tool turns used, 1 reserved",
    }),
  ).toBe("ad-coder: stage closeout (tool_turns): 1/2 tool turns used, 1 reserved\n");
});
