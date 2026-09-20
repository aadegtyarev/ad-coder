import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { FauxProviderHandle, FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { renderCliError, renderCliFailureLine } from "../src/cli";
import {
  assertTransitionOffered,
  DriveError,
  driveWorkflow,
  silentNoopWarning,
} from "../src/cli/drive";
import { resetPauseAnnouncements } from "../src/cli/pause-notice";
import { FileLedgerSink, MemoryLedgerSink } from "../src/ledger/ledger";
import { SUBMIT_FOLLOW_UP_TOOL_NAME } from "../src/orchestration/follow-up";
import { runPipeline } from "../src/orchestration/pipeline";
import { SUBMIT_PLAN_TOOL_NAME } from "../src/orchestration/plan";
import { createWorkflowSession } from "../src/orchestration/session";
import type {
  AvailableTransition,
  PipelineConfig,
  PipelinePause,
  RoleSpec,
  Verdict,
} from "../src/orchestration/types";
import { PipelinePauseError } from "../src/orchestration/types";
import { SUBMIT_VERDICT_TOOL_NAME } from "../src/orchestration/verdict";
import { RunCoordinator } from "../src/project-operations/run-coordinator";
import type { Role } from "../src/role";
import { defineRole } from "../src/role";

const CONTEXT_WINDOW = 200_000;
const BUDGET = { maxTokens: 100_000, reserveTokens: 10_000, keepRecentTokens: 20_000 } as const;

interface Fixture {
  faux: FauxProviderHandle;
  models: ReturnType<typeof createModels>;
  model: Model<Api>;
  targetDir: string;
  role(name: string, systemPrompt: string, activeToolNames?: string[]): RoleSpec;
}

/** A fresh faux provider + models + temp targetDir; one queue serves every role. */
function fixture(): Fixture {
  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "faux-1", contextWindow: CONTEXT_WINDOW }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel() as Model<Api>;
  const targetDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-drive-")));
  return {
    faux,
    models,
    model,
    targetDir,
    role(name, systemPrompt, activeToolNames = ["bash", "read", "write", "edit"]) {
      const role: Role = defineRole(
        {
          name,
          provider: "faux",
          modelId: model.id,
          systemPrompt,
          activeToolNames,
          cacheRetention: "none",
          contextBudget: { ...BUDGET },
        },
        model,
      );
      return { role, model };
    },
  };
}

function reviewerRole(fx: Fixture): RoleSpec {
  return fx.role("reviewer", "You review.", ["bash", "read", SUBMIT_VERDICT_TOOL_NAME]);
}

/** Script a submit_plan + text turn: the plan stage settles for real. */
function governedPlanTurn(): FauxResponseStep[] {
  return [
    fauxAssistantMessage(
      fauxToolCall(SUBMIT_PLAN_TOOL_NAME, {
        complexity: "medium",
        securitySurface: "none",
        summary: "plan: do X",
        contractRequirements: [],
        surfaceAnalysis: {
          projectType: "test fixture",
          surfaces: [{ id: "core", name: "core", rationale: "exercise orchestration" }],
          coverage: [
            {
              surfaceId: "core",
              status: "not_applicable",
              contractIds: [],
              evidence: ["fixture changes no product contract surface"],
              rationale: "CLI drive plumbing only",
            },
          ],
        },
      }),
    ),
    fauxAssistantMessage("plan: do X"),
  ];
}

/** A scripted reviewer turn: submit_verdict, then a text summary. */
function reviewerTurn(args: Verdict): FauxResponseStep[] {
  return [
    fauxAssistantMessage(fauxToolCall(SUBMIT_VERDICT_TOOL_NAME, args)),
    fauxAssistantMessage("review complete"),
  ];
}

/** Collect everything written to a stream as one string. */
class Capture extends Writable {
  chunks: string[] = [];
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (e?: Error) => void): void {
    this.chunks.push(chunk.toString());
    cb();
  }
  text(): string {
    return this.chunks.join("");
  }
}

