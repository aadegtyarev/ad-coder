#!/usr/bin/env bun
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { Context, Session } from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT, MemorySessionRepo } from "@earendil-works/pi-agent-core";
import type { Api, Model, Models, TextContent } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { driveWorkflow, silentNoopWarning } from "./cli/drive";
import type { ResolvableProvider } from "./cli/resolve-config";
import { resolvePipelineConfig } from "./cli/resolve-config";
import type { CompactionPolicy } from "./context/compactor";
import { Ledger, MemoryLedgerSink } from "./ledger/ledger";
import { createWorkflowSession } from "./orchestration/session";
import type { Complexity, PipelineConfig, RoleSpec } from "./orchestration/types";
import type { Role } from "./role";
import { resolveTargetDir } from "./runner/errors";
import { createRoleRunner } from "./runner/role-runner";
import type { WorkflowContext } from "./workflow";
import { isWorkflowModule } from "./workflow";

const ROLE_NAMES = ["planner", "coder", "reviewer", "security"] as const;
type RoleName = (typeof ROLE_NAMES)[number];
const PROVIDERS = ["deepseek", "openrouter", "openai-codex"] as const;
const COMPLEXITIES = ["trivial", "medium", "complex"] as const;

function fail(message: string): never {
  process.stderr.write(`ad-coder: ${message}\n${renderRootHelp()}\n`);
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

type ParsedArgs = {
  positionals: string[];
  flags: Record<string, string | undefined>;
  booleans: Record<string, boolean>;
};

type CommandDefinition = {
  name: string;
  description: string;
  positionals: readonly { name: string; description: string }[];
  options: readonly { name: string; value?: string; description: string; required?: boolean }[];
  run: (args: ParsedArgs) => Promise<void>;
};

/** Split a command's positionals from its registry-declared options. */
function parseArgs(argv: string[], command: CommandDefinition): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | undefined> = {};
  const booleans: Record<string, boolean> = {};
  outer: for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    for (const option of command.options) {
      if (arg === option.name && option.value === undefined) {
        booleans[option.name] = true;
        continue outer;
      }
      if (arg === option.name && option.value !== undefined) {
        const value = argv[i + 1];
        if (value === undefined) fail(`${option.name} requires a value`);
        flags[option.name] = value;
        i++;
        continue outer;
      }
      if (option.value !== undefined && arg.startsWith(`${option.name}=`)) {
        flags[option.name] = arg.slice(option.name.length + 1);
        continue outer;
      }
    }
    if (arg.startsWith("-")) fail(`unknown option: ${arg}`);
    positionals.push(arg);
  }
  return { positionals, flags, booleans };
}

/**
 * Warn when the process cwd is inside targetDir: Bun auto-loads a `.env` from
 * the process cwd into the environment at startup, so a dotenv under targetDir
 * would be folded into `process.env` and could supply the target's own
 * credentials -- erasing the credential boundary. Numbers/paths only.
 */
function warnCwdInsideTarget(absTargetDir: string): void {
  const cwd = process.cwd();
  if (cwd === absTargetDir || cwd.startsWith(absTargetDir + path.sep)) {
    process.stderr.write(
      `ad-coder: warning: the process cwd is inside --target-dir (${absTargetDir}); ` +
        `a .env there was auto-loaded into the environment and may supply the target's credentials\n`,
    );
  }
}

/**
 * Build the RoleRunner a `--target-dir` run exposes as `ctx.runRole`.
 *
 * Credentials come from `builtinModels()` -- the CLI's OWN process
 * environment -- never from `<targetDir>/.env`.
 */
function buildRunner(targetDirArg: string): WorkflowContext["runRole"] {
  const absTargetDir = resolveTargetDir(targetDirArg);
  warnCwdInsideTarget(absTargetDir);
  return createRoleRunner({ targetDir: absTargetDir, models: builtinModels() });
}

/**
 * The newest assistant text in a settled session. A LOCAL copy of the private
 * `extractFinalText` (duplicated by house convention, never imported): scan the
 * most recent message entries newest-first for the first assistant message and
 * join its `{ type: 'text' }` blocks (skipping thinking and tool-call blocks).
 * Returns `''` when no assistant text exists.
 */
