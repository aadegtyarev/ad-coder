import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Context, Message, Model } from "@earendil-works/pi-ai";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type {
  FauxProviderHandle,
  FauxResponseFactory,
  FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import { MemoryLedgerSink } from "../src/ledger/ledger";
import { SUBMIT_FOLLOW_UP_TOOL_NAME } from "../src/orchestration/follow-up";
import { runPipeline } from "../src/orchestration/pipeline";
import { parsePlan, SUBMIT_PLAN_TOOL_NAME } from "../src/orchestration/plan";
import { applyTransition, autoDriver, createWorkflowSession } from "../src/orchestration/session";
import type {
  AvailableTransition,
  PipelineRouting,
  Plan,
  RoleSpec,
  Verdict,
  WorkflowState,
} from "../src/orchestration/types";
import { OrchestrationError } from "../src/orchestration/types";
import { parseVerdict, SUBMIT_VERDICT_TOOL_NAME } from "../src/orchestration/verdict";
import { buildDefaultProfile } from "../src/profiles/default-profile";
import type { Profile } from "../src/profiles/types";
import type { ResolvedRegistry } from "../src/registry/types";
import type { Role } from "../src/role";
import { defineRole } from "../src/role";
import { SessionLimitController, SessionLimitError } from "../src/session-limits";

const CONTEXT_WINDOW = 200_000;
const BUDGET = { maxTokens: 100_000, reserveTokens: 10_000, keepRecentTokens: 20_000 } as const;

interface Fixture {
  faux: FauxProviderHandle;
  models: ReturnType<typeof createModels>;
  model: Model<Api>;
  targetDir: string;
  role(
    name: string,
    systemPrompt: string,
    activeToolNames?: string[],
    cacheRetention?: "none" | "short" | "long",
  ): RoleSpec;
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
  const targetDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-orch-")));
  return {
    faux,
    models,
    model,
    targetDir,
    role(
      name,
      systemPrompt,
      activeToolNames = ["bash", "read", "write", "edit"],
      cacheRetention = "none",
    ) {
      const role: Role = defineRole(
        {
          name,
          provider: "faux",
          modelId: model.id,
          systemPrompt,
          activeToolNames,
          cacheRetention,
          contextBudget: { ...BUDGET },
        },
        model,
      );
      return { role, model };
    },
  };
}

test("workflow rejects an undersized summarizer synchronously before provider dispatch", () => {
  const fx = fixture();
  const coder = fx.role("coder", "You code.");
  const reviewer = reviewerRole(fx);
  const summarizerModel = { ...fx.model, contextWindow: 32_000 };
  let dispatches = 0;
  const models = new Proxy(fx.models, {
    get(target, property, receiver) {
      if (["stream", "complete", "streamSimple", "completeSimple"].includes(String(property))) {
        return (..._args: unknown[]) => {
          dispatches += 1;
          throw new Error("unexpected provider dispatch");
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  expect(() =>
    createWorkflowSession({
      targetDir: fx.targetDir,
      models,
      task: "x",
      maxRounds: 1,
      roles: { coder, reviewer },
      compaction: { mode: "auto", summarizerModel },
    }),
  ).toThrow("summarizer context window 32000 is below reachable maximum 200000");
  expect(dispatches).toBe(0);
});

/** A reviewer role that can call submit_verdict (only this role needs the tool). */
function reviewerRole(fx: Fixture): RoleSpec {
  return fx.role("reviewer", "You review.", [
    "bash",
    "read",
    "write",
    "edit",
    SUBMIT_VERDICT_TOOL_NAME,
  ]);
}

/** A planner role that can call submit_plan (only this role needs the tool). */
function plannerRole(fx: Fixture): RoleSpec {
  return fx.role("planner", "You plan.", ["bash", "read", "write", "edit", SUBMIT_PLAN_TOOL_NAME]);
}

/**
 * A security role: read/bash only, no write/edit and no submit tool (this first
 * cut threads its final text, it never writes). Mirrors the role the pipeline's
 * conditional Security phase drives.
 */
function securityRole(fx: Fixture): RoleSpec {
  return fx.role("security", "You threat-model.", ["bash", "read"]);
}

/**
 * A scripted security turn: a single text threat-model message. It MUST end on a
 * text message (no trailing tool call) or extractFinalText yields '' and nothing
 * threads to the coder/reviewer.
 */
function securityTurn(text: string): FauxResponseStep[] {
  return [fauxAssistantMessage(text)];
}

/**
 * A scripted planner turn: call submit_plan with the plan args, then a text
 * summary. Two faux responses, because the harness re-prompts after the tool
 * call until a no-tool message settles the turn. The arg type admits a plain
 * record so malformed payloads can be scripted alongside well-formed plans.
 */
function plannerTurn(args: Plan | Record<string, unknown>): FauxResponseStep[] {
  return [
    fauxAssistantMessage(fauxToolCall(SUBMIT_PLAN_TOOL_NAME, args)),
    fauxAssistantMessage("plan text"),
  ];
}

/** The text of the newest user message the provider was called with. */
function lastUserText(context: Context): string {
  const messages: Message[] = context.messages;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message === undefined || message.role !== "user") {
      continue;
    }
    if (typeof message.content === "string") {
      return message.content;
    }
    return message.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("");
  }
  return "";
}

/**
 * A scripted reviewer turn: call submit_verdict with the verdict args (mirrors
 * what a real reviewer would do), then a text summary. Two faux responses,
 * because the harness re-prompts after the tool call until a no-tool message
 * settles the turn. The arg type admits a plain record so malformed payloads
 * (e.g. an invalid status) can be scripted alongside well-formed verdicts.
 */
function reviewerTurn(args: Verdict | Record<string, unknown>): FauxResponseStep[] {
  return [
    fauxAssistantMessage(fauxToolCall(SUBMIT_VERDICT_TOOL_NAME, args)),
    fauxAssistantMessage("review complete"),
  ];
}

function responseWithUsage(
  response: ReturnType<typeof fauxAssistantMessage>,
  freshInput: number,
  cachedInput: number,
  output: number,
): ReturnType<typeof fauxAssistantMessage> {
  return {
    ...response,
    usage: {
      input: freshInput,
      output,
      cacheRead: cachedInput,
      cacheWrite: 0,
      totalTokens: freshInput + cachedInput + output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

test("parseVerdict accepts a well-formed verdict", () => {
  const verdict = parseVerdict(
    { status: "changes_requested", issues: [{ severity: "major", what: "fix it" }], summary: "s" },
    "run-id",
  );
  expect(verdict.status).toBe("changes_requested");
  expect(verdict.issues[0]?.severity).toBe("major");
  expect(verdict.summary).toBe("s");
});

test("parseVerdict rejects a bad status, non-array issues, a missing what, and a non-object", () => {
  const cases: unknown[] = [
    { status: "yes", issues: [], summary: "s" },
    { status: "approved", issues: "none", summary: "s" },
    { status: "approved", issues: [{ severity: "major" }], summary: "s" },
    { status: "approved", issues: [{ severity: "wat", what: "x" }], summary: "s" },
    { status: "approved", issues: [], summary: 5 },
    ["not", "an", "object"],
    null,
    "string",
  ];
  for (const value of cases) {
    let caught: unknown;
    try {
      parseVerdict(value, "run-id");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OrchestrationError);
    expect((caught as OrchestrationError).code).toBe("malformed_verdict");
  }
});

test("direct pipeline captures FollowUps with engine provenance and closes them without orchestrator", async () => {
  const fx = fixture();
  const coder = fx.role("coder", "Trusted coder prompt bytes.", [SUBMIT_FOLLOW_UP_TOOL_NAME]);
  const reviewer = reviewerRole(fx);
  fx.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall(SUBMIT_FOLLOW_UP_TOOL_NAME, {
        kind: "note",
        title: "Remember the discovered constraint",
        evidence: [{ summary: "Observed in the implementation", path: "src/a.ts", line: 1 }],
      }),
    ),
    fauxAssistantMessage("coded"),
    ...reviewerTurn({ status: "approved", issues: [], summary: "good" }),
  ]);

  const result = await runPipeline({
    targetDir: fx.targetDir,
    models: fx.models,
    task: "implement",
    maxRounds: 1,
    roles: { coder, reviewer },
    projectStoreConfig: { projectOperations: { branch: "feature/coordinator" } },
    coordinator: { runId: "direct-follow-up" },
  });
  const checkpoint = JSON.parse(
    fs.readFileSync(
      path.join(fx.targetDir, ".ad-coder", "runs", "coordinator-direct-follow-up.json"),
      "utf8",
    ),
  ).value;
  expect(result.approved).toBe(true);
  expect(checkpoint.followUps).toHaveLength(1);
  expect(checkpoint.followUps[0].provenance).toEqual([
    { producer: "coder", runId: result.runIds[0], branch: "feature/coordinator" },
  ]);
  expect(
    fs.readFileSync(path.join(fx.targetDir, "docs", "notes", "candidates.md"), "utf8"),
  ).toContain("<!-- ad-coder:");
});

test("every workflow producer and repeated reviewer rounds receive engine-authored FollowUp provenance", async () => {
  const fx = fixture();
  const tools = ["bash", "read", SUBMIT_FOLLOW_UP_TOOL_NAME];
  const planner = fx.role("planner", "planner bytes\t", [...tools, SUBMIT_PLAN_TOOL_NAME]);
  const security = fx.role("security", "security bytes\t", tools);
  const coder = fx.role("coder", "coder bytes\t", tools);
  const reviewer = fx.role("reviewer", "reviewer bytes\t", [...tools, SUBMIT_VERDICT_TOOL_NAME]);
  const followUp = (title: string) =>
    fauxAssistantMessage(
      fauxToolCall(SUBMIT_FOLLOW_UP_TOOL_NAME, {
        kind: "note",
        title,
        evidence: [{ summary: "structural observation", path: "src/a.ts", line: 1 }],
      }),
    );
  fx.faux.setResponses([
    followUp("planner note"),
    ...plannerTurn({ complexity: "medium", securitySurface: "elevated", summary: "plan" }),
    followUp("security note"),
    fauxAssistantMessage("security"),
    followUp("coder one note"),
    fauxAssistantMessage("code one"),
    followUp("review one note"),
    ...reviewerTurn({
      status: "changes_requested",
      issues: [{ severity: "major", what: "adjust" }],
      summary: "retry",
    }),
    followUp("coder two note"),
    fauxAssistantMessage("code two"),
    followUp("review two note"),
    ...reviewerTurn({ status: "approved", issues: [], summary: "done" }),
  ]);

  const session = createWorkflowSession({
    targetDir: fx.targetDir,
    models: fx.models,
    task: "implement",
    maxRounds: 2,
    roles: { planner, security, coder, reviewer },
    projectStoreConfig: { projectOperations: { branch: "feature/matrix" } },
  });
  let state = session.initialState();
  const captured: Array<{ phase: string; producer: string; branch?: string }> = [];
  while (!state.done) {
    const stepped = await session.step(state);
    for (const item of stepped.result.followUps ?? []) {
      const provenance = item.provenance[0];
      if (provenance !== undefined)
        captured.push({
          phase: stepped.result.phase,
          producer: provenance.producer,
          ...(provenance.branch !== undefined && { branch: provenance.branch }),
        });
    }
    state = applyTransition(stepped.state, autoDriver(stepped.transitions));
  }
  expect(captured).toEqual([
    { phase: "plan", producer: "planner", branch: "feature/matrix" },
    { phase: "security", producer: "security", branch: "feature/matrix" },
    { phase: "code", producer: "coder", branch: "feature/matrix" },
    { phase: "review", producer: "reviewer", branch: "feature/matrix" },
    { phase: "code", producer: "coder", branch: "feature/matrix" },
    { phase: "review", producer: "reviewer", branch: "feature/matrix" },
  ]);
  expect(planner.role.systemPrompt).toBe("planner bytes\t");
  expect(security.role.systemPrompt).toBe("security bytes\t");
  expect(coder.role.systemPrompt).toBe("coder bytes\t");
  expect(reviewer.role.systemPrompt).toBe("reviewer bytes\t");
});

test("an explicit role tool allow-list does not gain submit_follow_up", async () => {
  const fx = fixture();
  fx.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall(SUBMIT_FOLLOW_UP_TOOL_NAME, {
        kind: "note",
        title: "must not capture",
        evidence: [{ summary: "attempt" }],
      }),
    ),
    fauxAssistantMessage("coded without the denied tool"),
  ]);
  const session = createWorkflowSession({
    targetDir: fx.targetDir,
    models: fx.models,
    task: "implement",
    maxRounds: 1,
    roles: { coder: fx.role("coder", "bytes", []), reviewer: reviewerRole(fx) },
  });
  const stepped = await session.step(session.initialState());
  expect(stepped.result.phase).toBe("code");
  expect(stepped.result.followUps).toEqual([]);
});

test("one round approve returns approved:true rounds:1", async () => {
  const fx = fixture();
  const planner = fx.role("planner", "You plan.");
  const coder = fx.role("coder", "You code.");
  const reviewer = reviewerRole(fx);
  const verdict: Verdict = { status: "approved", issues: [], summary: "looks good" };
  fx.faux.setResponses([
    fauxAssistantMessage("plan: do X"),
    fauxAssistantMessage("coded X"),
    ...reviewerTurn(verdict),
  ]);

  const result = await runPipeline({
    targetDir: fx.targetDir,
    models: fx.models,
    task: "implement X",
    maxRounds: 3,
    roles: { planner, coder, reviewer },
  });

  expect(result.approved).toBe(true);
  expect(result.rounds).toBe(1);
  expect(result.verdicts).toHaveLength(1);
  expect(result.verdicts[0]?.status).toBe("approved");
  expect(result.stageMetrics?.map((metric) => metric.stage)).toEqual([
    "plan",
    "code:1",
    "review:1",
  ]);
  for (const metric of result.stageMetrics ?? []) {
    expect(metric.input).toBe(metric.freshInput + metric.cachedInput);
    expect(metric.readFiles).toEqual([]);
    expect(metric.contextStrategy).toBe("auto");
  }
});

test("pipeline aggregates exact multi-response stage observations in stable order", async () => {
  const fx = fixture();
  execFileSync("git", ["init", "-q"], { cwd: fx.targetDir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: fx.targetDir });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], {
    cwd: fx.targetDir,
  });
  fs.writeFileSync(path.join(fx.targetDir, "tracked.txt"), "base\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: fx.targetDir });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: fx.targetDir });
  const plan = { complexity: "medium", securitySurface: "none", summary: "plan" } as const;
  const verdict: Verdict = { status: "approved", issues: [], summary: "ok" };
  fx.faux.setResponses([
    responseWithUsage(
      fauxAssistantMessage([
        fauxToolCall("read", { path: "tracked.txt" }, { id: "plan-read-1" }),
        fauxToolCall("read", { path: "tracked.txt" }, { id: "plan-read-2" }),
        fauxToolCall(SUBMIT_PLAN_TOOL_NAME, plan, { id: "plan-submit" }),
      ]),
      10,
      3,
      2,
    ),
    responseWithUsage(fauxAssistantMessage("planned"), 4, 5, 6),
    responseWithUsage(
      fauxAssistantMessage(
        fauxToolCall("write", { path: "tracked.txt", content: "changed\n" }, { id: "write" }),
      ),
      7,
      11,
      13,
    ),
    responseWithUsage(fauxAssistantMessage("coded"), 17, 19, 23),
    responseWithUsage(
      fauxAssistantMessage([
        fauxToolCall("read", { path: "tracked.txt" }, { id: "review-read" }),
        fauxToolCall(SUBMIT_VERDICT_TOOL_NAME, verdict, { id: "review-submit" }),
      ]),
      29,
      31,
      37,
    ),
    responseWithUsage(fauxAssistantMessage("reviewed"), 41, 43, 47),
  ]);

  const result = await runPipeline({
    targetDir: fx.targetDir,
    models: fx.models,
    task: "implement metrics",
    maxRounds: 1,
    compaction: { mode: "disabled-then-halt" },
    roles: {
      planner: fx.role("planner", "You plan.", ["read", SUBMIT_PLAN_TOOL_NAME], "short"),
      coder: fx.role("coder", "You code.", ["read", "write"], "short"),
      reviewer: fx.role("reviewer", "You review.", ["read", SUBMIT_VERDICT_TOOL_NAME], "short"),
    },
  });
  const cumulativeDiff = execFileSync("git", ["diff", "--no-ext-diff", "--no-textconv"], {
    cwd: fx.targetDir,
  }).byteLength;

  expect(result.stageMetrics).toEqual([
    {
      stage: "plan",
      input: 903,
      cachedInput: 164,
      freshInput: 739,
      output: 36,
      readFiles: ["tracked.txt"],
      readFilesTotal: 1,
      readFilesTruncated: 0,
      diffBytes: 0,
      contextStrategy: "disabled-then-halt",
    },
    {
      stage: "code:1",
      input: 585,
      cachedInput: 13,
      freshInput: 572,
      output: 15,
      readFiles: [],
      readFilesTotal: 0,
      readFilesTruncated: 0,
      diffBytes: cumulativeDiff,
      contextStrategy: "disabled-then-halt",
    },
    {
      stage: "review:1",
      input: 791,
      cachedInput: 118,
      freshInput: 673,
      output: 25,
      readFiles: ["tracked.txt"],
      readFilesTotal: 1,
      readFilesTruncated: 0,
      diffBytes: cumulativeDiff,
      contextStrategy: "disabled-then-halt",
    },
  ]);
});

