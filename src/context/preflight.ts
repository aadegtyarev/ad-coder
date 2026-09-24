import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTokens } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { Role } from "../role";
import { ContextBudgetError } from "./budget";
import { selectRecentTail } from "./compactor";
import { type EstimatorTool, estimateFullRequestTokens, grantedTools } from "./estimate";

/**
 * The full request a pre-flight assertion measures, in pi-ai `Context` shape.
 * `systemPrompt` is what the turn will actually send -- the runner appends the
 * compaction safety prompt in auto mode, so the caller passes the effective
 * prompt, not the raw role one. `tools` is the registered set; the allow-list
 * filter inside the estimator mirrors what the harness will grant.
 */
export interface RoleRequestContext {
  systemPrompt: string;
  tools?: readonly EstimatorTool[];
  messages: AgentMessage[];
}

/**
 * Pre-flight refusal, NOT a hook. It measures the FULL request (issue #630:
 * the role's system prompt and granted tool definitions outside the dialogue,
 * not the dialogue alone) and the irreducible recent tail (via the same
 * `selectRecentTail` the compactor uses, so the two agree on what "cannot be
 * evicted" means) and throws a typed `ContextBudgetError` when even that tail
 * plus the overhead plus the reserve cannot fit under `maxTokens` -- the one
 * case compaction can never rescue.
 *
 * Error diagnostics are NUMBERS ONLY: role name and token counts, never
 * message bodies or prompt text.
 *
 * `model` is read for its `contextWindow` off the passed-in object; no catalog
 * lookup happens, so a local or custom model validates. The effective ceiling
 * is `min(maxTokens, model.contextWindow)`, so a role paired at call time with
 * a model smaller than the one it was defined against is still caught.
 */
export function assertTurnFitsBudget(
  role: Role,
  request: RoleRequestContext,
  model: Model<Api>,
): void {
  const { maxTokens, reserveTokens, keepRecentTokens } = role.contextBudget;
  const ceiling = Math.min(maxTokens, model.contextWindow);
  const estimate = estimateFullRequestTokens({
    systemPrompt: request.systemPrompt,
    tools: grantedTools(role.activeToolNames, request.tools ?? []),
    messages: request.messages,
  });
  const { tail } = selectRecentTail(request.messages, keepRecentTokens);
  // The tail is dialogue-only, so it needs the request overhead appended ONLY
  // when no provider usage exists; a usage-based figure already contains both
  // the system prompt and the tools, and the caller re-checks the complete
  // full-request measure against the ceiling below.
  const tailTokens =
    tail.reduce((sum, message) => sum + estimateTokens(message), 0) + estimate.overheadTokens;
  if (tailTokens + reserveTokens > ceiling) {
    throw new ContextBudgetError({
      role: role.name,
      maxTokens,
      effectiveCeiling: ceiling,
      reserveTokens,
      keepRecentTokens,
      measuredTokens: estimate.tokens,
      overheadTokens: estimate.overheadTokens,
    });
  }
}

/** Refuse a disabled-compaction turn when the complete full request cannot fit. */
export function assertContextFitsBudget(
  role: Role,
  request: RoleRequestContext,
  model: Model<Api>,
): void {
  const { maxTokens, reserveTokens, keepRecentTokens } = role.contextBudget;
  const ceiling = Math.min(maxTokens, model.contextWindow);
  const estimate = estimateFullRequestTokens({
    systemPrompt: request.systemPrompt,
    tools: grantedTools(role.activeToolNames, request.tools ?? []),
    messages: request.messages,
  });
  if (estimate.tokens + reserveTokens > ceiling) {
    throw new ContextBudgetError({
      role: role.name,
      maxTokens,
      effectiveCeiling: ceiling,
      reserveTokens,
      keepRecentTokens,
      measuredTokens: estimate.tokens,
      overheadTokens: estimate.overheadTokens,
      reason:
        "the complete context (system prompt and tools included) plus reserve does not fit while compaction is disabled",
    });
  }
}