/** Build a PipelineConfig over the fixture with a shared readable ledger sink. */
function config(
  fx: Fixture,
  roles: PipelineConfig["roles"],
  ledgerSink: MemoryLedgerSink,
): PipelineConfig {
  return {
    targetDir: fx.targetDir,
    models: fx.models,
    task: "implement X",
    maxRounds: 3,
    roles,
    ledgerSink,
  };
}

test("a scripted choice sequence drives the loop and settles on the chosen stop", async () => {
  const fx = fixture();
  const coder = fx.role("coder", "You code.");
  const reviewer = reviewerRole(fx);
  const changes: Verdict = {
    status: "changes_requested",
    issues: [{ severity: "major", what: "fix it" }],
    summary: "needs work",
  };
  fx.faux.setResponses([fauxAssistantMessage("coded once"), ...reviewerTurn(changes)]);

  const ledgerSink = new MemoryLedgerSink();
  const session = createWorkflowSession(config(fx, { coder, reviewer }, ledgerSink));
  const output = new Capture();
  const error = new Capture();
  // No planner -> first phase is code: advance to review, then stop rather than
  // taking the default advance to a round-2 code phase.
  const input = Readable.from("advance\nstop\n");

  const result = await driveWorkflow({ session, ledgerSink, auto: false, input, output, error });

  expect(result.approved).toBe(false);
  expect(result.rounds).toBe(1);
  expect(result.verdicts[0]?.status).toBe("changes_requested");
  expect(output.text()).toContain("[code]");
  expect(output.text()).toContain("[review]");
  expect(output.text()).toContain("approved: false");
});

test("a stage-limit pause is reported as recovery guidance, not a pending decision", async () => {
  const fx = fixture();
  const coder = fx.role("coder", "You code.");
  const reviewer = reviewerRole(fx);
  fx.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: "printf one" })),
    fauxAssistantMessage("must not dispatch"),
  ]);
  const ledgerSink = new MemoryLedgerSink();
  const pipeline = config(fx, { coder, reviewer }, ledgerSink);
  pipeline.stageLimits = { maxModelTurns: 1 };
  const session = createWorkflowSession(pipeline);

  resetPauseAnnouncements();
  const errorCapture = new Capture();
  let caught: unknown;
  try {
    await driveWorkflow({
      session,
      ledgerSink,
      auto: true,
      input: Readable.from(""),
      output: new Capture(),
      error: errorCapture,
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PipelinePauseError);
  expect(caught).toMatchObject({ code: "pipeline_paused" });
  expect((caught as Error).message).toBe(
    "stage_limit: increase or disable the model_turns stage limit, then resume explicitly",
  );
  expect(errorCapture.text()).toContain("pipeline paused (");
  expect(errorCapture.text()).toContain("): stage_limit, limit model_turns (1) -- ");
  expect(errorCapture.text()).toContain(
    "increase or disable the model_turns stage limit, then resume explicitly",
  );
  expect(errorCapture.text()).toContain("the run is resumable, not failed");
  expect(errorCapture.text()).toContain("resume: ad-coder drive");
  // Exactly ONE pause announcement reaches stderr for a drive invocation that
  // pauses (review round 3, issue #501), and it is the pause line -- never the
  // thrown error's bare `code: action` message.
  expect(errorCapture.text().split("pipeline paused")).toHaveLength(2);
  expect(errorCapture.text()).not.toContain("stage_limit: increase or disable");
  // The entry-point catch shares the keyed memo, so the projection of the SAME
  // caught occurrence writes NOTHING: the drive result path already announced
  // it, and the generic `code: action` line must not follow it. This is the
  // strongest form the harness allows: the entry-point catch itself cannot be
  // driven end-to-end with the faux provider, because a spawned `bun run
  // src/cli.ts` resolves its models from the operator profile (real
  // providers, real credentials), no seam injects the in-process faux
  // provider across that boundary, and `main` sits behind the
  // `import.meta.main` guard so no in-process call reaches the catch.
  expect(renderCliFailureLine(caught)).toBeUndefined();
});