test("two rounds: reviewer round-1 issue is threaded into the coder round-2 prompt", async () => {
  const fx = fixture();
  const coderPrompts: string[] = [];
  const coderStep =
    (label: string): FauxResponseFactory =>
    (context) => {
      coderPrompts.push(lastUserText(context));
      return fauxAssistantMessage(`coded ${label}`);
    };
  const coder = fx.role("coder", "You code.");
  const reviewer = reviewerRole(fx);
  const changes: Verdict = {
    status: "changes_requested",
    issues: [{ severity: "major", what: "add a null check on the input" }],
    summary: "needs a fix",
  };
  const approve: Verdict = { status: "approved", issues: [], summary: "fixed" };
  fx.faux.setResponses([
    coderStep("round1"),
    ...reviewerTurn(changes),
    coderStep("round2"),
    ...reviewerTurn(approve),
  ]);

  const result = await runPipeline({
    targetDir: fx.targetDir,
    models: fx.models,
    task: "implement Y",
    maxRounds: 3,
    roles: { coder, reviewer },
  });

  expect(result.approved).toBe(true);
  expect(result.rounds).toBe(2);
  expect(coderPrompts).toHaveLength(2);
  expect(coderPrompts[1]).toContain("add a null check on the input");
});

test("maxRounds exhausted returns approved:false without throwing", async () => {
  const fx = fixture();
  const coder = fx.role("coder", "You code.");
  const reviewer = reviewerRole(fx);
  const changes: Verdict = {
    status: "changes_requested",
    issues: [{ severity: "blocker", what: "still broken" }],
    summary: "no",
  };
  fx.faux.setResponses([fauxAssistantMessage("coded once"), ...reviewerTurn(changes)]);

  const result = await runPipeline({
    targetDir: fx.targetDir,
    models: fx.models,
    task: "implement Z",
    maxRounds: 1,
    roles: { coder, reviewer },
  });

  expect(result.approved).toBe(false);
  expect(result.outcome).toBe("decomposition_required");
  expect(result.rounds).toBe(1);
  expect(result.verdicts[0]?.status).toBe("changes_requested");
});

