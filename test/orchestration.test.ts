import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import { COMPACTION_SAFETY_PROMPT } from "../src/context/compactor";
import { MemoryLedgerSink } from "../src/ledger/ledger";
import {
  buildSubmitFollowUpTool,
  SUBMIT_FOLLOW_UP_TOOL_NAME,
} from "../src/orchestration/follow-up";
import { runPipeline } from "../src/orchestration/pipeline";
import {
  formatPlannerInstruction,
  parsePlan,
  parsePlanText,
  SUBMIT_PLAN_TOOL_NAME,
} from "../src/orchestration/plan";
import {
  applyTransition,
  autoDriver,
  createWorkflowSession,
  selectPipelineContext,
} from "../src/orchestration/session";
import type {
  AvailableTransition,
  PipelineRouting,
  Plan,
  RoleSpec,
  Verdict,
  WorkflowState,
} from "../src/orchestration/types";
import { OrchestrationError } from "../src/orchestration/types";
import {
  buildSubmitVerdictTool,
  formatReviewerInstruction,
  parseVerdict,
  SUBMIT_VERDICT_TOOL_NAME,
} from "../src/orchestration/verdict";
import { buildDefaultProfile } from "../src/profiles/default-profile";
import type { Profile } from "../src/profiles/types";
import { ProjectOperationsError } from "../src/project-operations/errors";
import { type RunCheckpoint, RunCoordinator } from "../src/project-operations/run-coordinator";
import { ProjectStore } from "../src/project-store/project-store";
import { MODEL_INVENTORY_RESEARCH_BRIEF, RoleBriefError } from "../src/prompts/role-briefs";
import type { ResolvedRegistry } from "../src/registry/types";
import type { Role } from "../src/role";
import { defineRole } from "../src/role";
import { SessionLimitController, SessionLimitError } from "../src/session-limits";

const CONTEXT_WINDOW = 200_000;
const BUDGET = { maxTokens: 100_000, reserveTokens: 10_000, keepRecentTokens: 20_000 } as const;

test("incremental pipeline context keeps retries focused and widens deterministic hazards", () => {
  const base = {
    round: 2,
    diffBytes: 100,
    changedFiles: ["src/a.ts"],
    changedFilesTruncated: 0,
    evidencePresent: true,
  } as const;
  expect(selectPipelineContext(base)).toEqual({ selection: "focused" });
  expect(selectPipelineContext({ ...base, changedFiles: ["docs/contracts/quality.md"] })).toEqual({
    selection: "full",
    fallbackReason: "scope_drift",
  });
  expect(selectPipelineContext({ ...base, changedFiles: [".env.local"] })).toEqual({
    selection: "full",
    fallbackReason: "projection_redacted",
  });
  expect(selectPipelineContext({ ...base, evidencePresent: false })).toEqual({
    selection: "full",
    fallbackReason: "insufficient_evidence",
  });
  expect(selectPipelineContext({ ...base, riskChanged: true })).toEqual({
    selection: "full",
    fallbackReason: "risk_changed",
  });
  expect(
    selectPipelineContext({
      ...base,
      mode: { mode: "incremental", maxFocusedDiffBytes: 99 },
    }),
  ).toEqual({ selection: "full", fallbackReason: "material_diff" });
  expect(
    selectPipelineContext({
      ...base,
      mode: { mode: "incremental", maxFocusedDiffBytes: 0 },
    }),
  ).toEqual({ selection: "focused" });
});

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
  const submitted = governedPlan(args);
  return [
    fauxAssistantMessage(fauxToolCall(SUBMIT_PLAN_TOOL_NAME, submitted)),
    fauxAssistantMessage("plan text"),
  ];
}

