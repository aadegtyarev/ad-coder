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

const followUpParameters = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("contract"),
      title: Type.String(),
      evidence: Type.Array(evidenceSchema),
      contract: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("note"),
      title: Type.String(),
      evidence: Type.Array(evidenceSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("design-doc-drift"),
      title: Type.String(),
      evidence: Type.Array(evidenceSchema),
      document: Type.String(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("backlog"),
      title: Type.String(),
      evidence: Type.Array(evidenceSchema),
      priority: Type.Optional(
        Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
      ),
    },
    { additionalProperties: false },
  ),
]);

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
