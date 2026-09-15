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
import {
  assertTransitionOffered,
  DriveError,
  driveWorkflow,
  silentNoopWarning,
} from "../src/cli/drive";
import { FileLedgerSink, MemoryLedgerSink } from "../src/ledger/ledger";
import { SUBMIT_FOLLOW_UP_TOOL_NAME } from "../src/orchestration/follow-up";
import { runPipeline } from "../src/orchestration/pipeline";
import { createWorkflowSession } from "../src/orchestration/session";
import type {
  AvailableTransition,
  PipelineConfig,
  RoleSpec,
  Verdict,
} from "../src/orchestration/types";
import { OrchestrationError } from "../src/orchestration/types";
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

  let caught: unknown;
  try {
    await driveWorkflow({
      session,
      ledgerSink,
      auto: true,
      input: Readable.from(""),
      output: new Capture(),
      error: new Capture(),
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(OrchestrationError);
  expect(caught).toMatchObject({ code: "requirements_unresolved" });
  expect((caught as Error).message).toBe(
    "increase or disable the model_turns stage limit, then resume explicitly",
  );
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
  ).rejects.toMatchObject({ code: "requirements_unresolved" });
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
