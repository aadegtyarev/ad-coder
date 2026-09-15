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
/**
 * Whether both entry points now read their value through one shared parser.
 *
 * Asks three things of the source, all of which the duplicated original fails
 * and a genuine extraction passes: exactly one `parse`-ish function exists (two
 * is the duplication renamed), every `load`-ish entry point calls it, and no
 * entry point still trims the value inline (which is the duplicated body left
 * in place beside a decorative call).
 */
function sharesOneParser(source: string): boolean {
  const parsers = [...source.matchAll(/function\s+(parse[A-Za-z0-9_]*)\s*\(/g)].map(
    (match) => match[1] as string,
  );
  if (parsers.length !== 1) return false;
  const parser = parsers[0] as string;
  const entries = [
    ...source.matchAll(/function\s+load[A-Za-z0-9_]*\s*\([^)]*\)[^{]*\{([\s\S]*?)\n\}/g),
  ].map((match) => match[1] as string);
  if (entries.length < 2) return false;
  const callsParser = new RegExp(`\\b${parser}\\s*\\(`);
  return entries.every((body) => callsParser.test(body) && !body.includes(".trim()"));
}

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
        // SHARING, NOT SHAPE. This counted a `parse*` declaration plus two
        // `return parse*(` call sites, which a model satisfies while leaving the
        // duplication exactly where it was: declare a third function, call it
        // from one place, keep both original bodies. The task's whole point is
        // that ONE parser now serves both entry points, so the check asks for
        // that: exactly one parser is declared, both entry points call it, and
        // neither still trims the value itself.
        id: "extracts-shared-parser",
        passed: sharesOneParser(text),
      },
      { id: "has-regression-tests", passed: files.some((f) => /test|spec/.test(f)) },
    ],
    null,
    2,
  ),
);
