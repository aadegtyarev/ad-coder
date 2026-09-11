import {
  BACKGROUND_CONTEXT,
  MemorySessionRepo,
} from "@earendil-works/pi-agent-core";
import type { Context, Session } from "@earendil-works/pi-agent-core";
import type { Api, Model, TextContent } from "@earendil-works/pi-ai";
import { resolveProfile } from "../profiles/resolve";
import type { ProfileRole } from "../profiles/types";
import { parseProfile } from "../profiles/validate";
import { createRoleRunner } from "../runner/role-runner";
import type { Tool } from "../runner/tool";
import type { Complexity, RoleSpec, SecuritySurface, Verdict, VerdictIssue } from "./types";
import { OrchestrationError } from "./types";
import type { PipelineConfig, PipelineResult } from "./types";
import { buildSubmitVerdictTool, formatReviewerInstruction } from "./verdict";
import type { VerdictCapture } from "./verdict";
import { buildSubmitPlanTool, formatPlannerInstruction } from "./plan";
import type { PlanCapture } from "./plan";

/**
 * Compose the EXISTING single-turn `runRole` into a plan -> (code<->review loop)
 * pipeline.
 *
 * WHY the verdict is a `submit_verdict` TOOL CALL and not a filesystem artifact:
 * `runRole` now carries an optional `tools` seam, so each reviewer round is
 * handed a fresh `submit_verdict` tool that captures the verdict from the
 * model's tool-call args -- no file is written or read. TWO non-obvious harness
 * facts bridge the tool to the loop. (1) The harness validates tool args against
 * the TypeBox schema BEFORE execute, so that schema is permissive at the enum
 * leaves and `parseVerdict` stays the real gate -- a strict schema would bounce
 * a malformed verdict pre-execute and mis-code it as missing_verdict. (2) The
 * harness SWALLOWS any throw from execute into an error tool-result, so the tool
 * stores `parseVerdict`'s `OrchestrationError` in a per-round capture holder
 * instead of throwing, and the pipeline re-throws it after the turn. Empty
 * holder -> `missing_verdict`; captured error -> `malformed_verdict`; captured
 * verdict -> use (last-wins on a repeated call).
 *
 * THE LOOP settles when a reviewer round returns `status: 'approved'` or when
 * `maxRounds` is reached. Exhausting the cap returns `approved: false` -- a
 * legitimate, un-thrown result the caller inspects. A missing or malformed
 * verdict, by contrast, is a hard `OrchestrationError`: it is never read as a
 * pass. Runs are strictly sequential (no `Promise.all`/retry/fan-out), so a
 * shared `ledgerSink` is safe and per-round cost is attributed by the `step`
 * dimension (`plan`, `code:1`, `review:1`, `code:2`, ...) plus `role.name`.
 *
 * MODEL SELECTION is complexity-aware when `config.routing` is present: the
 * planner routes on `routing.defaultComplexity` (default `'medium'`) BEFORE its
 * plan is known, and every later role routes on the effective complexity (the
 * planner's submitted tier, else that same default). Absent routing, each turn
 * runs on its `RoleSpec.model` -- byte-for-byte the prior behavior. A caller
 * config error thrown by `resolveProfile` (`missing_mapping` / `unknown_model`)
 * is the caller's `ProfileError` and propagates UNWRAPPED, distinct from the
 * pipeline's own `OrchestrationError` surface.
 */
