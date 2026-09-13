import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const target = process.argv[2];
if (!target) throw new Error("usage: python-stable-labels <target-dir>");
const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(target, "src"))})
from labels import normalize_labels
source = [" Beta ", "alpha", "BETA", "", "  ", "Straße", "STRASSE"]
before = list(source)
result = normalize_labels(iter(source))
print(json.dumps({"result": result, "preserved": source == before}))
`;
const run = spawnSync("python3", ["-c", script], {
  encoding: "utf8",
  env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
});
const value = run.status === 0 ? JSON.parse(run.stdout) : { result: [], preserved: false };
const files = fs
  .readdirSync(target, { recursive: true })
  .map(String)
  .filter((x) => !x.startsWith(".git/"));
console.log(
  JSON.stringify(
    [
      {
        id: "stable-order",
        passed: JSON.stringify(value.result.slice(0, 2)) === JSON.stringify(["beta", "alpha"]),
      },
      { id: "iterable-support", passed: run.status === 0 },
      {
        id: "unicode-normalization",
        passed: value.result.filter((x: string) => x === "strasse").length === 1,
      },
      { id: "input-preserved", passed: value.preserved === true },
      { id: "has-tests", passed: files.some((x) => /test|spec/.test(x)) },
    ],
    null,
    2,
  ),
);
