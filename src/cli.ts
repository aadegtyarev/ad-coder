#!/usr/bin/env bun
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { Ledger } from "./ledger/ledger";
import { resolveTargetDir } from "./runner/errors";
import { createRoleRunner } from "./runner/role-runner";
import type { WorkflowContext } from "./workflow";
import { isWorkflowModule } from "./workflow";

const USAGE = "usage: ad-coder run <script.ts> [--target-dir <dir>]";

function fail(message: string): never {
  process.stderr.write(`ad-coder: ${message}\n${USAGE}\n`);
  process.exit(2);
}

/**
 * The module is imported into this process and inherits the whole environment,
 * including provider credentials. These checks keep a run from loading code off
 * the network or out of a directory anyone can write to; they are not a
 * sandbox, so the path argument is trusted input either way.
 */
function resolveScriptPath(specifier: string): string {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(specifier)) {
    fail(`refusing to load a URL specifier: ${specifier}`);
  }
  const resolved = path.resolve(process.cwd(), specifier);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(resolved);
  } catch (error) {
    fail(`cannot read ${resolved}: ${errorMessage(error)}`);
  }
  if (stat.isSymbolicLink()) fail(`refusing to load a symlink: ${resolved}`);
  if (!stat.isFile()) fail(`not a regular file: ${resolved}`);
  if ((stat.mode & 0o002) !== 0) fail(`refusing to load a world-writable file: ${resolved}`);
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    fail(`refusing to load a file owned by another user (uid ${stat.uid}): ${resolved}`);
  }
  // Group-writable is a warning, not a refusal: a umask of 002 makes every
  // checked-out file group-writable under the owner's own private group, and
  // whether that group has other members is not knowable from a stat.
  if ((stat.mode & 0o020) !== 0) {
    process.stderr.write(
      `ad-coder: warning: ${resolved} is writable by group ${stat.gid}; anyone in it can change the code this run executes\n`,
    );
  }
  return resolved;
}

/** Split positionals from the one optional flag; keep the flag parsing thin. */
function parseArgs(argv: string[]): {
  command: string | undefined;
  script: string | undefined;
  targetDir: string | undefined;
} {
  const positionals: string[] = [];
  let targetDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--target-dir") {
      const value = argv[i + 1];
      if (value === undefined) fail("--target-dir requires a directory path");
      targetDir = value;
      i++;
    } else if (arg.startsWith("--target-dir=")) {
      targetDir = arg.slice("--target-dir=".length);
    } else {
      positionals.push(arg);
    }
  }
  return { command: positionals[0], script: positionals[1], targetDir };
}

/**
 * Build the RoleRunner a `--target-dir` run exposes as `ctx.runRole`.
 *
 * Credentials come from `builtinModels()` -- the CLI's OWN process
 * environment -- never from `<targetDir>/.env`. Bun auto-loads `.env` from the
 * process cwd at startup, so if the operator launched ad-coder with its cwd
 * inside targetDir, that `.env` is already folded into `process.env` and the
 * boundary is gone; warn (numbers/paths only) rather than pretend otherwise.
 */
function buildRunner(targetDirArg: string): WorkflowContext["runRole"] {
  const absTargetDir = resolveTargetDir(targetDirArg);
  const cwd = process.cwd();
  if (cwd === absTargetDir || cwd.startsWith(absTargetDir + path.sep)) {
    process.stderr.write(
      `ad-coder: warning: the process cwd is inside --target-dir (${absTargetDir}); ` +
        `a .env there was auto-loaded into the environment and may supply the target's credentials\n`,
    );
  }
  return createRoleRunner({ targetDir: absTargetDir, models: builtinModels() });
}

async function main(argv: string[]): Promise<void> {
  const { command, script: scriptArg, targetDir } = parseArgs(argv);
  if (command !== "run") {
    fail(command === undefined ? "missing command" : `unknown command: ${command}`);
  }
  if (scriptArg === undefined) fail("missing <script.ts>");

  const scriptPath = resolveScriptPath(scriptArg);
  const runRole = targetDir === undefined ? undefined : buildRunner(targetDir);

  const imported: unknown = await import(pathToFileURL(scriptPath).href);
  const workflow = (imported as { default?: unknown }).default;
  if (!isWorkflowModule(workflow)) {
    fail(`${scriptPath} must default-export { name: string, run(ctx) }`);
  }

  const runId = crypto.randomUUID();
  const ledger = new Ledger({ runId, role: workflow.name, step: "run" });
  // runRole is spread in only when set: exactOptionalPropertyTypes forbids
  // handing an explicit `undefined` to the optional field.
  const ctx: WorkflowContext = { runId, ledger, ...(runRole !== undefined && { runRole }) };
  try {
    const result = await workflow.run(ctx);
    // Only the workflow's own return value reaches stdout -- never a provider
    // error object or a settled message, which carry request detail.
    process.stdout.write(`${JSON.stringify(result ?? null)}\n`);
  } finally {
    if (ledger.droppedRecords > 0) {
      process.stderr.write(`ad-coder: ${ledger.droppedRecords} ledger record(s) dropped\n`);
    }
    ledger.close();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`ad-coder: ${errorMessage(error)}\n`);
  process.exit(1);
}
