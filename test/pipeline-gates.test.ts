import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, AssistantMessage, Context, Message, Model } from "@earendil-works/pi-ai";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { createSpawnCommandExecutor, DEFAULT_PROJECT_GATES } from "../src/gates/project-gates";
import { GateRunner } from "../src/gates/runner";
import { runPipeline } from "../src/orchestration/pipeline";
import { SUBMIT_PLAN_TOOL_NAME } from "../src/orchestration/plan";
import {
  applyTransition,
  createWorkflowSession,
  toPipelineResult,
} from "../src/orchestration/session";
import type { RoleSpec, Verdict, WorkflowState } from "../src/orchestration/types";
import { SUBMIT_VERDICT_TOOL_NAME } from "../src/orchestration/verdict";
import { RunCoordinator } from "../src/project-operations/run-coordinator";
import type { Role } from "../src/role";
import { defineRole } from "../src/role";

const CONTEXT_WINDOW = 200_000;
const BUDGET = { maxTokens: 100_000, reserveTokens: 10_000, keepRecentTokens: 20_000 } as const;

/** A fresh faux provider + models + temp targetDir; one queue serves every role. */
function fixture() {
  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "faux-1", contextWindow: CONTEXT_WINDOW }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel() as Model<Api>;
  const targetDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-gates-")));
  const role = (name: string, systemPrompt: string, activeToolNames?: string[]): RoleSpec => {
    const declared: Role = defineRole(
      {
        name,
        provider: "faux",
        modelId: model.id,
        systemPrompt,
        activeToolNames: activeToolNames ?? ["bash", "read", "write", "edit"],
        cacheRetention: "none",
        contextBudget: { ...BUDGET },
      },
      model,
    );
    return { role: declared, model };
  };
  return { faux, models, model, targetDir, role };
}

function reviewerRole(fx: ReturnType<typeof fixture>): RoleSpec {
  return fx.role("reviewer", "You review.", [
    "bash",
    "read",
    "write",
    "edit",
    SUBMIT_VERDICT_TOOL_NAME,
  ]);
}

/** Step 1 submits the verdict (a tool call), step 2 ends the review turn. */
function reviewerTurn(
  args: Verdict | Record<string, unknown>,
): readonly [AssistantMessage, AssistantMessage] {
  return [
    fauxAssistantMessage(fauxToolCall(SUBMIT_VERDICT_TOOL_NAME, args)),
    fauxAssistantMessage("review complete"),
  ];
}

/** The text of the newest user message the faux provider received for a role. */
function lastUserText(context: Context): string {
  const messages: Message[] = context.messages;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message === undefined || message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    return message.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("");
  }
  return "";
}

const APPROVED: Verdict = { status: "approved", issues: [], summary: "ok" };

test("the default declared set never contains the stamp gate, whose writer is the settle path (issue #271)", async () => {
  // A run cannot reach review while any declared gate is red, and the only
  // review-stamp writer is `runPipeline`'s settle path -- which runs after
  // review. Declaring `bun run stamp:check` as an in-run gate therefore hands
  // the coder a fix only the run itself can perform at settle: the
  // review-then-stamp loop is unresolvable from inside a run. It is the
  // PRE-MERGE gate, so this assertion pins the exclusion -- the mechanism is
  // the list, which the existing `GateRunner` executes verbatim.
  expect(DEFAULT_PROJECT_GATES.map((gate) => gate.name)).not.toContain("bun run stamp:check");
  // When a project DOES want it in-run, it is the caller's explicit choice
  // (issue #239's substitution surfaces stay intact).
  expect(DEFAULT_PROJECT_GATES.length).toBeGreaterThan(0);
  expect(DEFAULT_PROJECT_GATES.every((gate) => gate.kind === "project")).toBe(true);
});

