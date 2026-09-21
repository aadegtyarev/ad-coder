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

/**
 * The one definition of the three tiers, quoted verbatim everywhere a tier gets
 * decided: the pipeline's plan stage, a planner reached through `run_role`, and
 * the orchestrator classifying in its own turn.
 *
 * It tiers by what a change REQUIRES, not by how many lines it spans. The
 * size-based wording that stood here ("trivial for a one-liner, complex for a
 * cross-cutting or high-risk one") rated "make Pool.reserve linearizable under
 * concurrent calls" as trivial across two model families -- one file, a few
 * lines, and the single hardest class of defect in the corpus: the same sweep
 * measured a seeded race at 0.07 on one model and 1.00 on another. Concurrency
 * is where the choice of model decides the outcome, so a rubric that prices it
 * by diff size routes exactly the wrong work to the cheapest cell.
 *
 * It lived in the planner instruction alone, which reaches a model only from
 * the pipeline's plan stage -- so the other two paths decided tiers with no
 * definition at all, and the corpus was scoring them against a rule they were
 * never given. One definition beats three paraphrases that drift.
 */
export const COMPLEXITY_RUBRIC =
  'Choose "trivial" when the change is confined to one function with no call sites and the fix is uniquely determined; "medium" when it crosses call sites, preserves two public behaviours at once, or carries a rule into another artifact; "complex" when it turns on an ordering or concurrency invariant, reconciles sources of truth that disagree, or fixes an error observable only far from its cause. Size is evidence, not the criterion: a one-line change to a race is complex.';

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
  "ui-responsiveness:input-control": "docs/contracts/ui-responsiveness.md",
  "ui-responsiveness:isolated-interrupt": "docs/contracts/ui-responsiveness.md",
  "ui-responsiveness:bounded-watch": "docs/contracts/ui-responsiveness.md",
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
  const surfaces = record.surfaces.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item))
      return bad(`surfaces[${index}] is not an object`);
    const entry = item as Record<string, unknown>;
    // Three separate sentences, one per field, rather than a loop over the three
    // key names: `nonEmptyBounded` is a type predicate, and only a check on the
    // literal path narrows `entry.id` to a string. A loop compiles to `unknown`
    // and `tsc` refuses the assignment below -- which is how CI caught it.
    if (!nonEmptyBounded(entry.id, maxTextBytes))
      return bad(`surfaces[${index}].id must be a non-empty string`);
    if (!nonEmptyBounded(entry.name, maxTextBytes))
      return bad(`surfaces[${index}].name must be a non-empty string`);
    if (!nonEmptyBounded(entry.rationale, maxTextBytes))
      return bad(`surfaces[${index}].rationale must be a non-empty string`);
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
  const coverage = record.coverage.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item))
      return bad(`coverage[${index}] is not an object`);
    const entry = item as Record<string, unknown>;
    // Three separate causes, three separate sentences, each naming the entry it
    // refused. They used to share `coverage fields are invalid`, which told a
    // planner holding a fifteen-line submission nothing: observed live, a
    // planner omitted `status` on all eight of its entries, was refused with
    // that one sentence twice, and only parsed on the third attempt when it
    // happened to guess the field (2026-09-18, run 8998ec7c).
    if (!nonEmptyBounded(entry.surfaceId, maxTextBytes))
      return bad(`coverage[${index}].surfaceId must be a non-empty string`);
    if (
      typeof entry.status !== "string" ||
      !COVERAGE_STATUSES.includes(entry.status as ContractCoverageStatus)
    )
      return bad(`coverage[${index}].status must be one of ${COVERAGE_STATUSES.join(", ")}`);
    if (!nonEmptyBounded(entry.rationale, maxTextBytes))
      return bad(`coverage[${index}].rationale must be a non-empty string`);
    for (const key of ["contractIds", "evidence"] as const) {
      if (
        !Array.isArray(entry[key]) ||
        (maxItems > 0 && entry[key].length > maxItems) ||
        entry[key].some((v) => !nonEmptyBounded(v, maxTextBytes))
      )
        return bad(`coverage[${index}].${key} must be bounded non-empty strings`);
    }
    const status = entry.status as ContractCoverageStatus;
    const contractIds = entry.contractIds as string[];
    const evidence = entry.evidence as string[];
    if (status === "covered" && (contractIds.length === 0 || evidence.length === 0))
      return bad(`coverage[${index}] is "covered" and requires contractIds and evidence`);
    if (status === "research_required" && contractIds.length === 0)
      return bad(
        `coverage[${index}].contractIds must be non-empty when status is "research_required"; resubmit with canonical contract IDs`,
      );
    const unknown = contractIds.filter((id) => !(id in CONTRACT_INDEX));
    // The refused VALUES are deliberately not echoed: this sentence reaches a
    // durable failure surface. `OrchestrationError.message` is re-wrapped by
    // `WorkflowStageFailureError` (src/orchestration/session.ts), which
    // docs/contracts/errors.md excludes from the safe-projection allow-list
    // precisely because it carries an uncontrolled message -- and a contract id
    // is an argument a model chose, which is exactly where a credential-shaped
    // string would arrive from. "one unknown id, here are all the known ones"
    // is as actionable as naming it: the model holds its own submission and can
    // diff it against the constant list. Caught by independent review, which
    // refused the first version of this sentence.
    if (unknown.length > 0)
      return bad(
        `coverage[${index}].contractIds contains ${unknown.length} unknown id(s); ` +
          `known ids are ${Object.keys(CONTRACT_INDEX).join(", ")}`,
      );
    if (status === "not_applicable" && (contractIds.length !== 0 || evidence.length === 0))
      return bad(`coverage[${index}] is "not_applicable" and requires evidence and no contracts`);
    if (status === "research_required" && evidence.length === 0)
      return bad(`coverage[${index}] is "research_required" and requires evidence of the gap`);
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
  called?: boolean;
}

