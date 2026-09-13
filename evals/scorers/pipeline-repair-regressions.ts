import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const target = process.argv[2];
if (!target) throw new Error("usage: pipeline-repair-regressions <target-dir>");
const modulePath = path.resolve(target, "src/result-store.ts");
const implementation = (await import(`${pathToFileURL(modulePath).href}?score=${Date.now()}`)) as {
  resultPath(baseDir: string, encodedId: string): string;
  saveResult(primary: () => void, metadata: () => void): unknown;
};

function rejects(value: string): boolean {
  try {
    implementation.resultPath("/tmp/calibration-base", value);
    return false;
  } catch {
    return true;
  }
}

const events: string[] = [];
try {
  implementation.saveResult(
    () => events.push("primary"),
    () => {
      events.push("metadata");
      throw new Error("seeded metadata failure");
    },
  );
} catch {
  // A loud failure is acceptable; the observable write ordering is the invariant.
}
const testFiles = fs
  .readdirSync(target, { recursive: true })
  .map(String)
  .filter((file) => !file.startsWith(".git/") && !file.startsWith(".ad-coder/"));
const checks = [
  { id: "rejects-encoded-traversal", passed: rejects("%2e%2e%2fescape") },
  { id: "rejects-malformed-encoding", passed: rejects("bad%") },
  { id: "prevents-partial-primary-write", passed: events[0] !== "primary" },
  { id: "has-regression-tests", passed: testFiles.some((file) => /test|spec/.test(String(file))) },
];
process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
