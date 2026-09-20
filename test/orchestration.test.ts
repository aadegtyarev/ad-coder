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
  buildSubmitPlanTool,
  formatPlannerInstruction,
  parsePlan,
  parsePlanText,
  SUBMIT_PLAN_TOOL_NAME,
} from "../src/orchestration/plan";
import {
  applyTransition,
  autoDriver,
  createWorkflowSession,
  safeChangedFilesWithConfig,
  selectPipelineContext,
  type WorkflowSession,
  WorkflowStageLimitError,
} from "../src/orchestration/session";
import { StageLimitError } from "../src/orchestration/stage-limits";
import type {
  AvailableTransition,
  PipelineConfig,
  PipelineContextProjectionLimits,
  PipelineRouting,
  Plan,
  RoleSpec,
  Verdict,
  WorkflowState,
} from "../src/orchestration/types";
import { OrchestrationError, PipelinePauseError } from "../src/orchestration/types";
import {
  buildSubmitVerdictTool,
  formatReviewerInstruction,
  parseVerdict,
  SUBMIT_VERDICT_TOOL_NAME,
} from "../src/orchestration/verdict";
import { buildDefaultProfile } from "../src/profiles/default-profile";
import type { Profile } from "../src/profiles/types";
import { ProjectOperationsError } from "../src/project-operations/errors";
import { validateFollowUpCandidate } from "../src/project-operations/follow-ups";
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

test("issue #449: measured ceilings and failed measurements are distinct decisions", () => {
  const base = {
    round: 2,
    diffBytes: 100,
    changedFiles: ["src/a.ts"],
    changedFilesTruncated: 0,
    evidencePresent: true,
  } as const;
  // A real path-list truncation widens under its own honest reason, keeping
  // its measured path list -- it is NOT a measurement failure.
  expect(selectPipelineContext({ ...base, changedFilesTruncated: 1 })).toEqual({
    selection: "full",
    fallbackReason: "path_list_truncated",
  });
  // A failed measurement widens even with an empty path list, so it can never
  // be read as "no changes" (a genuinely empty tree stays on the focused path).
  expect(selectPipelineContext({ ...base, changedFiles: [], projectionFailed: true })).toEqual({
    selection: "full",
    fallbackReason: "projection_failure",
  });
  // A failed measurement outranks a stale truncation count: the record names
  // the failure, not the ceiling.
  expect(
    selectPipelineContext({ ...base, changedFilesTruncated: 3, projectionFailed: true }),
  ).toEqual({ selection: "full", fallbackReason: "projection_failure" });
  // Redaction still outranks path truncation (security signal first).
  expect(
    selectPipelineContext({ ...base, changedFiles: [".env.local"], changedFilesTruncated: 1 }),
  ).toEqual({ selection: "full", fallbackReason: "projection_redacted" });
  // The reproduced defect: a bounded over-ceiling projection keeps deciding on
  // material size instead of dying before the escalation -- a large change
  // reaches material_diff with its path list intact.
  expect(selectPipelineContext({ ...base, diffBytes: 64 * 1024 + 1 })).toEqual({
    selection: "full",
    fallbackReason: "material_diff",
  });
});

/** The only fields safeChangedFilesWithConfig reads from a PipelineConfig. */
function changedFilesConfig(
  targetDir: string,
  projection: PipelineContextProjectionLimits,
): PipelineConfig {
  return {
    targetDir,
    pipelineContext: { mode: "incremental", maxFocusedDiffBytes: 64 * 1024, projection },
  } as unknown as PipelineConfig;
}

/** Empty repo with one commit, mirroring the runner-test fixture. */
function initChangedFilesRepo(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "base", "--allow-empty"], { cwd: dir });
  return dir;
}

test("issue #449: an over-ceiling untracked projection keeps the path list and records the cap", async () => {
  const dir = initChangedFilesRepo("ad-coder-orch-untracked-");
  const big = "🚀".repeat(200); // 800 bytes of multi-byte content, ceiling 512
  fs.writeFileSync(path.join(dir, "big.md"), `${big}\n`);
  fs.writeFileSync(path.join(dir, "small.md"), "x\n");
  const measured = await safeChangedFilesWithConfig(
    changedFilesConfig(dir, { maxPaths: 8, maxPathBytes: 1024, maxAggregateBytes: 512 }),
  );
  // The measurement SUCCEEDED: bounded content, not a failure.
  expect(measured.projectionFailed).toBe(false);
  expect(measured.files).toEqual(["big.md", "small.md"]);
  expect(measured.diff).toBeDefined();
  expect(measured.diff?.bytes ?? 0).toBeLessThanOrEqual(512);
  expect(measured.diff?.text).not.toContain("\u{FFFD}");
  expect(measured.diff?.untrackedTruncatedFiles).toBe(2);
  expect(measured.diff?.untrackedMeasuredBytes).toBe(
    Buffer.byteLength(`${big}\n`) + Buffer.byteLength("x\n"),
  );
});

test("issue #449: a genuine measurement failure keeps the path list and never reads as no changes", async () => {
  const dir = initChangedFilesRepo("ad-coder-orch-fail-");
  fs.writeFileSync(path.join(dir, "blob.bin"), Buffer.from([0xff, 0xfe, 0x00, 0x01]));
  const measured = await safeChangedFilesWithConfig(
    changedFilesConfig(dir, { maxPaths: 8, maxPathBytes: 1024, maxAggregateBytes: 4096 }),
  );
  expect(measured.projectionFailed).toBe(true);
  // The measured path list SURVIVES the failed projection: total 1, not 0.
  expect(measured.files).toEqual(["blob.bin"]);
  expect(measured.total).toBe(1);
  expect(measured.truncated).toBe(0);
  expect(measured.diff).toBeUndefined();
});

test("issue #449: redaction and path truncation keep their own record fields", async () => {
  const dir = initChangedFilesRepo("ad-coder-orch-redact-");
  fs.writeFileSync(path.join(dir, ".env.local"), "SECRET=x\n");
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  fs.writeFileSync(path.join(dir, "b.txt"), "b\n");
  const measured = await safeChangedFilesWithConfig(
    changedFilesConfig(dir, { maxPaths: 1, maxPathBytes: 1024, maxAggregateBytes: 4096 }),
  );
  // Redaction is its own fact and does NOT bump the truncated path count.
  expect(measured.redactedPaths).toBe(1);
  expect(measured.truncated).toBe(2);
  expect(measured.total).toBe(3);
  expect(measured.diff).toBeUndefined();
  expect(measured.projectionFailed).toBe(false);
});