test("a shared ledger sink carries distinct role/step records per round", async () => {
  const fx = fixture();
  const sink = new MemoryLedgerSink();
  const planner = fx.role("planner", "You plan.");
  const coder = fx.role("coder", "You code.");
  const reviewer = reviewerRole(fx);
  const changes: Verdict = {
    status: "changes_requested",
    issues: [{ severity: "minor", what: "tweak" }],
    summary: "again",
  };
  fx.faux.setResponses([
    fauxAssistantMessage("plan"),
    fauxAssistantMessage("code r1"),
    ...reviewerTurn(changes),
    fauxAssistantMessage("code r2"),
    ...reviewerTurn(changes),
  ]);

  const result = await runPipeline({
    targetDir: fx.targetDir,
    models: fx.models,
    task: "implement W",
    maxRounds: 2,
    roles: { planner, coder, reviewer },
    ledgerSink: sink,
  });

  expect(result.approved).toBe(false);
  expect(result.rounds).toBe(2);
  const seen = sink.records().map((r) => `${r.role}/${r.step}`);
  expect(seen).toContain("planner/plan");
  expect(seen).toContain("coder/code:1");
  expect(seen).toContain("coder/code:2");
  expect(seen).toContain("reviewer/review:1");
  expect(seen).toContain("reviewer/review:2");
  expect(result.stageMetrics.map((metric) => metric.stage)).toEqual([
    "plan",
    "code:1",
    "review:1",
    "code:2",
    "review:2",
  ]);
  for (const metric of result.stageMetrics) {
    const records = sink.records().filter((record) => record.step === metric.stage);
    const freshInput = records.reduce((total, record) => total + record.usage.input, 0);
    const cachedInput = records.reduce((total, record) => total + record.usage.cacheRead, 0);
    expect(metric).toMatchObject({
      freshInput,
      cachedInput,
      input: freshInput + cachedInput,
      output: records.reduce((total, record) => total + record.usage.output, 0),
      readFiles: [],
      readFilesTotal: 0,
      readFilesTruncated: 0,
      diffBytes: 0,
      contextStrategy: "auto",
    });
  }
});