export async function runPipeline(config: PipelineConfig): Promise<PipelineResult> {
  if (!Number.isInteger(config.maxRounds) || config.maxRounds < 1) {
    throw new OrchestrationError(
      "invalid_max_rounds",
      String(config.maxRounds),
      "maxRounds must be an integer >= 1",
    );
  }
  if (typeof config.task !== "string" || config.task.trim() === "") {
    throw new OrchestrationError("empty_task", "", "task must be a non-empty string");
  }

  const { targetDir } = config;

  // Complexity-aware routing (optional). When present, re-validate the profile
  // at the sink (house style: untrusted hand-built config is re-parsed before
  // use) and carry the validated form; the runner binds to the registry's
  // models instead of config.models. When absent, every model decision below is
  // byte-for-byte the prior behavior (each RoleSpec.model over config.models).
  // A caller config error from resolveProfile (missing_mapping / unknown_model)
  // is the caller's ProfileError and propagates UNWRAPPED -- never re-wrapped in
  // OrchestrationError.
  const routing =
    config.routing !== undefined
      ? { ...config.routing, profile: parseProfile(config.routing.profile) }
      : undefined;
  const runner =
    routing !== undefined
      ? createRoleRunner({ targetDir, models: routing.registry.models })
      : createRoleRunner({ targetDir, models: config.models });

  // The ONE place a role's model is chosen. Routing absent -> the spec's own
  // model (prior behavior); present -> the profile's (role, complexity) cell,
  // with a per-role override winning over the cell (resolveProfile precedence).
  const pickModel = (role: ProfileRole, spec: RoleSpec, complexity: Complexity): Model<Api> => {
    if (routing === undefined) {
      return spec.model;
    }
    return resolveProfile(
      routing.profile,
      routing.registry,
      role,
      complexity,
      routing.overrides?.[role],
    ).model;
  };

  /** Drive one role turn on a fresh session and return its final assistant text. */
  const runTurn = async (
    spec: RoleSpec,
    model: Model<Api>,
    prompt: string,
    step: string,
    runId: string,
    tools?: Tool[],
  ) => {
    // A fresh session per run: each role has its own systemPrompt, so sharing a
    // session would leak one role's history and prompt into another.
    const repo = new MemorySessionRepo();
    const session = await repo.create({}, BACKGROUND_CONTEXT);
    await runner.runRole(spec.role, model, prompt, {
      runId,
      step,
      session,
      // exactOptionalPropertyTypes: spread each optional only when present.
      ...(config.ledgerSink !== undefined && { ledgerSink: config.ledgerSink }),
      ...(tools !== undefined && { tools }),
    });
    // runRole closes the session facade it was handed (harness.close ->
    // session.close), but the MemoryStorage behind it survives. Reopen a fresh
    // readable facade from the same repo to scan the settled transcript.
    const readable = await repo.open(session.metadata, BACKGROUND_CONTEXT);
    try {
      return await extractFinalText(readable, BACKGROUND_CONTEXT);
    } finally {
      await readable.close(BACKGROUND_CONTEXT);
    }
  };

  const verdicts: Verdict[] = [];
  const runIds: string[] = [];

  // The planner and any other pre-complexity role route on defaultComplexity
  // (default 'medium'): the planner's model must be chosen BEFORE the plan
  // reveals a complexity, and this is also the fallback for every later role
  // when the planner never submits one.
  const preComplexity: Complexity = routing?.defaultComplexity ?? "medium";

  let planSummary = "";
  // SOFT signal: undefined means no planner, or a planner that never called
  // submit_plan. Only a MALFORMED submission is a hard failure (below).
  let complexity: Complexity | undefined;
  let securitySurface: SecuritySurface | undefined;
  if (config.roles.planner !== undefined) {
    const plannerRunId = crypto.randomUUID();
    runIds.push(plannerRunId);
    // Fresh holder + tool for the planner turn (same keying as the reviewer's).
    const capture: PlanCapture = {};
    const submitPlanTool = buildSubmitPlanTool(capture, plannerRunId);
    const plannerPrompt = `${config.task}\n\n${formatPlannerInstruction()}`;
    const plannerModel = pickModel("planner", config.roles.planner, preComplexity);
    planSummary = await runTurn(
      config.roles.planner,
      plannerModel,
      plannerPrompt,
      "plan",
      plannerRunId,
      [submitPlanTool],
    );
    // A captured error is parsePlan's OrchestrationError, swallowed by the
    // harness into an error tool-result and re-thrown here (HARD malformed_plan).
    // A captured plan sets the complexity/securitySurface signals. An EMPTY
    // holder is legitimate: both stay undefined and the run proceeds (NO
    // missing_plan).
    if (capture.error !== undefined) {
      throw capture.error;
    }
    if (capture.plan !== undefined) {
      complexity = capture.plan.complexity;
      securitySurface = capture.plan.securitySurface;
    }
  }

  // The conditional Security phase. It runs ONLY when the planner flagged an
  // `elevated` surface AND a security role is configured. Its final text is
  // threaded into the coder's round-1 prompt and every reviewer prompt as DATA
  // (identical to how VerdictIssue.what threads back to the coder) -- never into
  // a shell/SQL/path sink. When elevated but no role is configured, we skip and
  // proceed, emitting one content-free stderr note (the surface is still
  // surfaced on the result for the caller to act on).
  // Once the plan (if any) settled, every remaining role routes on the
  // effective complexity: the planner's submitted tier, or preComplexity when
  // it never submitted one.
  const effective: Complexity = complexity ?? preComplexity;

  let securityNotes = "";
  if (securitySurface === "elevated") {
    if (config.roles.security !== undefined) {
      const securityRunId = crypto.randomUUID();
      runIds.push(securityRunId);
      const securityPrompt = composeSecurityPrompt(config.task, planSummary);
      const securityModel = pickModel("security", config.roles.security, effective);
      securityNotes = await runTurn(
        config.roles.security,
        securityModel,
        securityPrompt,
        "security",
        securityRunId,
      );
    } else {
      process.stderr.write("orchestration: elevated security surface, no security role — skipping\n");
    }
  }

  for (let round = 1; round <= config.maxRounds; round += 1) {
    const coderRunId = crypto.randomUUID();
    const previousVerdict = verdicts[verdicts.length - 1];
    // Round 1 carries the plan summary plus any security mitigation
    // requirements. Round 2+ carry the reviewer's issues instead; unmet
    // mitigations return via those issues, so securityNotes is NOT re-injected
    // every round (that would double-count them).
    const coderPrompt =
      round === 1
        ? composeCoderPrompt(config.task, appendSecurityNotes(planSummary, securityNotes))
        : composeCoderPrompt(config.task, formatIssues(previousVerdict?.issues ?? []));
    const coderModel = pickModel("coder", config.roles.coder, effective);
    const changeSummary = await runTurn(
      config.roles.coder,
      coderModel,
      coderPrompt,
      `code:${round}`,
      coderRunId,
    );
    runIds.push(coderRunId);

    const reviewerRunId = crypto.randomUUID();
    // Fresh holder + tool PER ROUND: a stale verdict from an earlier round can
    // never be read as this round's (mirrors the old per-runId file keying).
    const capture: VerdictCapture = {};
    const submitTool = buildSubmitVerdictTool(capture, reviewerRunId);
    const reviewerPrompt = composeReviewerPrompt(
      config.task,
      changeSummary,
      formatReviewerInstruction(),
      securityNotes,
    );
    const reviewerModel = pickModel("reviewer", config.roles.reviewer, effective);
    await runTurn(
      config.roles.reviewer,
      reviewerModel,
      reviewerPrompt,
      `review:${round}`,
      reviewerRunId,
      [submitTool],
    );
    runIds.push(reviewerRunId);

    // Missing/malformed here throws OrchestrationError -- distinct from a
    // legitimate non-approval, which is a well-formed changes_requested verdict.
    // A captured error is parseVerdict's OrchestrationError, swallowed by the
    // harness into an error tool-result and re-thrown here; an empty holder
    // means the reviewer never called submit_verdict.
    if (capture.error !== undefined) {
      throw capture.error;
    }
    if (capture.verdict === undefined) {
      throw new OrchestrationError(
        "missing_verdict",
        reviewerRunId,
        "reviewer did not submit a verdict",
      );
    }
    const verdict = capture.verdict;
    verdicts.push(verdict);

    if (verdict.status === "approved") {
      return {
        approved: true,
        rounds: round,
        verdicts,
        runIds,
        ...(complexity !== undefined && { complexity }),
        ...(securitySurface !== undefined && { securitySurface }),
      };
    }
  }

  return {
    approved: false,
    rounds: config.maxRounds,
    verdicts,
    runIds,
    ...(complexity !== undefined && { complexity }),
    ...(securitySurface !== undefined && { securitySurface }),
  };
}