test("the default declared set carries the conflict-marker gate between docs and smoke (issue #474)", () => {
  // Issue #474: a rebase-resolved tree carried conflict markers and passed
  // EVERY gate that ran over it -- the in-run set is this list, executed by
  // the existing `GateRunner` verbatim, so the marker grep must be DECLARED
  // here and not only wired into CI. Its property is what an in-run gate can
  // hold: a deterministic, whole-project, cheap `git grep --cached` over the
  // index projection, decided by bytes no other declared gate reads.
  const gate = DEFAULT_PROJECT_GATES.find(
    (declared) => declared.name === "bun run check:conflict-markers",
  );
  expect(gate).toBeDefined();
  expect(gate?.kind).toBe("project");
  expect(gate?.command).toEqual(["bun", "run", "check:conflict-markers"]);
  // In order with its check:* neighbours: after the docs check, before the
  // artifact smoke, so a marker tree is named before anything is packaged.
  const names = DEFAULT_PROJECT_GATES.map((declared) => declared.name);
  expect(names.indexOf("bun run check:docs")).toBeLessThan(
    names.indexOf("bun run check:conflict-markers"),
  );
  expect(names.indexOf("bun run check:conflict-markers")).toBeLessThan(
    names.indexOf("bun run smoke:artifact"),
  );
});

test("the pipeline runs the declared gates after the coder and hands the reviewer the evidence", async () => {
  const fx = fixture();
  const coder = fx.role("coder", "You code.");
  const reviewer = reviewerRole(fx);
  let reviewerPrompt = "";
  fx.faux.setResponses([
    fauxAssistantMessage("coded"),
    (context) => {
      reviewerPrompt = lastUserText(context);
      return reviewerTurn(APPROVED)[0];
    },
    reviewerTurn(APPROVED)[1],
  ]);

  const argvs: string[][] = [];
  const report = await runPipeline({
    targetDir: fx.targetDir,
    models: fx.models,
    task: "implement V",
    maxRounds: 1,
    roles: { coder, reviewer },
    qualityGates: {
      gates: [
        { name: "make lint", kind: "project", command: ["make", "lint"] },
        { name: "typecheck", kind: "project", command: ["tsc", "--noEmit"] },
      ],
      executor: async (argv) => {
        argvs.push(argv);
        return { exitCode: 0, stdout: "", stderr: "clean" };
      },
    },
  });

  // The declared argv ran EXACTLY as declared, with zero path arguments
  // appended: a whole-project command decides over the whole directory.
  expect(argvs).toEqual([
    ["make", "lint"],
    ["tsc", "--noEmit"],
  ]);
  expect(report.approved).toBe(true);
  expect(report.reviewRan).toBe(true);
  expect(report.gateReport?.passed).toBe(true);
  expect(report.gateReport?.results.map((gateResult) => gateResult.name)).toEqual([
    "make lint",
    "typecheck",
  ]);

  // The reviewer saw the gate report as evidence, verdict per gate, and the
  // blocker rule stated by contract -- not an assertion it had to trust.
  expect(reviewerPrompt).toContain("Declared project gates");
  expect(reviewerPrompt).toContain("- make lint: PASSED");
  expect(reviewerPrompt).toContain("- typecheck: PASSED");
  expect(reviewerPrompt).toContain("blocker");
});

test("review framing distinguishes the strict pre-merge stamp gate from declared blockers", async () => {
  const fx = fixture();
  const coder = fx.role("coder", "You code.");
  const reviewer = reviewerRole(fx);
  let reviewerPrompt = "";
  fx.faux.setResponses([
    fauxAssistantMessage("coded"),
    (context) => {
      reviewerPrompt = lastUserText(context);
      return reviewerTurn(APPROVED)[0];
    },
    reviewerTurn(APPROVED)[1],
  ]);

  const report = await runPipeline({
    targetDir: fx.targetDir,
    models: fx.models,
    task: "implement stamp scope",
    maxRounds: 1,
    roles: { coder, reviewer },
    qualityGates: {
      gates: [{ name: "declared check", kind: "project", command: ["check"] }],
      executor: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    },
  });

  expect(report.gateReport?.passed).toBe(true);
  expect(reviewerPrompt).toContain(
    "bun run stamp:check is a strict PRE-MERGE gate, intentionally absent from the declared gates",
  );
  expect(reviewerPrompt).toContain(
    "red before a settled approved review writes its stamp, so it is not an in-run blocker and is not a review finding",
  );
  expect(reviewerPrompt).toContain("failed declared gates still block");
  expect(reviewerPrompt).not.toContain("- bun run stamp:check: PASSED");
  expect(reviewerPrompt).not.toContain("- bun run stamp:check: FAILED");
});

