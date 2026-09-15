import { Type } from "@earendil-works/pi-ai";
import { ProjectOperationsError } from "../project-operations/errors";
import { validateFollowUpCandidate } from "../project-operations/follow-ups";
import type { FollowUp, FollowUpCandidate, FollowUpProvenance } from "../project-operations/types";
import type { Tool } from "../runner/tool";
import { defineTool } from "../runner/tool";

export const SUBMIT_FOLLOW_UP_TOOL_NAME = "submit_follow_up";

export interface FollowUpCapture {
  followUps: FollowUp[];
  error?: ProjectOperationsError;
}

const evidenceSchema = Type.Object(
  {
    summary: Type.String(),
    path: Type.Optional(Type.String()),
    line: Type.Optional(Type.Number()),
    sha256: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

// ONE object, not a `Type.Union` of four. A union serialises to a top-level
// `anyOf`, and providers that validate tool schemas require the function's
// parameters to BE an object: DeepSeek answers 400 "schema must be a JSON
// Schema of 'type: \"object\"', got 'type: null'" and rejects the whole
// request, so every turn carrying this tool -- which is every workflow turn --
// dies before the model runs.
//
// Flattening costs nothing in strictness. `kind` stays a plain string and the
// per-kind fields become optional, exactly as `submit_plan` leaves its enum
// leaves loose; `validateFollowUpCandidate` still rejects an unknown kind, and
// its `exact()` check still refuses a field that does not belong to the kind
// that was declared (a `note` carrying `document`, say). The schema advertises
// the shape; the validator decides.
const followUpParameters = Type.Object(
  {
    kind: Type.String(),
    title: Type.String(),
    evidence: Type.Array(evidenceSchema),
    /** Only for kind "contract". */
    contract: Type.Optional(Type.String()),
    /** Required for kind "design-doc-drift". */
    document: Type.Optional(Type.String()),
    /** Only for kind "backlog": "low" | "medium" | "high". */
    priority: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export function buildSubmitFollowUpTool(
  capture: FollowUpCapture,
  provenance: FollowUpProvenance,
): Tool {
  return defineTool({
    name: SUBMIT_FOLLOW_UP_TOOL_NAME,
    description: "Record durable follow-up work discovered during this turn.",
    label: "submit follow-up",
    parameters: followUpParameters,
    prepareArguments(params) {
      return validateFollowUpCandidate(params);
    },
    async execute(_toolCallId, params) {
      try {
        const candidate = validateFollowUpCandidate(params) as FollowUpCandidate;
        capture.followUps.push({ ...candidate, provenance: [{ ...provenance }] } as FollowUp);
        delete capture.error;
        return { content: [{ type: "text", text: "follow-up recorded" }], details: undefined };
      } catch (error) {
        if (error instanceof ProjectOperationsError) {
          capture.error = error;
          return { content: [{ type: "text", text: error.code }], details: undefined };
        }
        throw error;
      }
    },
  });
}

export function formatFollowUpInstruction(): string {
  return `When you discover durable work outside this turn, call ${SUBMIT_FOLLOW_UP_TOOL_NAME}. Do not include provenance; the harness records it.`;
}
