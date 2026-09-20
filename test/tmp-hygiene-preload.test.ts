// End-to-end proof for issue #419's preload hygiene, demanded by the review:
// spawn a REAL `bun test` in a private sandbox whose cwd and `TMPDIR` are the
// sandbox, and observe the real `test/preload.ts` — (1) while the child run is
// live, per-test scratch lands inside an `ad-coder-test-` run root, (2) once
// the child exits, no such root survives in the sandbox, (3) the child's own
// test sees `os.tmpdir()` inside that root (the redirect really happened, not
// just a directory named like one), and (4) a child run that DOES leave a
// run-root-shaped directory in its system tmpdir exits NON-ZERO with the
// preload's own leak message (the gate, proven red as well as green), and (5) a
// foreign root whose owner is PROVEN alive is released instead: the same child
// run stays red on a dead-owned and a marker-less foreign root while the live
// one is named on stderr and left on disk.
//
// Deterministic by construction: nothing waits for the four-hour rule, nothing
// sleeps, and the child is a single short run. The only global-state coupling
// is the child's `TMPDIR` (and case (4)'s leak, which stays inside the
// sandbox's own tmpdir), set on the child's env — the outer run's `TMPDIR` is
// never touched.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RUN_ROOT_PREFIX } from "./tmp-hygiene";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
// Absolute, so the child resolves the repository preload while its cwd — and
// therefore its own `bunfig.toml` and test discovery — is the sandbox. The
// sandbox lives outside the repository, so the repository's root bunfig is
// unreachable from it (neither bunfig lookup nor discovery walks upward).
const PRELOAD_PATH = path.join(REPO_ROOT, "test", "preload.ts");
const SANDBOX_PREFIX = "tmp-hygiene-e2e-";
const INNER_TEST_NAME = "hygiene-probe.test.ts";
const CHILD_TIMEOUT_MS = 60_000;
// The child's system tmpdir, handed to it in its OWN variable: the preload
// overwrites `TMPDIR`, so a test that wants to write where the preload's
// snapshot lives cannot reach it through `os.tmpdir()`.
const LEAK_TMPDIR_VAR = "TMP_HYGIENE_CHILD_SYSTEM_TMPDIR";
// Prefix of the directory the mirror image of the failure creates, so the
// assertion does not depend on the message wording alone.
const LEAK_PREFIX = `${RUN_ROOT_PREFIX}LEAK-`;
// Prefixes of the three foreign roots case (5) leaves behind: one whose owner
// is proven alive, one whose owner is proven dead, one with no marker at all.
const LIVE_PREFIX = `${RUN_ROOT_PREFIX}LIVE-`;
const DEAD_PREFIX = `${RUN_ROOT_PREFIX}DEAD-`;
const UNMARKED_PREFIX = `${RUN_ROOT_PREFIX}UNMARKED-`;
// A pid far above the kernel's pid_max range, so `/proc/<pid>/stat` cannot
// exist: a dead owner proven without spawning or killing anyone.
const UNRUNNABLE_PID = 4194304;
// The preload's own line for a released name; asserted verbatim so the
// exemption cannot be mistaken for the name simply not being seen.
const HOLD_LINE = "[test-preload] tmpdir hold:";
// The preload's own line for this gate; asserted verbatim so a run that fails
// for some other reason cannot be mistaken for the leak being reported.
const LEAK_LINE = "[test-preload] tmpdir hygiene: leaked";

const sandboxes: string[] = [];

afterAll(() => {
  for (const dir of sandboxes) fs.rmSync(dir, { recursive: true, force: true });
});

function runRootsIn(dir: string): string[] {
  return fs.readdirSync(dir).filter((name) => name.startsWith(RUN_ROOT_PREFIX));
}

/** A private sandbox, wired to the repository preload and registered for cleanup. */
function makeSandbox(): string {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), SANDBOX_PREFIX));
  sandboxes.push(sandbox);
  fs.writeFileSync(
    path.join(sandbox, "bunfig.toml"),
    `[test]\npreload = [${JSON.stringify(PRELOAD_PATH)}]\n`,
  );
  return sandbox;
}

