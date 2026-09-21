import { Type } from "@earendil-works/pi-ai";
import type { Tool } from "../runner/tool";
import { defineTool } from "../runner/tool";
import type {
  IssueSeverity,
  RemovedTestBehavior,
  RemovedTestInventoryEntry,
  SurfaceAnalysis,
  Verdict,
  VerdictIssue,
  VerdictStatus,
} from "./types";
import { OrchestrationError } from "./types";

/** The tool name the reviewer calls to submit its verdict. */
export const SUBMIT_VERDICT_TOOL_NAME = "submit_verdict";

/**
 * How many times a review asks for its verdict before giving up.
 *
 * Two, matching the planner's handoff attempts: one retry converts the common
 * failure -- a thorough inspection that ends in prose -- into a settled review,
 * while a reviewer that will not submit twice is a configuration problem to
 * surface rather than a cost to keep paying. Shared by the pipeline round and
 * the standalone reviewer, which face the same failure for the same reason
 * (issue #278, issue #283).
 */
export const REVIEW_SUBMISSION_ATTEMPTS = 2;

/**
 * Re-states only the submission requirement; the inspection already happened.
 *
 * Every clause here is checkable from INSIDE the session reading it. That is the
 * whole defect (#525): a retry runs under a fresh run id, so "your preceding
 * response did not call submit_verdict" names a response the session never made,
 * and a claim about a context the reader cannot see is resolved by inventing the
 * context. "Your review" is redeemable -- `reviewRetryTask` put that text in this
 * prompt, under a header that says where it came from -- and the requirement
 * that follows is the only thing being asked for.
 */
export const REVIEW_SUBMISSION_RETRY = `Your review stands; submit it now by calling ${SUBMIT_VERDICT_TOOL_NAME} with the complete verdict object, then stop.`;

/**
 * The requirement when the attempt left NO review text to carry.
 *
 * `REVIEW_SUBMISSION_RETRY` cannot be reused here: it asserts that a review
 * stands, and this session -- a fresh run id, so no history -- holds none. That
 * is the #525 premise exactly, moved to the empty case instead of removed, and a
 * model resolves an unverifiable premise rather than declining it. So this retry
 * asks for the REVIEW, not for a submission: the attempt that produced nothing
 * has to be made again. Nothing here refers to a prior attempt either -- "your
 * preceding response produced no review text" is the same unverifiable premise
 * in a new costume (review of #525, round 3) -- and one sentence covers every
 * way an attempt can leave nothing behind: a truncation, a tool-only turn, a
 * provider that dropped the text.
 */
export const REVIEW_SUBMISSION_RESTART = `No review text is available in this session, so there is no verdict to submit yet. Review the work now and submit your verdict by calling ${SUBMIT_VERDICT_TOOL_NAME} with the complete verdict object, then stop.`;

/**
 * The task a retry attempt receives: the work, the review the attempts so far
 * produced, and the submission requirement.
 *
 * WHY THE REVIEW TRAVELS WITH IT. A retry runs under a FRESH run id, and a turn
 * is keyed by run id in the session store, so it opens a session with no
 * history: the review the retry prompt calls "your review" is nowhere in its
 * context. Measured 2026-09-20 (issue #525) on a lane whose first review run had
 * reproduced a blocker: the retry submitted `approved` after two model turns and
 * sixteen seconds, with a summary reporting six gates it never ran, while the
 * stamp and the merge gate read the submitted verdict -- the false premise was
 * resolved by inventing the review. Handing it the text makes the sentence true,
 * so the verdict is submitted over the review that was actually made.
 *
 * An attempt that produced no text at all is the one case with nothing to hand
 * over. It gets `REVIEW_SUBMISSION_RESTART` rather than the bare submission
 * retry: "your review stands" told to a session that has no review is the same
 * unverifiable premise, and the retry resolves it the same way. Neither branch
 * tells the session anything about a response it made, because a fresh session
 * made none.
 *
 * The text travels EXACTLY as the attempt produced it -- no trimming, no
 * reflow. Trimming only decides which of the two requirements applies; what a
 * reviewer wrote about leading whitespace is not the caller's to edit, and a
 * prompt that claims "verbatim" while editing the payload is a smaller version
 * of the same defect.
 */
