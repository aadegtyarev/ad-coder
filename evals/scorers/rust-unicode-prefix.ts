import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const target = process.argv[2];
if (!target) throw new Error("usage: rust-unicode-prefix <target-dir>");
const tests = path.join(target, "tests");
fs.mkdirSync(tests, { recursive: true });
const probe = path.join(tests, "__calibration_hidden.rs");
fs.writeFileSync(
  probe,
  `use rust_unicode_prefix::prefix;
#[test] fn ascii(){assert_eq!(prefix("abcdef",3),"abc");}
#[test] fn unicode(){assert_eq!(prefix("Привет",2),"Пр");assert_eq!(prefix("🙂a",1),"🙂");}
#[test] fn boundaries(){assert_eq!(prefix("abc",0),"");assert_eq!(prefix("abc",20),"abc");}
`,
);
const run = spawnSync("cargo", ["test", "--quiet", "--test", "__calibration_hidden"], {
  cwd: target,
  encoding: "utf8",
});
fs.rmSync(probe, { force: true });
const ownTests = fs
  .readdirSync(target, { recursive: true })
  .map(String)
  .filter((x) => !x.startsWith(".git/") && x !== "tests/__calibration_hidden.rs");
const output = `${run.stdout}\n${run.stderr}`;
console.log(
  JSON.stringify(
    [
      { id: "ascii", passed: run.status === 0 && /3 passed/.test(output) },
      { id: "unicode", passed: run.status === 0 },
      { id: "boundaries", passed: run.status === 0 },
      { id: "has-tests", passed: ownTests.some((x) => /test/.test(x)) },
    ],
    null,
    2,
  ),
);
