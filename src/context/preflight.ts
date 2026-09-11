import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateContextTokens, estimateTokens } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { Role } from "../role";
import { ContextBudgetError } from "./budget";
import { selectRecentTail } from "./compactor";

/**
 * Pre-flight refusal, NOT a hook. It measures the turn and the irreducible
 * recent tail (via the same `selectRecentTail` the compactor uses, so the two
 * agree on what "cannot be evicted" means) and throws a typed
 * `ContextBudgetError` when even that tail plus the reserve cannot fit under
 * `maxTokens` -- the one case compaction can never rescue.
 *
 * `model` is read for its `contextWindow` off the passed-in object; no catalog
 * lookup happens, so a local or custom model validates. The effective ceiling
 * is `min(maxTokens, model.contextWindow)`, so a role paired at call time with
 * a model smaller than the one it was defined against is still caught.
 */
export function assertTurnFitsBudget(
  role: Role,
  messages: AgentMessage[],
  model: Model<Api>,
): void {
  const { maxTokens, reserveTokens, keepRecentTokens } = role.contextBudget;
  const ceiling = Math.min(maxTokens, model.contextWindow);
  const measured = estimateContextTokens(messages).tokens;
  const { tail } = selectRecentTail(messages, keepRecentTokens);
  const tailTokens = tail.reduce((sum, message) => sum + estimateTokens(message), 0);
  if (tailTokens + reserveTokens > ceiling) {
    throw new ContextBudgetError({
      role: role.name,
      maxTokens,
      reserveTokens,
      keepRecentTokens,
      measuredTokens: measured,
    });
  }
}

/** Refuse a disabled-compaction turn when the complete context cannot fit. */
export function assertContextFitsBudget(
  role: Role,
  messages: AgentMessage[],
  model: Model<Api>,
): void {
  const { maxTokens, reserveTokens, keepRecentTokens } = role.contextBudget;
  const ceiling = Math.min(maxTokens, model.contextWindow);
  const measured = estimateContextTokens(messages).tokens;
  if (measured + reserveTokens > ceiling) {
    throw new ContextBudgetError({
      role: role.name,
      maxTokens,
      reserveTokens,
      keepRecentTokens,
      measuredTokens: measured,
      reason: "the complete context plus reserve does not fit while compaction is disabled",
    });
  }
}
