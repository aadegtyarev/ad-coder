import { Type } from "@earendil-works/pi-ai";
import type { Tool } from "../runner/tool";
import { defineTool } from "../runner/tool";
import type { IssueSeverity, SurfaceAnalysis, Verdict, VerdictIssue, VerdictStatus } from "./types";
import { OrchestrationError } from "./types";

/** The tool name the reviewer calls to submit its verdict. */
export const SUBMIT_VERDICT_TOOL_NAME = "submit_verdict";

const VERDICT_STATUSES: readonly VerdictStatus[] = ["approved", "changes_requested"];
const ISSUE_SEVERITIES: readonly IssueSeverity[] = ["blocker", "major", "minor"];

/**
 * A per-reviewer-round holder the `submit_verdict` tool writes into and the
 * pipeline reads after the turn. Exactly one of `verdict`/`error` is set once
 * the tool has fired; both absent means the reviewer never called the tool
 * (a `missing_verdict`). A FRESH holder per round -- keyed by closure, not a
 * shared field -- means a stale verdict from an earlier round can never be read
 * as the current one (mirrors the old per-runId file keying).
 */
export interface VerdictCapture {
  verdict?: Verdict;
  error?: OrchestrationError;
}

/**
 * Strictly validate untrusted, model-produced input into a `Verdict`.
 *
 * The verdict arrives as `submit_verdict` tool-call args: its shape is NOT
 * trusted. This is a pure, self-contained, hand-written validator (no `eval`,
 * no schema library): `value` must be an object; `status` one of the two
 * allowed literals; `issues` an array where every element is an object with a
 * `severity` in the three allowed literals and a string `what`; `summary` a
 * string. Any deviation throws `OrchestrationError('malformed_verdict')` --
 * never a silent coercion, never a default that could read as a pass.
 *
 * `detail` is a path-safe token (the reviewer runId) carried onto the error's
 * `detail` field; it is NEVER content and never the verdict body.
 */
export function parseVerdict(value: unknown, detail: string, expected?: SurfaceAnalysis): Verdict {
  const bad = (message: string): never => {
    throw new OrchestrationError("malformed_verdict", detail, message);
  };

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return bad("verdict is not an object");
  }
  const record = value as Record<string, unknown>;

  const status = record.status;
  if (typeof status !== "string" || !VERDICT_STATUSES.includes(status as VerdictStatus)) {
    return bad(`verdict.status must be one of ${VERDICT_STATUSES.join(", ")}`);
  }

  const rawIssues = record.issues;
  if (!Array.isArray(rawIssues)) {
    return bad("verdict.issues must be an array");
  }
  const issues: VerdictIssue[] = rawIssues.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return bad(`verdict.issues[${index}] must be an object`);
    }
    const issue = entry as Record<string, unknown>;
    const severity = issue.severity;
    if (typeof severity !== "string" || !ISSUE_SEVERITIES.includes(severity as IssueSeverity)) {
      return bad(`verdict.issues[${index}].severity must be one of ${ISSUE_SEVERITIES.join(", ")}`);
    }
    if (typeof issue.what !== "string") {
      return bad(`verdict.issues[${index}].what must be a string`);
    }
    return { severity: severity as IssueSeverity, what: issue.what };
  });

  if (typeof record.summary !== "string") {
    return bad("verdict.summary must be a string");
  }
  let coverage: Verdict["coverage"];
  const applicable = expected?.coverage.filter(({ status }) => status === "covered") ?? [];
  if (applicable.length > 0) {
    if (!Array.isArray(record.coverage)) return bad("verdict.coverage must be an array");
    coverage = record.coverage.map((entry, index) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry))
        return bad(`verdict.coverage[${index}] must be an object`);
      const item = entry as Record<string, unknown>;
      if (
        typeof item.surfaceId !== "string" ||
        !Array.isArray(item.contractIds) ||
        !item.contractIds.every((id) => typeof id === "string") ||
        !Array.isArray(item.evidence) ||
        !item.evidence.every((evidence) => typeof evidence === "string")
      )
        return bad(`verdict.coverage[${index}] fields are invalid`);
      return {
        surfaceId: item.surfaceId,
        contractIds: item.contractIds as string[],
        evidence: item.evidence as string[],
      };
    });
    const expectedBySurface = new Map(
      applicable.map((item) => [
        item.surfaceId,
        { ids: item.contractIds, set: new Set(item.contractIds) },
      ]),
    );
    if (coverage.length !== expectedBySurface.size) return bad("verdict.coverage is incomplete");
    const seen = new Set<string>();
    for (const [index, item] of coverage.entries()) {
      const contracts = expectedBySurface.get(item.surfaceId);
      if (contracts === undefined || seen.has(item.surfaceId))
        return bad("verdict.coverage contains unknown or duplicate surfaceId");
      seen.add(item.surfaceId);
      if (
        item.contractIds.length !== contracts.set.size ||
        item.contractIds.some((id) => !contracts.set.has(id))
      )
        return bad(
          `verdict.coverage[${index}].contractIds must exactly match required contract IDs: ${contracts.ids.join(", ")}; resubmit the verdict with those IDs`,
        );
      if (item.evidence.length === 0)
        return bad(
          `verdict.coverage[${index}].evidence must include at least one verification result; resubmit the verdict with evidence`,
        );
    }
  }

  return {
    status: status as VerdictStatus,
    issues,
    summary: record.summary,
    ...(coverage && { coverage }),
  };
}

