import { SUBMIT_FOLLOW_UP_TOOL_NAME } from "./follow-up";
import { SUBMIT_PLAN_TOOL_NAME } from "./plan";
import { SUBMIT_VERDICT_TOOL_NAME } from "./verdict";

/**
 * The workflow's structured-submission tools: names a pipeline stage calls to
 * hand its structured output back (plan, verdict, follow-ups). They exist only
 * where the pipeline registers their objects -- never in an independent role
 * invocation, whose delivery channel is plain assistant text.
 */
export const SUBMISSION_TOOL_NAMES: readonly string[] = [
  SUBMIT_PLAN_TOOL_NAME,
  SUBMIT_VERDICT_TOOL_NAME,
  SUBMIT_FOLLOW_UP_TOOL_NAME,
];

/** True for a workflow submission tool that nothing outside a pipeline registered. */
export function isSubmissionToolName(name: string): boolean {
  return (SUBMISSION_TOOL_NAMES as readonly string[]).includes(name);
}