/**
 * Strictly validate untrusted, model-produced input into a `Plan`.
 *
 * The plan arrives as `submit_plan` tool-call args: its shape is NOT trusted.
 * This is a pure, self-contained, hand-written validator (no `eval`, no schema
 * library): `value` must be an object; `complexity` one of the three allowed
 * literals; `securitySurface` one of the three allowed literals; `summary` a
 * string; and optional `contractRequirements` and `affectedFiles`, each an
 * array of non-empty strings.
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
  const affectedFiles = record.affectedFiles === undefined ? [] : record.affectedFiles;
  if (
    !Array.isArray(affectedFiles) ||
    affectedFiles.some((file) => typeof file !== "string" || file.trim() === "")
  ) {
    return bad("plan.affectedFiles must be an array of non-empty strings");
  }
  const surfaceAnalysis = parseSurfaceAnalysis(record.surfaceAnalysis, bad, limits);

  return {
    complexity: complexity as Complexity,
    securitySurface: securitySurface as SecuritySurface,
    summary: record.summary,
    contractRequirements: contractRequirements as string[],
    affectedFiles: affectedFiles as string[],
    surfaceAnalysis,
  };
}

/**
 * Scan out the first brace-balanced JSON object starting at or after `from`.
 *
 * String- and escape-aware, so a `{`/`}` inside a summary or rationale does not
 * shift the depth count. Returns the candidate substring, or `undefined` when no
 * `{` is present or the object never closes -- the truncation case, which the
 * caller must NOT confuse with "no plan was submitted".
 */
