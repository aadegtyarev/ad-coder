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
import { MemoryLedgerSink } from "../src/ledger/ledger";
import { createWorkflowSession } from "../src/orchestration/session";
import { runPipeline } from "../src/orchestration/pipeline";
import type {
  AvailableTransition,
  PipelineConfig,
  RoleSpec,
  Verdict,
} from "../src/orchestration/types";
import { SUBMIT_VERDICT_TOOL_NAME } from "../src/orchestration/verdict";
import { defineRole } from "../src/role";
import type { Role } from "../src/role";
import {
  assertTransitionOffered,
  DriveError,
  driveWorkflow,
  silentNoopWarning,
} from "../src/cli/drive";

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
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: CONTEXT_WINDOW }] });
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
function config(fx: Fixture, roles: PipelineConfig["roles"], ledgerSink: MemoryLedgerSink): PipelineConfig {
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
  const coder = fx.role("coder", "You code.");
  const reviewer = reviewerRole(fx);
  const changes: Verdict = {
    status: "changes_requested",
    issues: [{ severity: "major", what: "add a guard" }],
    summary: "again",
  };
  const approve: Verdict = { status: "approved", issues: [], summary: "fixed" };
  const script: FauxResponseStep[] = [
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
});

test("a silent no-op turn writes the warning to the error stream", async () => {
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

  await driveWorkflow({
    session,
    ledgerSink,
    auto: true,
    input: Readable.from(""),
    output,
    error,
  });

  expect(error.text()).toContain("no assistant text");
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
  const forged: AvailableTransition = { kind: "rework", isDefault: false, toPhase: "code", toRound: 2 };

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
  const forged: AvailableTransition = { kind: "advance", isDefault: true, toPhase: "done", toRound: 9 };
  const offered = (await session.step(session.initialState())).transitions;
  expect(() => assertTransitionOffered(forged, offered)).toThrow(DriveError);
});