/**
 * Build the `submit_verdict` tool for one reviewer round, writing into `capture`.
 *
 * TWO non-obvious pi-agent-core facts shape this. (1) The harness validates
 * tool-call args against `parameters` BEFORE `execute` runs, so the schema is
 * deliberately PERMISSIVE at the enum leaves (`status`/`severity` as
 * `Type.String`, not a union of literals): a malformed enum value must reach
 * `parseVerdict` rather than being bounced pre-execute -- which would surface as
 * `missing_verdict`, never `malformed_verdict`, and collapse the defense-in-depth
 * to a single gate. (2) The harness CATCHES any throw from `execute` and turns
 * it into an error tool-result; it does NOT propagate out of `runRole`. So
 * `execute` must CATCH `parseVerdict`'s `OrchestrationError` and store it in the
 * holder for the pipeline to re-throw after the turn, rather than throwing.
 *
 * `detail` is the reviewer runId, threaded onto any `OrchestrationError.detail`.
 */
export function buildSubmitVerdictTool(
  capture: VerdictCapture,
  detail: string,
  expected?: SurfaceAnalysis,
): Tool {
  return defineTool({
    name: SUBMIT_VERDICT_TOOL_NAME,
    description: "Record the review verdict.",
    label: "submit verdict",
    parameters: Type.Object({
      status: Type.String(),
      issues: Type.Array(Type.Object({ severity: Type.String(), what: Type.String() })),
      summary: Type.String(),
      coverage: Type.Optional(
        Type.Array(
          Type.Object({
            surfaceId: Type.String(),
            contractIds: Type.Array(Type.String()),
            evidence: Type.Array(Type.String()),
          }),
        ),
      ),
    }),
    async execute(_toolCallId, params) {
      try {
        // Last-wins: a reviewer that calls the tool twice overwrites the prior
        // capture, so the pipeline reads the final submission of the round.
        // `delete` (not `= undefined`) clears the sibling under
        // exactOptionalPropertyTypes, where the field is not typed `| undefined`.
        capture.verdict = parseVerdict(params, detail, expected);
        delete capture.error;
        return { content: [{ type: "text", text: "verdict recorded" }], details: undefined };
      } catch (error) {
        if (error instanceof OrchestrationError) {
          capture.error = error;
          delete capture.verdict;
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
 * The fixed instruction appended to the reviewer's prompt, telling it to CALL
 * the `submit_verdict` tool with the required shape. Exported so the pipeline
 * and the tests agree on it verbatim. No filesystem path is involved: the
 * verdict travels as tool-call args, not a written file.
 */
export function formatReviewerInstruction(expected?: SurfaceAnalysis): string {
  const applicable = expected?.coverage.filter(({ status }) => status === "covered") ?? [];
  return [
    `When your review is complete, submit your verdict by calling the ${SUBMIT_VERDICT_TOOL_NAME} tool.`,
    "Call it with this shape:",
    applicable.length === 0
      ? '{ "status": "approved" | "changes_requested", "issues": [ { "severity": "blocker" | "major" | "minor", "what": "<one issue>" } ], "summary": "<short summary>" }'
      : '{ "status": "approved" | "changes_requested", "issues": [ { "severity": "blocker" | "major" | "minor", "what": "<one issue>" } ], "summary": "<short summary>", "coverage": [{"surfaceId":"<id>","contractIds":["<id>"],"evidence":["<verification>"]}] }',
    ...(applicable.length === 0
      ? []
      : [
          `Cover exactly these surface contracts: ${JSON.stringify(
            applicable.map((item) => ({
              surfaceId: item.surfaceId,
              contractIds: item.contractIds,
            })),
          )}.`,
        ]),
    'Use "approved" only when no further changes are required; otherwise "changes_requested" with each required change as an issue.',
  ].join("\n");
}
