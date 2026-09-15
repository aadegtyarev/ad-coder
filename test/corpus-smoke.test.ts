import { expect, test } from "bun:test";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const RUNNER = path.join(REPO_ROOT, "evals", "runner", "corpus.ts");

function corpus(action: string): { code: number | null; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["bun", "run", RUNNER, action], { cwd: REPO_ROOT });
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

test("the corpus validates and every scorer still discriminates", () => {
  // The corpus runner is not one of the CI gates -- it is invoked by hand during
  // a calibration run, which is hours of live models later. Running its own
  // smoke from `bun test` is what moves "this scorer stopped telling pass from
  // fail" from a wasted calibration run to a red pipeline.
  const validate = corpus("validate");
  expect(validate.stderr).toBe("");
  expect(validate.code).toBe(0);
  expect(JSON.parse(validate.stdout).valid).toBe(true);

  const smoke = corpus("smoke");
  expect(smoke.stderr).toBe("");
  expect(smoke.code).toBe(0);
  const result = JSON.parse(smoke.stdout) as {
    count: number;
    scored: number;
    sampled: number;
    unscored: number;
    valid: boolean;
  };
  expect(result.valid).toBe(true);
  // Every task with a scorer is exercised one way or the other: against a
  // materialized fixture when it scores a target, against its checked-in pass
  // and fail samples when it scores an artifact or a report. Accounting for all
  // three buckets is the assertion -- a task that silently stops being covered
  // has to show up as `unscored`, where it is visible, rather than vanish.
  expect(result.scored + result.sampled + result.unscored).toBe(result.count);
  expect(result.unscored).toBe(0);
});