test("a red declared gate returns to the Coder with the captured output, then reviews only when green", async () => {
  const fx = fixture();
  const coder = fx.role("coder", "You code.");
  const reviewer = reviewerRole(fx);
  const coderPrompts: string[] = [];
  const reviewerPrompts: string[] = [];
  let red = true;
  let gateRuns = 0;
  fx.faux.setResponses([
    fauxAssistantMessage("coded once"),
    (context) => {
      coderPrompts.push(lastUserText(context));
      return fauxAssistantMessage("fixed");
    },
    (context) => {
      reviewerPrompts.push(lastUserText(context));
      return reviewerTurn(APPROVED)[0];
    },
    reviewerTurn(APPROVED)[1],
  ]);

  const report = await runPipeline({
    targetDir: fx.targetDir,
    models: fx.models,
    task: "implement W",
    maxRounds: 2,
    roles: { coder, reviewer },
    qualityGates: {
      gates: [{ name: "bun run check", kind: "project", command: ["bun", "run", "check"] }],
      executor: async () => {
        gateRuns += 1;
        const wasRed = red;
        red = false;
        return wasRed
          ? { exitCode: 1, stdout: "", stderr: "lint/correctness: unsorted import src/a.ts" }
          : { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  });

  // The coder SAW the red gate's captured output verbatim, framed as evidence.
  expect(coderPrompts[0]).toContain("Declared project gate failures");
  expect(coderPrompts[0]).toContain("bun run check");
  expect(coderPrompts[0]).toContain("unsorted import src/a.ts");
  // The review only happened once the gates were green, and its evidence says so.
  expect(reviewerPrompts[0]).toContain("- bun run check: PASSED");
  expect(report.approved).toBe(true);
  const gateResults = report.gateReport?.results ?? [];
  expect(gateResults).toHaveLength(1);
  expect(gateResults[0]?.passed).toBe(true);
  // Exactly ONE review verdict, TWO gate runs (red after round 1, green after
  // the fix), and a stage sequence that never routes red gate output into a
  // review: the coder round re-runs only when the gate went red.
  expect(gateRuns).toBe(2);
  expect(report.verdicts).toHaveLength(1);
  expect(report.stageMetrics.map((metric) => metric.stage)).toEqual([
    "code:1",
    "code:2",
    "review:2",
  ]);
  // Every stage run is durably ledgered, in that execution order.
  expect(report.runIds).toHaveLength(5);
});

test("a red declared gate at maxRounds settles NOT approved, before any review", async () => {
  const fx = fixture();
  const coder = fx.role("coder", "You code.");
  const reviewer = reviewerRole(fx);
  fx.faux.setResponses([
    fauxAssistantMessage("coded"),
    // No reviewer response is needed: a red gate must never reach review.
  ]);

  const report = await runPipeline({
    targetDir: fx.targetDir,
    models: fx.models,
    task: "implement X",
    maxRounds: 1,
    roles: { coder, reviewer },
    qualityGates: {
      gates: [
        { name: "bun run check:docs", kind: "project", command: ["bun", "run", "check:docs"] },
      ],
      executor: async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "docs/ARCHITECTURE.md over limit",
      }),
    },
  });

  // Blocked the same way a red review blocks -- but the operator reads WHICH
  // blocker: the red gate report, and the absence of any review round.
  expect(report.approved).toBe(false);
  expect(report.reviewRan).toBe(false);
  expect(report.verdicts).toHaveLength(0);
  expect(report.rounds).toBe(0);
  expect(report.gateReport?.passed).toBe(false);
  expect(report.gateReport?.results[0]?.name).toBe("bun run check:docs");
  expect(report.gateReport?.results[0]?.passed).toBe(false);
});

test("a stale approved verdict cannot bless a settled run whose gates went red", () => {
  // An unusual state, reachable via a driver rework after an approval, but
  // `applyTransition` reads the gate report itself so the settled outcome
  // never approves over red evidence.
  const approved: Verdict = { status: "approved", issues: [], summary: "was fine" };
  const redState = {
    phase: "review",
    round: 1,
    planSummary: "",
    contractRequirements: [],
    changeSummary: "",
    securityNotes: "",
    preComplexity: "medium",
    effective: "medium",
    verdicts: [approved],
    runIds: [],
    lastGateReport: {
      results: [{ name: "g", kind: "project", passed: false, output: "boom" }],
      passed: false,
    },
    done: false,
    approved: false,
  } as unknown as WorkflowState;
  const settled = applyTransition(redState, {
    kind: "stop",
    isDefault: true,
    toPhase: "done",
    toRound: 1,
  });
  expect(settled.approved).toBe(false);
  const result = toPipelineResult(settled);
  expect(result.outcome).toBe("decomposition_required");
  expect(result.gateReport?.passed).toBe(false);
  expect(result.reviewRan).toBe(true);
});

test("the runner marks a gate whose executor dies as THAT gate red, fail-loud not throwing", async () => {
  const runner = new GateRunner({
    executor: async () => {
      throw new Error("spawn ENOENT");
    },
  });
  const report = await runner.run([{ name: "g", kind: "project", command: ["tool"] }], []);
  expect(report.passed).toBe(false);
  expect(report.results[0]?.passed).toBe(false);
  expect(report.results[0]?.output).toContain("errored");
});

test("the spawn executor caps a chatty gate's capture and appends a marker", async () => {
  const executor = createSpawnCommandExecutor(64);
  const result = await executor([process.execPath, "-e", "console.log('x'.repeat(1000))"], ".");
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain("[capture truncated]");
  expect(result.stderr.length).toBeLessThan(1100);
});

test("the spawn executor reports a failing gate and a missing binary fail-loud", async () => {
  const failing = await createSpawnCommandExecutor()(
    [process.execPath, "-e", "process.exit(3)"],
    ".",
  );
  expect(failing.exitCode).toBe(3);
  const missing = await createSpawnCommandExecutor()(["definitely-not-a-binary-xyz"], ".");
  expect(missing.exitCode).toBe(1);
});

test("the coordinator renders a review that did not run as a red pause, resumable by operator", async () => {
  const fx = fixture();
  const coder = fx.role("coder", "You code.");
  const reviewer = reviewerRole(fx);
  fx.faux.setResponses([
    fauxAssistantMessage("coded"),
    // The reviewer runs but never calls submit_verdict -- TWICE, because the
    // stage asks again when the verdict never arrived (#278). A reviewer that
    // will not submit at all is what this pause is for.
    fauxAssistantMessage("I looked but did not submit a verdict"),
    fauxAssistantMessage("still no verdict"),
  ]);
  const session = createWorkflowSession({
    targetDir: fx.targetDir,
    models: fx.models,
    task: "implement Y",
    maxRounds: 1,
    roles: { coder, reviewer },
  });
  const coordinator = new RunCoordinator(session, session.projectStore, { runId: "r1" });
  await coordinator.run();
  const pause = coordinator.checkpoint.pause;
  expect(pause).toBeDefined();
  expect(pause?.phase).toBe("review");
  expect(pause?.code).toBe("review_not_run");
  expect(pause?.action).toContain("missing_verdict");
  // A review that did not happen blocks like a red gate: operator resume is
  // accepted (no unauthorized_resolution), unlike an unowned checkpoint.
  expect(() => coordinator.resumeStage({ source: "operator", action: "retry" })).not.toThrow();
});

test("a plan that was never submitted is a red pause, not silence", async () => {
  // Observed live (issue #315): the planner spent both handoff attempts writing
  // prose without calling submit_plan, the coordinator had no branch for
  // missing_plan, and the error escaped every handler -- the checkpoint kept its
  // pre-stage value and the run_pipeline call that started it stayed pending for
  // 48 minutes, indistinguishable from work in progress. Silence is the one
  // outcome a caller cannot act on.
  const fx = fixture();
  const planner = fx.role("planner", "You plan.", ["read", SUBMIT_PLAN_TOOL_NAME]);
  const coder = fx.role("coder", "You code.");
  const reviewer = reviewerRole(fx);
  fx.faux.setResponses([
    fauxAssistantMessage("here is my plan in prose"),
    fauxAssistantMessage("still prose, still no submit_plan"),
  ]);
  const session = createWorkflowSession({
    targetDir: fx.targetDir,
    models: fx.models,
    task: "implement Z",
    maxRounds: 1,
    roles: { planner, coder, reviewer },
  });
  const coordinator = new RunCoordinator(session, session.projectStore, { runId: "plan-silent" });
  await coordinator.run();
  const pause = coordinator.checkpoint.pause;
  expect(pause).toBeDefined();
  expect(pause?.phase).toBe("plan");
  expect(pause?.code).toBe("plan_not_json");
  expect(pause?.action).toContain("plan_not_json");
  // Recoverable like the review pause: the stage can be attempted again.
  expect(() => coordinator.resumeStage({ source: "operator", action: "retry" })).not.toThrow();
});

test("an empty planner response remains plan_not_submitted, distinct from prose", async () => {
  const fx = fixture();
  const planner = fx.role("planner", "You plan.", ["read", SUBMIT_PLAN_TOOL_NAME]);
  const coder = fx.role("coder", "You code.");
  const reviewer = reviewerRole(fx);
  fx.faux.setResponses([fauxAssistantMessage(""), fauxAssistantMessage("")]);
  const session = createWorkflowSession({
    targetDir: fx.targetDir,
    models: fx.models,
    task: "implement empty",
    maxRounds: 1,
    roles: { planner, coder, reviewer },
  });
  const coordinator = new RunCoordinator(session, session.projectStore, { runId: "plan-empty" });

  await coordinator.run();

  const pause = coordinator.checkpoint.pause;
  expect(pause?.phase).toBe("plan");
  expect(pause?.code).toBe("plan_not_submitted");
  expect(pause?.cause?.code).toBe("missing_plan");
  expect(pause?.action).toContain("missing_plan");
  expect(pause?.action).not.toContain("plan_not_json");
});

test("ci.yml declares the pre-merge stamp gate exactly once, as the last step (issue #295)", () => {
  // Configuration is data (issue #227): the workflow's step list is pinned as
  // text exactly like DEFAULT_PROJECT_GATES is pinned as data. A unit test
  // cannot execute a GitHub workflow -- this pins the artifact; CI itself is
  // the real execution and is observed on the pull request.
  const ci = fs.readFileSync(
    path.join(import.meta.dir, "..", ".github", "workflows", "ci.yml"),
    "utf8",
  );
  // Exactly one shell invocation: the command appears in the conditional, not
  // in comments or a second workflow step.
  expect(ci.split("if bun run stamp:check; then")).toHaveLength(2);
  expect(ci.split("bun run stamp:check")).toHaveLength(2);
  // The pre-merge gate runs LAST, after the artifact smoke (issue #295).
  expect(ci.indexOf("if bun run stamp:check; then")).toBeGreaterThan(
    ci.indexOf("- run: bun run smoke:artifact"),
  );
});
