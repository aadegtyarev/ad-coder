import { Type } from "@earendil-works/pi-ai";
import type { Tool } from "../runner/tool";
import { defineTool } from "../runner/tool";
import type {
  Complexity,
  ContractCoverageStatus,
  Plan,
  SecuritySurface,
  SurfaceAnalysis,
  SurfaceAnalysisLimits,
} from "./types";
import { OrchestrationError } from "./types";

/** The tool name the planner calls to submit its structured plan. */
export const SUBMIT_PLAN_TOOL_NAME = "submit_plan";

const COMPLEXITIES: readonly Complexity[] = ["trivial", "medium", "complex"];

const SECURITY_SURFACES: readonly SecuritySurface[] = ["none", "low", "elevated"];
const COVERAGE_STATUSES: readonly ContractCoverageStatus[] = [
  "covered",
  "not_applicable",
  "research_required",
];

export const DEFAULT_SURFACE_ANALYSIS_LIMITS: Readonly<SurfaceAnalysisLimits> = Object.freeze({
  maxItems: 0,
  maxTextBytes: 0,
  maxAggregateBytes: 0,
  maxDepth: 0,
});

function validateLimits(limits: SurfaceAnalysisLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new OrchestrationError(
        "malformed_plan",
        name,
        "surface limits must be non-negative integers",
      );
  }
}

function depthOf(value: unknown, depth = 0): number {
  if (value === null || typeof value !== "object") return depth;
  const children = Array.isArray(value) ? value : Object.values(value);
  return children.reduce((max, child) => Math.max(max, depthOf(child, depth + 1)), depth);
}

/** Stable IDs for the Markdown contracts the reviewer enforces. */
export const CONTRACT_INDEX = Object.freeze({
  "architecture:headless-first": "docs/contracts/architecture.md",
  "architecture:optional-workflow-modules": "docs/contracts/architecture.md",
  "architecture:programmatic-reachability": "docs/contracts/architecture.md",
  "architecture:independent-role-delegation": "docs/contracts/architecture.md",
  "cli:thin-front": "docs/contracts/cli.md",
  "cli:derived-help": "docs/contracts/cli.md",
  "cli:single-registry": "docs/contracts/cli.md",
  "config:configurable": "docs/contracts/config.md",
  "config:efficient-defaults": "docs/contracts/config.md",
  "config:resource-limits": "docs/contracts/config.md",
  "documentation:human-first": "docs/contracts/documentation.md",
  "documentation:architecture-map": "docs/contracts/documentation.md",
  "documentation:cold-reader-review": "docs/contracts/documentation.md",
  "documentation:periodic-audit": "docs/contracts/documentation.md",
  "operation-modes:manual-authority": "docs/contracts/operation-modes.md",
  "operation-modes:auto-provenance": "docs/contracts/operation-modes.md",
  "quality:clean-check": "docs/contracts/quality.md",
  "quality:biome": "docs/contracts/quality.md",
  "quality:project-health-audit": "docs/contracts/quality.md",
  "quality:test-pinned-decomposition": "docs/contracts/quality.md",
  "decomposition:diagnose": "docs/contracts/decomposition.md",
  "decomposition:boundary": "docs/contracts/decomposition.md",
  "decomposition:behavior-preserving": "docs/contracts/decomposition.md",
  "product-change:user-outcome": "docs/contracts/product-change.md",
  "product-change:surface-map": "docs/contracts/product-change.md",
  "product-change:close-loop": "docs/contracts/product-change.md",
  "errors:typed-actionable": "docs/contracts/errors.md",
  "errors:safe-projection": "docs/contracts/errors.md",
  "compatibility:public-surfaces": "docs/contracts/compatibility.md",
  "compatibility:semver-release": "docs/contracts/compatibility.md",
  "security:trusted-project-prompts": "docs/contracts/security.md",
  "tool-observability:headless-stream": "docs/contracts/tool-observability.md",
  "tool-observability:safe-projection": "docs/contracts/tool-observability.md",
  "tool-observability:truthful-lifecycle": "docs/contracts/tool-observability.md",
} as const);

function nonEmptyBounded(value: unknown, maxTextBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    (maxTextBytes === 0 || Buffer.byteLength(value) <= maxTextBytes)
  );
}

