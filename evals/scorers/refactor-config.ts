import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const target = process.argv[2];
if (!target) throw new Error("usage: refactor-config <target-dir>");
const file = path.join(target, "src/config.ts");
const text = fs.readFileSync(file, "utf8");
const mod = (await import(`${pathToFileURL(file).href}?score=${Date.now()}`)) as Record<
  string,
  (e: Record<string, string | undefined>) => string
>;
const cases = [
  [{}, "127.0.0.1"],
  [{ APP_HOST: "  " }, "127.0.0.1"],
  [{ APP_HOST: " host " }, "host"],
] as const;
const ok = (name: string) => cases.every(([e, w]) => mod[name]?.(e) === w);
const files = fs
  .readdirSync(target, { recursive: true })
  .map(String)
  .filter((f) => !f.startsWith(".git/"));
console.log(
  JSON.stringify(
    [
      { id: "preserves-host-api", passed: ok("loadHost") },
      { id: "preserves-worker-api", passed: ok("loadWorkerHost") },
      {
        id: "extracts-shared-parser",
        passed: /export\s+function\s+parse|export\s+const\s+parse/.test(text),
      },
      { id: "has-regression-tests", passed: files.some((f) => /test|spec/.test(f)) },
    ],
    null,
    2,
  ),
);