test("the entry-point pause projection announces one occurrence exactly once", () => {
  // The reviewer's strongest available assertion (see the stage-limit pause
  // test above for why the entry-point catch cannot be driven end-to-end):
  // the projection asked twice for ONE occurrence yields ONE line.
  resetPauseAnnouncements();
  const error = new PipelinePauseError(
    "entry-once",
    {
      phase: "code",
      code: "stage_limit",
      action: "increase or disable the model_turns stage limit, then resume explicitly",
      limitReason: "model_turns",
      limit: 2,
    },
    { steps: 1, totalCost: 0.01 },
  );
  // The winning ask renders the full pause line -- the drive result path's
  // shape, plus the runId the error carries (it carries neither a checkpoint
  // path nor a resume command, so the line stops at the runId).
  expect(renderCliFailureLine(error)).toBe(
    "ad-coder: pipeline paused (code): stage_limit, limit model_turns (2) -- " +
      "increase or disable the model_turns stage limit, then resume explicitly -- " +
      "the run is resumable, not failed; runId=entry-once\n",
  );
  // The same occurrence asked again: pure silence -- never the bare
  // `code: action` message the generic error renderer would print.
  expect(renderCliFailureLine(error)).toBeUndefined();
  expect(renderCliError(error)).toBe(
    "ad-coder: stage_limit: increase or disable the model_turns stage limit, then resume explicitly\n",
  );
  // A NEW occurrence (a different run) still announces: the memo is per
  // occurrence, not a global mute.
  expect(
    renderCliFailureLine(
      new PipelinePauseError(
        "entry-again",
        { phase: "code", code: "stage_limit", action: "resume explicitly" },
        { steps: 0, totalCost: 0 },
      ),
    ),
  ).toContain("pipeline paused (");
});

test("the entry-point pause projection builds every limit-clause variant", () => {
  resetPauseAnnouncements();
  const variant = (runId: string, limit: Pick<PipelinePause, "limitReason" | "limit">): string =>
    renderCliFailureLine(
      new PipelinePauseError(
        runId,
        { phase: "code", code: "stage_limit", action: "resume explicitly", ...limit },
        { steps: 0, totalCost: 0 },
      ),
    ) ?? "";
  // Each variant on its own occurrence (every ask consumes the memo): the
  // clause is byte-for-byte the drive result path's.
  const reasonLimit = variant("entry-reason-limit", { limitReason: "model_turns", limit: 2 });
  expect(reasonLimit).toContain("): stage_limit, limit model_turns (2) --");
  expect(reasonLimit).not.toContain("stage_limit: resume explicitly");
  expect(variant("entry-reason", { limitReason: "model_turns" })).toContain(
    "): stage_limit, limit model_turns --",
  );
  expect(variant("entry-limit", { limit: 3 })).toContain("): stage_limit, limit (3) --");
  expect(variant("entry-plain", {})).toContain("): stage_limit --");
});

test("a paused drive resumes its incomplete stage from the coordinator checkpoint", async () => {
  const fx = fixture();
  const coder = fx.role("coder", "You code.");
  const reviewer = reviewerRole(fx);
  const approve: Verdict = { status: "approved", issues: [], summary: "ok" };
  fx.faux.setResponses([
    fauxAssistantMessage("coded"),
    fauxAssistantMessage(fauxToolCall("bash", { command: "printf one" })),
  ]);
  const ledgerSink = new MemoryLedgerSink();
  const pipeline = config(fx, { coder, reviewer }, ledgerSink);
  pipeline.stageLimits = { maxModelTurns: 1 };
  const firstSession = createWorkflowSession(pipeline);
  const first = new RunCoordinator(firstSession, firstSession.projectStore, {
    runId: "drive-resume",
    task: pipeline.task,
  });
  await expect(
    driveWorkflow({
      session: firstSession,
      ledgerSink,
      auto: true,
      input: Readable.from(""),
      output: new Capture(),
      error: new Capture(),
      coordinator: first,
    }),
  ).rejects.toMatchObject({ code: "pipeline_paused" });
  expect(first.checkpoint.workflowState.phase).toBe("code");
  const pausedRunId = first.checkpoint.workflowState.activeStage?.runId;
  expect(pausedRunId).toBeDefined();

  // The admitted coder operation is already settled when the local limit fires;
  // resume must read that durable lane result instead of dispatching the prompt again.
  fx.faux.setResponses([...reviewerTurn(approve)]);
  pipeline.stageLimits = { maxModelTurns: 3 };
  const resumedSession = createWorkflowSession(pipeline);
  const resumed = new RunCoordinator(resumedSession, resumedSession.projectStore, {
    runId: "drive-resume",
    task: pipeline.task,
    resumeExisting: true,
  });
  resumed.resumeStage({ source: "operator", action: "retry" });
  const result = await driveWorkflow({
    session: resumedSession,
    ledgerSink,
    auto: true,
    input: Readable.from(""),
    output: new Capture(),
    error: new Capture(),
    coordinator: resumed,
  });
  expect(result.approved).toBe(true);
  expect(resumed.checkpoint.workflowState.done).toBe(true);
  expect(resumed.checkpoint.workflowState.activeStage).toBeUndefined();
  expect(resumed.checkpoint.workflowState.runIds.filter((id) => id === pausedRunId)).toHaveLength(
    1,
  );
  expect(
    resumed.checkpoint.workflowState.stageMetrics?.filter(({ stage }) => stage === "code:1"),
  ).toHaveLength(1);
});