function governedPlan(args: Plan | Record<string, unknown>): Plan | Record<string, unknown> {
  return "complexity" in args &&
    "securitySurface" in args &&
    "summary" in args &&
    !("surfaceAnalysis" in args)
    ? {
        ...args,
        surfaceAnalysis: {
          projectType: "TypeScript CLI/library",
          surfaces: [
            {
              id: "core",
              name: "programmatic core",
              rationale: "implementation changes core behavior",
            },
          ],
          coverage: [
            {
              surfaceId: "core",
              status: "not_applicable",
              contractIds: [],
              evidence: ["test fixture has no contract-sensitive behavior"],
              rationale: "no applicable contract in fixture",
            },
          ],
        },
      }
    : args;
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

test("submit_follow_up advertises discriminated variants and rejects all-fields calls safely", () => {
  const tool = buildSubmitFollowUpTool({ followUps: [] }, { producer: "coder", runId: "run-1" });
  const schema = tool.parameters as unknown as {
    anyOf: Array<{ properties: Record<string, unknown>; additionalProperties?: boolean }>;
  };
  expect(schema.anyOf.map((variant) => Object.keys(variant.properties).sort())).toEqual([
    ["contract", "evidence", "kind", "title"],
    ["evidence", "kind", "title"],
    ["document", "evidence", "kind", "title"],
    ["evidence", "kind", "priority", "title"],
  ]);
  expect(schema.anyOf.every((variant) => variant.additionalProperties === false)).toBe(true);

  const allFields = {
    kind: "note",
    title: "Auxiliary note",
    evidence: [{ summary: "Observed in a focused test" }],
    contract: "quality",
    document: "docs/ARCHITECTURE.md",
    priority: "high",
  };
  let diagnostic: unknown;
  try {
    tool.prepareArguments?.(allFields);
  } catch (error) {
    diagnostic = error;
  }
  expect(diagnostic).toBeInstanceOf(ProjectOperationsError);
  expect((diagnostic as ProjectOperationsError).code).toBe("invalid_follow_up");
  expect((diagnostic as ProjectOperationsError).detail).toBe("follow-up has an unknown field");
  expect((diagnostic as Error).message).not.toContain("Auxiliary note");
});

test("Coder and Reviewer primary results survive rejected all-fields follow-up metadata", async () => {
  const fx = fixture();
  const tools = [SUBMIT_FOLLOW_UP_TOOL_NAME];
  const coder = fx.role("coder", "You code.", tools);
  const reviewer = fx.role("reviewer", "You review.", [...tools, SUBMIT_VERDICT_TOOL_NAME]);
  const malformedFollowUp = (title: string) =>
    fauxAssistantMessage(
      fauxToolCall(SUBMIT_FOLLOW_UP_TOOL_NAME, {
        kind: "note",
        title,
        evidence: [{ summary: "Observed in the implementation" }],
        contract: "quality",
        document: "docs/ARCHITECTURE.md",
        priority: "high",
      }),
    );
  let reviewerPrompt = "";
  fx.faux.setResponses([
    malformedFollowUp("Coder auxiliary metadata"),
    fauxAssistantMessage("coder primary result"),
    malformedFollowUp("Reviewer auxiliary metadata"),
    (context) => {
      reviewerPrompt = lastUserText(context);
      return fauxAssistantMessage(
        fauxToolCall(SUBMIT_VERDICT_TOOL_NAME, {
          status: "approved",
          issues: [],
          summary: "primary review passed",
        }),
      );
    },
    fauxAssistantMessage("reviewer primary result"),
  ]);

  const result = await runPipeline({
    targetDir: fx.targetDir,
    models: fx.models,
    task: "implement",
    maxRounds: 1,
    roles: { coder, reviewer },
  });

  expect(reviewerPrompt).toContain("coder primary result");
  expect(result.approved).toBe(true);
  expect(result.verdicts).toEqual([
    { status: "approved", issues: [], summary: "primary review passed" },
  ]);
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
  const planner = plannerRole(fx);
  const coder = fx.role("coder", "You code.");
  const reviewer = reviewerRole(fx);
  const verdict: Verdict = { status: "approved", issues: [], summary: "looks good" };
  fx.faux.setResponses([
    ...plannerTurn({ complexity: "medium", securitySurface: "none", summary: "plan" }),
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
  const plan = governedPlan({ complexity: "medium", securitySurface: "none", summary: "plan" });
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
    monotonicNow: (() => {
      let time = 0;
      return () => (time += 100);
    })(),
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
      provider: "faux",
      model: "faux-1",
      thinkingLevel: "unknown",
      durationMs: 100,
      input: expect.any(Number),
      cachedInput: expect.any(Number),
      freshInput: expect.any(Number),
      output: 124,
      reasoning: 0,
      costUsd: 0,
      requestBytes: {
        systemPrompt: expect.any(Number),
        prompt: expect.any(Number),
        toolDefinitions: expect.any(Number),
        total: expect.any(Number),
      },
      readFiles: ["tracked.txt"],
      readFilesTotal: 1,
      readFilesTruncated: 0,
      diffBytes: 0,
      contextStrategy: "disabled-then-halt",
    },
    {
      stage: "code:1",
      provider: "faux",
      model: "faux-1",
      thinkingLevel: "unknown",
      durationMs: 100,
      input: expect.any(Number),
      cachedInput: expect.any(Number),
      freshInput: expect.any(Number),
      output: 15,
      reasoning: 0,
      costUsd: 0,
      requestBytes: {
        systemPrompt: expect.any(Number),
        prompt: expect.any(Number),
        toolDefinitions: expect.any(Number),
        total: expect.any(Number),
      },
      readFiles: [],
      readFilesTotal: 0,
      readFilesTruncated: 0,
      diffBytes: cumulativeDiff,
      contextStrategy: "disabled-then-halt",
      pipelineContextStrategy: "broad",
    },
    {
      stage: "review:1",
      provider: "faux",
      model: "faux-1",
      thinkingLevel: "unknown",
      durationMs: 100,
      input: expect.any(Number),
      cachedInput: expect.any(Number),
      freshInput: expect.any(Number),
      output: 25,
      reasoning: 0,
      costUsd: 0,
      requestBytes: {
        systemPrompt: expect.any(Number),
        prompt: expect.any(Number),
        toolDefinitions: expect.any(Number),
        total: expect.any(Number),
      },
      readFiles: ["tracked.txt"],
      readFilesTotal: 1,
      readFilesTruncated: 0,
      diffBytes: cumulativeDiff,
      contextStrategy: "disabled-then-halt",
      pipelineContextStrategy: "broad",
    },
  ]);
});