function sliceBalancedObject(text: string, from = 0): string | undefined {
  const start = text.indexOf("{", from);
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

/**
 * Every plan-shaped candidate in one planner response, most specific first.
 *
 * A model that is told to call `submit_plan` and answers in text does it in a
 * handful of observed shapes: the bare object, a ```json fence, and the object
 * preceded by prose or by a run-together tool name (`submit_planarguments: {`).
 * All of them carry a complete plan, so all of them are extracted and tried;
 * only text with no `{` at all means the planner genuinely submitted nothing.
 *
 * EVERY top-level object is collected, not just the first. The ambiguity
 * rejection in `parsePlanText` can only fire on candidates it was given, so
 * stopping at the first balanced object made that rejection depend on the
 * shape of the response rather than on its content: a draft and its correction
 * both fenced were caught, but a BARE draft followed by a second plan yielded
 * exactly one candidate -- the draft -- and was returned silently. That is the
 * governance bypass the rejection exists to close, so the scan walks the whole
 * text. It stays linear: the cursor only ever moves forward, past each object
 * it has already consumed.
 */
function planTextCandidates(value: string): string[] {
  const candidates: string[] = [];
  // Membership by Set, not by scanning the array. Deduping with `includes`
  // costs a full string comparison against every candidate already collected,
  // which was invisible while only a handful were ever extracted and became
  // quadratic the moment the scan started walking the whole text: a response
  // padded with brace-asides took 2s at 20k objects and ~59s at 1MB, stalling
  // the plan stage on output no model is prevented from producing.
  const seen = new Set<string>();
  const add = (candidate: string | undefined): void => {
    const trimmed = candidate?.trim();
    if (trimmed === undefined || trimmed === "" || seen.has(trimmed)) return;
    seen.add(trimmed);
    candidates.push(trimmed);
  };
  if (value.startsWith("{") && value.endsWith("}")) add(value);
  for (const match of value.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) add(match[1]);
  for (let cursor = 0; ; ) {
    const start = value.indexOf("{", cursor);
    if (start === -1) break;
    const sliced = sliceBalancedObject(value, start);
    // An object that never closes ends the scan: nothing after it is reachable,
    // and an empty candidate list is what tells the caller it was truncated.
    if (sliced === undefined) break;
    add(sliced);
    cursor = start + sliced.length;
  }
  return candidates;
}

/**
 * Recover a plan from a planner turn that answered in TEXT instead of calling
 * `submit_plan`, and distinguish the four outcomes the caller must tell apart.
 *
 * - a `Plan`: one candidate parsed AND validated.
 * - `undefined`: the response is empty/whitespace-only (genuine silence).
 * - throws `plan_not_json`: non-empty response with no JSON object candidate.
 * - throws `malformed_plan`: a candidate was present and every one failed. This
 *   includes truncated JSON and an AMBIGUOUS response with two valid plans.
 *
 * WHY THE FOUR-WAY SPLIT. A prose plan is work the planner attempted but not
 * the accepted handoff form; treating it as silence sent the operator looking
 * at registration instead of the response format. The accepted plan form stays
 * strict: prose is refused, not parsed.
 *
 * The thrown message is a FIXED structural string (or one `parsePlan` itself
 * emits); the planner's own text is never interpolated into it, so no model
 * content crosses the error boundary.
 */
export function parsePlanText(
  text: string,
  detail: string,
  limits: SurfaceAnalysisLimits = DEFAULT_SURFACE_ANALYSIS_LIMITS,
): Plan | undefined {
  const value = text.trim();
  const candidates = planTextCandidates(value);
  if (candidates.length === 0) {
    // No `{` at all. If the text nonetheless opens an object that never closes,
    // the planner was cut off mid-handoff -- a malformed submission, not silence.
    if (value.includes("{"))
      throw new OrchestrationError(
        "malformed_plan",
        detail,
        "planner JSON handoff is truncated: the submitted object never closes",
      );
    if (value.length > 0)
      throw new OrchestrationError(
        "plan_not_json",
        detail,
        "planner response carried no JSON object",
      );
    return undefined;
  }
  // Parse EVERY candidate rather than returning on the first that validates.
  //
  // WHY. A planner that drafts a plan and then corrects itself emits two
  // plan-shaped objects, and the real submission is the LAST one. Returning the
  // first silently accepted the draft -- which, when the draft said
  // `securitySurface: "none"` and the correction said `"elevated"`, skipped the
  // mandatory security phase with no error and no retry. That is a governance
  // bypass, and it is worse than the all-or-nothing gate this recovery replaced.
  // Guessing which of two submissions the planner meant is not this parser's
  // call to make, so two DIFFERENT valid plans are a rejection: the retry loop
  // then tells the planner to submit exactly one, which is recoverable.
  // Byte-different candidates that decode to the SAME plan (the bare object and
  // its own fenced copy) are one submission, not two, so they are compared
  // after parsing rather than as text.
  const plans: Plan[] = [];
  const errors: { error: OrchestrationError; planShaped: boolean }[] = [];
  for (const candidate of candidates) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(candidate);
    } catch {
      errors.push({
        error: new OrchestrationError("malformed_plan", detail, "planner JSON handoff is invalid"),
        planShaped: false,
      });
      continue;
    }
    try {
      plans.push(parsePlan(decoded, detail, limits));
    } catch (error) {
      if (!(error instanceof OrchestrationError)) throw error;
      // A nested fragment -- one `coverage` entry lifted out of a larger object
      // -- fails on whichever field it happens to lack first, and reporting THAT
      // sends the operator after a field the planner never got wrong. An object
      // carrying `complexity` is the one that was meant to be the plan.
      errors.push({
        error,
        planShaped:
          typeof decoded === "object" && decoded !== null && Object.hasOwn(decoded, "complexity"),
      });
    }
  }
  // Same reason as the candidate dedup above: a pairwise `findIndex` re-encodes
  // every plan against every other one. Encode each once, and let a Set answer
  // whether it was already seen.
  const distinctKeys = new Set<string>();
  const distinct = plans.filter((plan) => {
    const key = JSON.stringify(plan);
    if (distinctKeys.has(key)) return false;
    distinctKeys.add(key);
    return true;
  });
  if (distinct.length > 1)
    throw new OrchestrationError(
      "malformed_plan",
      detail,
      "planner text contains more than one distinct plan; submit exactly one",
    );
  if (distinct[0] !== undefined) return distinct[0];
  const reported = errors.find((entry) => entry.planShaped) ?? errors[0];
  throw (
    reported?.error ??
    new OrchestrationError("malformed_plan", detail, "planner JSON handoff is invalid")
  );
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
    description:
      "Record the plan's complexity, security surface, contract rules, affected files, and summary.",
    label: "submit plan",
    // Providers that expose strict JSON-schema tool calls can constrain this
    // mandatory handoff; others retain the normal tool-call fallback.
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    parameters: Type.Object({
      complexity: Type.String(),
      securitySurface: Type.String(),
      summary: Type.String(),
      contractRequirements: Type.Optional(Type.Array(Type.String())),
      // Same reasoning as `contractRequirements`: optional at the schema so a
      // legacy submission missing it reaches `parsePlan` and is named there,
      // never bounced pre-execute as a wrong-cause failure.
      affectedFiles: Type.Optional(Type.Array(Type.String())),
      // Spelled out STRUCTURALLY rather than as `Type.Any()`. An any-schema
      // serialises to a bare `{}`, and a provider that validates tool schemas
      // rejects the whole request for it -- DeepSeek answers "one of `type`,
      // `anyOf`, `$ref` field is required" with a 400, so the planner never
      // ran and the pipeline paused on an empty turn with zero tokens spent.
      // The shape mirrors `SurfaceAnalysis` so every node declares a `type`,
      // which is all the provider asked for.
      //
      // EVERY NESTED FIELD IS `Type.Optional`, and that is load-bearing rather
      // than lenient typing. TypeBox lists each non-optional property in its
      // object's `required`, and point (1) above applies to the WHOLE schema,
      // not just its enum leaves: the harness validates these args before
      // `execute`, so a required leaf makes a submission missing one field
      // bounce pre-execute. `capture.error` would then never be set, and the
      // pipeline would report "the planner did not submit a plan" about a
      // planner that submitted one -- naming the wrong cause, which
      // `docs/contracts/errors.md` forbids. Optional here restores the
      // pre-`Type.Any()` behaviour exactly: the payload reaches `parsePlan`,
      // which says which field is wrong. `surfaceAnalysis` itself stays
      // required because it was required before this schema existed too.
      surfaceAnalysis: Type.Object({
        projectType: Type.Optional(
          Type.String({ description: "the kind of project this repository is" }),
        ),
        surfaces: Type.Optional(
          Type.Array(
            Type.Object({
              id: Type.Optional(
                Type.String({ description: "a stable id, unique across the list" }),
              ),
              name: Type.Optional(Type.String({ description: "the affected product surface" })),
              rationale: Type.Optional(
                Type.String({ description: "why this surface is affected" }),
              ),
            }),
          ),
        ),
        // Every `description` below is ADVISORY, which is why adding one cannot
        // cost decision (1) anything: a description is not a `required` entry
        // and not a union of literals, so a submission that omits or mis-spells
        // the field still reaches `parsePlan` and still surfaces as
        // `malformed_plan` with `capture.error` set. What it buys is the
        // vocabulary on the surface a model sees EVERY turn -- the schema --
        // rather than only in the one long instruction line
        // `formatPlannerInstruction` appends to the task, and it reaches
        // providers that sample against this schema. Live evidence for the
        // cost of leaving it out: a planner omitted the required-by-validator
        // `status` on all eight entries of a submission, was refused with
        // "coverage fields are invalid" (which named neither the entry nor the
        // field), and burned two turns before it guessed (2026-09-18, run
        // 8998ec7c).
        coverage: Type.Optional(
          Type.Array(
            Type.Object({
              surfaceId: Type.Optional(
                Type.String({
                  description:
                    "the id of the surface entry this covers; must match a surfaces[].id",
                }),
              ),
              status: Type.Optional(
                Type.String({
                  description:
                    "REQUIRED. Exactly one of: covered, not_applicable, research_required",
                }),
              ),
              contractIds: Type.Optional(
                Type.Array(Type.String(), {
                  description:
                    "canonical contract ids this entry covers; required non-empty when status is covered or research_required, and required empty when it is not_applicable",
                }),
              ),
              evidence: Type.Optional(
                Type.Array(Type.String(), {
                  description:
                    "source locations, or the gap itself; required non-empty for every status",
                }),
              ),
              rationale: Type.Optional(
                Type.String({ description: "why this status holds for this surface" }),
              ),
            }),
          ),
        ),
      }),
    }),
    async execute(_toolCallId, params) {
      capture.called = true;
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
          // Same reason as `submit_follow_up`: "malformed_plan" tells a planner
          // nothing it can act on, while the validator's own message names the
          // field ("coverage.contractIds must be bounded non-empty strings").
          // This is the rejection five model families hit on the pipeline
          // tasks, each retrying blind until its stage ran out.
          return {
            content: [{ type: "text", text: `${error.code}: ${error.message}` }],
            details: undefined,
          };
        }
        throw error;
      }
    },
  });
}