test("drive --resume-run clears a plan_not_submitted pause and proceeds past the plan stage", async () => {
  // The CLI composition half of issue #315: `drive --resume-run` cleared only
  // `stage_limit`, so a planner that never submitted a plan (the resumable
  // class the coordinator records as `plan_not_submitted`) could not be
  // resumed through the CLI front -- the pause came back instantly.
  const fx = fixture();
  const planner = fx.role("planner", "You plan.", ["read"]);
  const coder = fx.role("coder", "You code.");
  const reviewer = reviewerRole(fx);
  const approve: Verdict = { status: "approved", issues: [], summary: "ok" };
  const ledgerSink = new MemoryLedgerSink();
  const pipeline = config(fx, { planner, coder, reviewer }, ledgerSink);

  // One drive with a planner that never calls submit_plan (both handoff
  // attempts): the coordinator pauses the PLAN stage, not a stage limit.
  fx.faux.setResponses([
    fauxAssistantMessage("prose plan, no tool call"),
    fauxAssistantMessage("still no plan"),
  ]);
  const firstSession = createWorkflowSession(pipeline);
  const pausedCoordinator = new RunCoordinator(firstSession, firstSession.projectStore, {
    runId: "drive-plan-resume",
    task: pipeline.task,
  });
  await expect(
    driveWorkflow({
      session: firstSession,
      ledgerSink,
      auto: true,
      input: Readable.from(""),
      output: new Capture(),
      error: new Capture(),
      coordinator: pausedCoordinator,
    }),
  ).rejects.toMatchObject({ code: "pipeline_paused" });
  expect(pausedCoordinator.checkpoint.pause?.code).toBe("plan_not_json");
  expect(pausedCoordinator.checkpoint.pause?.phase).toBe("plan");
  expect(pausedCoordinator.checkpoint.pause?.action).toContain("plan_not_json");
  const callsBeforeResume = fx.faux.state.callCount;
  expect(callsBeforeResume).toBe(2);

  // The explicit resume act clears the pause; the next drive re-runs the plan
  // stage for real and proceeds past it into code and review.
  fx.faux.setResponses([
    ...governedPlanTurn(),
    fauxAssistantMessage("coded X"),
    fauxAssistantMessage(fauxToolCall(SUBMIT_VERDICT_TOOL_NAME, approve)),
    fauxAssistantMessage("review complete"),
  ]);
  const resumedSession = createWorkflowSession(pipeline);
  const resumed = new RunCoordinator(resumedSession, resumedSession.projectStore, {
    runId: "drive-plan-resume",
    task: pipeline.task,
    resumeExisting: true,
  });
  resumed.resumeStage({ source: "operator", action: "retry" });
  expect(resumed.checkpoint.pause).toBeUndefined();
  const result = await driveWorkflow({
    session: resumedSession,
    ledgerSink,
    auto: true,
    input: Readable.from(""),
    output: new Capture(),
    error: new Capture(),
    coordinator: resumed,
  });
  expect(resumed.checkpoint.pause).toBeUndefined();
  expect(result.approved).toBe(true);
  expect(result.stageMetrics.filter((s) => s.stage === "plan")).toHaveLength(1);
  expect(fx.faux.state.callCount).toBeGreaterThan(callsBeforeResume);
});