async function extractFinalText(session: Session, context: Context): Promise<string> {
  const entries = await session.findEntries({ type: "message", order: "desc", limit: 20 }, context);
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role !== "assistant") continue;
    return message.content
      .filter((block): block is TextContent => block.type === "text")
      .map((block) => block.text)
      .join("");
  }
  return "";
}

/**
 * Drive ONE role turn standalone against a fresh in-memory session and return
 * its final assistant text plus the per-run cost summed from the ledger.
 *
 * Dependencies are injected (`models`/`model`/`ledgerSink`) so a faux-backed
 * registry substitutes for a real provider in tests -- no network, no key. The
 * settled `OperationResultRecord` is deliberately NOT returned or printed (it
 * carries request detail); only the extracted assistant text and the numeric
 * cost cross the boundary.
 */
export async function runRoleStandalone(params: {
  role: Role;
  model: Model<Api>;
  models: Models;
  targetDir: string;
  task: string;
  ledgerSink: MemoryLedgerSink;
  compaction?: CompactionPolicy;
}): Promise<{ text: string; cost: number }> {
  const repo = new MemorySessionRepo();
  const session = await repo.create({}, BACKGROUND_CONTEXT);
  await createRoleRunner({
    targetDir: params.targetDir,
    models: params.models,
    ...(params.compaction !== undefined && { compaction: params.compaction }),
  }).runRole(params.role, params.model, params.task, { session, ledgerSink: params.ledgerSink });
  // runRole closes the session facade it was handed; reopen a fresh readable
  // facade from the same repo to scan the settled transcript.
  const readable = await repo.open(session.metadata, BACKGROUND_CONTEXT);
  let text: string;
  try {
    text = await extractFinalText(readable, BACKGROUND_CONTEXT);
  } finally {
    await readable.close(BACKGROUND_CONTEXT);
  }
  let cost = 0;
  for (const record of params.ledgerSink.records()) {
    cost += record.usage.cost.total;
  }
  return { text, cost };
}

/** The resolved RoleSpec for a validated role name (all four are always present here). */
function roleSpecFor(config: PipelineConfig, name: RoleName): RoleSpec {
  const spec =
    name === "planner"
      ? config.roles.planner
      : name === "security"
        ? config.roles.security
        : name === "coder"
          ? config.roles.coder
          : config.roles.reviewer;
  if (spec === undefined) {
    throw new Error(`ad-coder: internal error: resolved config has no ${name} role`);
  }
  return spec;
}

function parseProviderFlag(value: string | undefined): ResolvableProvider | undefined {
  if (value === undefined) return undefined;
  if (!(PROVIDERS as readonly string[]).includes(value)) {
    fail(`unknown provider: ${value} (expected one of ${PROVIDERS.join(", ")})`);
  }
  return value as ResolvableProvider;
}

function parseComplexityFlag(value: string | undefined): Complexity | undefined {
  if (value === undefined) return undefined;
  if (!(COMPLEXITIES as readonly string[]).includes(value)) {
    fail(`invalid --default-complexity: ${value} (expected one of ${COMPLEXITIES.join(", ")})`);
  }
  return value as Complexity;
}

function parseMaxRoundsFlag(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    fail(`invalid --max-rounds: ${value} (expected a positive integer)`);
  }
  return parsed;
}