function parseSurfaceAnalysis(
  value: unknown,
  bad: (message: string) => never,
  limits: SurfaceAnalysisLimits,
): SurfaceAnalysis {
  const { maxItems, maxTextBytes, maxAggregateBytes, maxDepth } = limits;
  if (maxAggregateBytes > 0 && Buffer.byteLength(JSON.stringify(value)) > maxAggregateBytes)
    return bad("surfaceAnalysis exceeds aggregate byte limit");
  if (maxDepth > 0 && depthOf(value) > maxDepth)
    return bad("surfaceAnalysis exceeds nesting limit");
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return bad("plan.surfaceAnalysis must be an object");
  }
  const record = value as Record<string, unknown>;
  if (!nonEmptyBounded(record.projectType, maxTextBytes))
    return bad("surfaceAnalysis.projectType is required");
  if (
    !Array.isArray(record.surfaces) ||
    record.surfaces.length === 0 ||
    (maxItems > 0 && record.surfaces.length > maxItems)
  ) {
    return bad("surfaceAnalysis.surfaces exceeds the configured item limit");
  }
  const surfaces = record.surfaces.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item))
      return bad("surface is not an object");
    const entry = item as Record<string, unknown>;
    if (
      !nonEmptyBounded(entry.id, maxTextBytes) ||
      !nonEmptyBounded(entry.name, maxTextBytes) ||
      !nonEmptyBounded(entry.rationale, maxTextBytes)
    ) {
      return bad("surface id, name, and rationale are required");
    }
    return { id: entry.id, name: entry.name, rationale: entry.rationale };
  });
  if (new Set(surfaces.map(({ id }) => id)).size !== surfaces.length)
    return bad("surface ids must be unique");
  if (
    !Array.isArray(record.coverage) ||
    record.coverage.length !== surfaces.length ||
    (maxItems > 0 && record.coverage.length > maxItems)
  ) {
    return bad("coverage must contain exactly one entry per surface");
  }
  const coverage = record.coverage.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item))
      return bad("coverage is not an object");
    const entry = item as Record<string, unknown>;
    if (
      !nonEmptyBounded(entry.surfaceId, maxTextBytes) ||
      typeof entry.status !== "string" ||
      !COVERAGE_STATUSES.includes(entry.status as ContractCoverageStatus) ||
      !nonEmptyBounded(entry.rationale, maxTextBytes)
    )
      return bad("coverage fields are invalid");
    for (const key of ["contractIds", "evidence"] as const) {
      if (
        !Array.isArray(entry[key]) ||
        (maxItems > 0 && entry[key].length > maxItems) ||
        entry[key].some((v) => !nonEmptyBounded(v, maxTextBytes))
      )
        return bad(`coverage.${key} must be bounded non-empty strings`);
    }
    const status = entry.status as ContractCoverageStatus;
    const contractIds = entry.contractIds as string[];
    const evidence = entry.evidence as string[];
    if (status === "covered" && (contractIds.length === 0 || evidence.length === 0))
      return bad("covered surfaces require contractIds and evidence");
    if (contractIds.some((id) => !(id in CONTRACT_INDEX)))
      return bad("coverage contains an unknown contract id");
    if (status === "not_applicable" && (contractIds.length !== 0 || evidence.length === 0))
      return bad("not_applicable surfaces require rationale evidence and no contracts");
    if (status === "research_required" && evidence.length === 0)
      return bad("research_required surfaces require evidence of the gap");
    return {
      surfaceId: entry.surfaceId,
      status,
      contractIds,
      evidence,
      rationale: entry.rationale,
    };
  });
  const ids = new Set(surfaces.map(({ id }) => id));
  if (
    new Set(coverage.map(({ surfaceId }) => surfaceId)).size !== coverage.length ||
    coverage.some(({ surfaceId }) => !ids.has(surfaceId))
  )
    return bad("coverage surfaceIds must uniquely match surfaces");
  return { projectType: record.projectType, surfaces, coverage };
}

