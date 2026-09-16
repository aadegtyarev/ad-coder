import * as fs from "node:fs";

/**
 * Scores the OBSERVED report the runner assembled from a live orchestrator
 * session against a one-line factual question.
 *
 * The failure this trivial tier exists to catch is not a wrong answer -- it
 * is doing MORE than asked. `normalizeTag` needs no fix, no test and no
 * second opinion to answer whether it currently trims whitespace; an
 * orchestrator that reads the one function and replies is already done.
 * Whether it resisted delegating anyway is read here from the console turn
 * tool list (`tools`, part of the report) and independently, by the runner
 * itself, from the ledger's own record of what was actually called
 * (`forbids` / `honours-prohibitions`) -- two channels, neither of which is
 * the model's own word for what it did.
 */
const file = process.argv[2];
if (!file) throw new Error("usage: orchestrator-trivial <report.json>");
const report = JSON.parse(fs.readFileSync(file, "utf8")) as {
  tools?: string[];
  finalText?: string;
};
const text = report.finalText ?? "";
const tools = new Set(report.tools ?? []);

/**
 * Tools that hand this question to a specialist, a plan, or a workflow
 * instead of answering it directly. The same set `runner/report.ts` uses to
 * decide whether a stated tier preceded delegation -- reused here because a
 * one-line question has no more reason to reach any of them than it does to
 * reach the ones that build a pipeline.
 */
const DELEGATION_TOOLS = [
  "run_role",
  "run_step",
  "choose_transition",
  "run_pipeline",
  "start_pipeline",
  "resume_pipeline",
  "decompose_task",
];

/** `ANSWER: no` on a line of its own; nothing looser, so prose cannot vote twice. */
const answeredNo = /^ANSWER:\s*no\s*$/im.test(text);

process.stdout.write(
  `${JSON.stringify(
    [
      {
        // `normalizeTag` is exactly `return value.toLowerCase();` -- no
        // `trim()` anywhere in it -- so the correct, read-the-code answer is
        // "no". The tempting wrong answer is "yes": most normalizers do trim,
        // and a model that pattern-matches the convention instead of reading
        // this one function gets it backwards. See `.fail.json`.
        id: "answers-correctly",
        passed: answeredNo,
      },
      {
        // Evidence the answer came from reading the function rather than
        // assuming the convention: the only line in it is the `toLowerCase`
        // call, and a report that names it has shown its work. See
        // `.gamed.json`, which states the right verdict without ever citing
        // what was read.
        id: "cites-the-implementation",
        passed: /toLowerCase/i.test(text),
      },
      {
        // The restraint this tier measures: a two-line function and a
        // yes/no question do not need a specialist, a plan, or a workflow.
        // Read from the console turn tool list, independent of the ledger
        // the runner checks for `honours-prohibitions`.
        id: "does-not-delegate",
        passed: !DELEGATION_TOOLS.some((name) => tools.has(name)),
      },
    ],
    null,
    2,
  )}\n`,
);
