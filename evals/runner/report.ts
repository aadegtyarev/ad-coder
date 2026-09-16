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

/** The balanced bracket span starting at `start`, or null if it never closes. */
function balancedSpan(text: string, start: number): string | null {
  const open = text[start] as "[" | "{";
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
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
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

/**
 * The JSON an artifact-scored role was asked to emit.
 *
 * `ad-coder role` appends a `cost:` line to the assistant text and models wrap
 * JSON in fences, so the payload is located by bracket balance rather than by
 * trusting the surrounding prose to be absent.
 *
 * WHY THE LAST PARSEABLE SPAN. Taking the FIRST bracket assumed no prose before
 * the answer contains one, and prose about code routinely does: a planner
 * explained an id format as `[a-z0-9-]` above its plan, the extractor returned
 * that character class as the whole answer, and a run that passed every check
 * was recorded as `unreadable_answer` at quality 0.12 -- a model failure the
 * harness invented. Requiring the span to PARSE fixes that case and not the
 * next one, because prose can contain valid JSON too ("we considered {"a":1}
 * first"). The answer is what the role finished with, so the last top-level
 * span that parses is the answer -- which is also the convention every scorer
 * already uses when it reads from the final `]`.
 *
 * Spans nested inside an accepted one are skipped rather than considered, so an
 * array's own last element cannot be mistaken for the answer.
 */
export function extractJsonArtifact(stdout: string): string {
  let sawBracket = false;
  let unterminated = false;
  let answer: string | undefined;
  for (let index = 0; index < stdout.length; index += 1) {
    const char = stdout[index];
    if (char !== "[" && char !== "{") continue;
    sawBracket = true;
    const span = balancedSpan(stdout, index);
    if (span === null) {
      unterminated = true;
      // An unclosed bracket means every bracket after it inside the same run of
      // text is also unclosed, and each would rescan to the end: `"[ x"` repeated
      // took 38 seconds at 288KB. Nothing readable can follow on this line, so
      // the scan resumes at the next one -- which keeps a real answer on a later
      // line reachable while making the cost linear in practice.
      const nextLine = stdout.indexOf("\n", index);
      if (nextLine < 0) break;
      index = nextLine;
      continue;
    }
    try {
      JSON.parse(span);
    } catch {
      // A balanced span that is not JSON -- an object literal quoted in the
      // explanation, a character class. Not a candidate, and its interior may
      // still hold one, so the scan does not skip it.
      continue;
    }
    // An unclosed bracket EARLIER in the output encloses this one, so what
    // parsed is a fragment of a truncated answer -- the first element of a
    // cut-off array, say. Reporting it would score a fraction of an answer as
    // the whole of one, which reads as a model that answered briefly rather
    // than as an answer that did not fit.
    if (unterminated) break;
    answer = span;
    // Skip its interior: a nested span is part of this answer, never a rival to
    // it. `index` is advanced to the span's last character, and the loop's own
    // increment moves past it.
    index += span.length - 1;
  }
  if (answer !== undefined) return answer;
  if (!sawBracket) throw new Error("role produced no JSON artifact");
  // Truncation is reported distinctly from unreadability because it is a
  // context-budget fact rather than a formatting one, and they call for
  // different responses.
  throw new Error(
    unterminated
      ? "role produced an unterminated JSON artifact"
      : "role produced no readable JSON artifact",
  );
}