/** Run a single role standalone against a target directory, resolved from the environment. */
async function roleCommand(
  positionals: string[],
  flags: Record<string, string | undefined>,
): Promise<void> {
  const name = positionals[1];
  if (name === undefined) fail("missing <role>");
  if (!(ROLE_NAMES as readonly string[]).includes(name)) {
    fail(`unknown role: ${name} (expected one of ${ROLE_NAMES.join(", ")})`);
  }
  const task = positionals[2];
  if (task === undefined) fail("missing <task>");
  const targetDirArg = flags["--target-dir"];
  if (targetDirArg === undefined) fail("--target-dir is required for the role command");

  const provider = parseProviderFlag(flags["--provider"]);
  const maxRounds = parseMaxRoundsFlag(flags["--max-rounds"]);
  const defaultComplexity = parseComplexityFlag(flags["--default-complexity"]);

  const absTargetDir = resolveTargetDir(targetDirArg);
  warnCwdInsideTarget(absTargetDir);

  const config = resolvePipelineConfig({
    task,
    targetDir: absTargetDir,
    env: (n: string) => process.env[n],
    ...(provider !== undefined && { provider }),
    ...(flags["--strong-model"] !== undefined && { strongModel: flags["--strong-model"] }),
    ...(flags["--mid-model"] !== undefined && { midModel: flags["--mid-model"] }),
    ...(flags["--cheap-model"] !== undefined && { cheapModel: flags["--cheap-model"] }),
    ...(maxRounds !== undefined && { maxRounds }),
    ...(defaultComplexity !== undefined && { defaultComplexity }),
  });

  const spec = roleSpecFor(config, name as RoleName);
  const ledgerSink = new MemoryLedgerSink();
  const { text, cost } = await runRoleStandalone({
    role: spec.role,
    model: spec.model,
    models: config.models,
    targetDir: absTargetDir,
    task,
    ledgerSink,
    ...(config.compaction !== undefined && { compaction: config.compaction }),
  });

  // The extracted assistant text IS this subcommand's result value, so it is
  // the one thing that reaches stdout (never the raw OperationResultRecord).
  process.stdout.write(`${text}\n`);
  process.stdout.write(`cost: $${cost.toFixed(8)}\n`);
  // A silent no-op turn (empty text AND zero cost) is otherwise two blank-looking
  // lines; surface it as a clear stderr signal (provider auth / empty response).
  const warning = silentNoopWarning(text, cost);
  if (warning !== undefined) {
    process.stderr.write(warning);
  }
}

/**
 * Drive the stepped workflow engine one phase at a time against a target
 * directory, resolved from the environment. A THIN front: it validates args,
 * resolves the config, sets a readable ledger sink the drive loop sums cost
 * from, creates the session, and hands the real stdin/stdout/stderr streams to
 * `driveWorkflow` (the loop itself lives in the library, per the thin-front
 * contract). `--auto` swaps the human read for the auto-driver.
 */
async function driveCommand(
  positionals: string[],
  flags: Record<string, string | undefined>,
  auto: boolean,
): Promise<void> {
  const task = positionals[1];
  if (task === undefined) fail("missing <task>");
  const targetDirArg = flags["--target-dir"];
  if (targetDirArg === undefined) fail("--target-dir is required for the drive command");

  const provider = parseProviderFlag(flags["--provider"]);
  const maxRounds = parseMaxRoundsFlag(flags["--max-rounds"]);
  const defaultComplexity = parseComplexityFlag(flags["--default-complexity"]);

  const absTargetDir = resolveTargetDir(targetDirArg);
  warnCwdInsideTarget(absTargetDir);

  const config = resolvePipelineConfig({
    task,
    targetDir: absTargetDir,
    env: (n: string) => process.env[n],
    ...(provider !== undefined && { provider }),
    ...(flags["--strong-model"] !== undefined && { strongModel: flags["--strong-model"] }),
    ...(flags["--mid-model"] !== undefined && { midModel: flags["--mid-model"] }),
    ...(flags["--cheap-model"] !== undefined && { cheapModel: flags["--cheap-model"] }),
    ...(maxRounds !== undefined && { maxRounds }),
    ...(defaultComplexity !== undefined && { defaultComplexity }),
  });

  // resolvePipelineConfig assigns its own internal LedgerSink (typed as the
  // non-readable interface); replace it with a readable instance the drive loop
  // sums per-step and total cost from, and drive against that same instance.
  const ledgerSink = new MemoryLedgerSink();
  config.ledgerSink = ledgerSink;
  const session = createWorkflowSession(config);
  await driveWorkflow({
    session,
    ledgerSink,
    auto,
    input: process.stdin,
    output: process.stdout,
    error: process.stderr,
  });
}

