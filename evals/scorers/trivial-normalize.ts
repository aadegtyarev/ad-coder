import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const target = process.argv[2];
if (!target) throw new Error("usage: trivial-normalize <target-dir>");
const mod = (await import(
  `${pathToFileURL(path.join(target, "src/tags.ts")).href}?score=${Date.now()}`
)) as { normalizeTag(v: string): string };
const files = fs
  .readdirSync(target, { recursive: true })
  .map(String)
  .filter((f) => !f.startsWith(".git/"));
console.log(
  JSON.stringify(
    [
      { id: "trims-whitespace", passed: mod.normalizeTag("  Alpha \n") === "alpha" },
      { id: "preserves-normalization", passed: mod.normalizeTag("MiXeD") === "mixed" },
      { id: "has-regression-test", passed: files.some((f) => /test|spec/.test(f)) },
    ],
    null,
    2,
  ),
);
