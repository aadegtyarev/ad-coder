import type { Api, Model } from "@earendil-works/pi-ai";

/**
 * The role-owned context ceiling, in provider tokens. `maxTokens` is the whole
 * budget for a turn; `reserveTokens` is held back for the model's own reply;
 * `keepRecentTokens` is the recent tail the compactor never evicts.
 */
export interface ContextBudget {
  maxTokens: number;
  reserveTokens: number;
  keepRecentTokens: number;
}

export interface ContextBudgetPercents {
  maxTokensPercent?: number;
  reserveTokensPercent?: number;
  keepRecentTokensPercent?: number;
}

export const DEFAULT_CONTEXT_BUDGET_PERCENTS = {
  maxTokensPercent: 0.9,
  reserveTokensPercent: 0.1,
  keepRecentTokensPercent: 0.25,
} as const;

/** Validate and derive a portable budget from one effective model window. */
export function deriveContextBudget(
  contextWindow: number,
  percents?: ContextBudgetPercents,
): ContextBudget {
  const resolved = { ...DEFAULT_CONTEXT_BUDGET_PERCENTS, ...(percents ?? {}) };
  for (const [name, value] of Object.entries(resolved)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value >= 1) {
      throw new Error(`${name} must be a finite number between 0 and 1`);
    }
  }
  const budget = {
    maxTokens: Math.floor(contextWindow * resolved.maxTokensPercent),
    reserveTokens: Math.floor(contextWindow * resolved.reserveTokensPercent),
    keepRecentTokens: Math.floor(contextWindow * resolved.keepRecentTokensPercent),
  };
  if (budget.reserveTokens + budget.keepRecentTokens >= budget.maxTokens) {
    throw new Error(
      "reserveTokensPercent + keepRecentTokensPercent must be below maxTokensPercent",
    );
  }
  return budget;
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

/**
 * Validate a budget at the role boundary against the caller-supplied model's
 * real window. Throws `defineRole(<roleName>): ...` so a malformed or
 * over-window budget cannot reach the harness. Numbers only in the message.
 */
export function validateContextBudget(
  roleName: string,
  budget: ContextBudget,
  model: Model<Api>,
): void {
  if (!isPositiveInteger(budget.maxTokens)) {
    throw new Error(`defineRole(${roleName}): maxTokens must be a positive integer`);
  }
  if (!isPositiveInteger(budget.reserveTokens)) {
    throw new Error(`defineRole(${roleName}): reserveTokens must be a positive integer`);
  }
  if (!isPositiveInteger(budget.keepRecentTokens)) {
    throw new Error(`defineRole(${roleName}): keepRecentTokens must be a positive integer`);
  }
  if (budget.maxTokens > model.contextWindow) {
    throw new Error(
      `defineRole(${roleName}): maxTokens ${budget.maxTokens} exceeds the model context window ${model.contextWindow}`,
    );
  }
  if (budget.reserveTokens + budget.keepRecentTokens >= budget.maxTokens) {
    throw new Error(
      `defineRole(${roleName}): reserveTokens ${budget.reserveTokens} + keepRecentTokens ${budget.keepRecentTokens} must be below maxTokens ${budget.maxTokens}`,
    );
  }
}

/**
 * Raised by the pre-flight when even the irreducible recent tail plus the
 * reserve cannot fit under the effective ceiling. Carries the role name and
 * token numbers ONLY -- never message bodies, content, or prompt text.
 */
export class ContextBudgetError extends Error {
  /** Widened to `string` so a subclass can name the condition it refines. */
  override readonly name: string = "ContextBudgetError";
  readonly role: string;
  readonly maxTokens: number;
  readonly effectiveCeiling: number;
  readonly reserveTokens: number;
  readonly keepRecentTokens: number;
  readonly measuredTokens: number;

  constructor(fields: {
    role: string;
    maxTokens: number;
    effectiveCeiling?: number;
    reserveTokens: number;
    keepRecentTokens: number;
    measuredTokens: number;
    reason?: string;
    /**
     * Replaces the default tail. A condition whose only way out is NOT a retry
     * (a session whose compaction is spent, for instance) must be able to say
     * so: a message that ends "then retry" is a lie the reader acts on.
     */
    advice?: string;
  }) {
    const effectiveCeiling = fields.effectiveCeiling ?? fields.maxTokens;
    super(
      `context budget (${fields.role}): measured ${fields.measuredTokens} tokens against effective ceiling ${effectiveCeiling} (maxTokens ${fields.maxTokens}, reserveTokens ${fields.reserveTokens}, keepRecentTokens ${fields.keepRecentTokens}); ${fields.reason ?? "the irreducible recent tail plus reserve does not fit"}. ${fields.advice ?? "Choose a model with a larger context window or reduce the context-budget settings, then retry."}`,
    );
    this.role = fields.role;
    this.maxTokens = fields.maxTokens;
    this.effectiveCeiling = effectiveCeiling;
    this.reserveTokens = fields.reserveTokens;
    this.keepRecentTokens = fields.keepRecentTokens;
    this.measuredTokens = fields.measuredTokens;
  }
}
