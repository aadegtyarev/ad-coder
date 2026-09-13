import * as fs from "node:fs";

interface Finding {
  code: string;
  blocking: boolean;
}

const file = process.argv[2];
if (!file) throw new Error("usage: reviewer-hidden-regression <findings.json>");
const raw = fs.readFileSync(file, "utf8");
const end = raw.lastIndexOf("]");
if (end < 0) throw new Error("reviewer artifact must contain a JSON array");
const findings = JSON.parse(raw.slice(0, end + 1)) as Finding[];
const blockingCodes = new Set(findings.filter((finding) => finding.blocking).map((f) => f.code));
const hasAny = (...codes: string[]) => codes.some((code) => blockingCodes.has(code));
const checks = [
  {
    id: "detects-path-escape",
    passed: hasAny("decoded-path-escape", "PATH_TRAVERSAL", "RESULT_PATH_TRAVERSAL"),
  },
  {
    id: "detects-silent-fallback",
    passed: hasAny("primary-result-discarded", "PARTIAL_SAVE", "METADATA_ORDER_AND_ERROR"),
  },
  { id: "avoids-false-positive", passed: !blockingCodes.has("raw-id-allows-slash") },
];
process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