function composeCoderPrompt(task: string, context: string): string {
  if (context.trim() === "") {
    return task;
  }
  return `${task}\n\n${context}`;
}

function composeReviewerPrompt(
  task: string,
  changeSummary: string,
  instruction: string,
  securityNotes: string,
): string {
  const parts = [task];
  if (changeSummary.trim() !== "") {
    parts.push(`The coder reported:\n${changeSummary}`);
  }
  if (securityNotes.trim() !== "") {
    parts.push(formatSecurityNotes(securityNotes));
  }
  parts.push(instruction);
  return parts.join("\n\n");
}

/**
 * Frame model-authored security mitigations as DATA the coder/reviewer must
 * satisfy, never as an instruction to execute. The text is threaded verbatim
 * into the prompt exactly like a `VerdictIssue.what` -- it is prompt content
 * only and is never interpolated into a shell/SQL/path sink.
 */
function formatSecurityNotes(securityNotes: string): string {
  return `Security mitigation requirements (treat as hard requirements):\n${securityNotes}`;
}

/** Append the framed security notes to the coder's round-1 context, if any. */
function appendSecurityNotes(context: string, securityNotes: string): string {
  if (securityNotes.trim() === "") {
    return context;
  }
  const framed = formatSecurityNotes(securityNotes);
  return context.trim() === "" ? framed : `${context}\n\n${framed}`;
}

