import {
  BACKGROUND_CONTEXT,
  MemorySessionRepo,
} from "@earendil-works/pi-agent-core";
import type { Context, Session } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import { createRoleRunner } from "../runner/role-runner";
import type { Tool } from "../runner/tool";
import type { RoleSpec, Verdict, VerdictIssue } from "./types";
import { OrchestrationError } from "./types";
import type { PipelineConfig, PipelineResult } from "./types";
import { buildSubmitVerdictTool, formatReviewerInstruction } from "./verdict";
import type { VerdictCapture } from "./verdict";

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
  const runner = createRoleRunner({ targetDir, models: config.models });

  /** Drive one role turn on a fresh session and return its final assistant text. */
  const runTurn = async (
    spec: RoleSpec,
    prompt: string,
    step: string,
    runId: string,
    tools?: Tool[],
  ) => {
    // A fresh session per run: each role has its own systemPrompt, so sharing a
    // session would leak one role's history and prompt into another.
    const repo = new MemorySessionRepo();
    const session = await repo.create({}, BACKGROUND_CONTEXT);
    await runner.runRole(spec.role, spec.model, prompt, {
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

  let planSummary = "";
  if (config.roles.planner !== undefined) {
    const plannerRunId = crypto.randomUUID();
    runIds.push(plannerRunId);
    planSummary = await runTurn(config.roles.planner, config.task, "plan", plannerRunId);
  }

  for (let round = 1; round <= config.maxRounds; round += 1) {
    const coderRunId = crypto.randomUUID();
    const previousVerdict = verdicts[verdicts.length - 1];
    const coderPrompt =
      round === 1
        ? composeCoderPrompt(config.task, planSummary)
        : composeCoderPrompt(config.task, formatIssues(previousVerdict?.issues ?? []));
    const changeSummary = await runTurn(
      config.roles.coder,
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
    );
    await runTurn(config.roles.reviewer, reviewerPrompt, `review:${round}`, reviewerRunId, [
      submitTool,
    ]);
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
      return { approved: true, rounds: round, verdicts, runIds };
    }
  }

  return { approved: false, rounds: config.maxRounds, verdicts, runIds };
}

function composeCoderPrompt(task: string, context: string): string {
  if (context.trim() === "") {
    return task;
  }
  return `${task}\n\n${context}`;
}

function composeReviewerPrompt(task: string, changeSummary: string, instruction: string): string {
  const parts = [task];
  if (changeSummary.trim() !== "") {
    parts.push(`The coder reported:\n${changeSummary}`);
  }
  parts.push(instruction);
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
