import type { LedgerRecord } from "../../src/ledger/types";

/** The console `--json` turn projection, narrowed to the fields evidence comes from. */
export interface ConsoleTurn {
  runId?: string;
  step?: string;
  status?: string;
  assistantText?: string;
  toolCalls?: { toolName?: string }[];
}

/**
 * What the runner OBSERVED about an orchestrator run.
 *
 * Nothing here is asserted by the model or typed by an operator: tools come
 * from the console turn stream, `approved` and the planner's tier from the
 * workflow checkpoint, and `plannerDelegated` from a ledger row. The previous
 * bench took the two complexity tiers as argv, so "did it classify correctly"
 * and "did the planner agree" were the same number entered twice.
 */
export interface OrchestratorReport {
  taskId: string;
  /** Derived from the tools actually called, never from the task's declared mode. */
  mode: "role" | "manual-workflow" | "automatic-pipeline";
  /** The tier the model stated before it was able to delegate anything. */
  predictedComplexity: string | null;
  /** False when a delegating tool ran in the same turn that carried the claim. */
  predictedBeforeDelegation: boolean;
  /** The planner's own tier: the workflow checkpoint's, else the tier relayed back. */
  plannerComplexity: string | null;
  /** A ledger row stepped `role:planner` -- proof a planner turn really executed. */
  plannerDelegated: boolean;
  approved: boolean;
  /** Tool NAMES in call order. The console projection deliberately carries no arguments. */
  tools: string[];
  /** Ledger role column, deduplicated. */
  roles: string[];
  /**
   * The last turn's assistant text.
   *
   * For a task whose answer IS the text -- a decomposition, a classification --
   * rather than the state a tool left behind. Delegation and ordering are
   * observable from the ledger and the tool list; a structure the orchestrator
   * writes out is not, so without this a report could say the Planner was
   * consulted and never what came of it.
   */
  finalText: string;
}

const TIERS = ["trivial", "medium", "complex"] as const;

/**
 * Tools that could have produced the answer the orchestrator is about to give.
 *
 * The classification check is about the model's OWN judgement, so a tier stated
 * in a turn that already delegated is transcription, not classification.
 */
const DELEGATION_TOOLS = new Set([
  "run_role",
  "run_step",
  "run_pipeline",
  "start_pipeline",
  "resume_pipeline",
  "decompose_task",
]);

/** `COMPLEXITY: complex` on a line of its own; nothing looser, so prose cannot vote twice. */
export function statedTier(text: string, label: string): string | null {
  const match = new RegExp(`^${label}:\\s*(\\w+)\\s*$`, "im").exec(text);
  const value = match?.[1]?.toLowerCase();
  return value !== undefined && (TIERS as readonly string[]).includes(value) ? value : null;
}

export function buildOrchestratorReport(input: {
  taskId: string;
  turns: readonly ConsoleTurn[];
  ledger: readonly LedgerRecord[];
  workflowState?: { complexity?: string; approved?: boolean };
}): OrchestratorReport {
  const tools = input.turns.flatMap((turn) =>
    (turn.toolCalls ?? []).map((call) => call.toolName ?? "").filter(Boolean),
  );
  const firstTurn = input.turns[0];
  const firstTurnTools = (firstTurn?.toolCalls ?? []).map((call) => call.toolName ?? "");
  const predictedComplexity = statedTier(firstTurn?.assistantText ?? "", "COMPLEXITY");
  const relayed = statedTier(
    input.turns.map((turn) => turn.assistantText ?? "").join("\n"),
    "PLANNER_COMPLEXITY",
  );
  return {
    taskId: input.taskId,
    mode:
      tools.includes("run_pipeline") || tools.includes("start_pipeline")
        ? "automatic-pipeline"
        : tools.includes("run_step") && tools.includes("choose_transition")
          ? "manual-workflow"
          : "role",
    predictedComplexity,
    predictedBeforeDelegation:
      predictedComplexity !== null && !firstTurnTools.some((name) => DELEGATION_TOOLS.has(name)),
    // The checkpoint's tier is the planner's OWN structured output; the relayed
    // line is only a fallback for a delegation that never entered the workflow.
    plannerComplexity: input.workflowState?.complexity ?? relayed,
    plannerDelegated: input.ledger.some((row) => row.step === "role:planner"),
    approved: input.workflowState?.approved === true,
    tools,
    roles: [...new Set(input.ledger.map((row) => row.role))],
    // The last turn's own words, for a task whose answer IS the text rather than
    // the state a tool left behind. Delegation and ordering are observable from
    // the ledger and the tool list; a decomposition is not -- it is a structure
    // the orchestrator writes out, and without this the report could say the
    // Planner was consulted but never what came of it.
    finalText: input.turns.at(-1)?.assistantText ?? "",
  };
}

/**
 * The JSON an artifact-scored role was asked to emit.
 *
 * `ad-coder role` appends a `cost:` line to the assistant text and models wrap
 * JSON in fences, so the payload is located by BRACKET BALANCE from the first
 * bracket rather than by trusting the surrounding prose to be absent.
 */
export function extractJsonArtifact(stdout: string): string {
  const start = stdout.search(/[[{]/);
  if (start < 0) throw new Error("role produced no JSON artifact");
  const open = stdout[start] as "[" | "{";
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < stdout.length; index += 1) {
    const char = stdout[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return stdout.slice(start, index + 1);
    }
  }
  throw new Error("role produced an unterminated JSON artifact");
}
