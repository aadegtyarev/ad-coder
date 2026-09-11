import {
  BACKGROUND_CONTEXT,
  MemorySessionRepo,
} from "@earendil-works/pi-agent-core";
import type { Context, Session } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import { createRoleRunner } from "../runner/role-runner";
import type { RoleSpec, Verdict, VerdictIssue } from "./types";
import { OrchestrationError } from "./types";
import type { PipelineConfig, PipelineResult } from "./types";
import { formatReviewerInstruction, readVerdict, verdictArtifactPath } from "./verdict";

/**
 * Compose the EXISTING single-turn `runRole` into a plan -> (code<->review loop)
 * pipeline.
 *
 * WHY the verdict is a filesystem artifact and not a tool call: `runRole`
 * hardcodes its tool set and exposes no tool-injection seam, and its result
 * carries only a `tipId`, no tool-call payload. So the reviewer cannot CALL a
 * `submit_verdict` tool; instead it WRITES a JSON artifact via the existing
 * write tool, which the pipeline reads and strictly validates. The tool-call
 * form is a deferred follow-up needing an optional `tools` param on `runRole`.
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
  const runTurn = async (spec: RoleSpec, prompt: string, step: string, runId: string) => {
    // A fresh session per run: each role has its own systemPrompt, so sharing a
    // session would leak one role's history and prompt into another.
    const repo = new MemorySessionRepo();
    const session = await repo.create({}, BACKGROUND_CONTEXT);
    await runner.runRole(spec.role, spec.model, prompt, {
      runId,
      step,
      session,
      // exactOptionalPropertyTypes: spread the sink only when present.
      ...(config.ledgerSink !== undefined && { ledgerSink: config.ledgerSink }),
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
    const instruction = formatReviewerInstruction(verdictArtifactPath(targetDir, reviewerRunId));
    const reviewerPrompt = composeReviewerPrompt(config.task, changeSummary, instruction);
    await runTurn(config.roles.reviewer, reviewerPrompt, `review:${round}`, reviewerRunId);
    runIds.push(reviewerRunId);

    // Missing/malformed here throws OrchestrationError -- distinct from a
    // legitimate non-approval, which is a well-formed changes_requested verdict.
    const verdict = readVerdict(targetDir, reviewerRunId);
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