export function reviewRetryTask(task: string, priorText: string): string {
  if (priorText.trim() === "") return `${task}\n\n${REVIEW_SUBMISSION_RESTART}`;
  return `${task}\n\nYour review so far, verbatim:\n\n${priorText}\n\n${REVIEW_SUBMISSION_RETRY}`;
}

const VERDICT_STATUSES: readonly VerdictStatus[] = [
  "approved",
  "changes_requested",
  "decomposition_required",
];
const ISSUE_SEVERITIES: readonly IssueSeverity[] = ["blocker", "major", "minor"];

/** Inventory observable removed test assertions from a bounded unified diff. */
export function inventoryRemovedTests(diff: string): RemovedTestInventoryEntry[] {
  const entries: RemovedTestInventoryEntry[] = [];
  let path = "";
  let oldLine = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git a/")) {
      path = line.slice("diff --git a/".length).split(" b/")[0] ?? "";
      continue;
    }
    const hunk = line.match(/^@@ -(\d+)/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      continue;
    }
    if (
      line.startsWith("-") &&
      !line.startsWith("---") &&
      /(?:^|\/)test(?:\/|[^/]*\.test\.)[^/]*\.(?:ts|tsx|js|jsx)$/.test(path)
    ) {
      const text = line.slice(1);
      if (text.trim() !== "")
        entries.push({ removedTestId: `${path}:${oldLine}`, path, line: oldLine, text });
      oldLine += 1;
    } else if (!line.startsWith("+")) {
      if (line !== "" && !line.startsWith("\\")) oldLine += 1;
    }
  }
  return entries;
}

/** One bounded mapping shared by the TypeScript shape, schema descriptions and validator. */
export const VERDICT_ISSUE_FIELDS = {
  what: 2000,
  location: 400,
  closureCriterion: 1200,
  findingId: 120,
  evidence: 1600,
  maxIssues: 40,
  maxAggregateBytes: 100_000,
  summary: 4000,
} as const;
const ARTIFACT_ONLY =
  /(?:review\s*(?:-\s*)?(?:artifact|stamp)|review|round|stamp|freshness|accounting|process)\s+(?:artifact|metadata|bookkeeping|stamp|freshness)|(?:stale|outdated)\s+(?:review\s*)?stamp/i;
const hasText = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";
const redactFinding = (value: string): string =>
  value
    .replace(/(?:bearer|token|password|secret|api[_ -]?key)\s*[:=]\s*\S+/gi, "[REDACTED]")
    .replace(/(?:^|\s)(?:\/home\/|\/Users\/|[A-Za-z]:\\)[^\s]*/g, " [REDACTED_PATH]");
function bounded(
  field: string,
  value: unknown,
  max: number,
  bad: (message: string) => never,
): string {
  if (!hasText(value)) return bad(`verdict.issues[].${field} must be a non-empty string`);
  if (Buffer.byteLength(value, "utf8") > max)
    return bad(`verdict.issues[].${field} exceeds ${max} bytes`);
  return value;
}

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
 * no schema library): `value` must be an object; `status` one of the three
 * allowed literals; `issues` an array where every element is an object with a
 * `severity` in the three allowed literals and a string `what`; `summary` a
 * string. Any deviation throws `OrchestrationError('malformed_verdict')` --
 * never a silent coercion, never a default that could read as a pass.
 *
 * `detail` is a path-safe token (the reviewer runId) carried onto the error's
 * `detail` field; it is NEVER content and never the verdict body.
 */
