import type { ChildPipelineSpec, DurableRunRecord } from "./control-plane";
import type { PipelineResult } from "./types";

// Authority for the ceiling of 4: docs/contracts/operator-flow.md, the
// 2026-09-20 entry for issue #451.
export const MAX_DERIVED_CHILDREN = 4;

/**
 * Cut a settled, not-approved run into follow-on children from the reviewer's
 * own findings. Pure: reads only the settled record and result, writes nothing,
 * throws nothing. A run without an escalation signal, one whose signal is not
 * `required: true` (a cap-exhausted run names the limit without classifying
 * the work), or whose last `changes_requested` verdict carries no
 * `blocker`/`major` issue, derives no children -- the caller turns that into a
 * pause, never a throw.
 */
export function deriveChildSpecs(
  record: DurableRunRecord,
  result: PipelineResult,
): ChildPipelineSpec[] {
  if (result.escalation?.required !== true) return [];
  const blockingVerdict = [...record.verdicts]
    .reverse()
    .find((verdict) => verdict.status === "changes_requested");
  if (blockingVerdict === undefined) return [];
  return (
    blockingVerdict.issues
      .filter((issue) => issue.severity === "blocker" || issue.severity === "major")
      // Whitespace-only text cannot become a task, so it is nothing-derivable, not a throw.
      .filter((issue) => issue.what.trim() !== "")
      .slice(0, MAX_DERIVED_CHILDREN)
      // The scope spread comes first so a scope key named `task` cannot overwrite
      // the derived task: the issue's text is the child's task, always.
      .map((issue) => ({
        ...structuredClone(record.scope),
        task: issue.what.trim(),
      }))
  );
}
