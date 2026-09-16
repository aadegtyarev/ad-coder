import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Flags a corpus task that has stopped telling models apart.
 *
 * Both of this project's task defects were caught by a person reading a sweep
 * printout: `planner-contract-carry-v1` failing every model identically, and
 * three trivial coder tasks scoring 1.00 for the cheapest model available. Both
 * are visible in the numbers, so neither should need a person to notice.
 *
 * Two signatures, and they mean opposite things:
 *
 * SATURATED -- every model of every price scores near the top. The task is not
 * measuring the difference the routing decision needs; the cheapest model clears
 * it, so quoting it in favour of any model is quoting nothing.
 *
 * INVERTED -- quality falls as price rises. That is not a hard task, it is a
 * broken one: an expensive model has no reason to do worse unless the checks are
 * scoring something other than capability. This is exactly what
 * `planner-contract-carry-v1` looked like before its prompt was fixed.
 *
 * Reports rather than fails. The evidence is observational -- a sweep may cover
 * two models one week and six the next -- so this is a standing question put to
 * whoever reads it, not a gate that blocks a merge on sample size.
 */
interface Row {
  taskId: string;
  provider: string;
  models: string;
  accepted: boolean;
  reportedCostUsd?: number | null;
}

const root = path.resolve(import.meta.dir, "..");
const evidence = path.join(root, "docs", "calibration-evidence.jsonl");
const rows: Row[] = fs.existsSync(evidence)
  ? fs
      .readFileSync(evidence, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Row)
  : [];

/** A task needs samples from this many distinct models before it can be judged. */
const MINIMUM_MODELS = 3;

const byTask = new Map<string, Row[]>();
for (const row of rows) {
  const list = byTask.get(row.taskId) ?? [];
  list.push(row);
  byTask.set(row.taskId, list);
}

const findings: { taskId: string; signature: string; detail: string }[] = [];
for (const [taskId, samples] of byTask) {
  const models = new Set(samples.map((sample) => `${sample.provider}/${sample.models}`));
  if (models.size < MINIMUM_MODELS) continue;
  const accepted = samples.filter((sample) => sample.accepted).length;
  if (accepted === samples.length)
    findings.push({
      taskId,
      signature: "saturated",
      detail: `every one of ${samples.length} samples across ${models.size} models was accepted`,
    });
  const priced = samples.filter(
    (sample) => typeof sample.reportedCostUsd === "number" && sample.reportedCostUsd > 0,
  );
  if (priced.length >= MINIMUM_MODELS) {
    const dearest = [...priced].sort(
      (left, right) => (right.reportedCostUsd ?? 0) - (left.reportedCostUsd ?? 0),
    );
    const half = Math.floor(dearest.length / 2);
    const expensive = dearest.slice(0, half);
    const cheap = dearest.slice(dearest.length - half);
    const rate = (group: Row[]) => group.filter((s) => s.accepted).length / group.length;
    if (rate(expensive) < rate(cheap))
      findings.push({
        taskId,
        signature: "inverted",
        detail: `the dearer half was accepted ${(rate(expensive) * 100).toFixed(0)}% against the cheaper half's ${(rate(cheap) * 100).toFixed(0)}%`,
      });
  }
}

console.log(
  JSON.stringify(
    { version: 1, tasks: byTask.size, samples: rows.length, findings, valid: true },
    null,
    2,
  ),
);
