#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CalibrationTask } from "../../src/evaluation/calibration";

type Task = CalibrationTask & {
  fixture?: string;
  scorer?: string;
  scorerInput?: "target" | "artifact" | "report";
};
const root = path.resolve(import.meta.dir, "..");
const corpus = JSON.parse(fs.readFileSync(path.join(root, "corpus.json"), "utf8")) as {
  version: number;
  tasks: string[];
};
if (
  corpus.version !== 1 ||
  !Array.isArray(corpus.tasks) ||
  new Set(corpus.tasks).size !== corpus.tasks.length
)
  throw new Error("invalid corpus manifest");
const tasks = corpus.tasks.map((rel) => {
  const file = path.resolve(root, rel);
  if (!file.startsWith(`${root}${path.sep}`)) throw new Error("task escapes corpus");
  return { file, task: JSON.parse(fs.readFileSync(file, "utf8")) as Task };
});
for (const { task } of tasks) {
  if (!task.id || !task.prompt || !task.checks?.length)
    throw new Error(`invalid task: ${task.id ?? "unknown"}`);
  if (task.fixture && !fs.statSync(path.join(root, "fixtures", task.fixture)).isDirectory())
    throw new Error(`missing fixture: ${task.id}`);
  if (
    task.scorerInput !== undefined &&
    !["target", "artifact", "report"].includes(task.scorerInput)
  )
    throw new Error(`invalid scorer input: ${task.id}`);
  if (task.scorer && !fs.statSync(path.join(root, "scorers", task.scorer)).isFile())
    throw new Error(`missing scorer: ${task.id}`);
}
const action = process.argv[2] ?? "list";
if (action === "list")
  console.log(
    JSON.stringify(
      tasks.map(({ task }) => ({
        id: task.id,
        role: task.role,
        complexity: task.complexity,
        mode: task.mode,
        fixture: task.fixture ?? null,
      })),
      null,
      2,
    ),
  );
else if (action === "validate")
  console.log(JSON.stringify({ version: 1, count: tasks.length, valid: true }));
else if (action === "smoke") {
  let scored = 0;
  for (const { task } of tasks) {
    if (!task.fixture || !task.scorer || task.scorerInput !== "target") continue;
    const target = fs.mkdtempSync(path.join(os.tmpdir(), `ad-coder-${task.id}-`));
    fs.rmSync(target, { recursive: true });
    const materialize = spawnSync(
      "bun",
      [
        path.resolve(root, "../scripts/calibration-materialize.ts"),
        path.join(root, "fixtures", task.fixture),
        target,
      ],
      { encoding: "utf8" },
    );
    if (materialize.status !== 0) throw new Error(materialize.stderr);
    const score = spawnSync("bun", [path.join(root, "scorers", task.scorer), target], {
      encoding: "utf8",
    });
    fs.rmSync(target, { recursive: true, force: true });
    if (score.status !== 0) throw new Error(score.stderr);
    const checks = JSON.parse(score.stdout) as { id: string; passed: boolean }[];
    if (
      checks.length !== task.checks.length ||
      checks.some((c) => !task.checks.some((e) => e.id === c.id))
    )
      throw new Error(`scorer mismatch: ${task.id}`);
    scored++;
  }
  console.log(JSON.stringify({ version: 1, count: tasks.length, scored, valid: true }));
} else throw new Error("usage: corpus.ts [list|validate|smoke]");