export function parseVerdict(
  value: unknown,
  detail: string,
  expected?: SurfaceAnalysis,
  priorFindings: readonly VerdictIssue[] = [],
  removedTestInventory?: readonly RemovedTestInventoryEntry[],
): Verdict {
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
  if (rawIssues.length > VERDICT_ISSUE_FIELDS.maxIssues)
    return bad(`verdict.issues exceeds the maximum of ${VERDICT_ISSUE_FIELDS.maxIssues} findings`);
  let issueBytes = 0;
  const seenFindingIds = new Set<string>();
  const issues: VerdictIssue[] = rawIssues.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return bad(`verdict.issues[${index}] must be an object`);
    }
    const issue = entry as Record<string, unknown>;
    const severity = issue.severity;
    if (typeof severity !== "string" || !ISSUE_SEVERITIES.includes(severity as IssueSeverity)) {
      return bad(`verdict.issues[${index}].severity must be one of ${ISSUE_SEVERITIES.join(", ")}`);
    }
    const what = redactFinding(
      bounded(`what`, issue.what, VERDICT_ISSUE_FIELDS.what, (message) =>
        bad(message.replace("issues[]", `issues[${index}]`)),
      ),
    );
    const needsAddress = severity === "blocker" || severity === "major";
    const location = needsAddress
      ? redactFinding(
          bounded("location", issue.location, VERDICT_ISSUE_FIELDS.location, (message) =>
            bad(message.replace("issues[]", `issues[${index}]`)),
          ),
        )
      : typeof issue.location === "string"
        ? redactFinding(issue.location)
        : "summary";
    const closureCriterion = needsAddress
      ? redactFinding(
          bounded(
            "closureCriterion",
            issue.closureCriterion,
            VERDICT_ISSUE_FIELDS.closureCriterion,
            (message) => bad(message.replace("issues[]", `issues[${index}]`)),
          ),
        )
      : typeof issue.closureCriterion === "string"
        ? redactFinding(issue.closureCriterion)
        : "reviewer-specified";
    if (needsAddress && ARTIFACT_ONLY.test(what))
      return bad(
        `verdict.issues[${index}] review-artifact-only complaints belong in verdict.summary, not ${severity}; resubmit it in summary`,
      );
    const findingId =
      issue.findingId === undefined
        ? undefined
        : redactFinding(
            bounded("findingId", issue.findingId, VERDICT_ISSUE_FIELDS.findingId, (message) =>
              bad(message.replace("issues[]", `issues[${index}]`)),
            ),
          );
    const evidence =
      issue.evidence === undefined
        ? undefined
        : redactFinding(
            bounded("evidence", issue.evidence, VERDICT_ISSUE_FIELDS.evidence, (message) =>
              bad(message.replace("issues[]", `issues[${index}]`)),
            ),
          );
    const resolution =
      issue.resolution === undefined
        ? undefined
        : typeof issue.resolution === "string" &&
            ["closed", "remains", "new"].includes(issue.resolution)
          ? (issue.resolution as "closed" | "remains" | "new")
          : bad(`verdict.issues[${index}].resolution must be closed, remains, or new`);
    if (needsAddress && findingId === undefined)
      return bad(`verdict.issues[${index}].findingId is required for blocker and major findings`);
    if (resolution === "closed" && evidence === undefined)
      return bad(`verdict.issues[${index}].evidence is required when resolution is closed`);
    if (findingId !== undefined) {
      if (seenFindingIds.has(findingId))
        return bad(`verdict.issues[${index}].findingId must be unique within the verdict`);
      seenFindingIds.add(findingId);
    }
    issueBytes += Buffer.byteLength(
      JSON.stringify({ what, location, closureCriterion, findingId, resolution, evidence }),
      "utf8",
    );
    if (issueBytes > VERDICT_ISSUE_FIELDS.maxAggregateBytes)
      return bad(`verdict.issues exceeds ${VERDICT_ISSUE_FIELDS.maxAggregateBytes} bytes`);
    return {
      severity: severity as IssueSeverity,
      what,
      location,
      closureCriterion,
      ...(findingId !== undefined && { findingId }),
      ...(resolution !== undefined && { resolution }),
      ...(evidence !== undefined && { evidence }),
    };
  });

  // issue #478: "changes_requested" with an empty issues list is not a
  // verdict -- it names no defect to fix, so the round deadlocks on a stamp
  // that blocks it. Same stance as the coverage branch below: refuse
  // mechanically rather than guessing at the issue bodies' wording.
  if (status === "changes_requested" && issues.length === 0)
    return bad(
      'verdict.issues must name at least one REMAINING defect when verdict.status is "changes_requested" (an empty list means nothing must change: resolved findings belong in verdict.summary, and "approved" is the verdict with an empty verdict.issues); resubmit the corrected verdict',
    );

  // Findings with an ID are identity-accounted regardless of severity. Preserve
  // compatibility only for prior minor findings that never had an ID.
  const carriedFindings = priorFindings.filter(
    (finding) => finding.findingId !== undefined || finding.severity !== "minor",
  );
  if (carriedFindings.length > 0) {
    const priorIds = new Set(carriedFindings.map((finding) => finding.findingId));
    if (priorIds.has(undefined)) return bad("prior findings must all have findingId");
    const carriedIds = new Set(carriedFindings.map((finding) => finding.findingId as string));
    const resolvedIds = new Set(
      issues
        .filter((issue) => issue.resolution === "closed" || issue.resolution === "remains")
        .map((issue) => issue.findingId),
    );
    for (const id of carriedIds) {
      if (!resolvedIds.has(id))
        return bad(
          `verdict.issues must account for carried findingId ${id} as closed with evidence or remains; resubmit it instead of silently dropping it`,
        );
    }
    for (const issue of issues) {
      const carriesPriorFinding = issue.findingId !== undefined && carriedIds.has(issue.findingId);
      if (issue.severity === "minor" && !carriesPriorFinding) continue;
      if (issue.findingId === undefined || issue.resolution === undefined)
        return bad(
          `verdict.issues findingId ${issue.findingId ?? "<missing>"} must declare resolution`,
        );
      if (issue.resolution === "new" && carriesPriorFinding)
        return bad(`verdict.issues findingId ${issue.findingId} cannot be new when it is carried`);
    }
  }

  if (typeof record.summary !== "string") {
    return bad("verdict.summary must be a string");
  }
  if (Buffer.byteLength(record.summary, "utf8") > VERDICT_ISSUE_FIELDS.summary)
    return bad(`verdict.summary exceeds ${VERDICT_ISSUE_FIELDS.summary} bytes`);
  let coverage: Verdict["coverage"];
  const applicable = expected?.coverage.filter(({ status }) => status === "covered") ?? [];
  if (applicable.length > 0) {
    if (!Array.isArray(record.coverage)) return bad("verdict.coverage must be an array");
    coverage = record.coverage.map((entry, index) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry))
        return bad(`verdict.coverage[${index}] must be an object`);
      const item = entry as Record<string, unknown>;
      // The index was here but the FIELD was not, and this branch covers four of
      // them: it was the same refusal-plan.ts used to give, one sentence for
      // several causes, and it names neither the one that failed nor what it
      // wanted (`docs/contracts/errors.md`). Split per field, matching the
      // corrective messages below.
      if (typeof item.surfaceId !== "string")
        return bad(`verdict.coverage[${index}].surfaceId must be a string`);
      if (
        !Array.isArray(item.contractIds) ||
        !item.contractIds.every((id) => typeof id === "string")
      )
        return bad(`verdict.coverage[${index}].contractIds must be an array of strings`);
      if (
        !Array.isArray(item.evidence) ||
        !item.evidence.every((evidence) => typeof evidence === "string")
      )
        return bad(`verdict.coverage[${index}].evidence must be an array of strings`);
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

  let removedTests: RemovedTestBehavior[] | undefined;
  if (record.removedTests !== undefined) {
    if (!Array.isArray(record.removedTests)) return bad("verdict.removedTests must be an array");
    removedTests = record.removedTests.map((entry, index) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry))
        return bad(`verdict.removedTests[${index}] must be an object`);
      const item = entry as Record<string, unknown>;
      const removedTestId = bounded("removedTestId", item.removedTestId, 200, (message) =>
        bad(message.replace("issues[]", `removedTests[${index}]`)),
      );
      const behavior = bounded("behavior", item.behavior, 1200, (message) =>
        bad(message.replace("issues[]", `removedTests[${index}]`)),
      );
      const destination = bounded("destination", item.destination, 400, (message) =>
        bad(message.replace("issues[]", `removedTests[${index}]`)),
      );
      if (item.fate !== "restored" && item.fate !== "moved")
        return bad(`verdict.removedTests[${index}].fate must be restored or moved`);
      return {
        removedTestId,
        behavior: redactFinding(behavior),
        destination: redactFinding(destination),
        fate: item.fate,
      };
    });
  }
  if (removedTestInventory !== undefined) {
    if (removedTestInventory.length > 0 && removedTests === undefined)
      return bad("verdict.removedTests is required: account for every removed test behavior");
    const expectedIds = new Set(removedTestInventory.map((entry) => entry.removedTestId));
    const actualIds = new Set((removedTests ?? []).map((entry) => entry.removedTestId));
    if (
      removedTests !== undefined &&
      (removedTests.length !== expectedIds.size ||
        actualIds.size !== expectedIds.size ||
        [...expectedIds].some((id) => !actualIds.has(id)))
    )
      return bad(
        "verdict.removedTests must account for every machine-inventoried removed test behavior",
      );
  }
  return {
    status: status as VerdictStatus,
    // Approved rounds are terminal and must not carry review findings into state,
    // durable records, or the next coder handoff.
    issues: status === "approved" ? [] : issues,
    summary: redactFinding(record.summary),
    ...(coverage && { coverage }),
    ...(removedTests && { removedTests }),
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
  priorFindings: readonly VerdictIssue[] = [],
  removedTestInventory?: readonly RemovedTestInventoryEntry[],
): Tool {
  return defineTool({
    name: SUBMIT_VERDICT_TOOL_NAME,
    description:
      "Record the review verdict. `status` may be approved, changes_requested, or " +
      "decomposition_required. Submit decomposition_required ONLY for a measurable " +
      "escalation signal: repeated rework of one place, two or more roles producing no " +
      "signal, one role monopolising the run, a stage consuming large input while " +
      "emitting almost nothing, input ceilings exhausted, or sources of truth that " +
      "disagree. Never use it for a mood, or because the work merely feels large.",
    label: "submit verdict",
    // Prefer provider-native strict schemas without excluding portable
    // tool-calling providers from the review workflow.
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    // Every NESTED field is `Type.Optional`, for the same reason the enum
    // leaves stay bare strings: the harness validates these args before
    // `execute`, and TypeBox lists each non-optional property in its object's
    // `required`. A required nested leaf would bounce an incomplete submission
    // pre-execute, so `capture.error` would never be set and the reviewer
    // would be told it did not submit a verdict when it did. That also
    // silences `parseVerdict`'s corrective messages -- the coverage branch
    // names the exact contract IDs to resubmit -- which are the reviewer's
    // only route to a correct second attempt. `parseVerdict` is the gate.
    // The `description` strings state the vocabulary where a model actually
    // reads it. They are advisory, so -- like the optional leaves above -- they
    // cannot bounce a submission pre-execute: decision (1) is untouched, and
    // the rejection still reaches `parseVerdict`. Their absence is what left
    // `status` and `severity` unguessable from the schema alone (2026-09-18,
    // run 8998ec7c).
    parameters: Type.Object({
      status: Type.String({
        description:
          "REQUIRED. Exactly one of: approved, changes_requested, decomposition_required",
      }),
      issues: Type.Array(
        Type.Object({
          severity: Type.Optional(
            Type.String({
              description: "one of: blocker, major, minor",
            }),
          ),
          what: Type.Optional(
            Type.String({ description: "the bounded issue itself; required for every issue" }),
          ),
          location: Type.Optional(
            Type.String({
              description:
                "required for blocker/major: relative file:line or scenario/fixture address",
            }),
          ),
          closureCriterion: Type.Optional(
            Type.String({
              description: "required for blocker/major: objective observation proving closure",
            }),
          ),
          findingId: Type.Optional(
            Type.String({ description: "stable id; required for every blocker and major finding" }),
          ),
          resolution: Type.Optional(Type.String({ description: "closed, remains, or new" })),
          evidence: Type.Optional(
            Type.String({ description: "bounded evidence required for closed findings" }),
          ),
        }),
        {
          description:
            'each remaining defect you found; a defect you verified as resolved belongs in "summary" instead, and "approved" is exactly the verdict whose issues list is empty',
        },
      ),
      // issue #489: this field was DELETED from the schema by #484 (0.124.0)
      // in the same hunk that added the `issues` description above, and
      // nothing noticed -- `parseVerdict` still refuses a submission without
      // it (`verdict.summary must be a string`, three branches down),
      // `formatReviewerInstruction` still draws it in the shape it tells the
      // reviewer to send, and `record.summary` is what the verdict record
      // keeps. The tool asks providers for a strict JSON schema
      // (`constrainedSampling` above), so the declared shape is the one the
      // model is held to: the field was required by the validator and offered
      // by no schema at all. Measured cost: 6 of 7 `submit_verdict` calls
      // across #477's three lost rounds omitted it, each refusal was retried
      // with the identical payload, and the third round ended on
      // `stage input limit reached (2045632/2000000)` with no verdict. The
      // description states the requirement where the model reads it, beside
      // `status`'s -- a JSON shape example alone reads as illustrative.
      summary: Type.String({
        description: "REQUIRED. a short summary of the review",
      }),
      removedTests: Type.Optional(
        Type.Array(
          Type.Object({
            removedTestId: Type.Optional(
              Type.String({ description: "id from the machine diff inventory" }),
            ),
            behavior: Type.Optional(Type.String()),
            fate: Type.Optional(Type.String({ description: "restored or moved" })),
            destination: Type.Optional(Type.String()),
          }),
          { description: "machine-visible fate for each removed test behavior" },
        ),
      ),
      coverage: Type.Optional(
        Type.Array(
          Type.Object({
            surfaceId: Type.Optional(
              Type.String({
                description:
                  "the id of a surface the PLAN marked covered; every such surface needs one entry here",
              }),
            ),
            contractIds: Type.Optional(
              Type.Array(Type.String(), {
                description:
                  "must exactly match the contract ids the plan recorded for that surface",
              }),
            ),
            evidence: Type.Optional(
              Type.Array(Type.String(), {
                description: "at least one verification result; an empty array is rejected",
              }),
            ),
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
        capture.verdict = parseVerdict(
          params,
          detail,
          expected,
          priorFindings,
          removedTestInventory,
        );
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
    // issue #489: the shape alone read as illustrative -- the fields a model
    // must not drop were only implied by the drawing. Name them, and name the
    // cost of dropping one, because the retry is paid out of the same round
    // budget: that is how a round which had already decided its verdict
    // reached the ceiling with nothing submitted.
    "Every field in that shape is required on the FIRST call -- `status`, `issues` and `summary`, plus `coverage` whenever it appears below. A submission that omits one is refused, and the corrected resubmission is paid from the same round budget.",
    applicable.length === 0
      ? '{ "status": "approved" | "changes_requested", "issues": [ { "severity": "blocker" | "major" | "minor", "what": "<one issue>", "location": "<file:line or scenario>", "closureCriterion": "<objective closure test>" } ], "summary": "<short summary>" }'
      : '{ "status": "approved" | "changes_requested", "issues": [ { "severity": "blocker" | "major" | "minor", "what": "<one issue>", "location": "<file:line or scenario>", "closureCriterion": "<objective closure test>" } ], "summary": "<short summary>", "coverage": [{"surfaceId":"<id>","contractIds":["<id>"],"evidence":["<verification>"]}] }',
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
    "Every blocker/major issue must be a reproducible defect with a bounded location and objective closureCriterion; stale review stamps, review artifacts, round bookkeeping, and freshness are process artifacts and belong in summary, never in issues.",
    "Every blocker/major finding requires a stable findingId on the first submission. For every carried finding, report closed (with evidence), remains, or new using its findingId; carried identities may not be silently dropped or relabeled.",
    "If tests are removed, submit removedTests entries with each machine-inventoried removedTestId: each behavior must be restored or have a concrete new coverage destination; an unlisted removal is refused.",
    'Issues name only defects that REMAIN; anything you verified and resolved belongs in the summary, and "approved" is exactly the verdict whose issues list is empty.',
  ].join("\n");
}