test("issue #449: a real path-list truncation keeps its measured count without redaction", async () => {
  const dir = initChangedFilesRepo("ad-coder-orch-paths-");
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  fs.writeFileSync(path.join(dir, "b.txt"), "b\n");
  fs.writeFileSync(path.join(dir, "c.txt"), "c\n");
  const measured = await safeChangedFilesWithConfig(
    changedFilesConfig(dir, { maxPaths: 2, maxPathBytes: 1024, maxAggregateBytes: 4096 }),
  );
  expect(measured.files).toEqual(["a.txt", "b.txt"]);
  expect(measured.total).toBe(3);
  expect(measured.truncated).toBe(1);
  expect(measured.redactedPaths).toBe(0);
  expect(measured.projectionFailed).toBe(false);
  expect(measured.diff).toBeDefined();
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

test("reviewer instruction says issues only names REMAINING defects and approved means an empty issues list", () => {
  // issue #478: the instruction named only one direction (approved vs
  // otherwise), so a reviewer with nothing left to fix recorded
  // "changes_requested" over resolved findings. Pin the reverse direction in
  // words, where the model reads it.

  const instruction = formatReviewerInstruction();
  expect(instruction).toContain("issues");
  expect(instruction).toContain("REMAIN");
  expect(instruction).toContain('approved" is exactly the verdict whose issues list is empty');
  expect(instruction).toContain("belongs in the summary");
});

test("parseVerdict rejects changes_requested with an empty issues list, naming the rule", () => {
  // issue #478: this passed today and deadlocked the round (round 3ca17be2
  // over #445) -- a reviewer with nothing left to fix still stamped
  // "changes_requested" because nothing said an empty issues list is
  // "approved". Refuse mechanically, the way the coverage branch does: name
  // the field path, the rule and the resubmission.
  let caught: unknown;
  try {
    parseVerdict(
      { status: "changes_requested", issues: [], summary: "all findings RESOLVED" },
      "run-id",
    );
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(OrchestrationError);
  expect((caught as OrchestrationError).code).toBe("malformed_verdict");
  expect((caught as Error).message).toBe(
    'verdict.issues must name at least one REMAINING defect when verdict.status is "changes_requested" (an empty list means nothing must change: resolved findings belong in verdict.summary, and "approved" is the verdict with an empty verdict.issues); resubmit the corrected verdict',
  );
});

test("parseVerdict accepts an approved verdict with a non-empty issues list (minor notes)", () => {
  // issue #478: "approved with minor notes" is a legal form and must keep
  // passing alongside the new empty-issues refusal on "changes_requested".
  const verdict = parseVerdict(
    {
      status: "approved",
      issues: [{ severity: "minor", what: "consider renaming x to y in a follow-up" }],
      summary: "s",
    },
    "run-id",
  );
  expect(verdict.status).toBe("approved");
  expect(verdict.issues[0]?.what).toContain("follow-up");
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

test("parseVerdict accepts decomposition_required and still rejects an unknown status", () => {
  // Pins pre-change: `decomposition_required` was not a member of the status
  // union, so it was rejected as malformed alongside genuinely unknown values.
  const verdict = parseVerdict(
    { status: "decomposition_required", issues: [], summary: "needs decomposition" },
    "run-id",
  );
  expect(verdict.status).toBe("decomposition_required");

  let caught: unknown;
  try {
    parseVerdict({ status: "unknown_status", issues: [], summary: "s" }, "run-id");
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(OrchestrationError);
  expect((caught as OrchestrationError).code).toBe("malformed_verdict");
});

test("submit_follow_up advertises one typed object and rejects all-fields calls safely", () => {
  const tool = buildSubmitFollowUpTool({ followUps: [] }, { producer: "coder", runId: "run-1" });
  const schema = tool.parameters as unknown as {
    type?: string;
    anyOf?: unknown;
    required: string[];
    properties: Record<string, { type?: string }>;
    additionalProperties?: boolean;
  };
  // A top-level `anyOf` -- what a Type.Union of the four kinds produces -- is
  // rejected outright by providers that validate tool schemas ("schema must be
  // a JSON Schema of 'type: \"object\"'"), and this tool rides along on EVERY
  // workflow turn, so the whole run dies. One object, per-kind fields optional.
  expect(schema.type).toBe("object");
  expect(schema.anyOf).toBeUndefined();
  expect(schema.required.sort()).toEqual(["evidence", "kind", "title"]);
  expect(Object.keys(schema.properties).sort()).toEqual([
    "contract",
    "document",
    "evidence",
    "kind",
    "priority",
    "title",
  ]);
  expect(schema.additionalProperties).toBe(false);

  // The looser schema does NOT loosen the gate: a kind carrying another kind's
  // field is still refused, by the validator rather than by the schema.
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

  // And an unknown kind is still refused even though `kind` is now a bare string.
  let unknownKind: unknown;
  try {
    tool.prepareArguments?.({
      kind: "invented",
      title: "t",
      evidence: [{ summary: "s" }],
    });
  } catch (error) {
    unknownKind = error;
  }
  // The refusal names the accepted set, not only the disease: "kind is
  // unsupported" cost a live stage twelve identical rejections across four
  // invented kinds (2026-09-18, run 8998ec7c).
  expect((unknownKind as ProjectOperationsError).detail).toBe(
    "kind must be one of contract, note, design-doc-drift, backlog",
  );
});

test("a rejected tool call tells the model WHAT was wrong, not only that it was", async () => {
  // A model that receives "invalid_follow_up" cannot tell which field it got
  // wrong, so its only move is to call again unchanged. Observed 2026-09-16:
  // four identical rejections in a row, the stage exhausted, and the run
  // reported as a provider fault while the provider was answering normally.
  // docs/contracts/errors.md now requires `code: message`.
  const tool = buildSubmitFollowUpTool({ followUps: [] }, { producer: "coder", runId: "run-1" });
  // The harness passes six arguments; this tool reads only the first two, so the
  // rest are the narrowest stubs that satisfy the signature.
  const result = await (
    tool.execute as unknown as (
      id: string,
      params: unknown,
    ) => Promise<{ content: { text: string }[] }>
  )("call-1", {
    kind: "note",
    title: "Zephyrine cataloguing",
    evidence: [],
  });
  const text = result.content[0]?.text ?? "";
  expect(text).toContain("invalid_follow_up");
  // The actionable half: the validator's own sentence naming the field.
  expect(text).toContain("evidence must be non-empty");
  // And still no content from the rejected payload.
  expect(text).not.toContain("Zephyrine");
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

test("a coder stage that enters its closeout reserve settles structurally closed_out (issue #327)", async () => {
  const fx = fixture();
  execFileSync("git", ["init", "-q"], { cwd: fx.targetDir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: fx.targetDir });
  fs.writeFileSync(path.join(fx.targetDir, "tracked.txt"), "base\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: fx.targetDir });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: fx.targetDir });
  const planner = plannerRole(fx);
  const coder = fx.role("coder", "You code.", ["read"]);
  const reviewer = reviewerRole(fx);
  fx.faux.setResponses([
    ...plannerTurn({ complexity: "medium", securitySurface: "none", summary: "plan" }),
    fauxAssistantMessage(fauxToolCall("read", { path: "tracked.txt" })),
    fauxAssistantMessage("partial coding"),
    ...reviewerTurn({ status: "approved", issues: [], summary: "good" }),
  ]);

  const result = await runPipeline({
    targetDir: fx.targetDir,
    models: fx.models,
    task: "implement X",
    maxRounds: 1,
    roleStageLimits: { coder: { maxToolTurns: 2, finalResponseReserveToolTurns: 1 } },
    roles: { planner, coder, reviewer },
  });

  const coderMetrics = result.stageMetrics?.find((metric) => metric.stage === "code:1");
  expect(coderMetrics?.status).toBe("closed_out");
  expect(coderMetrics?.stageCloseout).toEqual({
    code: "stage_closeout",
    reason: "tool_turns",
    detail: expect.any(String),
  });
  for (const metric of result.stageMetrics ?? []) {
    if (metric.stage !== "code:1") {
      expect(metric.status).toBeUndefined();
      expect(metric.stageCloseout).toBeUndefined();
    }
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

test("an over-ceiling untracked change escalates on material_diff with its path list intact (issue #449)", async () => {
  const fx = fixture();
  execFileSync("git", ["init", "-q"], { cwd: fx.targetDir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: fx.targetDir });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: fx.targetDir });
  fs.writeFileSync(path.join(fx.targetDir, "baseline.txt"), "baseline\n");
  execFileSync("git", ["add", "baseline.txt"], { cwd: fx.targetDir });
  execFileSync("git", ["commit", "-qm", "baseline"], { cwd: fx.targetDir });
  // 70 KiB untracked: past the 64 KiB material ceiling AND the 32 KiB
  // aggregate projection ceiling -- the reproduced #449 shape, which before
  // this change died as projection_failure with changedFiles: [] from round
  // 2 on and left every stage searching blind.
  fs.writeFileSync(path.join(fx.targetDir, "big.txt"), "a".repeat(70 * 1024));
  const coder = fx.role("coder", "You code.");
  const reviewer = reviewerRole(fx);
  let coderRetryPrompt: string | undefined;
  const changes: Verdict = {
    status: "changes_requested",
    issues: [{ severity: "major", what: "add a null check" }],
    summary: "needs a fix",
  };
  const approve: Verdict = { status: "approved", issues: [], summary: "fixed" };
  fx.faux.setResponses([
    fauxAssistantMessage("coded round1"),
    fauxAssistantMessage(fauxToolCall(SUBMIT_VERDICT_TOOL_NAME, changes)),
    fauxAssistantMessage("review complete"),
    (context) => {
      coderRetryPrompt = lastUserText(context);
      return fauxAssistantMessage("coded round2");
    },
    fauxAssistantMessage(fauxToolCall(SUBMIT_VERDICT_TOOL_NAME, approve)),
    fauxAssistantMessage("review complete"),
  ]);

  const session = createWorkflowSession({
    targetDir: fx.targetDir,
    models: fx.models,
    task: "implement over-ceiling untracked",
    maxRounds: 3,
    roles: { coder, reviewer },
  });
  let state = session.initialState();
  while (!state.done) {
    const stepped = await session.step(state);
    state = applyTransition(stepped.state, autoDriver(stepped.transitions));
  }

  // The retrying stage kept its measured path list and escalated on material
  // size -- the durable record never says projection_failure, and "no changes"
  // is impossible: the files and their true measured size are all there.
  const round2 = state.stageMetrics?.find((metric) => metric.stage === "code:2");
  expect(round2?.pipelineContextStrategy).toBe("full");
  expect(round2?.pipelineContextFallbackReason).toBe("material_diff");
  expect(state.pipelineContext?.selection).toBe("full");
  expect(state.pipelineContext?.fallbackReason).toBe("material_diff");
  expect(state.pipelineContext?.changedFilesTotal).toBe(1);
  expect(state.pipelineContext?.changedFiles).toEqual(["big.txt"]);
  expect(state.pipelineContext?.projectionFailed).toBeUndefined();
  expect(state.pipelineContext?.untrackedTruncatedFiles).toBe(1);
  expect(state.pipelineContext?.diffBytes ?? 0).toBeGreaterThanOrEqual(70 * 1024);
  // The coder's round-2 prompt carries the path list and the honest reason,
  // never a failed measurement rendered as an empty list.
  expect(coderRetryPrompt).toContain('"big.txt"');
  expect(coderRetryPrompt).toContain("Full-context retry fallback: material_diff.");
  expect(coderRetryPrompt).not.toContain("projection_failure");
  expect(coderRetryPrompt).not.toContain("the git measurement failed");
});

test("factory sessions preserve role ceilings for durable review-limit resumes (issue #511)", async () => {
  const fx = fixture();
  const coder = fx.role("coder", "You code.");
  const reviewer = reviewerRole(fx);
  const target = new ProjectStore(fx.targetDir);
  let firstAttempt = true;

  const makeSession = (reviewLimit: number): WorkflowSession => {
    const factorySession = createWorkflowSession({
      targetDir: fx.targetDir,
      models: fx.models,
      task: "resume a paused review",
      maxRounds: 1,
      roles: { coder, reviewer },
      stageLimits: { maxInputTokens: 2_400_000 },
      roleStageLimits: { reviewer: { maxInputTokens: reviewLimit } },
    });
    return {
      ...factorySession,
      initialState: () => ({ ...factorySession.initialState(), phase: "review" }),
      async step(state) {
        if (firstAttempt) {
          firstAttempt = false;
          const limit = new StageLimitError("input", 2_400_000, 2_400_000, {
            maxDurationMs: 0,
            maxModelTurns: 0,
            maxToolTurns: 0,
            maxInputTokens: 2_400_000,
            maxCostUsd: 0,
            finalResponseReserveModelTurns: 0,
            finalResponseReserveDurationMs: 0,
            finalResponseReserveToolTurns: 0,
            finalResponseReserveInputTokens: 0,
            elapsedMs: 1,
            modelTurns: 0,
            toolTurns: 0,
            inputTokens: 2_400_000,
            lastInputTokens: 2_400_000,
            costUsd: 0,
            costInFlight: false,
          });
          throw new WorkflowStageLimitError(limit, "paused-review", {
            stage: "review:1",
            status: "paused",
            input: 2_400_000,
            cachedInput: 0,
            freshInput: 2_400_000,
            output: 0,
            costUsd: 0,
            requestBytes: { systemPrompt: 0, prompt: 0, toolDefinitions: 0, total: 0 },
            readFiles: [],
            readFilesTotal: 0,
            readFilesTruncated: 0,
            diffBytes: 0,
            contextStrategy: "auto",
          });
        }
        return {
          state: { ...state, done: true, approved: true },
          result: { phase: "review", runId: "review-resumed", text: "approved" },
          transitions: [{ kind: "stop", isDefault: true, toPhase: "done", toRound: state.round }],
        };
      },
    };
  };

  const paused = await new RunCoordinator(makeSession(2_400_000), target, {
    runId: "factory-role-limit",
  }).run();
  expect(paused.checkpoint.pause).toMatchObject({
    phase: "review",
    code: "stage_limit",
    limitReason: "input",
    limit: 2_400_000,
  });

  const resumed = new RunCoordinator(makeSession(2_600_000), new ProjectStore(fx.targetDir), {
    runId: "factory-role-limit",
    resumeExisting: true,
  });
  expect(() => resumed.resumeStage({ source: "operator", action: "retry" })).not.toThrow(
    "unchanged input stage limit",
  );
  expect((await resumed.run()).status).not.toBe("paused");
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

test("first changes_requested verdict still advances to a second code round (issue #451)", async () => {
  // Pins pre-change: only the SECOND blocking verdict stops; the first keeps
  // the single advance into another code round.
  const fx = fixture();
  const coder = fx.role("coder", "You code.");
  const reviewer = reviewerRole(fx);
  fx.faux.setResponses([
    fauxAssistantMessage("code r1"),
    ...reviewerTurn({
      status: "changes_requested",
      issues: [{ severity: "major", what: "handle empty input" }],
      summary: "needs a fix",
    }),
    fauxAssistantMessage("code r2"),
    ...reviewerTurn({ status: "approved", issues: [], summary: "fixed" }),
  ]);
  const result = await runPipeline({
    targetDir: fx.targetDir,
    models: fx.models,
    task: "implement",
    maxRounds: 3,
    roles: { coder, reviewer },
  });
  expect(result.approved).toBe(true);
  expect(result.rounds).toBe(2);
  expect((result.stageMetrics ?? []).filter((m) => m.stage.startsWith("code:"))).toHaveLength(2);
});

test("second blocking verdict settles not-approved with blocking_verdicts and no third code round (issue #451)", async () => {
  // Pins pre-change: two changes_requested verdicts used to advance into a
  // third identical code round; the stop rule settles on the second instead,
  // regardless of maxRounds.
  const fx = fixture();
  const coder = fx.role("coder", "You code.");
  const reviewer = reviewerRole(fx);
  const changes: Verdict = {
    status: "changes_requested",
    issues: [{ severity: "major", what: "still not right" }],
    summary: "again",
  };
  fx.faux.setResponses([
    fauxAssistantMessage("code r1"),
    ...reviewerTurn(changes),
    fauxAssistantMessage("code r2"),
    ...reviewerTurn(changes),
  ]);
  const result = await runPipeline({
    targetDir: fx.targetDir,
    models: fx.models,
    task: "implement",
    maxRounds: 5,
    roles: { coder, reviewer },
  });
  expect(result.approved).toBe(false);
  expect(result.outcome).toBe("decomposition_required");
  expect(result.escalation).toEqual({
    required: true,
    reason: "blocking_verdicts",
    blockingVerdicts: 2,
  });
  // Two code rounds, never a third.
  expect((result.stageMetrics ?? []).filter((m) => m.stage.startsWith("code:"))).toHaveLength(2);
});

test("second blocking verdict settles at the shipped maxRounds: 2 with blocking_verdicts (issue #451)", async () => {
  // Pins pre-change: at the shipped default maxRounds (2) the second blocking
  // verdict arrives exactly when round === maxRounds, so the cap branch used to
  // settle first and the blocking_verdicts signal was never set.
  const fx = fixture();
  const coder = fx.role("coder", "You code.");
  const reviewer = reviewerRole(fx);
  const changes: Verdict = {
    status: "changes_requested",
    issues: [{ severity: "major", what: "still not right" }],
    summary: "again",
  };
  fx.faux.setResponses([
    fauxAssistantMessage("code r1"),
    ...reviewerTurn(changes),
    fauxAssistantMessage("code r2"),
    ...reviewerTurn(changes),
  ]);
  const result = await runPipeline({
    targetDir: fx.targetDir,
    models: fx.models,
    task: "implement",
    maxRounds: 2,
    roles: { coder, reviewer },
  });
  expect(result.approved).toBe(false);
  expect(result.escalation).toEqual({
    required: true,
    reason: "blocking_verdicts",
    blockingVerdicts: 2,
  });
  // Two code rounds, never a third.
  expect((result.stageMetrics ?? []).filter((m) => m.stage.startsWith("code:"))).toHaveLength(2);
});

test("decomposition_required verdict stops on round 1 with role_requested (issue #451)", async () => {
  // Pins pre-change: decomposition_required was not parseable, so a role
  // request to stop-and-decompose could never settle the run on round 1.
  const fx = fixture();
  const coder = fx.role("coder", "You code.");
  const reviewer = reviewerRole(fx);
  fx.faux.setResponses([
    fauxAssistantMessage("code r1"),
    ...reviewerTurn({
      status: "decomposition_required",
      issues: [],
      summary: "needs decomposition",
    }),
  ]);
  const result = await runPipeline({
    targetDir: fx.targetDir,
    models: fx.models,
    task: "implement",
    maxRounds: 5,
    roles: { coder, reviewer },
  });
  expect(result.approved).toBe(false);
  expect(result.outcome).toBe("decomposition_required");
  expect(result.escalation).toEqual({
    required: true,
    reason: "role_requested",
    blockingVerdicts: 1,
  });
  expect((result.stageMetrics ?? []).filter((m) => m.stage.startsWith("code:"))).toHaveLength(1);
});

test("escalation record carries exactly the three keys (issue #451)", async () => {
  // Pins pre-change: the escalation record must expose only required/reason/
  // blockingVerdicts -- no summary, issue text, file content, or model text.
  const fx = fixture();
  const coder = fx.role("coder", "You code.");
  const reviewer = reviewerRole(fx);
  fx.faux.setResponses([
    fauxAssistantMessage("code r1"),
    ...reviewerTurn({
      status: "decomposition_required",
      issues: [{ severity: "major", what: "not a trivial fix" }],
      summary: "needs decomposition",
    }),
  ]);
  const result = await runPipeline({
    targetDir: fx.targetDir,
    models: fx.models,
    task: "implement",
    maxRounds: 2,
    roles: { coder, reviewer },
  });
  const escalation = result.escalation;
  expect(escalation).toBeDefined();
  expect(Object.keys(escalation ?? {}).sort()).toEqual(["blockingVerdicts", "reason", "required"]);
});

test("approved result carries no escalation (issue #451)", async () => {
  // Pins pre-change: escalation is absent on approval, so the approved result
  // stays byte-identical to before the signal existed.
  const fx = fixture();
  const coder = fx.role("coder", "You code.");
  const reviewer = reviewerRole(fx);
  fx.faux.setResponses([
    fauxAssistantMessage("code r1"),
    ...reviewerTurn({ status: "approved", issues: [], summary: "good" }),
  ]);
  const result = await runPipeline({
    targetDir: fx.targetDir,
    models: fx.models,
    task: "implement",
    maxRounds: 2,
    roles: { coder, reviewer },
  });
  expect(result.approved).toBe(true);
  expect("escalation" in result).toBe(false);
});

test("cap-exhausted not-approved result carries no escalation (issue #451)", async () => {
  // Pins pre-change: round-cap exhaustion with fewer than two blocking verdicts
  // is a round limit, not the review stop rule, so it must not gain an
  // escalation signal.
  const fx = fixture();
  const coder = fx.role("coder", "You code.");
  const reviewer = reviewerRole(fx);
  fx.faux.setResponses([
    fauxAssistantMessage("code r1"),
    ...reviewerTurn({
      status: "changes_requested",
      issues: [{ severity: "major", what: "x" }],
      summary: "needs a fix",
    }),
  ]);
  const result = await runPipeline({
    targetDir: fx.targetDir,
    models: fx.models,
    task: "implement",
    maxRounds: 1,
    roles: { coder, reviewer },
  });
  expect(result.approved).toBe(false);
  expect(result.outcome).toBe("decomposition_required");
  expect("escalation" in result).toBe(false);
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

test("a reviewer that reviewed in prose is asked again, and its verdict settles the round (#278)", async () => {
  const fx = fixture();
  const coder = fx.role("coder", "You code.");
  const reviewer = reviewerRole(fx);
  // The measured failure: a thorough inspection that ends in prose without
  // calling submit_verdict -- roughly two attempts in three on a flash
  // reviewer. The review happened; only the submission was skipped, so the
  // round must not be thrown away.
  fx.faux.setResponses([
    fauxAssistantMessage("coded"),
    fauxAssistantMessage("I reviewed it thoroughly and it looks correct"),
    ...reviewerTurn({ status: "approved", issues: [], summary: "good" }),
  ]);

  const result = await runPipeline({
    targetDir: fx.targetDir,
    models: fx.models,
    task: "implement R",
    maxRounds: 2,
    roles: { coder, reviewer },
  });

  expect(result.approved).toBe(true);
  expect(result.verdicts.at(-1)?.status).toBe("approved");
  // One review ROUND, settled on its second ask -- not a second round, which
  // would have re-run the coder and paid for the inspection twice.
  expect(result.rounds).toBe(1);
});

test("a reviewer that never calls submit_verdict blocks as a red review-not-run pause", async () => {
  const fx = fixture();
  const coder = fx.role("coder", "You code.");
  const reviewer = reviewerRole(fx);
  // Reviewer emits only text -- no submit_verdict tool call. TWICE: the stage
  // asks again when the verdict never arrived (#278), so a reviewer that will
  // not submit has to refuse both times for the pause to be the real outcome.
  fx.faux.setResponses([
    fauxAssistantMessage("coded"),
    fauxAssistantMessage("I reviewed but submitted no verdict"),
    fauxAssistantMessage("still no verdict"),
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
  expect(caught).toBeInstanceOf(PipelinePauseError);
  // Reviewer did not run is a RED result with its own code, not a silence:
  // distinct from "reviewed, no findings" and blocked like a red gate.
  expect((caught as PipelinePauseError).code).toBe("pipeline_paused");
  expect((caught as PipelinePauseError).message).toContain("review_not_run");
  expect((caught as PipelinePauseError).message).toContain("missing_verdict");
});

test("a malformed submission blocks as a red review-not-run pause with the cause named", async () => {
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
  expect(caught).toBeInstanceOf(PipelinePauseError);
  expect((caught as PipelinePauseError).message).toContain("review_not_run");
  expect((caught as PipelinePauseError).message).toContain("malformed_verdict");
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
  // Absent affectedFiles defaults to [] -- the degrade-cleanly contract.
  expect(plan.affectedFiles).toEqual([]);

  const affected = parsePlan(
    {
      complexity: "medium",
      securitySurface: "low",
      summary: "s",
      affectedFiles: ["src/a.ts", "src/b.ts"],
      surfaceAnalysis,
    },
    "run-id",
  );
  expect(affected.affectedFiles).toEqual(["src/a.ts", "src/b.ts"]);

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
  // A malformed affectedFiles submission is rejected naming the offending
  // field, never reported as an absent plan (docs/contracts/errors.md).
  const affectedFilesCases: unknown[] = [
    {
      complexity: "medium",
      securitySurface: "none",
      summary: "s",
      affectedFiles: "src/a.ts",
      surfaceAnalysis,
    },
    {
      complexity: "medium",
      securitySurface: "none",
      summary: "s",
      affectedFiles: [""],
      surfaceAnalysis,
    },
    {
      complexity: "medium",
      securitySurface: "none",
      summary: "s",
      affectedFiles: [5],
      surfaceAnalysis,
    },
  ];
  for (const value of affectedFilesCases) {
    let caught: unknown;
    try {
      parsePlan(value, "run-id");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OrchestrationError);
    expect((caught as OrchestrationError).code).toBe("malformed_plan");
    expect((caught as OrchestrationError).message).toContain("plan.affectedFiles");
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

test("a planner submission carries affected files into the coder round-1 prompt", async () => {
  // THE INJECTION PIN (issue #316 slice 1): the planner's affected files ride
  // the structured submission into the coder's round-1 handoff as framed data
  // -- so a brief never needs a hand-written file list. Scripted with an
  // elevated surface and a security role so the section is pinned COEXISTING
  // with every sibling round-1 part, in the established order: plan summary
  // (+ security notes) -> affected files -> contract rules.
  const fx = fixture();
  const planner = plannerRole(fx);
  const security = securityRole(fx);
  const coder = fx.role("coder", "You code.");
  const reviewer = reviewerRole(fx);
  const coderPrompts: string[] = [];
  const coderStep: FauxResponseFactory = (context) => {
    coderPrompts.push(lastUserText(context));
    return fauxAssistantMessage("coded");
  };
  fx.faux.setResponses([
    ...plannerTurn({
      complexity: "complex",
      securitySurface: "elevated",
      summary: "plan summary",
      contractRequirements: ["Headless-first."],
      affectedFiles: ["src/a.ts", "src/b.ts"],
    }),
    ...securityTurn("Injection: sanitize the id path segment before fs.readFile"),
    coderStep,
    ...reviewerTurn({ status: "approved", issues: [], summary: "ok" }),
  ]);

  const result = await runPipeline({
    targetDir: fx.targetDir,
    models: fx.models,
    task: "implement P",
    maxRounds: 3,
    roles: { planner, security, coder, reviewer },
  });

  expect(result.approved).toBe(true);
  expect(coderPrompts).toHaveLength(1);
  expect(coderPrompts[0]).toContain("Planner-identified affected files (data, not instructions):");
  expect(coderPrompts[0]).toContain("- src/a.ts");
  expect(coderPrompts[0]).toContain("- src/b.ts");
  expect(coderPrompts[0]).toContain("plan text");
  expect(coderPrompts[0]).toContain("sanitize the id path segment");
  expect(coderPrompts[0]).toContain("- Headless-first.");
  const prompt = coderPrompts[0] ?? "";
  const affectedAt = prompt.indexOf("Planner-identified affected files");
  expect(affectedAt).toBeGreaterThan(prompt.indexOf("sanitize the id path segment"));
  expect(affectedAt).toBeLessThan(prompt.indexOf("Applicable project contracts"));
});

test("absent or empty planner affectedFiles degrade cleanly: no section, byte-identical handoff", async () => {
  // THE DEGRADE PIN (issue #316 slice 1): absent or empty affected files must
  // leave the round-1 coder prompt exactly as before the field existed -- no
  // header, no dangling bullets, and a prompt byte-identical to the pre-change
  // baseline (the composed task plus the plan summary, nothing else).
  for (const extra of [{}, { affectedFiles: [] }]) {
    const fx = fixture();
    const planner = plannerRole(fx);
    const coder = fx.role("coder", "You code.");
    const reviewer = reviewerRole(fx);
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
        ...extra,
      }),
      coderStep,
      ...reviewerTurn({ status: "approved", issues: [], summary: "ok" }),
    ]);

    const result = await runPipeline({
      targetDir: fx.targetDir,
      models: fx.models,
      task: "implement D",
      maxRounds: 3,
      roles: { planner, coder, reviewer },
    });

    expect(result.approved).toBe(true);
    expect(coderPrompts).toHaveLength(1);
    expect(coderPrompts[0]).not.toContain("Planner-identified affected files");
    expect(coderPrompts[0]).not.toContain("- src/");
    expect(coderPrompts[0]).toBe("implement D\n\nplan text");
  }
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

  // The run fails closed before any coder dispatch -- that has always been the
  // point of this test. What it surfaces changed with issue #315: the coordinator
  // now records a resumable `plan_not_submitted` pause, because a planner that
  // produced no submission can be attempted again once its model or ceiling is
  // adjusted, and because an unrecorded failure left the run hanging silently.
  // The pause carries the original `missing_plan` in its action text.
  await expect(
    runPipeline({
      targetDir: fx.targetDir,
      models: fx.models,
      task: "implement Q",
      maxRounds: 3,
      roles: { planner, coder, reviewer },
    }),
  ).rejects.toMatchObject({ pause: { phase: "plan", code: "plan_not_submitted" } });
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
  ).rejects.toMatchObject({ pause: { phase: "plan", code: "plan_not_submitted" } });
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
  ).rejects.toMatchObject({ code: "pipeline_paused" });
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
    affectedFiles: [],
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

  // The text fallback routes every candidate through parsePlan, so it inherits
  // affectedFiles for free -- a fenced plan carrying the planner's file list is
  // recovered whole, not stripped (issue #316).
  const withFiles = parsePlanText(
    `\`\`\`json\n${JSON.stringify(
      governedPlan({
        complexity: "medium",
        securitySurface: "low",
        summary: "s",
        affectedFiles: ["src/a.ts", "src/b.ts"],
      }),
    )}\n\`\`\``,
    "run-id",
  );
  expect(withFiles?.affectedFiles).toEqual(["src/a.ts", "src/b.ts"]);

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

test("two different plans in one planner response are rejected, not silently resolved", () => {
  // A planner that drafts and then corrects itself puts the REAL submission
  // last. Taking the first candidate accepted the draft -- and a draft saying
  // securitySurface "none" where the correction said "elevated" skipped the
  // mandatory security phase with no error and no retry. Guessing which one was
  // meant is not this parser's job; ambiguity is a rejection the planner can fix.
  const draft = JSON.stringify(
    governedPlan({ complexity: "trivial", securitySurface: "none", summary: "draft" }),
  );
  const final = JSON.stringify(
    governedPlan({ complexity: "complex", securitySurface: "elevated", summary: "final" }),
  );
  let caught: unknown;
  try {
    parsePlanText(
      `Let me draft this:\n\`\`\`json\n${draft}\n\`\`\`\n\nFinal answer:\n\`\`\`json\n${final}\n\`\`\``,
      "run-id",
    );
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(OrchestrationError);
  expect((caught as OrchestrationError).code).toBe("malformed_plan");
  expect((caught as OrchestrationError).message).toContain("more than one distinct plan");

  // The SAME plan reaching the parser twice -- the bare object and its own
  // fenced copy -- is one submission, not two, and must still resolve.
  const single = JSON.stringify(
    governedPlan({ complexity: "medium", securitySurface: "none", summary: "one" }),
  );
  expect(parsePlanText(`\`\`\`json\n${single}\n\`\`\``, "run-id")?.complexity).toBe("medium");
});

test("an UNFENCED draft followed by a second plan is rejected too, not silently accepted", () => {
  // The rejection above only fired when both plans happened to be fenced. A
  // planner that writes its draft as a bare object -- the single most common
  // text-fallback shape -- produced exactly ONE candidate, because the scan
  // stopped at the first balanced object. So the draft was returned, and a
  // draft saying securitySurface "none" where the correction said "elevated"
  // skipped the mandatory security phase: the very bypass this check exists to
  // close, still open for the shape most likely to hit it.
  const draft = JSON.stringify(
    governedPlan({ complexity: "trivial", securitySurface: "none", summary: "draft" }),
  );
  const final = JSON.stringify(
    governedPlan({ complexity: "complex", securitySurface: "elevated", summary: "final" }),
  );

  for (const [label, text] of [
    ["bare, prose between", `Draft:\n${draft}\n\nOn reflection:\n${final}`],
    ["bare, adjacent", `${draft}\n\n${final}`],
    ["bare then fenced", `Draft:\n${draft}\n\nFinal:\n\`\`\`json\n${final}\n\`\`\``],
  ] as const) {
    let caught: unknown;
    try {
      parsePlanText(text, "run-id");
    } catch (error) {
      caught = error;
    }
    expect(caught, label).toBeInstanceOf(OrchestrationError);
    expect((caught as OrchestrationError).code, label).toBe("malformed_plan");
    expect((caught as OrchestrationError).message, label).toContain("more than one distinct plan");
  }

  // Scanning the whole text must not turn ONE plan into two. A single bare
  // object surrounded by prose stays a single submission -- the nested objects
  // inside it (surfaceAnalysis, its coverage entries) are consumed with it, not
  // collected as rival candidates.
  const one = JSON.stringify(
    governedPlan({ complexity: "medium", securitySurface: "low", summary: "one" }),
  );
  expect(parsePlanText(`Here it is.\n\n${one}\n\nDone.`, "run-id")?.summary).toBe("one");
  expect(parsePlanText(`${one}\n\n\`\`\`json\n${one}\n\`\`\``, "run-id")?.summary).toBe("one");

  // A complete plan followed by a cut-off object still resolves: the complete
  // one was a real submission, and the unterminated tail is not a rival plan.
  expect(parsePlanText(`${one}\n\n${final.slice(0, 40)}`, "run-id")?.summary).toBe("one");
});

test("scanning the whole planner response stays linear, not quadratic, in its objects", () => {
  // Walking the whole text made the candidate dedup load-bearing, and deduping
  // by scanning the array compares each new candidate against every one already
  // held. That is invisible at the handful of candidates a real plan produces
  // and quadratic on a response padded with brace-asides -- measured at ~2s for
  // 20k objects and ~59s for 1MB, spent inside a single planner turn with no
  // ceiling upstream. A model is not prevented from emitting that, so the cost
  // is pinned here rather than left to the next person to rediscover.
  const timeFor = (objects: number): number => {
    const text = Array.from({ length: objects }, (_, index) => `{"a":${index}}`).join(" ");
    const started = performance.now();
    expect(() => parsePlanText(text, "run-id")).toThrow(OrchestrationError);
    return performance.now() - started;
  };

  // One wall-clock ceiling, not a ratio between two sizes. A ratio looks
  // machine-independent but divides by a small number: the 5k sample is ~13ms
  // here, so a single scheduling hiccup swings it, and the earlier form failed
  // about one run in six on unchanged code. Measured on this machine, 40k
  // objects cost ~350ms with the Set and ~8500ms with the array scan this test
  // exists to prevent -- a 24x gap, and the ceiling sits inside it with room
  // for a much slower CI box to stay under while any quadratic regression, on
  // any hardware, lands far above.
  timeFor(2000); // warm up, so JIT compilation is not charged to the measured run
  expect(timeFor(40000)).toBeLessThan(3000);
});

test("a nested fragment never becomes the reported plan rejection", () => {
  // Observed on a real run: a model emitted its tool call as pseudo-XML, the
  // balanced-brace slice lifted out one `coverage` entry, and the operator was
  // told "plan.complexity must be one of ..." -- a field the planner never got
  // wrong. Prefer the candidate that actually carries `complexity`.
  const fragment = JSON.stringify({
    surfaceId: "core",
    status: "covered",
    contractIds: [],
    evidence: [],
    rationale: "r",
  });
  const real = JSON.stringify(
    governedPlan({ complexity: "medium", securitySurface: "sideways", summary: "s" }),
  );
  let caught: unknown;
  try {
    parsePlanText(`\`\`\`json\n${fragment}\n\`\`\`\n\n\`\`\`json\n${real}\n\`\`\``, "run-id");
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(OrchestrationError);
  expect((caught as OrchestrationError).message).toContain("securitySurface");
  expect((caught as OrchestrationError).message).not.toContain("complexity");
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

test("every node of the submit_plan schema declares a type, so a validating provider accepts it", () => {
  // A node serialised as a bare `{}` -- what `Type.Any()` produces -- makes
  // providers that validate tool schemas reject the ENTIRE request: DeepSeek
  // answers 400 "one of `type`, `anyOf`, `$ref` field is required", so the
  // planner never runs and the stage fails having spent nothing. Walk the
  // serialised schema and assert no such node survives anywhere in it.
  const schema = buildSubmitPlanTool({}, "run").parameters as Record<string, unknown>;
  const untyped: string[] = [];
  const walk = (node: unknown, pointer: string): void => {
    if (node === null || typeof node !== "object" || Array.isArray(node)) return;
    const record = node as Record<string, unknown>;
    if (record.type === undefined && record.anyOf === undefined && record.$ref === undefined)
      untyped.push(pointer);
    for (const key of ["properties", "items", "patternProperties"]) {
      const child = record[key];
      if (child === undefined) continue;
      if (key === "items") walk(child, `${pointer}/items`);
      else
        for (const [name, value] of Object.entries(child as Record<string, unknown>))
          walk(value, `${pointer}/${key}/${name}`);
    }
  };
  walk(schema, "");
  expect(untyped).toEqual([]);
  // The enum leaves stay plain strings on purpose: parsePlan is the gate.
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  expect(properties.complexity?.type).toBe("string");
  expect(properties.surfaceAnalysis?.type).toBe("object");
});

test("an incomplete submit_plan reaches parsePlan and is named, not reported as a missing plan", async () => {
  // THE REGRESSION THIS GUARDS. Spelling `surfaceAnalysis` out structurally
  // makes TypeBox emit a `required` list for every non-optional nested field,
  // and pi-ai's `validateToolArguments` runs that schema INSIDE the harness,
  // before `execute`. A submission missing one leaf would then be bounced
  // pre-execute: `capture.error` never set, the retry prompt telling the
  // planner it "did not call submit_plan" when it did, and the run finally
  // failing as `missing_plan`. `docs/contracts/errors.md` forbids exactly that
  // -- an invalid input reported as an absent one. Every nested field is
  // therefore `Type.Optional`, so `parsePlan` stays the single content gate.
  const fx = fixture();
  const planner = plannerRole(fx);
  const coder = fx.role("coder", "You code.");
  const reviewer = reviewerRole(fx);
  // A coverage entry missing `contractIds` -- a leaf, three levels deep.
  fx.faux.setResponses([
    ...plannerTurn({
      complexity: "medium",
      securitySurface: "low",
      summary: "s",
      surfaceAnalysis: {
        projectType: "TypeScript CLI/library",
        surfaces: [{ id: "core", name: "programmatic core", rationale: "changes core" }],
        coverage: [
          {
            surfaceId: "core",
            status: "not_applicable",
            evidence: ["no contract-sensitive behavior"],
            rationale: "no applicable contract",
          },
        ],
      },
    }),
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
  // The specific cause, not "you did not submit a plan".
  expect((caught as OrchestrationError).code).toBe("malformed_plan");
  // The entry is indexed as well as the field named: a submission carries up to
  // fifteen coverage entries and "coverage.contractIds" left the planner to
  // find which one (2026-09-18, run 8998ec7c).
  expect((caught as OrchestrationError).message).toContain("coverage[0].contractIds");
  expect((caught as OrchestrationError).code).not.toBe("missing_plan");
});

test("a refused coverage entry names the entry, the field, and the vocabulary it wanted", () => {
  // THE REGRESSION THIS GUARDS. `parsePlan` answered THREE causes with ONE
  // sentence -- "coverage fields are invalid" -- which named neither the entry
  // nor the field. Observed live: a planner omitted the validator-required
  // `status` on all eight of its entries, was refused with that sentence twice,
  // and parsed only on the third attempt, once it happened to guess the field
  // (2026-09-18, run 8998ec7c). `docs/contracts/errors.md` forbids naming the
  // WRONG cause; naming none is the same failure with a friendlier face. Each
  // sentence quotes the one list the validator checks against, so it cannot
  // advertise a value the gate itself would then refuse.
  const entry = {
    surfaceId: "cli",
    status: "covered",
    contractIds: ["cli:thin-front"],
    evidence: ["test"],
    rationale: "applies",
  };
  const planWith = (coverageEntry: Record<string, unknown>) => ({
    complexity: "medium",
    securitySurface: "low",
    summary: "s",
    contractRequirements: [],
    surfaceAnalysis: {
      projectType: "CLI",
      surfaces: [{ id: "cli", name: "CLI", rationale: "changed" }],
      coverage: [coverageEntry],
    },
  });
  const { status: _dropped, ...withoutStatus } = entry;
  const refusedWith = (value: unknown): string => {
    try {
      parsePlan(value, "run-id");
    } catch (error) {
      return (error as OrchestrationError).message;
    }
    throw new Error("parsePlan accepted a submission it should have refused");
  };

  // The live case: `status` simply absent, which is what the schema invites by
  // declaring the leaf optional with no description.
  expect(refusedWith(planWith(withoutStatus))).toBe(
    "coverage[0].status must be one of covered, not_applicable, research_required",
  );
  // A later entry is named as itself, not as the first: the planner's real
  // submission carried eight, and "coverage fields are invalid" left it to find
  // which one by hand.
  expect(
    refusedWith({
      ...planWith(entry),
      surfaceAnalysis: {
        projectType: "CLI",
        surfaces: [
          { id: "cli", name: "CLI", rationale: "changed" },
          { id: "core", name: "core", rationale: "changed" },
        ],
        coverage: [entry, { ...withoutStatus, surfaceId: "core" }],
      },
    }),
  ).toBe("coverage[1].status must be one of covered, not_applicable, research_required");
  expect(refusedWith(planWith({ ...entry, status: "partially_covered" }))).toBe(
    "coverage[0].status must be one of covered, not_applicable, research_required",
  );
  expect(refusedWith(planWith({ ...entry, surfaceId: "  " }))).toBe(
    "coverage[0].surfaceId must be a non-empty string",
  );
  expect(refusedWith(planWith({ ...entry, rationale: "" }))).toBe(
    "coverage[0].rationale must be a non-empty string",
  );
  expect(refusedWith(planWith({ ...entry, contractIds: [] }))).toBe(
    'coverage[0] is "covered" and requires contractIds and evidence',
  );
  // The refused VALUE is not echoed. This sentence reaches a durable failure
  // surface, and a contract id is an argument a model chose -- the place a
  // credential-shaped string would arrive from. The count plus the constant
  // list is as actionable as naming it: the model still holds its submission.
  // Independent review refused the version that echoed it.
  const unknownId = refusedWith(planWith({ ...entry, contractIds: ["cli:invented"] }));
  expect(unknownId).toContain("coverage[0].contractIds contains 1 unknown id(s)");
  expect(unknownId).toContain("known ids are ");
  expect(unknownId).not.toContain("cli:invented");
  // A refusal names the field, never the value that filled it. `parsePlan`'s
  // message is re-wrapped by `WorkflowStageFailureError` into a durable failure
  // surface (docs/contracts/errors.md excludes that class from the
  // safe-projection allow-list for exactly this reason), so an argument a model
  // chose must not ride along -- that is where a credential-shaped string would
  // arrive from. `verdict.ts` already refused an unknown surfaceId without
  // echoing it; this pins the same discipline on the plan side and keeps it
  // pinned, because the first version of the contract-id sentence did echo.
  const secret = "opaque-submitted-value-7c1f";
  // Opaque rather than credential-shaped on purpose. A token-shaped literal in a
  // tracked file is refused by this repository's own `smoke:artifact` scanner
  // (scripts/artifact-smoke.ts) -- the same discipline one level up. The shape of
  // the value changes nothing about the code under test, only about the ledger
  // it would reach.
  const refusals = [
    refusedWith(planWith({ ...entry, contractIds: [secret] })),
    refusedWith(planWith({ ...entry, status: secret })),
    refusedWith(planWith({ ...entry, surfaceId: secret })),
    refusedWith({
      ...planWith(entry),
      surfaceAnalysis: {
        ...planWith(entry).surfaceAnalysis,
        surfaces: [{ id: secret, name: "CLI", rationale: "changed" }],
      },
    }),
  ];
  for (const refusal of refusals) expect(refusal).not.toContain(secret);
  // A surface is indexed the same way, so the two lists can be read together.
  expect(
    refusedWith({
      ...planWith(entry),
      surfaceAnalysis: {
        ...planWith(entry).surfaceAnalysis,
        surfaces: [{ id: "cli", name: "", rationale: "changed" }],
      },
    }),
  ).toBe("surfaces[0].name must be a non-empty string");
});

test("the submission schemas state their vocabulary in descriptions, not in unions", () => {
  // The other half of the same fix. A `description` is ADVISORY: it is not a
  // `required` entry and not a union of literals, so it cannot bounce a
  // submission pre-execute -- the property the "every nested field is
  // Type.Optional" decision protects, and the one the enum-leaf decision
  // protects, both stay exactly as they were. What it buys is the vocabulary on
  // the surface a model reads EVERY turn, which is also the surface a provider
  // that samples against the schema can see. `follow-up.ts` records the same
  // reasoning for `kind`.
  type Leaf = { type?: string; description?: string; required?: string[] };
  type Node = {
    type?: string;
    description?: string;
    required?: string[];
    properties?: Record<string, Node>;
    items?: Node;
  };
  const leavesOf = (schema: unknown, ...path: string[]): Node =>
    path.reduce<Node>(
      (node, key) => (key === "items" ? (node.items as Node) : (node.properties?.[key] as Node)),
      schema as Node,
    );

  const coverage = leavesOf(
    buildSubmitPlanTool({}, "run").parameters,
    "surfaceAnalysis",
    "coverage",
    "items",
  );
  expect(coverage.required ?? []).toEqual([]);
  const status = leavesOf(coverage, "status") as Leaf;
  // Still a bare string: `parsePlan` remains the gate.
  expect(status.type).toBe("string");
  expect(status.description).toBe(
    "REQUIRED. Exactly one of: covered, not_applicable, research_required",
  );
  // The sentence a model reads here names the same three values the rejection
  // quotes and the validator checks -- one vocabulary, three places, and the
  // list is derived from the one the gate uses rather than retyped.
  for (const value of ["covered", "not_applicable", "research_required"])
    expect(status.description).toContain(value);
  // `status` is the only coverage leaf the validator requires unconditionally,
  // and the only one whose description says so.
  for (const name of ["surfaceId", "contractIds", "evidence", "rationale"])
    expect(leavesOf(coverage, name).description).toBeDefined();

  const verdictStatus = leavesOf(buildSubmitVerdictTool({}, "run").parameters, "status") as Leaf;
  expect(verdictStatus.type).toBe("string");
  expect(verdictStatus.description).toContain("approved");
  expect(verdictStatus.description).toContain("changes_requested");
  const severity = leavesOf(
    buildSubmitVerdictTool({}, "run").parameters,
    "issues",
    "items",
    "severity",
  ) as Leaf;
  expect(severity.type).toBe("string");
  expect(severity.description).toContain("blocker");
});

test("a submission satisfying the declared verdict schema is accepted by the validator (issue #489)", () => {
  // The regression this pins, measured 2026-09-20: #484 added a description to
  // `issues` and deleted the neighbouring `summary` property from the schema in
  // the same hunk. `parseVerdict` went on demanding the field, so the shape the
  // provider was asked to hold the model to (the tool sets
  // `constrainedSampling: strict`) was narrower than the shape the validator
  // accepts -- the reviewer was refused for omitting a field no schema offered.
  // Three paid rounds of #477 died on it and the durable ledger kept only a
  // 0-token provider row, which read as a provider failure.
  //
  // The assertion is deliberately ONE-DIRECTIONAL and derived, not retyped: a
  // payload built from the schema's OWN `required` list must be accepted. Add a
  // required property and this test fails until the payload teaches it; delete
  // one the validator still wants and it fails on the validator's refusal.
  // Retyping the field names here would have passed through the very deletion
  // it exists to catch.
  type Node = { required?: string[]; properties?: Record<string, Node> };
  const schema = buildSubmitVerdictTool({}, "run").parameters as Node;
  const declared = schema.required ?? [];

  // The values are the ones `formatReviewerInstruction` draws in the shape it
  // tells the reviewer to send. `coverage` is absent on purpose: it is
  // `Type.Optional`, so a submission without it must stay legal.
  const sample: Record<string, unknown> = { status: "approved", issues: [] };
  const sampleNames = new Set(["status", "issues", "summary", "coverage"]);
  // A required property this test has never been taught fails here, which is
  // the other direction: the schema growing a demand the validator does not
  // accept is the same defect mirrored.
  expect(declared.filter((name) => !sampleNames.has(name))).toEqual([]);

  // Built from `declared` alone -- nothing hand-added beyond the sample map, so
  // losing a required property loses it from the payload too.
  const payload: Record<string, unknown> = {};
  for (const name of declared) payload[name] = name === "summary" ? "ok" : sample[name];

  let refusal: unknown;
  try {
    parseVerdict(payload, "run");
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toBeUndefined();

  // And the instruction text the reviewer reads must name every required field:
  // a schema-only requirement stays invisible on a route that samples freely.
  const instruction = formatReviewerInstruction();
  for (const name of declared) expect(instruction).toContain(name);
});

test("no submission validator demands a field its own schema never declares (issue #489)", () => {
  // The test above pins the instance. This one pins the CLASS, because the
  // instance was not caught by anything for a full release: the existing
  // structural guard only asserts that nested objects carry no `required`, so a
  // property deleted from the top level -- which is what #484 did -- was
  // invisible to it. Three submission tools reach an `unknown`-typed validator
  // (`parseVerdict`, `parsePlan`, `validateFollowUpCandidate`), which is the
  // only place in this codebase where a demand can exist without a declaration;
  // TypeScript covers every other tool, which is why the class is this small.
  type Node = { required?: string[]; properties?: Record<string, Node>; items?: Node };
  const declaredFields = (node: Node, into = new Set<string>()): Set<string> => {
    for (const [name, child] of Object.entries(node.properties ?? {})) {
      into.add(name);
      declaredFields(child, into);
    }
    if (node.items !== undefined) declaredFields(node.items, into);
    return into;
  };
  // Every spelling a refusal in this codebase uses to name a field: the tail of
  // a dotted path (`verdict.summary`, `coverage[0].contractIds`) and the
  // subject of a `must`/`is` sentence (`plan.summary must be a string`). The
  // extraction is deliberately generous and the assertion is one-directional:
  // naming a declared field proves nothing, naming an undeclared one is the
  // defect. A message this misses is silence, never a false alarm.
  const namedFields = (message: string): string[] => [
    ...[...message.matchAll(/\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1] as string),
    ...[...message.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*) (?:must|is|cannot|needs) /g)].map(
      (match) => match[1] as string,
    ),
  ];

  // The VALUES are hand-written: a validator walks its branches in order, and
  // only a value it accepts reaches the next branch -- a payload of placeholders
  // stops at the first leaf and never reaches the one that was deleted. The
  // NAMES are not hand-written: each payload is assembled from its schema's own
  // `required`, so a property deleted from a schema disappears from the payload
  // and the validator's refusal names a field no schema declares. That is
  // exactly what #484 shipped.
  const probes = [
    {
      tool: "submit_verdict",
      schema: buildSubmitVerdictTool({}, "run").parameters as Node,
      values: { status: "approved", issues: [], summary: "ok" } as Record<string, unknown>,
      validate: (payload: object): unknown => parseVerdict(payload, "run"),
    },
    {
      tool: "submit_plan",
      schema: buildSubmitPlanTool({}, "run").parameters as Node,
      values: {
        complexity: "trivial",
        securitySurface: "none",
        summary: "ok",
        surfaceAnalysis: { projectType: "cli", surfaces: [], coverage: [] },
      } as Record<string, unknown>,
      validate: (payload: object): unknown => parsePlan(payload, "run"),
    },
    {
      tool: "submit_follow_up",
      schema: buildSubmitFollowUpTool({ followUps: [] }, { producer: "engine", runId: "capture" })
        .parameters as Node,
      values: {
        kind: "note",
        title: "a durable note",
        evidence: [{ summary: "an evidence summary" }],
      } as Record<string, unknown>,
      validate: (payload: object): unknown => validateFollowUpCandidate(payload),
    },
  ];

  for (const probe of probes) {
    const required = probe.schema.required ?? [];
    // A required property this test was never taught fails here, which is the
    // mirrored direction: the schema grew a demand and the payload must be
    // taught the value that satisfies it before any of this means anything.
    expect({
      tool: probe.tool,
      untaught: required.filter((name) => !(name in probe.values)),
    }).toEqual({ tool: probe.tool, untaught: [] });

    const payload: Record<string, unknown> = {};
    for (const name of required) payload[name] = probe.values[name];

    let refusal = "";
    try {
      probe.validate(payload);
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    // A refusal may legitimately demand a nested leaf the schema declares
    // `Type.Optional` -- the documented soft family, where the schema
    // advertises and the validator decides, so an incomplete submission gets
    // the validator's corrective sentence instead of a pre-execute bounce. It
    // may never demand a field the schema does not declare at all.
    const declared = declaredFields(probe.schema);
    expect({
      tool: probe.tool,
      undeclared: namedFields(refusal).filter((name) => !declared.has(name)),
    }).toEqual({ tool: probe.tool, undeclared: [] });
  }
});

test("an incomplete submit_verdict reaches parseVerdict and is named, not reported as a missing verdict", async () => {
  // Same pre-execute hazard on the reviewer's side, and worse here: the
  // coverage branch of `parseVerdict` answers with the exact contract IDs to
  // resubmit, which is the reviewer's only route to a correct second attempt.
  // A nested `required` would replace that guidance with a schema bounce.
  const fx = fixture();
  const planner = plannerRole(fx);
  const coder = fx.role("coder", "You code.");
  const reviewer = reviewerRole(fx);
  // An issue missing `what` -- a leaf inside an array inside the arguments.
  fx.faux.setResponses([
    ...plannerTurn({ complexity: "medium", securitySurface: "low", summary: "s" }),
    fauxAssistantMessage("coded"),
    ...reviewerTurn({
      status: "changes_requested",
      issues: [{ severity: "major" }],
      summary: "needs work",
    }),
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
  expect(caught).toBeInstanceOf(PipelinePauseError);
  // Not a schema pre-empt: the guidance reaches the reviewer in its tool
  // result; the pipeline-level pause names the red review, not the field.
  expect((caught as PipelinePauseError).message).toContain("review_not_run");
});

test("no tool schema requires a nested field, so the harness never pre-empts the parser", () => {
  // A structural guard over BOTH mandatory handoffs at once, so a later hand
  // spelling out another nested shape cannot silently reintroduce the
  // pre-execute bounce. Only the top level may carry `required`: that is the
  // contract with the provider (the tool's own arguments), while everything
  // below it belongs to `parsePlan`/`parseVerdict`.
  const schemas: Array<[string, Record<string, unknown>]> = [
    ["submit_plan", buildSubmitPlanTool({}, "run").parameters as Record<string, unknown>],
    ["submit_verdict", buildSubmitVerdictTool({}, "run").parameters as Record<string, unknown>],
  ];
  const offenders: string[] = [];
  const walk = (node: unknown, pointer: string, depth: number): void => {
    if (node === null || typeof node !== "object" || Array.isArray(node)) return;
    const record = node as Record<string, unknown>;
    if (depth > 0 && Array.isArray(record.required) && record.required.length > 0) {
      offenders.push(`${pointer}: ${(record.required as string[]).join(", ")}`);
    }
    const properties = record.properties;
    if (properties !== undefined)
      for (const [name, value] of Object.entries(properties as Record<string, unknown>))
        walk(value, `${pointer}/${name}`, depth + 1);
    if (record.items !== undefined) walk(record.items, `${pointer}/items`, depth + 1);
  };
  for (const [name, schema] of schemas) walk(schema, name, 0);
  expect(offenders).toEqual([]);
  // ...while the top level still names what the tool call itself must carry.
  const topLevel = Object.fromEntries(
    schemas.map(([name, schema]) => [name, schema.required as string[]]),
  );
  expect(topLevel.submit_plan).toContain("surfaceAnalysis");
  expect(topLevel.submit_verdict).toContain("status");
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