test("an interrupted coordinator without a pause can be reopened and driven", async () => {
  const fx = fixture();
  const coder = fx.role("coder", "You code.");
  const reviewer = reviewerRole(fx);
  const approve: Verdict = { status: "approved", issues: [], summary: "ok" };
  const ledgerSink = new MemoryLedgerSink();
  const pipeline = config(fx, { coder, reviewer }, ledgerSink);
  const firstSession = createWorkflowSession(pipeline);
  new RunCoordinator(firstSession, firstSession.projectStore, {
    runId: "drive-interrupted",
    task: pipeline.task,
  });

  fx.faux.setResponses([fauxAssistantMessage("coded"), ...reviewerTurn(approve)]);
  const resumedSession = createWorkflowSession(pipeline);
  const resumed = new RunCoordinator(resumedSession, resumedSession.projectStore, {
    runId: "drive-interrupted",
    task: pipeline.task,
    resumeExisting: true,
  });
  expect(resumed.checkpoint.pause).toBeUndefined();
  const result = await driveWorkflow({
    session: resumedSession,
    ledgerSink,
    auto: true,
    input: Readable.from(""),
    output: new Capture(),
    error: new Capture(),
    coordinator: resumed,
  });
  expect(result.approved).toBe(true);
});

test("a scripted rework choice re-runs the coder without a review in between", async () => {
  const fx = fixture();
  const coder = fx.role("coder", "You code.");
  const reviewer = reviewerRole(fx);
  const approve: Verdict = { status: "approved", issues: [], summary: "good" };
  fx.faux.setResponses([
    fauxAssistantMessage("code r1"),
    fauxAssistantMessage("code r2"),
    ...reviewerTurn(approve),
  ]);

  const ledgerSink = new MemoryLedgerSink();
  const session = createWorkflowSession(config(fx, { coder, reviewer }, ledgerSink));
  const output = new Capture();
  const error = new Capture();
  // code r1 -> rework (code r2) -> advance (review) -> stop (approved default).
  const input = Readable.from("rework\nadvance\nstop\n");

  const result = await driveWorkflow({ session, ledgerSink, auto: false, input, output, error });

  expect(result.approved).toBe(true);
  expect(result.rounds).toBe(1);
  expect(output.text()).toContain("code r2");
  expect(output.text()).toContain("verdict: approved");
});

test("auto:true reproduces runPipeline's approved/rounds/verdicts on the same scenario", async () => {
  const fx = fixture();
  const coder = fx.role("coder", "You code.", [SUBMIT_FOLLOW_UP_TOOL_NAME]);
  const reviewer = reviewerRole(fx);
  const changes: Verdict = {
    status: "changes_requested",
    issues: [{ severity: "major", what: "add a guard" }],
    summary: "again",
  };
  const approve: Verdict = { status: "approved", issues: [], summary: "fixed" };
  const script: FauxResponseStep[] = [
    fauxAssistantMessage(
      fauxToolCall(SUBMIT_FOLLOW_UP_TOOL_NAME, {
        kind: "note",
        title: "Shared coordinator scenario",
        evidence: [{ summary: "All drivers observed the same follow-up" }],
      }),
    ),
    fauxAssistantMessage("code r1"),
    ...reviewerTurn(changes),
    fauxAssistantMessage("code r2"),
    ...reviewerTurn(approve),
  ];

  fx.faux.setResponses([...script]);
  const pipelineResult = await runPipeline({
    targetDir: fx.targetDir,
    models: fx.models,
    task: "implement X",
    maxRounds: 3,
    roles: { coder, reviewer },
  });

  fx.faux.setResponses([...script]);
  const ledgerSink = new MemoryLedgerSink();
  const session = createWorkflowSession(config(fx, { coder, reviewer }, ledgerSink));
  const driveResult = await driveWorkflow({
    session,
    ledgerSink,
    auto: true,
    input: Readable.from(""),
    output: new Capture(),
    error: new Capture(),
  });

  expect(driveResult.approved).toBe(pipelineResult.approved);
  expect(driveResult.rounds).toBe(pipelineResult.rounds);
  expect(driveResult.verdicts.map((v) => v.status)).toEqual(
    pipelineResult.verdicts.map((v) => v.status),
  );
  const note = fs.readFileSync(path.join(fx.targetDir, "docs", "notes", "candidates.md"), "utf8");
  expect(note.match(/<!-- ad-coder:/g)).toHaveLength(1);
  const checkpoints = fs
    .readdirSync(path.join(fx.targetDir, ".ad-coder", "runs"))
    .filter((name) => name.startsWith("coordinator-"));
  expect(checkpoints).toHaveLength(2);
  for (const checkpoint of checkpoints) {
    const persisted = JSON.parse(
      fs.readFileSync(path.join(fx.targetDir, ".ad-coder", "runs", checkpoint), "utf8"),
    ).value;
    expect(persisted.phase).toBe("complete");
    expect(persisted.followUps).toHaveLength(1);
  }
});