/**
 * The requirement for a session that holds no plan text: nothing to submit yet.
 *
 * Every clause is checkable from INSIDE the session reading it. That is the
 * whole point (#525): a retry opens a fresh run id, so "your preceding response
 * did not call submit_plan" names a response that session never made -- and a
 * model resolves a premise it cannot check by inventing it, which on this
 * surface means inventing a plan (review of #525, round 3).
 */
export const PLANNER_SUBMISSION_RESTART = `No plan text and no ${SUBMIT_PLAN_TOOL_NAME} call are present in this session, so there is nothing to submit yet. Plan the task above now and submit it by calling ${SUBMIT_PLAN_TOOL_NAME} with the complete required object, then stop.`;

/**
 * The task a planner retry attempt receives: the work, the plan-so-far, and the
 * requirement it has to meet now.
 *
 * The same mechanism #525 fixed on the review surface, on the other decision
 * surface that re-asks under a fresh run id. Two things make the prompt true for
 * the session that reads it: the attempt's own text travels with the task under a
 * header that says where it came from, and the requirement is phrased about what
 * THIS session holds rather than about a history it does not have.
 *
 * `correction` is the rejection path's own wording -- it names WHICH failure the
 * validator reported, which is the only route to a correct resubmission. It is
 * used even when nothing was carried: a planner that submitted through the tool
 * and wrote no prose still has to be told what was refused. The default is the
 * restart requirement, reached exactly when nothing was written: non-empty text
 * always leaves either a parsed plan (the loop breaks) or a correction
 * (`parsePlanText` throws for non-empty text rather than returning), so at the
 * shipped two-attempt budget a carry and a correction travel together.
 *
 * The text travels EXACTLY as the attempt produced it; trimming only decides
 * whether there is anything to carry.
 */
