import * as fs from "node:fs";

interface Finding {
  code: string;
  blocking: boolean;
}

const file = process.argv[2];
if (!file) throw new Error("usage: reviewer-hidden-regression <findings.json>");
const findings = JSON.parse(fs.readFileSync(file, "utf8")) as Finding[];
const blockingCodes = new Set(findings.filter((finding) => finding.blocking).map((f) => f.code));
const checks = [
  { id: "detects-path-escape", passed: blockingCodes.has("decoded-path-escape") },
  { id: "detects-silent-fallback", passed: blockingCodes.has("primary-result-discarded") },
  { id: "avoids-false-positive", passed: !blockingCodes.has("raw-id-allows-slash") },
];
process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