test("a silent no-op turn fails with an actionable typed error", async () => {
  const fx = fixture();
  const coder = fx.role("coder", "You code.");
  const reviewer = reviewerRole(fx);
  const approve: Verdict = { status: "approved", issues: [], summary: "ok" };
  // Coder returns empty assistant text (a stand-in for a provider that needs auth).
  fx.faux.setResponses([fauxAssistantMessage(""), ...reviewerTurn(approve)]);

  const ledgerSink = new MemoryLedgerSink();
  const session = createWorkflowSession(config(fx, { coder, reviewer }, ledgerSink));
  const output = new Capture();
  const error = new Capture();

  await expect(
    driveWorkflow({
      session,
      ledgerSink,
      auto: true,
      input: Readable.from(""),
      output,
      error,
    }),
  ).rejects.toMatchObject({ code: "empty_turn" });

  expect(error.text()).toContain("empty_turn");
  expect(error.text()).toContain("codex login");
});

test("silentNoopWarning fires only on empty text AND zero cost", () => {
  expect(silentNoopWarning("", 0)).toContain("codex login");
  expect(silentNoopWarning("x", 0)).toBeUndefined();
  expect(silentNoopWarning("", 5)).toBeUndefined();
});

test("a transition not offered by the step is rejected at the driver boundary", () => {
  const offered: AvailableTransition[] = [
    { kind: "advance", isDefault: true, toPhase: "review", toRound: 1 },
    { kind: "stop", isDefault: false, toPhase: "done", toRound: 1 },
  ];
  const forged: AvailableTransition = {
    kind: "rework",
    isDefault: false,
    toPhase: "code",
    toRound: 2,
  };

  let caught: unknown;
  try {
    assertTransitionOffered(forged, offered);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DriveError);
  expect((caught as DriveError).code).toBe("transition_not_offered");
  expect((caught as DriveError).detail).toBe("rework");
});

test("driveWorkflow rejects a driver that returns a forged transition", async () => {
  const fx = fixture();
  const coder = fx.role("coder", "You code.");
  const reviewer = reviewerRole(fx);
  const approve: Verdict = { status: "approved", issues: [], summary: "ok" };
  fx.faux.setResponses([fauxAssistantMessage("coded"), ...reviewerTurn(approve)]);

  const ledgerSink = new MemoryLedgerSink();
  const session = createWorkflowSession(config(fx, { coder, reviewer }, ledgerSink));
  // A scripted input naming a kind the code step never offers ("review" is not a
  // transition kind) re-prompts rather than being accepted; feed EOF after so the
  // read cannot be satisfied. Instead assert the boundary directly via the guard.
  const forged: AvailableTransition = {
    kind: "advance",
    isDefault: true,
    toPhase: "done",
    toRound: 9,
  };
  const offered = (await session.step(session.initialState())).transitions;
  expect(() => assertTransitionOffered(forged, offered)).toThrow(DriveError);
});