/** Load and run a workflow module against an optional target directory. */
async function runCommand(
  positionals: string[],
  flags: Record<string, string | undefined>,
): Promise<void> {
  const scriptArg = positionals[1];
  if (scriptArg === undefined) fail("missing <script.ts>");

  const scriptPath = resolveScriptPath(scriptArg);
  const targetDir = flags["--target-dir"];
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

const COMMANDS: readonly CommandDefinition[] = [
  {
    name: "run",
    description: "Run a workflow module.",
    positionals: [{ name: "<script.ts>", description: "Workflow module to load and run." }],
    options: [
      {
        name: "--target-dir",
        value: "<dir>",
        description: "Expose a role runner for this project.",
      },
    ],
    run: ({ positionals, flags }) => runCommand(positionals, flags),
  },
  {
    name: "role",
    description: "Run one pipeline role once.",
    positionals: [
      { name: "<planner|coder|reviewer|security>", description: "Role to run." },
      { name: "<task>", description: "Task for the role." },
    ],
    options: [
      {
        name: "--target-dir",
        value: "<dir>",
        description: "Directory containing the project to operate on.",
        required: true,
      },
      {
        name: "--provider",
        value: "<provider>",
        description: "Provider: deepseek, openrouter, or openai-codex.",
      },
      { name: "--strong-model", value: "<name>", description: "Override the strong model." },
      { name: "--mid-model", value: "<name>", description: "Override the mid-tier model." },
      { name: "--cheap-model", value: "<name>", description: "Override the cheap model." },
      {
        name: "--max-rounds",
        value: "<n>",
        description: "Set the maximum number of pipeline rounds.",
      },
      {
        name: "--default-complexity",
        value: "<complexity>",
        description: "Set trivial, medium, or complex as the default.",
      },
    ],
    run: ({ positionals, flags }) => roleCommand(positionals, flags),
  },
  {
    name: "drive",
    description: "Interactively drive the built-in pipeline.",
    positionals: [{ name: "<task>", description: "Task for the pipeline." }],
    options: [
      { name: "--auto", description: "Automatically choose pipeline transitions." },
      {
        name: "--target-dir",
        value: "<dir>",
        description: "Directory containing the project to operate on.",
        required: true,
      },
      {
        name: "--provider",
        value: "<provider>",
        description: "Provider: deepseek, openrouter, or openai-codex.",
      },
      { name: "--strong-model", value: "<name>", description: "Override the strong model." },
      { name: "--mid-model", value: "<name>", description: "Override the mid-tier model." },
      { name: "--cheap-model", value: "<name>", description: "Override the cheap model." },
      {
        name: "--max-rounds",
        value: "<n>",
        description: "Set the maximum number of pipeline rounds.",
      },
      {
        name: "--default-complexity",
        value: "<complexity>",
        description: "Set trivial, medium, or complex as the default.",
      },
    ],
    run: ({ positionals, flags, booleans }) =>
      driveCommand(positionals, flags, booleans["--auto"] === true),
  },
];

function renderRootHelp(): string {
  return [
    "usage: ad-coder <command> [options]",
    "",
    "Commands:",
    ...COMMANDS.map((command) => `  ${command.name.padEnd(7)} ${command.description}`),
  ].join("\n");
}

function renderCommandHelp(command: CommandDefinition): string {
  const argumentsUsage = command.positionals.map(({ name }) => name).join(" ");
  const optionsUsage =
    command.options.filter(({ required }) => !required).length === 0 ? "" : " [options]";
  const requiredOptions = command.options
    .filter(({ required }) => required)
    .map(({ name, value }) => `${name} ${value ?? ""}`.trim())
    .join(" ");
  const usage = ["usage: ad-coder", command.name, argumentsUsage, requiredOptions, optionsUsage]
    .filter(Boolean)
    .join(" ");
  const positionals =
    command.positionals.length === 0
      ? []
      : [
          "",
          "Arguments:",
          ...command.positionals.map(
            ({ name, description }) => `  ${name.padEnd(35)} ${description}`,
          ),
        ];
  const options = [
    "",
    "Options:",
    `${"  --help, -h".padEnd(37)}Show this help.`,
    ...command.options.map(
      ({ name, value, description, required }) =>
        `  ${`${name}${value === undefined ? "" : ` ${value}`}${required ? " (required)" : ""}`.padEnd(35)} ${description}`,
    ),
  ];
  return [usage, ...positionals, ...options].join("\n");
}

async function main(argv: string[]): Promise<void> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    process.stdout.write(`${renderRootHelp()}\n`);
    return;
  }
  const commandName = argv[0];
  const command = COMMANDS.find(({ name }) => name === commandName);
  if (command === undefined)
    fail(commandName === undefined ? "missing command" : `unknown command: ${commandName}`);
  if (argv.slice(1).some((arg) => arg === "--help" || arg === "-h")) {
    process.stdout.write(`${renderCommandHelp(command)}\n`);
    return;
  }
  await command.run(parseArgs(argv, command));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Only run when invoked as the entry point, so importing this module for tests
// (e.g. to exercise runRoleStandalone) does not fire the CLI dispatch.
if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`ad-coder: ${errorMessage(error)}\n`);
    process.exit(1);
  }
}