/** One real `bun test` in `sandbox`, cwd and `TMPDIR` inside it. */
function runChild(sandbox: string, extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, ["test"], {
    cwd: sandbox,
    env: { ...process.env, TMPDIR: sandbox, ...extraEnv },
    encoding: "utf8",
    timeout: CHILD_TIMEOUT_MS,
  });
}

test("the real preload redirects per-test scratch into a run root and removes it when the child run exits", () => {
  const sandbox = makeSandbox();
  const probePath = path.join(sandbox, "probe.json");

  // The child test asserts and records the same three properties, so a
  // preload that never ran cannot pass by making the outer checks vacuous.
  fs.writeFileSync(
    path.join(sandbox, INNER_TEST_NAME),
    `import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const sandbox = ${JSON.stringify(sandbox)};
const probePath = ${JSON.stringify(probePath)};

test("per-test scratch lands inside the preload's run root", () => {
  const root = os.tmpdir();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-probe-"));
  fs.writeFileSync(path.join(scratch, "payload.txt"), "payload");
  const roots = fs.readdirSync(sandbox).filter((name) => name.startsWith(${JSON.stringify(RUN_ROOT_PREFIX)}));
  fs.writeFileSync(
    probePath,
    JSON.stringify({
      tmpdir: root,
      rootName: path.basename(root),
      rootInsideSandbox: root.startsWith(sandbox + path.sep),
      rootExistedDuringRun: fs.existsSync(root),
      rootsDuringRun: roots,
      scratchInsideRoot: scratch.startsWith(root + path.sep),
      scratchExistedDuringRun: fs.existsSync(path.join(scratch, "payload.txt")),
    }),
  );
  expect(root.startsWith(sandbox + path.sep)).toBe(true);
  expect(path.basename(root).startsWith(${JSON.stringify(RUN_ROOT_PREFIX)})).toBe(true);
  expect(roots).toEqual([path.basename(root)]);
  expect(scratch.startsWith(root + path.sep)).toBe(true);
});
`,
  );

  const child = runChild(sandbox);
  const output = `${child.stdout ?? ""}${child.stderr ?? ""}`;
  if (child.status !== 0) {
    // The child's own output verbatim: an assertion inside it is the only way
    // to tell "the preload never ran" from "the preload ran and broke".
    throw new Error(
      `inner bun test exited with status ${child.status} (signal ${child.signal}):\n${output}`,
    );
  }

  // (1) + (3) During the run: the child saw `os.tmpdir()` inside a run root it
  // had just created under the sandbox, the root existed, and per-test scratch
  // was created inside it.
  const probe = JSON.parse(fs.readFileSync(probePath, "utf8")) as {
    tmpdir: string;
    rootName: string;
    rootInsideSandbox: boolean;
    rootExistedDuringRun: boolean;
    rootsDuringRun: string[];
    scratchInsideRoot: boolean;
    scratchExistedDuringRun: boolean;
  };
  expect(probe.rootInsideSandbox).toBe(true);
  expect(probe.rootName.startsWith(RUN_ROOT_PREFIX)).toBe(true);
  expect(probe.rootExistedDuringRun).toBe(true);
  expect(probe.rootsDuringRun).toEqual([probe.rootName]);
  expect(probe.scratchInsideRoot).toBe(true);
  expect(probe.scratchExistedDuringRun).toBe(true);

  // (2) After the child exited: its teardown deleted the root — the probed path
  // is gone and the sandbox holds no `ad-coder-test-` entry at all. This is the
  // check that would have caught the leak the review blocked on.
  expect(fs.existsSync(probe.tmpdir)).toBe(false);
  expect(runRootsIn(sandbox)).toEqual([]);
});

