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
 * reserve cannot fit under `maxTokens`. Carries the role name and token
 * numbers ONLY -- never message bodies, content, or prompt text.
 */
export class ContextBudgetError extends Error {
  override readonly name = "ContextBudgetError";
  readonly role: string;
  readonly maxTokens: number;
  readonly reserveTokens: number;
  readonly keepRecentTokens: number;
  readonly measuredTokens: number;

  constructor(fields: {
    role: string;
    maxTokens: number;
    reserveTokens: number;
    keepRecentTokens: number;
    measuredTokens: number;
  }) {
    super(
      `assertTurnFitsBudget(${fields.role}): measured ${fields.measuredTokens} tokens against maxTokens ${fields.maxTokens} (reserveTokens ${fields.reserveTokens}, keepRecentTokens ${fields.keepRecentTokens}); the irreducible recent tail plus reserve does not fit`,
    );
    this.role = fields.role;
    this.maxTokens = fields.maxTokens;
    this.reserveTokens = fields.reserveTokens;
    this.keepRecentTokens = fields.keepRecentTokens;
    this.measuredTokens = fields.measuredTokens;
  }
}