test("two rounds: reviewer round-1 issue is threaded into the coder round-2 prompt", async () => {
  const fx = fixture();
  const coderPrompts: string[] = [];
  const reviewerPrompts: string[] = [];
  execFileSync("git", ["init", "-q"], { cwd: fx.targetDir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: fx.targetDir });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], {
    cwd: fx.targetDir,
  });
  fs.writeFileSync(path.join(fx.targetDir, "baseline.txt"), "baseline\n");
  execFileSync("git", ["add", "baseline.txt"], { cwd: fx.targetDir });
  execFileSync("git", ["commit", "-qm", "baseline"], { cwd: fx.targetDir });
  const coderStep =
    (label: string): FauxResponseFactory =>
    (context) => {
      coderPrompts.push(lastUserText(context));
      if (label === "round1") {
        fs.writeFileSync(path.join(fx.targetDir, "new-test.ts"), "export const covered = true;\n");
      }
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
  const reviewerStep =
    (verdict: Verdict): FauxResponseFactory =>
    (context) => {
      reviewerPrompts.push(lastUserText(context));
      return fauxAssistantMessage(fauxToolCall(SUBMIT_VERDICT_TOOL_NAME, verdict));
    };
  fx.faux.setResponses([
    coderStep("round1"),
    reviewerStep(changes),
    fauxAssistantMessage("review complete"),
    coderStep("round2"),
    reviewerStep(approve),
    fauxAssistantMessage("review complete"),
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
  expect(coderPrompts[1]).toContain('"new-test.ts"');
  expect(coderPrompts[1]).not.toContain("Full-context retry fallback");
  expect(reviewerPrompts).toHaveLength(2);
  expect(reviewerPrompts[0]).toContain("implement Y");
  expect(reviewerPrompts[1]).toContain("Focused re-review");
  expect(reviewerPrompts[1]).toContain("add a null check on the input");
  expect(reviewerPrompts[1]).toContain("Bounded changed diff");
  expect(reviewerPrompts[1]).not.toContain("implement Y");
  expect(result.stageMetrics?.at(-1)?.pipelineContextStrategy).toBe("focused");
});

test("untracked retry evidence remains focused when its bounded projection is safe", async () => {
  const fx = fixture();
  const reviewerPrompts: string[] = [];
  execFileSync("git", ["init", "-q"], { cwd: fx.targetDir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: fx.targetDir });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: fx.targetDir });
  fs.writeFileSync(path.join(fx.targetDir, "baseline.txt"), "baseline\n");
  execFileSync("git", ["add", "baseline.txt"], { cwd: fx.targetDir });
  execFileSync("git", ["commit", "-qm", "baseline"], { cwd: fx.targetDir });
  const coder = fx.role("coder", "You code.");
  const reviewer = reviewerRole(fx);
  const changes: Verdict = {
    status: "changes_requested",
    issues: [{ severity: "major", what: "add a null check" }],
    summary: "needs a fix",
  };
  const approve: Verdict = { status: "approved", issues: [], summary: "fixed" };
  fx.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("write", { path: "new.ts", content: "export const added = true;\n" }),
    ),
    fauxAssistantMessage("coded round1"),
    (context) => {
      reviewerPrompts.push(lastUserText(context));
      return fauxAssistantMessage(fauxToolCall(SUBMIT_VERDICT_TOOL_NAME, changes));
    },
    fauxAssistantMessage("review complete"),
    fauxAssistantMessage("coded round2"),
    (context) => {
      reviewerPrompts.push(lastUserText(context));
      return fauxAssistantMessage(fauxToolCall(SUBMIT_VERDICT_TOOL_NAME, approve));
    },
    fauxAssistantMessage("review complete"),
  ]);

  const result = await runPipeline({
    targetDir: fx.targetDir,
    models: fx.models,
    task: "implement untracked evidence",
    maxRounds: 3,
    roles: { coder, reviewer },
  });

  expect(result.approved).toBe(true);
  expect(reviewerPrompts.at(1)).toContain("Focused re-review");
  expect(reviewerPrompts.at(1)).toContain("new.ts");
  expect(result.stageMetrics?.at(-1)?.pipelineContextStrategy).toBe("focused");
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
  const planner = plannerRole(fx);
  const coder = fx.role("coder", "You code.");
  const reviewer = reviewerRole(fx);
  const changes: Verdict = {
    status: "changes_requested",
    issues: [{ severity: "minor", what: "tweak" }],
    summary: "again",
  };
  fx.faux.setResponses([
    ...plannerTurn({ complexity: "medium", securitySurface: "none", summary: "plan" }),
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

test("documentation-surface verdict guidance names exact contracts and validation self-corrects", () => {
  const expected = {
    projectType: "docs",
    surfaces: [{ id: "docs", name: "Documentation", rationale: "changed" }],
    coverage: [
      {
        surfaceId: "docs",
        status: "covered" as const,
        contractIds: ["documentation:human-first", "quality:clean-check"],
        evidence: ["docs/contracts/documentation.md"],
        rationale: "applies",
      },
    ],
  };
  const instruction = formatReviewerInstruction(expected);
  expect(instruction).toContain(
    'Cover exactly these surface contracts: [{"surfaceId":"docs","contractIds":["documentation:human-first","quality:clean-check"]}].',
  );

  const base = { status: "approved", issues: [], summary: "ok" };
  let contractError: unknown;
  try {
    parseVerdict(
      {
        ...base,
        coverage: [{ surfaceId: "docs", contractIds: ["untrusted-contract"], evidence: ["gate"] }],
      },
      "run",
      expected,
    );
  } catch (error) {
    contractError = error;
  }
  expect(contractError).toBeInstanceOf(OrchestrationError);
  expect((contractError as OrchestrationError).code).toBe("malformed_verdict");
  expect((contractError as Error).message).toBe(
    "verdict.coverage[0].contractIds must exactly match required contract IDs: documentation:human-first, quality:clean-check; resubmit the verdict with those IDs",
  );
  expect((contractError as Error).message).not.toContain("untrusted-contract");

  let evidenceError: unknown;
  try {
    parseVerdict(
      {
        ...base,
        coverage: [
          {
            surfaceId: "docs",
            contractIds: ["documentation:human-first", "quality:clean-check"],
            evidence: [],
          },
        ],
      },
      "run",
      expected,
    );
  } catch (error) {
    evidenceError = error;
  }
  expect(evidenceError).toBeInstanceOf(OrchestrationError);
  expect((evidenceError as OrchestrationError).code).toBe("malformed_verdict");
  expect((evidenceError as Error).message).toBe(
    "verdict.coverage[0].evidence must include at least one verification result; resubmit the verdict with evidence",
  );
});

test("submit_verdict exposes safe correction guidance and accepts a corrected retry", async () => {
  const expected = {
    projectType: "docs",
    surfaces: [{ id: "docs", name: "Documentation", rationale: "changed" }],
    coverage: [
      {
        surfaceId: "docs",
        status: "covered" as const,
        contractIds: ["documentation:human-first"],
        evidence: ["contract"],
        rationale: "applies",
      },
    ],
  };
  const capture: { verdict?: Verdict; error?: OrchestrationError } = {};
  const tool = buildSubmitVerdictTool(capture, "review-run", expected);
  const execute = tool.execute as unknown as (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: Array<{ text: string }> }>;
  const mismatch = await execute("call-1", {
    status: "approved",
    issues: [],
    summary: "ok",
    coverage: [{ surfaceId: "docs", contractIds: ["attacker-controlled"], evidence: ["gate"] }],
  });
  const mismatchText = mismatch.content.map(({ text }) => text).join("");
  expect(mismatchText).toContain("documentation:human-first");
  expect(mismatchText).toContain("resubmit the verdict");
  expect(mismatchText).not.toContain("attacker-controlled");
  const missingEvidence = await execute("call-2", {
    status: "approved",
    issues: [],
    summary: "ok",
    coverage: [{ surfaceId: "docs", contractIds: ["documentation:human-first"], evidence: [] }],
  });
  expect(missingEvidence.content.map(({ text }) => text).join("")).toContain(
    "include at least one verification result",
  );
  await execute("call-3", {
    status: "approved",
    issues: [],
    summary: "ok",
    coverage: [
      { surfaceId: "docs", contractIds: ["documentation:human-first"], evidence: ["gate"] },
    ],
  });
  expect(capture.error).toBeUndefined();
  expect(capture.verdict?.status).toBe("approved");
});

test("parsePlan accepts a well-formed plan and rejects bad complexity / bad securitySurface / non-string summary / non-object", () => {
  const surfaceAnalysis = {
    projectType: "TypeScript CLI/library",
    surfaces: [{ id: "cli", name: "CLI", rationale: "changes CLI" }],
    coverage: [
      {
        surfaceId: "cli",
        status: "covered",
        contractIds: ["cli:thin-front"],
        evidence: ["docs/contracts/cli.md"],
        rationale: "existing contract applies",
      },
    ],
  } as const;
  const plan = parsePlan(
    { complexity: "medium", securitySurface: "elevated", summary: "s", surfaceAnalysis },
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
      surfaceAnalysis,
    },
    "run-id",
  );
  expect(contracted.contractRequirements).toEqual(["Headless-first."]);

  const cases: unknown[] = [
    { complexity: "huge", securitySurface: "none", summary: "s", surfaceAnalysis },
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

test("a planner emitting only text fails closed before code", async () => {
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

  await expect(
    runPipeline({
      targetDir: fx.targetDir,
      models: fx.models,
      task: "implement Q",
      maxRounds: 3,
      roles: { planner, coder, reviewer },
    }),
  ).rejects.toMatchObject({ code: "missing_plan" });
});

test("a planner whole-JSON fallback is strictly validated before code", async () => {
  const fx = fixture();
  const planner = plannerRole(fx);
  const coder = fx.role("coder", "You code.");
  const reviewer = reviewerRole(fx);
  fx.faux.setResponses([
    fauxAssistantMessage(
      JSON.stringify(
        governedPlan({ complexity: "medium", securitySurface: "none", summary: "json" }),
      ),
    ),
    fauxAssistantMessage("coded"),
    ...reviewerTurn({ status: "approved", issues: [], summary: "ok" }),
  ]);
  await expect(
    runPipeline({
      targetDir: fx.targetDir,
      models: fx.models,
      task: "JSON handoff",
      maxRounds: 1,
      roles: { planner, coder, reviewer },
    }),
  ).resolves.toMatchObject({ approved: true, complexity: "medium" });
});

test("planner gets one bounded corrective retry for a missing structured handoff", async () => {
  const fx = fixture();
  const planner = plannerRole(fx);
  const coder = fx.role("coder", "You code.");
  const reviewer = reviewerRole(fx);
  fx.faux.setResponses([
    fauxAssistantMessage("plan in text only"),
    ...plannerTurn({ complexity: "medium", securitySurface: "none", summary: "recorded" }),
    fauxAssistantMessage("coded"),
    ...reviewerTurn({ status: "approved", issues: [], summary: "ok" }),
  ]);

  const result = await runPipeline({
    targetDir: fx.targetDir,
    models: fx.models,
    task: "implement corrective handoff",
    maxRounds: 1,
    roles: { planner, coder, reviewer },
  });
  expect(result.approved).toBe(true);
  expect(result.stageMetrics.filter(({ stage }) => stage === "plan")).toHaveLength(2);
});

test("a default-open planner emitting only text fails closed before code", async () => {
  const fx = fixture();
  fx.faux.setResponses([fauxAssistantMessage("plan only")]);
  await expect(
    runPipeline({
      targetDir: fx.targetDir,
      models: fx.models,
      task: "implement Q",
      maxRounds: 1,
      roles: {
        planner: fx.role("planner", "plan", undefined),
        coder: fx.role("coder", "code"),
        reviewer: reviewerRole(fx),
      },
    }),
  ).rejects.toMatchObject({ code: "missing_plan" });
});

test("parsePlan rejects invented contract IDs and covered entries without evidence", () => {
  const base = {
    complexity: "medium",
    securitySurface: "none",
    summary: "plan",
    surfaceAnalysis: {
      projectType: "CLI",
      surfaces: [{ id: "cli", name: "CLI", rationale: "changed" }],
      coverage: [
        {
          surfaceId: "cli",
          status: "covered",
          contractIds: ["invented:contract"],
          evidence: ["claim"],
          rationale: "applies",
        },
      ],
    },
  };
  expect(() => parsePlan(base, "run-id")).toThrow(OrchestrationError);
  base.surfaceAnalysis.coverage[0]!.contractIds = ["cli:thin-front"];
  base.surfaceAnalysis.coverage[0]!.evidence = [];
  expect(() => parsePlan(base, "run-id")).toThrow(OrchestrationError);
});

test("planner instruction exposes canonical IDs accepted by validation", () => {
  const instruction = formatPlannerInstruction();
  expect(instruction).toContain("Canonical contract IDs accepted by this pipeline:");
  expect(instruction).toContain(
    "If the provider returns text instead, emit one complete JSON object",
  );
  // The fenced form is what models emit by default; the instruction must not
  // forbid a shape the parser accepts.
  expect(instruction).toContain("```json fence");
  expect(instruction).toContain("errors:typed-actionable");
  expect(instruction).toContain("quality:clean-check");
});

test("surface analysis limits are zero-disabled and independently enforced", () => {
  const value = {
    complexity: "medium",
    securitySurface: "low",
    summary: "plan",
    contractRequirements: [],
    surfaceAnalysis: {
      projectType: "A deliberately long project type",
      surfaces: [{ id: "cli", name: "CLI", rationale: "changed" }],
      coverage: [
        {
          surfaceId: "cli",
          status: "covered",
          contractIds: ["cli:thin-front"],
          evidence: ["test"],
          rationale: "applies",
        },
      ],
    },
  };
  expect(
    parsePlan(value, "run-id", {
      maxItems: 0,
      maxTextBytes: 0,
      maxAggregateBytes: 0,
      maxDepth: 0,
    }).surfaceAnalysis.projectType,
  ).toContain("long");
  expect(() =>
    parsePlan(value, "run-id", {
      maxItems: 0,
      maxTextBytes: 5,
      maxAggregateBytes: 0,
      maxDepth: 0,
    }),
  ).toThrow(OrchestrationError);
  expect(() =>
    parsePlan(value, "run-id", {
      maxItems: 0,
      maxTextBytes: 0,
      maxAggregateBytes: 10,
      maxDepth: 0,
    }),
  ).toThrow(OrchestrationError);
  expect(() =>
    parsePlan(value, "run-id", {
      maxItems: 0,
      maxTextBytes: 0,
      maxAggregateBytes: 0,
      maxDepth: 1,
    }),
  ).toThrow(OrchestrationError);
  expect(() =>
    parsePlan(value, "run-id", {
      maxItems: -1,
      maxTextBytes: 0,
      maxAggregateBytes: 0,
      maxDepth: 0,
    }),
  ).toThrow(OrchestrationError);
  for (const invalid of [1.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() =>
      parsePlan(value, "run-id", {
        maxItems: invalid,
        maxTextBytes: 0,
        maxAggregateBytes: 0,
        maxDepth: 0,
      }),
    ).toThrow(OrchestrationError);
  }
  const two = structuredClone(value);
  two.surfaceAnalysis.surfaces.push({ id: "api", name: "API", rationale: "changed" });
  two.surfaceAnalysis.coverage.push({
    surfaceId: "api",
    status: "covered",
    contractIds: ["architecture:headless-first"],
    evidence: ["test"],
    rationale: "applies",
  });
  expect(() =>
    parsePlan(two, "run-id", { maxItems: 1, maxTextBytes: 0, maxAggregateBytes: 0, maxDepth: 0 }),
  ).toThrow(OrchestrationError);
});

test("workflow validates production surface limits before provider dispatch", () => {
  const fx = fixture();
  expect(() =>
    createWorkflowSession({
      targetDir: fx.targetDir,
      models: fx.models,
      task: "x",
      maxRounds: 1,
      surfaceAnalysisLimits: { maxItems: 0, maxTextBytes: 0, maxAggregateBytes: 0, maxDepth: 1.5 },
      roles: { coder: fx.role("coder", "code"), reviewer: reviewerRole(fx) },
    }),
  ).toThrow("surfaceAnalysisLimits.maxDepth");
});

test("research-required surface cannot reach a coder turn", async () => {
  const fx = fixture();
  fx.faux.setResponses([
    ...plannerTurn({
      complexity: "medium",
      securitySurface: "low",
      summary: "plan",
      contractRequirements: [],
      surfaceAnalysis: {
        projectType: "CLI",
        surfaces: [{ id: "cli", name: "CLI", rationale: "new command" }],
        coverage: [
          {
            surfaceId: "cli",
            status: "research_required",
            contractIds: [],
            evidence: ["no CLI UX contract"],
            rationale: "standards unknown",
          },
        ],
      },
    }),
  ]);
  await expect(
    runPipeline({
      targetDir: fx.targetDir,
      models: fx.models,
      task: "implement",
      maxRounds: 1,
      roles: {
        planner: plannerRole(fx),
        coder: fx.role("coder", "code"),
        reviewer: reviewerRole(fx),
      },
    }),
  ).rejects.toMatchObject({ code: "requirements_unresolved" });
});

test("research is checkpointed before dispatch and persists only normalized provenance", async () => {
  const fx = fixture();
  fs.mkdirSync(path.join(fx.targetDir, "docs/contracts"), { recursive: true });
  fs.writeFileSync(
    path.join(fx.targetDir, "docs/contracts/config.md"),
    "# Config\n\nCanonical rule.\n",
  );
  const secret = "Bearer super-secret-value";
  const runId = "durable-research";
  let coordinator: RunCoordinator;
  let outbound = "";
  fx.faux.setResponses([
    ...plannerTurn({
      complexity: "medium",
      securitySurface: "low",
      summary: "safe plan",
      contractRequirements: [],
      surfaceAnalysis: {
        projectType: "CLI",
        surfaces: [{ id: "cli", name: "CLI", rationale: "new configuration" }],
        coverage: [
          {
            surfaceId: "cli",
            status: "research_required",
            contractIds: ["config:configurable"],
            evidence: ["gap"],
            rationale: "needs evidence",
          },
        ],
      },
    }),
    (context) => {
      outbound = lastUserText(context);
      const checkpoint = coordinator.checkpoint;
      expect(checkpoint.researchEffect?.status).toBe("dispatched");
      expect(checkpoint.workflowState.phase).toBe("research");
      expect(JSON.stringify(checkpoint)).not.toContain(secret);
      return fauxAssistantMessage(
        JSON.stringify({ summary: "corroborated", resolvedSurfaceIds: ["cli"] }),
      );
    },
  ]);
  const session = createWorkflowSession({
    targetDir: fx.targetDir,
    models: fx.models,
    task: `implement without exposing ${secret}`,
    maxRounds: 1,
    roles: {
      planner: plannerRole(fx),
      researcher: fx.role("researcher", "facts only"),
      coder: fx.role("coder", "code"),
      reviewer: reviewerRole(fx),
    },
  });
  coordinator = new RunCoordinator(session, session.projectStore, { runId });
  await coordinator.step();
  expect(coordinator.checkpoint.workflowState.phase).toBe("research");
  await coordinator.prepareStep();
  const persisted = JSON.stringify(coordinator.checkpoint);
  expect(outbound).not.toContain(secret);
  expect(persisted).not.toContain(secret);
  expect(persisted).not.toContain("resolvedSurfaceIds");
  expect(coordinator.checkpoint.completedEffects).toHaveLength(1);
  expect(coordinator.checkpoint.pendingStep?.state.researchProvenance?.[0]).toMatchObject({
    destination: "faux/faux-1",
    summary: "corroborated",
  });
});

test("model-inventory research composes its brief and persists only brief provenance", async () => {
  const fx = fixture();
  fs.mkdirSync(path.join(fx.targetDir, "docs/contracts"), { recursive: true });
  fs.writeFileSync(path.join(fx.targetDir, "docs/contracts/config.md"), "# Config\nCanonical.\n");
  const briefContent = fs.readFileSync(MODEL_INVENTORY_RESEARCH_BRIEF.path, "utf8");
  let researcherSystemPrompt: string | undefined;
  fx.faux.setResponses([
    ...plannerTurn(researchPlan()),
    (context) => {
      researcherSystemPrompt = context.systemPrompt;
      return fauxAssistantMessage(
        JSON.stringify({ summary: "corroborated", resolvedSurfaceIds: ["cli"] }),
      );
    },
  ]);
  const session = createWorkflowSession({
    targetDir: fx.targetDir,
    models: fx.models,
    task: "refresh model inventory",
    maxRounds: 1,
    researchPurpose: "model-inventory-bootstrap",
    roles: {
      planner: plannerRole(fx),
      researcher: fx.role("researcher", "facts only"),
      coder: fx.role("coder", "code"),
      reviewer: reviewerRole(fx),
    },
  });
  const coordinator = new RunCoordinator(session, session.projectStore, {
    runId: "brief-provenance",
  });
  await coordinator.step();
  await coordinator.prepareStep();
  expect(researcherSystemPrompt).toBe(
    `facts only\n\n${briefContent}\n\n${COMPACTION_SAFETY_PROMPT}`,
  );
  const persisted = JSON.stringify(coordinator.checkpoint);
  expect(coordinator.checkpoint.pendingStep?.state.stageMetrics?.at(-1)?.roleBrief).toEqual({
    id: MODEL_INVENTORY_RESEARCH_BRIEF.id,
    version: MODEL_INVENTORY_RESEARCH_BRIEF.version,
    sha256: createHash("sha256").update(briefContent).digest("hex"),
  });
  expect(persisted).not.toContain(briefContent);
  expect(persisted).not.toContain(MODEL_INVENTORY_RESEARCH_BRIEF.path);
});

test("ordinary research keeps its prompt and a missing required brief fails before dispatch", async () => {
  const fx = fixture();
  let researcherSystemPrompt: string | undefined;
  fx.faux.setResponses([
    ...plannerTurn(researchPlan()),
    (context) => {
      researcherSystemPrompt = context.systemPrompt;
      return fauxAssistantMessage(
        JSON.stringify({ summary: "corroborated", resolvedSurfaceIds: ["cli"] }),
      );
    },
  ]);
  const session = createWorkflowSession({
    targetDir: fx.targetDir,
    models: fx.models,
    task: "ordinary research",
    maxRounds: 1,
    roles: {
      planner: plannerRole(fx),
      researcher: fx.role("researcher", "facts only"),
      coder: fx.role("coder", "code"),
      reviewer: reviewerRole(fx),
    },
  });
  const coordinator = new RunCoordinator(session, session.projectStore, {
    runId: "ordinary-research-prompt",
  });
  await coordinator.step();
  await coordinator.prepareStep();
  expect(researcherSystemPrompt).toBe(`facts only\n\n${COMPACTION_SAFETY_PROMPT}`);

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
      task: "bootstrap inventory",
      maxRounds: 1,
      researchPurpose: "model-inventory-bootstrap",
      researchBrief: { id: "inventory", version: "v1", path: path.join(fx.targetDir, "missing") },
      roles: {
        researcher: fx.role("researcher", "facts only"),
        coder: fx.role("coder", "code"),
        reviewer: reviewerRole(fx),
      },
    }),
  ).toThrow(RoleBriefError);
  expect(dispatches).toBe(0);
});

test("rejected research payload never reaches durable production-flow artifacts", async () => {
  const fx = fixture();
  fs.mkdirSync(path.join(fx.targetDir, "docs/contracts"), { recursive: true });
  fs.writeFileSync(path.join(fx.targetDir, "docs/contracts/config.md"), "# Config\nCanonical.\n");
  const rawMarker = "raw-provider-marker-7f43";
  const injectedSecret = "orchid-moon-private-value";
  fx.faux.setResponses([
    ...plannerTurn({
      complexity: "medium",
      securitySurface: "low",
      summary: "safe plan",
      contractRequirements: [],
      surfaceAnalysis: {
        projectType: "CLI",
        surfaces: [{ id: "cli", name: "CLI", rationale: "configuration" }],
        coverage: [
          {
            surfaceId: "cli",
            status: "research_required",
            contractIds: ["config:configurable"],
            evidence: ["gap"],
            rationale: "needs evidence",
          },
        ],
      },
    }),
    fauxAssistantMessage(
      JSON.stringify({
        summary: "candidate",
        resolvedSurfaceIds: ["cli"],
        unknown: `${rawMarker}:${injectedSecret}`,
      }),
    ),
  ]);
  const session = createWorkflowSession({
    targetDir: fx.targetDir,
    models: fx.models,
    task: "implement",
    maxRounds: 1,
    roles: {
      planner: plannerRole(fx),
      researcher: fx.role("researcher", "facts only"),
      coder: fx.role("coder", "code"),
      reviewer: reviewerRole(fx),
    },
  });
  const coordinator = new RunCoordinator(session, session.projectStore, { runId: "reject-raw" });
  await coordinator.step();
  expect(await coordinator.prepareStep()).toBeUndefined();
  expect(coordinator.checkpoint.pause).toMatchObject({
    phase: "research",
    code: "research_rejected",
  });
  const durableFiles = fs
    .readdirSync(path.join(fx.targetDir, ".ad-coder"), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => fs.readFileSync(path.join(entry.parentPath, entry.name), "utf8"))
    .join("\n");
  expect(durableFiles).not.toContain(rawMarker);
  expect(durableFiles).not.toContain(injectedSecret);
  expect(JSON.stringify(coordinator.checkpoint)).not.toContain(rawMarker);
  expect(JSON.stringify(coordinator.checkpoint)).not.toContain(injectedSecret);
});

function researchPlan(): Plan {
  return {
    complexity: "medium",
    securitySurface: "low",
    summary: "research plan",
    contractRequirements: [],
    surfaceAnalysis: {
      projectType: "CLI",
      surfaces: [{ id: "cli", name: "CLI", rationale: "changed" }],
      coverage: [
        {
          surfaceId: "cli",
          status: "research_required",
          contractIds: ["config:configurable"],
          evidence: ["gap"],
          rationale: "needs evidence",
        },
      ],
    },
  };
}

function researchSession(
  fx: Fixture,
  surfaceAnalysisLimits?: {
    maxItems: number;
    maxTextBytes: number;
    maxAggregateBytes: number;
    maxDepth: number;
  },
) {
  return createWorkflowSession({
    targetDir: fx.targetDir,
    models: fx.models,
    task: "implement",
    maxRounds: 1,
    ...(surfaceAnalysisLimits !== undefined && { surfaceAnalysisLimits }),
    roles: {
      planner: plannerRole(fx),
      researcher: fx.role("researcher", "facts"),
      coder: fx.role("coder", "code"),
      reviewer: reviewerRole(fx),
    },
  });
}

test("RunCoordinator propagates positive and zero surface limits", async () => {
  for (const [runId, maxTextBytes, rejects] of [
    ["positive-limits", 3, true],
    ["zero-limits", 0, false],
  ] as const) {
    const fx = fixture();
    fx.faux.setResponses([...plannerTurn(researchPlan())]);
    const coordinator = new RunCoordinator(
      researchSession(fx, { maxItems: 0, maxTextBytes, maxAggregateBytes: 0, maxDepth: 0 }),
      new ProjectStore(fx.targetDir),
      { runId },
    );
    if (rejects) await expect(coordinator.step()).rejects.toMatchObject({ code: "malformed_plan" });
    else {
      await coordinator.step();
      expect(coordinator.checkpoint.workflowState.phase).toBe("research");
    }
  }
});

test("research pauses on missing and invalid canonical corroboration", async () => {
  for (const [runId, canonical] of [
    ["missing-canonical", undefined],
    ["invalid-canonical", ""],
  ] as const) {
    const fx = fixture();
    if (canonical !== undefined) {
      fs.mkdirSync(path.join(fx.targetDir, "docs/contracts"), { recursive: true });
      fs.writeFileSync(path.join(fx.targetDir, "docs/contracts/config.md"), canonical);
    }
    fx.faux.setResponses([
      ...plannerTurn(researchPlan()),
      fauxAssistantMessage(JSON.stringify({ summary: "bounded", resolvedSurfaceIds: ["cli"] })),
    ]);
    const session = researchSession(fx);
    const coordinator = new RunCoordinator(session, session.projectStore, { runId });
    await coordinator.step();
    expect(await coordinator.prepareStep()).toBeUndefined();
    expect(coordinator.checkpoint.pause?.code).toBe("research_rejected");
    expect(coordinator.checkpoint.pendingStep).toBeUndefined();
  }
});

test("mandatory research response ceilings fail closed in production flow", async () => {
  const responses = [
    "not json",
    JSON.stringify({ summary: "x".repeat(4097), resolvedSurfaceIds: ["cli"] }),
    JSON.stringify({ summary: "x", resolvedSurfaceIds: Array(257).fill("cli") }),
    JSON.stringify({
      summary: "x",
      resolvedSurfaceIds: ["cli"],
      nested: { a: { b: { c: { d: "raw-depth-marker" } } } },
    }),
    JSON.stringify({ summary: "x".repeat(128 * 1024), resolvedSurfaceIds: ["cli"] }),
  ];
  for (const [index, response] of responses.entries()) {
    const fx = fixture();
    fs.mkdirSync(path.join(fx.targetDir, "docs/contracts"), { recursive: true });
    fs.writeFileSync(path.join(fx.targetDir, "docs/contracts/config.md"), "canonical");
    fx.faux.setResponses([...plannerTurn(researchPlan()), fauxAssistantMessage(response)]);
    const session = researchSession(fx);
    const coordinator = new RunCoordinator(session, session.projectStore, {
      runId: `response-ceiling-${index}`,
      checkpointByteLimit: 0,
    });
    await coordinator.step();
    expect(await coordinator.prepareStep()).toBeUndefined();
    expect(coordinator.checkpoint.pause?.code).toBe("research_rejected");
  }
});

test("mandatory request and initial checkpoint ceilings cannot be disabled", async () => {
  const fx = fixture();
  const plan = researchPlan();
  plan.surfaceAnalysis = {
    projectType: "CLI",
    surfaces: Array.from({ length: 257 }, (_, index) => ({
      id: `surface-${index}`,
      name: `surface-${index}`,
      rationale: "changed",
    })),
    coverage: Array.from({ length: 257 }, (_, index) => ({
      surfaceId: `surface-${index}`,
      status: "research_required" as const,
      contractIds: [],
      evidence: ["gap"],
      rationale: "needs evidence",
    })),
  };
  fx.faux.setResponses([...plannerTurn(plan)]);
  const session = researchSession(fx, {
    maxItems: 0,
    maxTextBytes: 0,
    maxAggregateBytes: 0,
    maxDepth: 0,
  });
  const coordinator = new RunCoordinator(session, session.projectStore, {
    runId: "mandatory-request",
    checkpointByteLimit: 0,
  });
  await coordinator.step();
  expect(await coordinator.prepareStep()).toBeUndefined();
  expect(coordinator.checkpoint.pause?.code).toBe("unsafe_request");

  const baseSession = researchSession(fx);
  const oversized = {
    ...baseSession,
    initialState: () => ({
      ...baseSession.initialState(),
      planSummary: "x".repeat(8 * 1024 * 1024),
    }),
  };
  expect(
    () =>
      new RunCoordinator(oversized, oversized.projectStore, {
        runId: "mandatory-checkpoint",
        checkpointByteLimit: 0,
      }),
  ).toThrow("mandatoryCheckpointByteLimit");
});

test("dispatched recovery is actionable and concurrent resume accepts one effect", async () => {
  const fx = fixture();
  fs.mkdirSync(path.join(fx.targetDir, "docs/contracts"), { recursive: true });
  fs.writeFileSync(path.join(fx.targetDir, "docs/contracts/config.md"), "canonical");
  const runId = "concurrent-research";
  let reopened: RunCoordinator | undefined;
  let session: ReturnType<typeof researchSession>;
  fx.faux.setResponses([
    ...plannerTurn(researchPlan()),
    async () => {
      reopened = new RunCoordinator(session, session.projectStore, { runId });
      expect(await reopened.prepareStep()).toBeUndefined();
      throw new Error("simulated dispatched transport crash");
    },
    fauxAssistantMessage(JSON.stringify({ summary: "recovered", resolvedSurfaceIds: ["cli"] })),
  ]);
  session = researchSession(fx);
  const coordinator = new RunCoordinator(session, session.projectStore, { runId });
  await coordinator.step();
  await expect(coordinator.prepareStep()).rejects.toMatchObject({ code: "checkpoint_conflict" });
  expect(reopened!.checkpoint.pause?.code).toBe("ambiguous_dispatch");
  const competing = new RunCoordinator(session, session.projectStore, { runId });
  const attempts = await Promise.allSettled(
    [reopened!, competing].map(async (candidate) => {
      candidate.resumeResearch({ source: "operator", action: "retry" });
      return candidate.prepareStep();
    }),
  );
  expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
  expect(attempts.filter(({ status }) => status === "rejected")).toHaveLength(1);
  const winner = [reopened!, competing].find(
    (candidate) => candidate.checkpoint.completedEffects.length === 1,
  );
  expect(winner?.checkpoint.completedEffects).toHaveLength(1);
  expect(winner?.checkpoint.pendingStep?.state.researchProvenance).toHaveLength(1);
});

test("a prepared research cursor reopens and completes exactly once without a raw query", async () => {
  const fx = fixture();
  fs.mkdirSync(path.join(fx.targetDir, "docs/contracts"), { recursive: true });
  fs.writeFileSync(path.join(fx.targetDir, "docs/contracts/config.md"), "canonical");
  fx.faux.setResponses([
    ...plannerTurn(researchPlan()),
    fauxAssistantMessage(JSON.stringify({ summary: "resumed", resolvedSurfaceIds: ["cli"] })),
  ]);
  const runId = "prepared-research";
  const session = researchSession(fx);
  const coordinator = new RunCoordinator(session, session.projectStore, { runId });
  await coordinator.step();
  const checkpointPath = path.join(session.projectStore.layout.runs, `coordinator-${runId}.json`);
  const persisted = session.projectStore.readVersionedJson<RunCheckpoint>(checkpointPath);
  const intent = session.prepareResearch?.(persisted.value.workflowState);
  expect(intent).toBeDefined();
  expect(JSON.stringify(intent)).not.toContain("research-questions");
  session.projectStore.writeVersionedJson(
    checkpointPath,
    {
      ...persisted.value,
      workflowState: { ...persisted.value.workflowState, researchIntent: intent },
      researchEffect: { intent: intent!, status: "prepared" },
    },
    persisted.version,
  );
  const reopened = new RunCoordinator(session, session.projectStore, { runId });
  await reopened.prepareStep();
  expect(reopened.checkpoint.completedEffects).toEqual([intent!.effectId]);
  expect(reopened.checkpoint.pendingStep?.state.researchProvenance).toHaveLength(1);
  expect(JSON.stringify(reopened.checkpoint)).not.toContain("research-questions");
});

/**
 * The text fallback accepts every shape a planner actually produces, and
 * separates "said nothing" from "said something unusable".
 *
 * Each case below was observed on a real run that the old bare-object gate
 * mis-reported: a fenced object, a `submit_plan arguments:` prefix, and an
 * object cut off mid-field all returned `undefined`, which the caller read as
 * silence and reported as `missing_plan`.
 */
test("parsePlanText recovers fenced and prefixed plans and names a truncated one", () => {
  const plan = governedPlan({ complexity: "medium", securitySurface: "none", summary: "s" });
  const json = JSON.stringify(plan);

  for (const [label, text] of [
    ["bare", json],
    ["fenced", `\`\`\`json\n${json}\n\`\`\``],
    ["prefixed", `submit_plan arguments: ${json}`],
    ["prose-wrapped", `Here is the plan.\n\n${json}\n\nLet me know.`],
    ["brace inside a string value", JSON.stringify({ ...plan, summary: "a { brace" })],
  ] as const) {
    const parsed = parsePlanText(text, "run-id");
    expect(parsed, label).toBeDefined();
    expect(parsed!.complexity, label).toBe("medium");
  }

  // Silence -- no plan-shaped content at all -- stays `undefined` so the caller
  // can still retry it as a missing handoff.
  expect(parsePlanText("I could not analyse this repository.", "run-id")).toBeUndefined();
  expect(parsePlanText("", "run-id")).toBeUndefined();

  // A cut-off object IS a submission, and reporting it as silence hid the real
  // cause (an output ceiling) behind "planner did not submit".
  let caught: unknown;
  try {
    parsePlanText(json.slice(0, json.length - 20), "run-id");
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(OrchestrationError);
  expect((caught as OrchestrationError).code).toBe("malformed_plan");
  expect((caught as OrchestrationError).message).toContain("truncated");
});

test("a fenced planner JSON fallback is accepted and validated before code", async () => {
  const fx = fixture();
  fx.faux.setResponses([
    fauxAssistantMessage(
      `\`\`\`json\n${JSON.stringify(
        governedPlan({ complexity: "medium", securitySurface: "none", summary: "fenced" }),
      )}\n\`\`\``,
    ),
    fauxAssistantMessage("coded"),
    ...reviewerTurn({ status: "approved", issues: [], summary: "ok" }),
  ]);
  await expect(
    runPipeline({
      targetDir: fx.targetDir,
      models: fx.models,
      task: "fenced handoff",
      maxRounds: 1,
      roles: {
        planner: plannerRole(fx),
        coder: fx.role("coder", "You code."),
        reviewer: reviewerRole(fx),
      },
    }),
  ).resolves.toMatchObject({ approved: true, complexity: "medium" });
});

/**
 * A rejected submission gets the same retry budget as a missing one.
 *
 * The loop used to break on the first rejection, so a planner that called
 * submit_plan with one bad field got zero retries while a planner that ignored
 * the tool entirely got a second attempt -- the near-miss punished harder than
 * the total miss.
 */
test("planner gets a corrective retry after a rejected submission, and is told why", async () => {
  const fx = fixture();
  const plannerPrompts: string[] = [];
  const record =
    (step: FauxResponseStep): FauxResponseFactory =>
    (...args) => {
      plannerPrompts.push(lastUserText(args[0]));
      return typeof step === "function" ? step(...args) : step;
    };
  fx.faux.setResponses([
    // securitySurface "extreme" passes the permissive schema but fails parsePlan.
    ...plannerTurn({ complexity: "medium", securitySurface: "extreme", summary: "s" }).map(record),
    ...plannerTurn({ complexity: "medium", securitySurface: "none", summary: "ok" }).map(record),
    fauxAssistantMessage("coded"),
    ...reviewerTurn({ status: "approved", issues: [], summary: "ok" }),
  ]);

  const result = await runPipeline({
    targetDir: fx.targetDir,
    models: fx.models,
    task: "rejected then corrected",
    maxRounds: 1,
    roles: {
      planner: plannerRole(fx),
      coder: fx.role("coder", "You code."),
      reviewer: reviewerRole(fx),
    },
  });
  expect(result.approved).toBe(true);
  expect(result.stageMetrics.filter(({ stage }) => stage === "plan")).toHaveLength(2);
  // The retry states what was rejected instead of claiming no call was made.
  const retryPrompt = plannerPrompts.at(-1) ?? "";
  expect(retryPrompt).toContain("submit_plan submission was rejected");
  expect(retryPrompt).not.toContain("did not call submit_plan");
});

test("a planner emitting only text is told no call was made, not that one was rejected", async () => {
  const fx = fixture();
  const plannerPrompts: string[] = [];
  const record =
    (step: FauxResponseStep): FauxResponseFactory =>
    (...args) => {
      plannerPrompts.push(lastUserText(args[0]));
      return typeof step === "function" ? step(...args) : step;
    };
  fx.faux.setResponses([
    record(fauxAssistantMessage("no tool call here")),
    ...plannerTurn({ complexity: "medium", securitySurface: "none", summary: "ok" }).map(record),
    fauxAssistantMessage("coded"),
    ...reviewerTurn({ status: "approved", issues: [], summary: "ok" }),
  ]);
  await runPipeline({
    targetDir: fx.targetDir,
    models: fx.models,
    task: "silent then corrected",
    maxRounds: 1,
    roles: {
      planner: plannerRole(fx),
      coder: fx.role("coder", "You code."),
      reviewer: reviewerRole(fx),
    },
  });
  expect(plannerPrompts.at(-1) ?? "").toContain("did not call submit_plan");
});

test("a malformed submit_plan throws OrchestrationError malformed_plan", async () => {
  const fx = fixture();
  const planner = plannerRole(fx);
  const coder = fx.role("coder", "You code.");
  const reviewer = reviewerRole(fx);
  // securitySurface "extreme" passes the permissive schema but fails parsePlan.
  // Both attempts are spent on a rejected submission: the budget is exhausted,
  // so the pipeline reports the rejection itself, not a missing handoff.
  fx.faux.setResponses([
    ...plannerTurn({ complexity: "medium", securitySurface: "extreme", summary: "s" }),
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
    recordStep(
      log,
      "planner",
      fauxAssistantMessage(fauxToolCall(SUBMIT_PLAN_TOOL_NAME, governedPlan(args))),
    ),
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
    ...plannerTurn({ complexity: "medium", securitySurface: "none", summary: "plan" }),
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
      planner: plannerRole(a),
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
      planner: plannerRole(b),
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
  const plan = governedPlan({ complexity: "medium", securitySurface: "none", summary: "s" });
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
    ...plannerTurn({ complexity: "medium", securitySurface: "none", summary: "plan" }),
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
