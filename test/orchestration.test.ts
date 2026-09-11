import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, Context, Message, Model } from "@earendil-works/pi-ai";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { FauxProviderHandle, FauxResponseFactory, FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { MemoryLedgerSink } from "../src/ledger/ledger";
import { OrchestrationError } from "../src/orchestration/types";
import type { RoleSpec, Verdict } from "../src/orchestration/types";
import { runPipeline } from "../src/orchestration/pipeline";
import { parseVerdict, SUBMIT_VERDICT_TOOL_NAME } from "../src/orchestration/verdict";
import { parsePlan, SUBMIT_PLAN_TOOL_NAME } from "../src/orchestration/plan";
import type { Plan } from "../src/orchestration/types";
import { defineRole } from "../src/role";
import type { Role } from "../src/role";

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
  const targetDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-orch-")));
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

/** A reviewer role that can call submit_verdict (only this role needs the tool). */
function reviewerRole(fx: Fixture): RoleSpec {
  return fx.role("reviewer", "You review.", ["bash", "read", "write", "edit", SUBMIT_VERDICT_TOOL_NAME]);
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
});

test("two rounds: reviewer round-1 issue is threaded into the coder round-2 prompt", async () => {
  const fx = fixture();
  const coderPrompts: string[] = [];
  const coderStep = (label: string): FauxResponseFactory => (context) => {
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
  fx.faux.setResponses([
    fauxAssistantMessage("coded once"),
    ...reviewerTurn(changes),
  ]);

  const result = await runPipeline({
    targetDir: fx.targetDir,
    models: fx.models,
    task: "implement Z",
    maxRounds: 1,
    roles: { coder, reviewer },
  });

  expect(result.approved).toBe(false);
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

  const cases: unknown[] = [
    { complexity: "huge", securitySurface: "none", summary: "s" },
    { complexity: "medium", securitySurface: "extreme", summary: "s" },
    { complexity: "medium", summary: "s" },
    { complexity: "medium", securitySurface: "none", summary: 5 },
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

test("a planner calling submit_plan surfaces result.complexity and result.securitySurface", async () => {
  const fx = fixture();
  const planner = plannerRole(fx);
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
    task: "implement P",
    maxRounds: 3,
    roles: { planner, coder, reviewer },
  });

  expect(result.approved).toBe(true);
  expect(result.complexity).toBe("medium");
  expect(result.securitySurface).toBe("low");
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
  const coderStep = (label: string): FauxResponseFactory => (context) => {
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
