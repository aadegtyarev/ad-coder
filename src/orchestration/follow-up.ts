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
// The `description` strings are what make the last sentence above true. They are
// advisory by construction, so they cannot bounce a submission pre-execute and
// the flattening decision (and its DeepSeek 400) is untouched -- but they are
// the only statement of the vocabulary that reaches a provider sampling against
// this schema, and the only one present on every turn. Without them the schema
// advertised a shape whose one mandatory word was unguessable: a security stage
// cycled through four invented kinds, was refused identically twelve times, and
// recorded nothing (2026-09-18, run 8998ec7c).
const followUpParameters = Type.Object(
  {
    kind: Type.String({
      description:
        'REQUIRED. Exactly one of: contract, note, design-doc-drift, backlog. "contract" also needs `contract`, "design-doc-drift" also needs `document`, "backlog" may carry `priority`; any other field for the chosen kind is rejected.',
    }),
    title: Type.String({ description: "one line naming the durable work" }),
    evidence: Type.Array(evidenceSchema, {
      description: "at least one entry; each needs a summary",
    }),
    contract: Type.Optional(
      Type.String({ description: 'the contract name; required when kind is "contract"' }),
    ),
    document: Type.Optional(
      Type.String({
        description: 'the drifted document; required when kind is "design-doc-drift"',
      }),
    ),
    priority: Type.Optional(
      Type.String({ description: 'only for kind "backlog": one of low, medium, high' }),
    ),
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
          // The CODE alone ("invalid_follow_up") names the disease, not the
          // symptom: a model holding it cannot tell which field it got wrong,
          // so its only move is to guess and call again. Observed on
          // 2026-09-16 -- four identical rejections in a row, no progress, the
          // stage exhausted, and the run surfaced as "research provider
          // response was unavailable or invalid" when the provider was fine.
          // The validator already writes a usable sentence ("evidence must be
          // non-empty"); it was being discarded one line before the model.
          // `ProjectOperationsError.message` is already `code: detail`, so the
          // code is in there once and only once.
          return { content: [{ type: "text", text: error.message }], details: undefined };
        }
        throw error;
      }
    },
  });
}

export function formatFollowUpInstruction(): string {
  return `When you discover durable work outside this turn, call ${SUBMIT_FOLLOW_UP_TOOL_NAME}. Do not include provenance; the harness records it.`;
}