test("a run root left behind by the run makes the child run fail, with the leak named", () => {
  // The mirror image of the test above, and the half the review demanded: the
  // gate added to `test/preload.ts` is only proven if a run that DOES leave an
  // `ad-coder-test-` directory in the system tmpdir comes out RED with the
  // preload's own message. The child reproduces the measured shape of the leak
  // (a run-root-shaped directory appearing in the system tmpdir after the
  // preload's snapshot, never removed — `test/cli.test.ts`'s late worker
  // re-created exactly this way) without depending on the worker's timing: the
  // inner test makes it directly.
  const sandbox = makeSandbox();
  const probePath = path.join(sandbox, "leak-probe.json");
  fs.writeFileSync(
    path.join(sandbox, INNER_TEST_NAME),
    `import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const sandbox = ${JSON.stringify(sandbox)};
const probePath = ${JSON.stringify(probePath)};

test("leaves a run-root-shaped directory in the system tmpdir", () => {
  // The preload has already pointed \`TMPDIR\` at its own run root, so the system tmpdir is reached through the env var the outer test supplied, not through \`os.tmpdir()\`.
  const systemTmp = process.env[${JSON.stringify(LEAK_TMPDIR_VAR)}];
  expect(systemTmp).toBe(sandbox);
  const leaked = fs.mkdtempSync(path.join(systemTmp, ${JSON.stringify(LEAK_PREFIX)}));
  fs.writeFileSync(
    probePath,
    JSON.stringify({ runRoot: os.tmpdir(), leaked, leakedName: path.basename(leaked) }),
  );
  // Deliberately NOT removed: this is the leak the gate is supposed to report.
  expect(fs.existsSync(leaked)).toBe(true);
});
`,
  );

  const child = runChild(sandbox, { [LEAK_TMPDIR_VAR]: sandbox });
  const output = `${child.stdout ?? ""}${child.stderr ?? ""}`;
  const probe = JSON.parse(fs.readFileSync(probePath, "utf8")) as {
    runRoot: string;
    leaked: string;
    leakedName: string;
  };

  // The child's own test ran and passed — the failure below is the preload's
  // gate and nothing else, which the message assertion pins down. (The probe
  // file is the second witness: the inner test only writes it after its own
  // `expect(systemTmp).toBe(sandbox)` and its `mkdtempSync` both succeeded.)
  expect(output).toContain("1 pass");
  expect(child.status).not.toBe(0);
  // The gate's own line, with the numbers: exactly ONE new run-root-shaped
  // entry, named, and the run's own root reported as removed rather than leaked
  // (so the entry counted is the child's, not the run root renamed).
  expect(output).toContain(LEAK_LINE);
  expect(output).toContain(
    `leaked 1 new ${RUN_ROOT_PREFIX}* entry in ${sandbox} (${probe.leakedName})`,
  );
  expect(output).toContain(
    `own run root ${path.basename(probe.runRoot)} was removed by the 5 teardown attempts`,
  );
  // Nothing was cleaned up behind the warning: the leak is still there, which
  // is what makes it a FAILURE rather than a note, and exactly one run-root
  // entry exists in the sandbox (the leaked one — the child's own root is gone).
  expect(fs.existsSync(probe.leaked)).toBe(true);
  expect(runRootsIn(sandbox)).toEqual([probe.leakedName]);
});

