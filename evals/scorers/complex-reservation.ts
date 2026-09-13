import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const target = process.argv[2];
if (!target) throw new Error("usage: complex-reservation <target-dir>");
const { Pool } = (await import(
  `${pathToFileURL(path.join(target, "src/pool.ts")).href}?score=${Date.now()}`
)) as { Pool: new (n: number) => { reserve(n: number): Promise<boolean>; remaining(): number } };
const pool = new Pool(1);
const results = await Promise.all([pool.reserve(1), pool.reserve(1)]);
const p2 = new Pool(2);
const failed = await p2.reserve(3);
let invalid = false;
try {
  await p2.reserve(0);
} catch {
  invalid = true;
}
const after = await p2.reserve(1);
const files = fs
  .readdirSync(target, { recursive: true })
  .map(String)
  .filter((f) => !f.startsWith(".git/"));
console.log(
  JSON.stringify(
    [
      {
        id: "prevents-overbooking",
        passed: results.filter(Boolean).length === 1 && pool.remaining() === 0,
      },
      { id: "preserves-failed-capacity", passed: failed === false && p2.remaining() === 1 },
      { id: "rejects-invalid", passed: invalid },
      { id: "recovers-after-failure", passed: after === true },
      { id: "has-concurrency-tests", passed: files.some((f) => /test|spec/.test(f)) },
    ],
    null,
    2,
  ),
);