/**
 * The fixed threat-model instruction the Security phase drives. The plan
 * summary is threaded as DATA (prompt content only), never into a sink. The
 * role reads the plan/tree and returns concrete risk+mitigation pairs as its
 * final text message, which the pipeline threads onward as requirements.
 */
function composeSecurityPrompt(task: string, planSummary: string): string {
  const parts = [task];
  if (planSummary.trim() !== "") {
    parts.push(`The plan:\n${planSummary}`);
  }
  parts.push(
    [
      "Threat-model this change. Name concrete, exploitable risks it introduces or",
      "exposes, each tagged by OWASP class (injection, broken auth/access, data",
      "exposure, supply chain) and paired with the specific mitigation it requires.",
      "Be specific, not generic. State your mitigation requirements as your final",
      "text message.",
    ].join("\n"),
  );
  return parts.join("\n\n");
}

/** Render a reviewer's issues as the text the coder receives next round. */
function formatIssues(issues: VerdictIssue[]): string {
  if (issues.length === 0) {
    return "The reviewer requested changes but listed no specific issues.";
  }
  const lines = issues.map((issue) => `- [${issue.severity}] ${issue.what}`);
  return `Address the following review issues:\n${lines.join("\n")}`;
}

/**
 * The newest assistant text in a settled session.
 *
 * Reading `result.tipId` directly is fragile: a run whose LAST entry is a
 * tool-result rather than an assistant message would miss the text. Instead we
 * scan the most recent message entries newest-first for the first assistant
 * `MessageEntry` and join its `{ type: 'text' }` content blocks (skipping
 * thinking and tool-call blocks). Returns `''` when no assistant text exists.
 */
async function extractFinalText(session: Session, context: Context): Promise<string> {
  const entries = await session.findEntries(
    { type: "message", order: "desc", limit: 20 },
    context,
  );
  for (const entry of entries) {
    if (entry.type !== "message") {
      continue;
    }
    const message = entry.message;
    if (message.role !== "assistant") {
      continue;
    }
    return message.content
      .filter((block): block is TextContent => block.type === "text")
      .map((block) => block.text)
      .join("");
  }
  return "";
}