/**
 * A per-planner-turn holder the `submit_plan` tool writes into and the pipeline
 * reads after the turn. At most one of `plan`/`error` is set once the tool has
 * fired. Both absent means the planner failed to submit the mandatory artifact;
 * the session turns that into `missing_plan`. A fresh holder per run, keyed by
 * closure, prevents a stale plan from being read as the current plan.
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
 * string; and optional `contractRequirements` an array of non-empty strings.
 * Any deviation throws
 * `OrchestrationError('malformed_plan')` -- never a silent coercion, never a
 * default. `summary` is checked for type only and is NOT interpolated into any
 * shell/SQL/path/prompt sink in this unit (the coder still receives the
 * free-text plan, unchanged), so no new sink is introduced.
 *
 * `detail` is a path-safe token (the planner runId) carried onto the error's
 * `detail` field; it is NEVER content and never the plan body.
 */
export function parsePlan(
  value: unknown,
  detail: string,
  limits: SurfaceAnalysisLimits = DEFAULT_SURFACE_ANALYSIS_LIMITS,
): Plan {
  validateLimits(limits);
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

  const contractRequirements =
    record.contractRequirements === undefined ? [] : record.contractRequirements;
  if (
    !Array.isArray(contractRequirements) ||
    contractRequirements.some(
      (requirement) => typeof requirement !== "string" || requirement.trim() === "",
    )
  ) {
    return bad("plan.contractRequirements must be an array of non-empty strings");
  }
  const surfaceAnalysis = parseSurfaceAnalysis(record.surfaceAnalysis, bad, limits);

  return {
    complexity: complexity as Complexity,
    securitySurface: securitySurface as SecuritySurface,
    summary: record.summary,
    contractRequirements: contractRequirements as string[],
    surfaceAnalysis,
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
export function buildSubmitPlanTool(
  capture: PlanCapture,
  detail: string,
  limits: SurfaceAnalysisLimits = DEFAULT_SURFACE_ANALYSIS_LIMITS,
): Tool {
  validateLimits(limits);
  return defineTool({
    name: SUBMIT_PLAN_TOOL_NAME,
    description: "Record the plan's complexity, security surface, contract rules, and summary.",
    label: "submit plan",
    parameters: Type.Object({
      complexity: Type.String(),
      securitySurface: Type.String(),
      summary: Type.String(),
      contractRequirements: Type.Optional(Type.Array(Type.String())),
      surfaceAnalysis: Type.Any(),
    }),
    async execute(_toolCallId, params) {
      try {
        // Last-wins: a planner that calls the tool twice overwrites the prior
        // capture, so the pipeline reads the final submission. `delete` (not
        // `= undefined`) clears the sibling under exactOptionalPropertyTypes,
        // where the field is not typed `| undefined`.
        capture.plan = parsePlan(params, detail, limits);
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
 * travels as tool-call args. Calling the tool is mandatory whenever a planner is
 * configured; free text alone cannot authorize a coder turn.
 */
export function formatPlannerInstruction(): string {
  return [
    `When your plan is ready, record it by calling the ${SUBMIT_PLAN_TOOL_NAME} tool.`,
    "Call it with this shape:",
    '{ "complexity": "trivial" | "medium" | "complex", "securitySurface": "none" | "low" | "elevated", "summary": "<short summary>", "contractRequirements": ["<rule>"], "surfaceAnalysis": { "projectType": "<type>", "surfaces": [{"id":"<stable-id>","name":"<surface>","rationale":"<why affected>"}], "coverage": [{"surfaceId":"<stable-id>","status":"covered|not_applicable|research_required","contractIds":["<canonical id>"],"evidence":["<source or gap evidence>"],"rationale":"<decision>"}] } }',
    "This structured submission is mandatory. Identify every affected product surface before coding.",
    'For status "covered", contractIds and evidence must both be non-empty. Use only canonical contract IDs.',
    'For status "not_applicable", contractIds must be empty and evidence must explain why no contract applies.',
    'For status "research_required", evidence must name the missing contract knowledge; do not claim "covered" with empty arrays.',
    'Choose "trivial" for a one-liner, "medium" for a routine multi-file change, "complex" for a cross-cutting or high-risk one.',
    'Choose "none" when the task touches no attack surface, "low" for incidental exposure, "elevated" when it touches auth, secrets, user input, crypto, or an external boundary.',
  ].join("\n");
}