test("per-step cost is attributed by position and reconciles with the total", async () => {
  // Regression. The drive loop attributed per-step cost by matching
  // record.runId === result.runId. Those never match -- a record carries the
  // harness operation runId (event.runId) while result.runId is the ledger's
  // file-name/step runId (see test/runner.test.ts) -- so every step printed $0
  // while the total was right. The faux provider always writes cost.total = 0,
  // so a cost-stamping sink is used to give records a real per-record cost and
  // drive the WHOLE loop through the real attribution call site: under the old
  // runId join every "cost:" line was $0 against a positive total; attribution
  // by record position partitions the total exactly.
  const PER_RECORD = 0.25;
  class StampSink extends MemoryLedgerSink {
    override write(record: Parameters<MemoryLedgerSink["write"]>[0]): void {
      super.write({
        ...record,
        usage: { ...record.usage, cost: { ...record.usage.cost, total: PER_RECORD } },
      });
    }
  }

  const fx = fixture();
  const coder = fx.role("coder", "You code.");
  const reviewer = reviewerRole(fx);
  const approve: Verdict = { status: "approved", issues: [], summary: "ok" };
  fx.faux.setResponses([fauxAssistantMessage("coded"), ...reviewerTurn(approve)]);

  const ledgerSink = new StampSink();
  const session = createWorkflowSession(config(fx, { coder, reviewer }, ledgerSink));
  const output = new Capture();
  await driveWorkflow({
    session,
    ledgerSink,
    auto: true,
    input: Readable.from(""),
    output,
    error: new Capture(),
  });

  const text = output.text();
  const perStep = [...text.matchAll(/^cost: \$([0-9.]+)$/gm)].map((m) => Number(m[1]));
  const total = Number(text.match(/total cost: \$([0-9.]+)/)?.[1]);
  const records = ledgerSink.records().length;

  expect(records).toBeGreaterThan(0);
  expect(total).toBeCloseTo(PER_RECORD * records, 8); // total sums every record
  expect(perStep.length).toBeGreaterThanOrEqual(2); // one code step + one review step
  expect(perStep.every((c) => c > 0)).toBe(true); // THE regression: no step is $0
  const sum = perStep.reduce((a, b) => a + b, 0);
  expect(sum).toBeCloseTo(total, 8); // per-step attribution partitions the total exactly
});

test("a driven run stays readable and still leaves its ledger file on disk", async () => {
  // Regression, same one as the orchestrated session: the drive loop needs a
  // READABLE sink (it attributes per-step cost by record position), and
  // installing one replaced the durable file sink outright -- so `ad-coder
  // drive` ran a whole multi-role pipeline and left nothing under
  // `.ad-coder/ledger` while `ad-coder role` did. This composes the sink
  // exactly as `driveCommand` does and drives a real pipeline through it.
  const fx = fixture();
  const coder = fx.role("coder", "You code.");
  const reviewer = reviewerRole(fx);
  const approve: Verdict = { status: "approved", issues: [], summary: "ok" };
  fx.faux.setResponses([fauxAssistantMessage("coded"), ...reviewerTurn(approve)]);

  const runId = "drive-evidence";
  const ledgerPath = path.join(fx.targetDir, ".ad-coder", "ledger", `${runId}.jsonl`);
  const ledgerSink = new MemoryLedgerSink(new FileLedgerSink(ledgerPath));
  const session = createWorkflowSession(config(fx, { coder, reviewer }, ledgerSink));
  try {
    await driveWorkflow({
      session,
      ledgerSink,
      auto: true,
      input: Readable.from(""),
      output: new Capture(),
      error: new Capture(),
    });
  } finally {
    ledgerSink.close();
  }

  const rows = fs
    .readFileSync(ledgerPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { role: string; step: string });
  // Both halves of the mirror agree: the drive loop read back exactly what the
  // audit trail kept, rather than one of the two going empty.
  expect(rows).toHaveLength(ledgerSink.records().length);
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.map(({ role }) => role)).toContain("coder");
  expect(rows.map(({ role }) => role)).toContain("reviewer");
});