test.skipIf(process.platform !== "linux")(
  "a foreign root whose owner is PROVEN alive is released with a named hold line, while a dead-owned and a marker-less one still fail the run",
  () => {
    // The other half of the gate's verdict, and the one a concurrent `bun test`
    // in another worktree exercises on any busy machine: a new
    // `ad-coder-test-*` name that belongs to a LIVE run must not turn this run
    // red. The child leaves THREE foreign roots in its system tmpdir -- one
    // whose marker names this (live) process, one whose marker names a pid
    // above the kernel's pid_max range, and one with no marker at all -- so a
    // single run pins both directions: released on a proof of life, red on
    // every other verdict, and nothing deleted behind either.
    const sandbox = makeSandbox();
    const probePath = path.join(sandbox, "hold-probe.json");
    // This process is the live owner: pid + its real starttime (field 22 of
    // `/proc/self/stat`; after the possibly spacey comm field the tail starts
    // at field 3, so field 22 is index 19 of the tail) is exactly what the
    // preload writes into a run root's `run-pid`.
    const stat = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8");
    const tail = stat.slice(stat.lastIndexOf(")") + 2);
    const starttime = tail.split(" ")[19]?.trim() ?? "";
    // Without it the marker below would be garbage and the case would prove
    // nothing, so the parse is asserted rather than assumed.
    expect(starttime).not.toBe("");
    // The child's system tmpdir, in the same variable the leak case uses: the
    // preload overwrites `TMPDIR`, so a test writing where the preload's
    // snapshot lives cannot reach it through `os.tmpdir()`.
    fs.writeFileSync(
      path.join(sandbox, INNER_TEST_NAME),
      `import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const sandbox = ${JSON.stringify(sandbox)};
const probePath = ${JSON.stringify(probePath)};

test("leaves a live-owned, a dead-owned and a marker-less run-root-shaped directory", () => {
  const systemTmp = process.env[${JSON.stringify(LEAK_TMPDIR_VAR)}];
  expect(systemTmp).toBe(sandbox);
  const live = fs.mkdtempSync(path.join(systemTmp, ${JSON.stringify(LIVE_PREFIX)}));
  fs.writeFileSync(path.join(live, "run-pid"), ${JSON.stringify(`${process.pid} ${starttime}`)});
  const dead = fs.mkdtempSync(path.join(systemTmp, ${JSON.stringify(DEAD_PREFIX)}));
  fs.writeFileSync(path.join(dead, "run-pid"), ${JSON.stringify(`${UNRUNNABLE_PID} 0`)});
  const unmarked = fs.mkdtempSync(path.join(systemTmp, ${JSON.stringify(UNMARKED_PREFIX)}));
  fs.writeFileSync(
    probePath,
    JSON.stringify({
      runRoot: os.tmpdir(),
      live,
      dead,
      unmarked,
      liveName: path.basename(live),
      deadName: path.basename(dead),
      unmarkedName: path.basename(unmarked),
    }),
  );
  // Deliberately NOT removed: all three are the foreign names the gate has to
  // rule on, one of which it must release.
  expect(fs.existsSync(unmarked)).toBe(true);
});
`,
    );

    const child = runChild(sandbox, { [LEAK_TMPDIR_VAR]: sandbox });
    const output = `${child.stdout ?? ""}${child.stderr ?? ""}`;
    const probe = JSON.parse(fs.readFileSync(probePath, "utf8")) as {
      runRoot: string;
      live: string;
      dead: string;
      unmarked: string;
      liveName: string;
      deadName: string;
      unmarkedName: string;
    };

    // The child's own test ran and passed, so what follows is the preload's
    // verdict and nothing else.
    expect(output).toContain("1 pass");
    // (a) The live-owned name is RELEASED: named on stderr, left out of the
    // leak list, and still on disk -- releasing is a verdict about someone
    // else's property, not a licence to delete it.
    expect(output).toContain(
      `${HOLD_LINE} ${probe.liveName} belongs to a live concurrent run, not to this one`,
    );
    // (b) The gate is not weakened by that exemption: the dead-owned and the
    // marker-less names are BOTH leaks, which is why this run is red. Parsed
    // from the line itself rather than matched loosely, so a leak count or a
    // name set that drifted would be caught.
    const leakLine =
      /tmpdir hygiene: leaked (\d+) new ad-coder-test-\* entr(?:y|ies) in [^\s(]+ \(([^)]*)\)/.exec(
        output,
      );
    expect(leakLine).not.toBeNull();
    expect(leakLine?.[1]).toBe("2");
    expect(leakLine?.[2]?.split(", ").sort()).toEqual([probe.deadName, probe.unmarkedName].sort());
    expect(output).toContain(
      `own run root ${path.basename(probe.runRoot)} was removed by the 5 teardown attempts`,
    );
    expect(child.status).not.toBe(0);
    // Nothing was deleted by the verdict either way: all three foreign roots,
    // including the one it released, are exactly as the child left them.
    for (const dir of [probe.live, probe.dead, probe.unmarked]) {
      expect(fs.existsSync(dir)).toBe(true);
    }
    expect(runRootsIn(sandbox).sort()).toEqual(
      [probe.deadName, probe.liveName, probe.unmarkedName].sort(),
    );
  },
);