test("a reviewer that never calls submit_verdict throws OrchestrationError missing_verdict", async () => {
  const fx = fixture();
  const coder = fx.role("coder", "You code.");
  const reviewer = reviewerRole(fx);
  // Reviewer emits only text -- no submit_verdict tool call.
  fx.faux.setResponses([
    fauxAssistantMessage("coded"),
    fauxAssistantMessage("I reviewed but submitted no verdict"),
  ]);

  let caught: unknown;
  try {
    await runPipeline({
      targetDir: fx.targetDir,
      models: fx.models,
      task: "implement V",
      maxRounds: 1,
      roles: { coder, reviewer },
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(OrchestrationError);
  expect((caught as OrchestrationError).code).toBe("missing_verdict");
});

test("a malformed submission throws OrchestrationError malformed_verdict", async () => {
  const fx = fixture();
  const coder = fx.role("coder", "You code.");
  const reviewer = reviewerRole(fx);
  // status "yes" passes the permissive schema but fails parseVerdict.
  fx.faux.setResponses([
    fauxAssistantMessage("coded"),
    ...reviewerTurn({ status: "yes", issues: [], summary: "s" }),
  ]);

  let caught: unknown;
  try {
    await runPipeline({
      targetDir: fx.targetDir,
      models: fx.models,
      task: "implement U",
      maxRounds: 1,
      roles: { coder, reviewer },
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(OrchestrationError);
  expect((caught as OrchestrationError).code).toBe("malformed_verdict");
});

test("parsePlan accepts a well-formed plan and rejects bad complexity / bad securitySurface / non-string summary / non-object", () => {
  const plan = parsePlan(
    { complexity: "medium", securitySurface: "elevated", summary: "s" },
    "run-id",
  );
  expect(plan.complexity).toBe("medium");
  expect(plan.securitySurface).toBe("elevated");
  expect(plan.summary).toBe("s");
  expect(plan.contractRequirements).toEqual([]);

  const contracted = parsePlan(
    {
      complexity: "medium",
      securitySurface: "low",
      summary: "s",
      contractRequirements: ["Headless-first."],
    },
    "run-id",
  );
  expect(contracted.contractRequirements).toEqual(["Headless-first."]);

  const cases: unknown[] = [
    { complexity: "huge", securitySurface: "none", summary: "s" },
    { complexity: "medium", securitySurface: "extreme", summary: "s" },
    { complexity: "medium", summary: "s" },
    { complexity: "medium", securitySurface: "none", summary: 5 },
    { complexity: "medium", securitySurface: "none", summary: "s", contractRequirements: "x" },
    { complexity: "medium", securitySurface: "none", summary: "s", contractRequirements: null },
    { complexity: "medium", securitySurface: "none", summary: "s", contractRequirements: [""] },
    ["not", "an", "object"],
    null,
    "string",
  ];
  for (const value of cases) {
    let caught: unknown;
    try {
      parsePlan(value, "run-id");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OrchestrationError);
    expect((caught as OrchestrationError).code).toBe("malformed_plan");
  }
});

test("a planner submission carries contract requirements into the coder prompt and result", async () => {
  const fx = fixture();
  const planner = plannerRole(fx);
  const coder = fx.role("coder", "You code.");
  const reviewer = reviewerRole(fx);
  const verdict: Verdict = { status: "approved", issues: [], summary: "ok" };
  const coderPrompts: string[] = [];
  const coderStep: FauxResponseFactory = (context) => {
    coderPrompts.push(lastUserText(context));
    return fauxAssistantMessage("coded");
  };
  fx.faux.setResponses([
    ...plannerTurn({
      complexity: "medium",
      securitySurface: "low",
      summary: "plan summary",
      contractRequirements: ["Headless-first."],
    }),
    coderStep,
    ...reviewerTurn(verdict),
  ]);

  const result = await runPipeline({
    targetDir: fx.targetDir,
    models: fx.models,
    task: "implement P",
    maxRounds: 3,
    roles: { planner, coder, reviewer },
  });

  expect(result.approved).toBe(true);
  expect(result.complexity).toBe("medium");
  expect(result.securitySurface).toBe("low");
  expect(result.contractRequirements).toEqual(["Headless-first."]);
  expect(coderPrompts[0]).toContain("Applicable project contracts (blocking requirements):");
  expect(coderPrompts[0]).toContain("- Headless-first.");
});

test("a planner emitting only text leaves result.complexity undefined and the run approves", async () => {
  const fx = fixture();
  const planner = plannerRole(fx);
  const coder = fx.role("coder", "You code.");
  const reviewer = reviewerRole(fx);
  const verdict: Verdict = { status: "approved", issues: [], summary: "ok" };
  fx.faux.setResponses([
    fauxAssistantMessage("plan: do X, no tool call"),
    fauxAssistantMessage("coded"),
    ...reviewerTurn(verdict),
  ]);

  const result = await runPipeline({
    targetDir: fx.targetDir,
    models: fx.models,
    task: "implement Q",
    maxRounds: 3,
    roles: { planner, coder, reviewer },
  });

  expect(result.approved).toBe(true);
  expect(result.complexity).toBeUndefined();
});

test("a malformed submit_plan throws OrchestrationError malformed_plan", async () => {
  const fx = fixture();
  const planner = plannerRole(fx);
  const coder = fx.role("coder", "You code.");
  const reviewer = reviewerRole(fx);
  // securitySurface "extreme" passes the permissive schema but fails parsePlan.
  fx.faux.setResponses([
    ...plannerTurn({ complexity: "medium", securitySurface: "extreme", summary: "s" }),
  ]);

  let caught: unknown;
  try {
    await runPipeline({
      targetDir: fx.targetDir,
      models: fx.models,
      task: "implement R",
      maxRounds: 1,
      roles: { planner, coder, reviewer },
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(OrchestrationError);
  expect((caught as OrchestrationError).code).toBe("malformed_plan");
});

test("elevated surface + security role runs the phase and threads its text to the coder round-1 prompt", async () => {
  const fx = fixture();
  const sink = new MemoryLedgerSink();
  const planner = plannerRole(fx);
  const security = securityRole(fx);
  const reviewer = reviewerRole(fx);
  const coderPrompts: string[] = [];
  const coderStep =
    (label: string): FauxResponseFactory =>
    (context) => {
      coderPrompts.push(lastUserText(context));
      return fauxAssistantMessage(`coded ${label}`);
    };
  const coder = fx.role("coder", "You code.");
  const verdict: Verdict = { status: "approved", issues: [], summary: "ok" };
  fx.faux.setResponses([
    ...plannerTurn({ complexity: "complex", securitySurface: "elevated", summary: "plan summary" }),
    ...securityTurn("Injection: sanitize the id path segment before fs.readFile"),
    coderStep("round1"),
    ...reviewerTurn(verdict),
  ]);

  const result = await runPipeline({
    targetDir: fx.targetDir,
    models: fx.models,
    task: "implement S",
    maxRounds: 3,
    roles: { planner, security, coder, reviewer },
    ledgerSink: sink,
  });

  expect(result.approved).toBe(true);
  expect(result.securitySurface).toBe("elevated");
  const seen = sink.records().map((r) => `${r.role}/${r.step}`);
  expect(seen).toContain("security/security");
  expect(coderPrompts).toHaveLength(1);
  expect(coderPrompts[0]).toContain("sanitize the id path segment");
});

test("elevated surface + no security role skips the phase and the run approves", async () => {
  const fx = fixture();
  const sink = new MemoryLedgerSink();
  const planner = plannerRole(fx);
  const coder = fx.role("coder", "You code.");
  const reviewer = reviewerRole(fx);
  const verdict: Verdict = { status: "approved", issues: [], summary: "ok" };
  fx.faux.setResponses([
    ...plannerTurn({ complexity: "complex", securitySurface: "elevated", summary: "plan summary" }),
    fauxAssistantMessage("coded"),
    ...reviewerTurn(verdict),
  ]);

  const result = await runPipeline({
    targetDir: fx.targetDir,
    models: fx.models,
    task: "implement T",
    maxRounds: 3,
    roles: { planner, coder, reviewer },
    ledgerSink: sink,
  });

  expect(result.approved).toBe(true);
  expect(result.securitySurface).toBe("elevated");
  const steps = sink.records().map((r) => r.step);
  expect(steps).not.toContain("security");
});

test("a non-elevated surface does not run the security phase even when a security role is configured", async () => {
  const fx = fixture();
  const sink = new MemoryLedgerSink();
  const planner = plannerRole(fx);
  const security = securityRole(fx);
  const coder = fx.role("coder", "You code.");
  const reviewer = reviewerRole(fx);
  const verdict: Verdict = { status: "approved", issues: [], summary: "ok" };
  fx.faux.setResponses([
    ...plannerTurn({ complexity: "medium", securitySurface: "low", summary: "plan summary" }),
    fauxAssistantMessage("coded"),
    ...reviewerTurn(verdict),
  ]);

  const result = await runPipeline({
    targetDir: fx.targetDir,
    models: fx.models,
    task: "implement N",
    maxRounds: 3,
    roles: { planner, security, coder, reviewer },
    ledgerSink: sink,
  });

  expect(result.approved).toBe(true);
  expect(result.securitySurface).toBe("low");
  const steps = sink.records().map((r) => r.step);
  expect(steps).not.toContain("security");
});

// -- Complexity-aware routing ------------------------------------------------
//
// These cases prove config.routing drives the per-turn model. A three-model
// faux provider ('cheap'/'mid'/'strong') backs a hand-built ResolvedRegistry;
// each turn is scripted with a factory that records the streamed model.id, so
// selection is asserted on the ACTUAL resolved model, not just prompt text.

const ROUTE_MODELS = ["cheap", "mid", "strong"] as const;

interface RoutingFixture {
  faux: FauxProviderHandle;
  registry: ResolvedRegistry;
  targetDir: string;
  getModel(name: string): Model<Api>;
  /** A RoleSpec whose own model is `specModel` (used only on the routing-absent path). */
  role(
    name: string,
    specModel: string,
    activeToolNames?: string[],
    thinkingLevel?: ThinkingLevel,
  ): RoleSpec;
}

/** A faux provider with three models + a hand-built ResolvedRegistry over them. */
function routingFixture(): RoutingFixture {
  const faux = fauxProvider({
    provider: "faux",
    models: ROUTE_MODELS.map((id) => ({ id, contextWindow: CONTEXT_WINDOW })),
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const targetDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-route-")));

  const getModel = (name: string): Model<Api> => {
    const m = faux.getModel(name);
    if (m === undefined) {
      throw new Error(`routingFixture: no faux model "${name}"`);
    }
    return m as Model<Api>;
  };
  const registry: ResolvedRegistry = {
    models,
    getModel,
    lookup(name) {
      return { models, model: getModel(name) };
    },
  };

  return {
    faux,
    registry,
    targetDir,
    getModel,
    role(name, specModel, activeToolNames = ["bash", "read", "write", "edit"], thinkingLevel) {
      const model = getModel(specModel);
      const role: Role = defineRole(
        {
          name,
          provider: "faux",
          modelId: model.id,
          systemPrompt: `You ${name}.`,
          activeToolNames,
          cacheRetention: "none",
          contextBudget: { ...BUDGET },
          ...(thinkingLevel !== undefined && { thinkingLevel }),
        },
        model,
      );
      return { role, model };
    },
  };
}

/** Records the model.id the turn streamed on, under `key`, then returns `message`. */
function recordStep(
  log: Record<string, string>,
  key: string,
  message: ReturnType<typeof fauxAssistantMessage>,
): FauxResponseFactory {
  return (_context, _options, _state, model) => {
    log[key] = model.id;
    return message;
  };
}

/** Records the request reasoning value emitted by pi for the configured thinking level. */
function recordRoutedStep(
  modelLog: Record<string, string>,
  thinkingLog: Record<string, ThinkingLevel | undefined>,
  key: string,
  message: ReturnType<typeof fauxAssistantMessage>,
): FauxResponseFactory {
  return (_context, options, _state, model) => {
    modelLog[key] = model.id;
    thinkingLog[key] = options?.reasoning as ThinkingLevel | undefined;
    return message;
  };
}

/** A planner turn that records its model under 'planner', then submits `args`. */
function plannerTurnRec(
  log: Record<string, string>,
  args: Plan | Record<string, unknown>,
): FauxResponseStep[] {
  return [
    recordStep(log, "planner", fauxAssistantMessage(fauxToolCall(SUBMIT_PLAN_TOOL_NAME, args))),
    fauxAssistantMessage("plan text"),
  ];
}

/** A reviewer turn that records its model under 'reviewer', then submits `args`. */
function reviewerTurnRec(
  log: Record<string, string>,
  args: Verdict | Record<string, unknown>,
): FauxResponseStep[] {
  return [
    recordStep(log, "reviewer", fauxAssistantMessage(fauxToolCall(SUBMIT_VERDICT_TOOL_NAME, args))),
    fauxAssistantMessage("review complete"),
  ];
}

/** buildDefaultProfile over the three routing model NAMES. */
function defaultRouteProfile(): Profile {
  return buildDefaultProfile({ strong: "strong", mid: "mid", cheap: "cheap" });
}

test("routing (a): planner complexity 'complex' routes the coder to the strong model", async () => {
  const fx = routingFixture();
  const log: Record<string, string> = {};
  const thinkingLevels: Record<string, ThinkingLevel | undefined> = {};
  const planner = fx.role("planner", "mid", [
    "bash",
    "read",
    "write",
    "edit",
    SUBMIT_PLAN_TOOL_NAME,
  ]);
  const coder = fx.role("coder", "mid");
  const reviewer = fx.role("reviewer", "mid", [
    "bash",
    "read",
    "write",
    "edit",
    SUBMIT_VERDICT_TOOL_NAME,
  ]);
  const verdict: Verdict = { status: "approved", issues: [], summary: "ok" };
  const base = defaultRouteProfile();
  const profile: Profile = {
    entries: base.entries.map((entry) =>
      entry.role === "coder" && entry.complexity === "complex"
        ? { ...entry, thinkingLevel: "high" }
        : entry.role === "reviewer" && entry.complexity === "complex"
          ? { ...entry, thinkingLevel: "low" }
          : entry,
    ),
  };
  fx.faux.setResponses([
    ...plannerTurnRec(log, { complexity: "complex", securitySurface: "low", summary: "plan" }),
    recordRoutedStep(log, thinkingLevels, "coder", fauxAssistantMessage("coded")),
    recordRoutedStep(
      log,
      thinkingLevels,
      "reviewer",
      fauxAssistantMessage(fauxToolCall(SUBMIT_VERDICT_TOOL_NAME, verdict)),
    ),
    fauxAssistantMessage("review complete"),
  ]);

  const routing: PipelineRouting = { profile, registry: fx.registry };
  const result = await runPipeline({
    targetDir: fx.targetDir,
    models: fx.registry.models,
    task: "implement A",
    maxRounds: 3,
    roles: { planner, coder, reviewer },
    routing,
  });

  expect(result.approved).toBe(true);
  expect(result.complexity).toBe("complex");
  // coder @ complex -> strong; reviewer -> mid at every complexity.
  expect(log.coder).toBe("strong");
  expect(log.reviewer).toBe("mid");
  expect(thinkingLevels).toEqual({ coder: "high", reviewer: "low" });
});

test("routing (b): planner complexity 'trivial' routes the coder to the cheap model", async () => {
  const fx = routingFixture();
  const log: Record<string, string> = {};
  const planner = fx.role("planner", "mid", [
    "bash",
    "read",
    "write",
    "edit",
    SUBMIT_PLAN_TOOL_NAME,
  ]);
  const coder = fx.role("coder", "mid");
  const reviewer = fx.role("reviewer", "mid", [
    "bash",
    "read",
    "write",
    "edit",
    SUBMIT_VERDICT_TOOL_NAME,
  ]);
  const verdict: Verdict = { status: "approved", issues: [], summary: "ok" };
  fx.faux.setResponses([
    ...plannerTurnRec(log, { complexity: "trivial", securitySurface: "none", summary: "plan" }),
    recordStep(log, "coder", fauxAssistantMessage("coded")),
    ...reviewerTurnRec(log, verdict),
  ]);

  const routing: PipelineRouting = { profile: defaultRouteProfile(), registry: fx.registry };
  const result = await runPipeline({
    targetDir: fx.targetDir,
    models: fx.registry.models,
    task: "implement B",
    maxRounds: 3,
    roles: { planner, coder, reviewer },
    routing,
  });

  expect(result.approved).toBe(true);
  expect(result.complexity).toBe("trivial");
  expect(log.coder).toBe("cheap");
});

test("routing (c): a coder override wins over the (coder, complexity) cell", async () => {
  const fx = routingFixture();
  const log: Record<string, string> = {};
  const thinkingLevels: Record<string, ThinkingLevel | undefined> = {};
  const planner = fx.role("planner", "mid", [
    "bash",
    "read",
    "write",
    "edit",
    SUBMIT_PLAN_TOOL_NAME,
  ]);
  const coder = fx.role("coder", "mid");
  const reviewer = fx.role("reviewer", "mid", [
    "bash",
    "read",
    "write",
    "edit",
    SUBMIT_VERDICT_TOOL_NAME,
  ]);
  const verdict: Verdict = { status: "approved", issues: [], summary: "ok" };
  fx.faux.setResponses([
    // trivial would route the coder to 'cheap'; the override must beat it.
    ...plannerTurnRec(log, { complexity: "trivial", securitySurface: "none", summary: "plan" }),
    recordRoutedStep(log, thinkingLevels, "coder", fauxAssistantMessage("coded")),
    ...reviewerTurnRec(log, verdict),
  ]);

  const routing: PipelineRouting = {
    profile: defaultRouteProfile(),
    registry: fx.registry,
    overrides: { coder: { model: "strong", thinkingLevel: "minimal" } },
  };
  const result = await runPipeline({
    targetDir: fx.targetDir,
    models: fx.registry.models,
    task: "implement C",
    maxRounds: 3,
    roles: { planner, coder, reviewer },
    routing,
  });

  expect(result.approved).toBe(true);
  // Override 'strong' wins over the trivial cell's 'cheap'.
  expect(log.coder).toBe("strong");
  expect(thinkingLevels.coder).toBe("minimal");
});

test("routing (d): the pre-complexity planner routes on defaultComplexity, not the submitted tier", async () => {
  const fx = routingFixture();
  const log: Record<string, string> = {};
  // A profile whose PLANNER row varies per complexity, so the model the planner
  // runs on reveals which complexity it was resolved at.
  const base = defaultRouteProfile();
  const profile: Profile = {
    entries: base.entries.map((e) =>
      e.role === "planner"
        ? {
            ...e,
            model:
              e.complexity === "trivial" ? "cheap" : e.complexity === "medium" ? "mid" : "strong",
          }
        : e,
    ),
  };
  const planner = fx.role("planner", "mid", [
    "bash",
    "read",
    "write",
    "edit",
    SUBMIT_PLAN_TOOL_NAME,
  ]);
  const coder = fx.role("coder", "mid");
  const reviewer = fx.role("reviewer", "mid", [
    "bash",
    "read",
    "write",
    "edit",
    SUBMIT_VERDICT_TOOL_NAME,
  ]);
  const verdict: Verdict = { status: "approved", issues: [], summary: "ok" };
  fx.faux.setResponses([
    // Planner SUBMITS 'complex' (planner row -> strong), but it is resolved
    // BEFORE the plan, on defaultComplexity 'trivial' (planner row -> cheap).
    ...plannerTurnRec(log, { complexity: "complex", securitySurface: "none", summary: "plan" }),
    recordStep(log, "coder", fauxAssistantMessage("coded")),
    ...reviewerTurnRec(log, verdict),
  ]);

  const routing: PipelineRouting = {
    profile,
    registry: fx.registry,
    defaultComplexity: "trivial",
  };
  const result = await runPipeline({
    targetDir: fx.targetDir,
    models: fx.registry.models,
    task: "implement D",
    maxRounds: 3,
    roles: { planner, coder, reviewer },
    routing,
  });

  expect(result.approved).toBe(true);
  // Pre-complexity: planner resolved at defaultComplexity 'trivial' -> cheap,
  // NOT the submitted 'complex' -> strong.
  expect(log.planner).toBe("cheap");
  // The coder, resolved AFTER the plan, uses the submitted 'complex' -> strong.
  expect(log.coder).toBe("strong");
});

test("routing (e): with no routing, each turn runs on its own RoleSpec.model", async () => {
  const fx = routingFixture();
  const log: Record<string, string> = {};
  const thinkingLevels: Record<string, ThinkingLevel | undefined> = {};
  const coder = fx.role("coder", "cheap", undefined, "medium");
  const reviewer = fx.role("reviewer", "strong", [
    "bash",
    "read",
    "write",
    "edit",
    SUBMIT_VERDICT_TOOL_NAME,
  ]);
  const verdict: Verdict = { status: "approved", issues: [], summary: "ok" };
  fx.faux.setResponses([
    recordRoutedStep(log, thinkingLevels, "coder", fauxAssistantMessage("coded")),
    ...reviewerTurnRec(log, verdict),
  ]);

  const result = await runPipeline({
    targetDir: fx.targetDir,
    models: fx.registry.models,
    task: "implement E",
    maxRounds: 1,
    roles: { coder, reviewer },
  });

  expect(result.approved).toBe(true);
  // Routing absent: the configured RoleSpec.model is used verbatim.
  expect(log.coder).toBe("cheap");
  expect(log.reviewer).toBe("strong");
  expect(thinkingLevels.coder).toBe("medium");
});

/**
 * Drive a session to completion with a supplied driver, returning the settled
 * state. Mirrors runPipeline's loop but lets a test choose each transition (the
 * whole point of the stepped engine) rather than always taking the default.
 */
async function drive(
  session: ReturnType<typeof createWorkflowSession>,
  driver: (transitions: AvailableTransition[], state: WorkflowState) => AvailableTransition,
): Promise<WorkflowState> {
  let state = session.initialState();
  while (!state.done) {
    const { state: settled, transitions } = await session.step(state);
    state = applyTransition(settled, driver(transitions, settled));
  }
  return state;
}

/** Sum the provider-reported total cost across every ledger record. */
function totalCost(sink: MemoryLedgerSink): number {
  return sink.records().reduce((acc, r) => acc + r.usage.cost.total, 0);
}

test("stepped: auto-driver yields the same verdict/rounds/ledger as runPipeline", async () => {
  const changes: Verdict = {
    status: "changes_requested",
    issues: [{ severity: "major", what: "handle empty input" }],
    summary: "needs a fix",
  };
  const approve: Verdict = { status: "approved", issues: [], summary: "fixed" };
  const scenario = () => [
    fauxAssistantMessage("plan it"),
    fauxAssistantMessage("code r1"),
    ...reviewerTurn(changes),
    fauxAssistantMessage("code r2"),
    ...reviewerTurn(approve),
  ];

  // Reference: runPipeline over a fixed faux scenario.
  const a = fixture();
  const aSink = new MemoryLedgerSink();
  a.faux.setResponses(scenario());
  const viaPipeline = await runPipeline({
    targetDir: a.targetDir,
    models: a.models,
    task: "implement Q",
    maxRounds: 3,
    roles: {
      planner: a.role("planner", "You plan."),
      coder: a.role("coder", "You code."),
      reviewer: reviewerRole(a),
    },
    ledgerSink: aSink,
  });

  // Same scenario, driven step-by-step with autoDriver.
  const b = fixture();
  const bSink = new MemoryLedgerSink();
  b.faux.setResponses(scenario());
  const session = createWorkflowSession({
    targetDir: b.targetDir,
    models: b.models,
    task: "implement Q",
    maxRounds: 3,
    roles: {
      planner: b.role("planner", "You plan."),
      coder: b.role("coder", "You code."),
      reviewer: reviewerRole(b),
    },
    ledgerSink: bSink,
  });
  const settled = await drive(session, (transitions) => autoDriver(transitions));

  expect(settled.approved).toBe(viaPipeline.approved);
  expect(settled.verdicts.length).toBe(viaPipeline.rounds);
  expect(settled.verdicts).toEqual(viaPipeline.verdicts);
  const labels = (sink: MemoryLedgerSink) => sink.records().map((r) => `${r.role}/${r.step}`);
  expect(labels(bSink)).toEqual(labels(aSink));
  expect(totalCost(bSink)).toBe(totalCost(aSink));
});

test("stepped: a rework driver re-runs the coder with no review in between", async () => {
  const fx = fixture();
  const sink = new MemoryLedgerSink();
  const approve: Verdict = { status: "approved", issues: [], summary: "ok" };
  // code:1, then (rework) code:2, then review:2 approves.
  fx.faux.setResponses([
    fauxAssistantMessage("code r1"),
    fauxAssistantMessage("code r2"),
    ...reviewerTurn(approve),
  ]);
  const session = createWorkflowSession({
    targetDir: fx.targetDir,
    models: fx.models,
    task: "implement R",
    maxRounds: 3,
    roles: { coder: fx.role("coder", "You code."), reviewer: reviewerRole(fx) },
    ledgerSink: sink,
  });

  // Rework once out of the first code phase, then take defaults.
  let reworked = false;
  const settled = await drive(session, (transitions) => {
    const rework = transitions.find((t) => t.kind === "rework");
    if (!reworked && rework !== undefined) {
      reworked = true;
      return rework;
    }
    return autoDriver(transitions);
  });

  const steps = sink.records().map((r) => r.step);
  expect(steps).toContain("code:1");
  expect(steps).toContain("code:2");
  // Exactly one review round, and never a review:1 (the rework skipped it).
  const reviewSteps = [...new Set(steps.filter((s) => s.startsWith("review:")))];
  expect(reviewSteps).toEqual(["review:2"]);
  expect(steps).not.toContain("review:1");
  expect(settled.round).toBe(2);
  expect(settled.approved).toBe(true);
});

test("stepped: a stop-after-plan driver ends with no code or review records", async () => {
  const fx = fixture();
  const sink = new MemoryLedgerSink();
  const plan: Plan = { complexity: "medium", securitySurface: "none", summary: "s" };
  fx.faux.setResponses([...plannerTurn(plan)]);
  const session = createWorkflowSession({
    targetDir: fx.targetDir,
    models: fx.models,
    task: "implement S",
    maxRounds: 3,
    roles: {
      planner: plannerRole(fx),
      coder: fx.role("coder", "You code."),
      reviewer: reviewerRole(fx),
    },
    ledgerSink: sink,
  });

  // Stop immediately after the plan step instead of advancing to code.
  const settled = await drive(session, (transitions) => {
    const stop = transitions.find((t) => t.kind === "stop");
    return stop ?? autoDriver(transitions);
  });

  const steps = sink.records().map((r) => r.step);
  expect(steps).toContain("plan");
  expect(steps.some((s) => s.startsWith("code:"))).toBe(false);
  expect(steps.some((s) => s.startsWith("review:"))).toBe(false);
  expect(settled.done).toBe(true);
  expect(settled.approved).toBe(false);
  expect(settled.verdicts).toHaveLength(0);
});

test("workflow roles share one controller and stop before the next provider dispatch", async () => {
  const fx = fixture();
  const controller = new SessionLimitController({ maxTurns: 2 });
  fx.faux.setResponses([
    fauxAssistantMessage("plan text"),
    fauxAssistantMessage("coded"),
    fauxAssistantMessage("must not review"),
  ]);
  const session = createWorkflowSession({
    targetDir: fx.targetDir,
    models: fx.models,
    task: "implement limits",
    maxRounds: 1,
    roles: {
      planner: plannerRole(fx),
      coder: fx.role("coder", "You code."),
      reviewer: reviewerRole(fx),
    },
    sessionLimitController: controller,
  });

  await expect(drive(session, autoDriver)).rejects.toBeInstanceOf(SessionLimitError);
  expect(fx.faux.state.callCount).toBe(2);
  expect(controller.snapshot().admittedTurns).toBe(2);
});