export function plannerRetryTask(
  task: string,
  priorText: string,
  correction: string = PLANNER_SUBMISSION_RESTART,
): string {
  const carried = priorText.trim() === "" ? "" : `Your plan so far, verbatim:\n\n${priorText}\n\n`;
  return `${task}\n\n${carried}${correction}`;
}

/**
 * The fixed instruction appended to the planner's prompt, telling it to CALL the
 * `submit_plan` tool with the required shape. Exported so the pipeline and the
 * tests agree on it verbatim. No filesystem path is involved: the plan signal
 * travels as tool-call args. Calling the tool is mandatory whenever a planner is
 * configured; free text alone cannot authorize a coder turn.
 */
export function formatPlannerInstruction(): string {
  const canonicalIds = Object.keys(CONTRACT_INDEX).join(", ");
  return [
    `When your plan is ready, record it by calling the ${SUBMIT_PLAN_TOOL_NAME} tool.`,
    "Call it with this shape:",
    '{ "complexity": "trivial" | "medium" | "complex", "securitySurface": "none" | "low" | "elevated", "summary": "<short summary>", "contractRequirements": ["<rule>"], "affectedFiles": ["<path>"], "surfaceAnalysis": { "projectType": "<type>", "surfaces": [{"id":"<stable-id>","name":"<surface>","rationale":"<why affected>"}], "coverage": [{"surfaceId":"<stable-id>","status":"covered|not_applicable|research_required","contractIds":["<canonical id>"],"evidence":["<source or gap evidence>"],"rationale":"<decision>"}] } }',
    "This structured submission is mandatory. Identify every affected product surface before coding.",
    `Text without a ${SUBMIT_PLAN_TOOL_NAME} tool call is not a submission: the turn is rejected and the plan is lost. Only the ${SUBMIT_PLAN_TOOL_NAME} tool call records and submits the plan.`,
    // The text fallback used to demand a bare object with "no Markdown", which
    // asked models to suppress the fenced form they emit by default and made a
    // recoverable handoff look like a refusal. State what the parser accepts
    // instead, and put the weight on the one property that is NOT recoverable:
    // the object has to be finished.
    `Call ${SUBMIT_PLAN_TOOL_NAME} first. If the provider returns text instead, emit one complete JSON object with that shape -- alone, or inside a single \`\`\`json fence -- and nothing after it. A cut-off object cannot be read; keep the fields short enough to close it.`,
    'For status "covered", contractIds and evidence must both be non-empty. Use only canonical contract IDs.',
    `Canonical contract IDs accepted by this pipeline: ${canonicalIds}.`,
    'For status "not_applicable", contractIds must be empty and evidence must explain why no contract applies.',
    'For status "research_required", contractIds must be non-empty canonical IDs and evidence must name the missing contract knowledge; do not claim "covered" with empty arrays.',
    COMPLEXITY_RUBRIC,
    'Choose "none" when the task touches no attack surface, "low" for incidental exposure, "elevated" when it touches auth, secrets, user input, crypto, or an external boundary.',
  ].join("\n");
}
