import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "../runner/tool";
import type { Tool } from "../runner/tool";
import { OrchestrationError } from "./types";
import type { Complexity, Plan, SecuritySurface } from "./types";

/** The tool name the planner calls to submit its structured plan. */
export const SUBMIT_PLAN_TOOL_NAME = "submit_plan";

const COMPLEXITIES: readonly Complexity[] = ["trivial", "medium", "complex"];

const SECURITY_SURFACES: readonly SecuritySurface[] = ["none", "low", "elevated"];

/**
 * A per-planner-turn holder the `submit_plan` tool writes into and the pipeline
 * reads after the turn. At most one of `plan`/`error` is set once the tool has
 * fired; BOTH absent is legitimate and NOT an error -- unlike the verdict, an
 * absent plan is a SOFT undefined-complexity, so the pipeline proceeds rather
 * than raising a (deliberately non-existent) `missing_plan`. A FRESH holder per
 * run -- keyed by closure -- keeps a stale plan from being read as the current.
 */
export interface PlanCapture {
  plan?: Plan;
  error?: OrchestrationError;
}

/**
 * Strictly validate untrusted, model-produced input into a `Plan`.
 *
 * The plan arrives as `submit_plan` tool-call args: its shape is NOT trusted.
 * This is a pure, self-contained, hand-written validator (no `eval`, no schema
 * library): `value` must be an object; `complexity` one of the three allowed
 * literals; `securitySurface` one of the three allowed literals; `summary` a
 * string. Any deviation throws
 * `OrchestrationError('malformed_plan')` -- never a silent coercion, never a
 * default. `summary` is checked for type only and is NOT interpolated into any
 * shell/SQL/path/prompt sink in this unit (the coder still receives the
 * free-text plan, unchanged), so no new sink is introduced.
 *
 * `detail` is a path-safe token (the planner runId) carried onto the error's
 * `detail` field; it is NEVER content and never the plan body.
 */
export function parsePlan(value: unknown, detail: string): Plan {
  const bad = (message: string): never => {
    throw new OrchestrationError("malformed_plan", detail, message);
  };

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return bad("plan is not an object");
  }
  const record = value as Record<string, unknown>;

  const complexity = record.complexity;
  if (typeof complexity !== "string" || !COMPLEXITIES.includes(complexity as Complexity)) {
    return bad(`plan.complexity must be one of ${COMPLEXITIES.join(", ")}`);
  }

  const securitySurface = record.securitySurface;
  if (
    typeof securitySurface !== "string" ||
    !SECURITY_SURFACES.includes(securitySurface as SecuritySurface)
  ) {
    return bad(`plan.securitySurface must be one of ${SECURITY_SURFACES.join(", ")}`);
  }

  if (typeof record.summary !== "string") {
    return bad("plan.summary must be a string");
  }

  return {
    complexity: complexity as Complexity,
    securitySurface: securitySurface as SecuritySurface,
    summary: record.summary,
  };
}

/**
 * Build the `submit_plan` tool for one planner turn, writing into `capture`.
 *
 * TWO non-obvious pi-agent-core facts shape this (identical to `submit_verdict`).
 * (1) The harness validates tool-call args against `parameters` BEFORE `execute`
 * runs, so the schema is deliberately PERMISSIVE at the enum leaf (`complexity`
 * as `Type.String`, not a union of literals): a malformed value must reach
 * `parsePlan` and surface as `malformed_plan`, rather than being bounced
 * pre-execute (which would collapse the defense-in-depth to a single gate).
 * (2) The harness CATCHES any throw from `execute` and turns it into an error
 * tool-result; it does NOT propagate out of `runRole`. So `execute` must CATCH
 * `parsePlan`'s `OrchestrationError` and store it in the holder for the pipeline
 * to re-throw after the turn, rather than throwing.
 *
 * `detail` is the planner runId, threaded onto any `OrchestrationError.detail`.
 */
export function buildSubmitPlanTool(capture: PlanCapture, detail: string): Tool {
  return defineTool({
    name: SUBMIT_PLAN_TOOL_NAME,
    description: "Record the plan's complexity and summary.",
    label: "submit plan",
    parameters: Type.Object({
      complexity: Type.String(),
      securitySurface: Type.String(),
      summary: Type.String(),
    }),
    async execute(_toolCallId, params) {
      try {
        // Last-wins: a planner that calls the tool twice overwrites the prior
        // capture, so the pipeline reads the final submission. `delete` (not
        // `= undefined`) clears the sibling under exactOptionalPropertyTypes,
        // where the field is not typed `| undefined`.
        capture.plan = parsePlan(params, detail);
        delete capture.error;
        return { content: [{ type: "text", text: "plan recorded" }], details: undefined };
      } catch (error) {
        if (error instanceof OrchestrationError) {
          capture.error = error;
          delete capture.plan;
          return { content: [{ type: "text", text: error.code }], details: undefined };
        }
        throw error;
      }
    },
  });
}

/**
 * The fixed instruction appended to the planner's prompt, telling it to CALL the
 * `submit_plan` tool with the required shape. Exported so the pipeline and the
 * tests agree on it verbatim. No filesystem path is involved: the plan signal
 * travels as tool-call args. Calling the tool is OPTIONAL -- a planner that only
 * emits free text leaves the complexity signal undefined and the run proceeds.
 */
export function formatPlannerInstruction(): string {
  return [
    `When your plan is ready, record it by calling the ${SUBMIT_PLAN_TOOL_NAME} tool.`,
    "Call it with this shape:",
    '{ "complexity": "trivial" | "medium" | "complex", "securitySurface": "none" | "low" | "elevated", "summary": "<short summary>" }',
    'Choose "trivial" for a one-liner, "medium" for a routine multi-file change, "complex" for a cross-cutting or high-risk one.',
    'Choose "none" when the task touches no attack surface, "low" for incidental exposure, "elevated" when it touches auth, secrets, user input, crypto, or an external boundary.',
  ].join("\n");
}
