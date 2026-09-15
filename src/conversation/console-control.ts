import type { CostAnomalyBlock } from "../economics/cost-anomaly";
import {
  type BackgroundRunManager,
  DEFAULT_BACKGROUND_RUN_LIMITS,
} from "../orchestration/background-runs";

export type ConsoleControlCode =
  | "unknown_command"
  | "invalid_command"
  | "not_available"
  | "not_found"
  | "not_terminal"
  | "invalid_request"
  | "launch_failed"
  | "resource_limit"
  | "interrupted";

/**
 * Safe public projection of a failed console command, per `docs/contracts/errors.md`:
 * a stable `code`, concise text naming the failed operation, whether a retry can
 * succeed, and the next useful action. It never carries prompts or run content.
 */
export interface ConsoleControlFailure {
  readonly code: ConsoleControlCode;
  /** The command token the operator typed, when one was recognized. */
  readonly command?: string;
  readonly message: string;
  readonly action: string;
  readonly retryable: boolean;
}

export interface ConsoleCommandArgument {
  readonly name: string;
  readonly required: boolean;
  readonly description: string;
  /** Noun phrase naming this argument in a missing-argument failure. */
  readonly label: string;
}

export interface ConsoleCommandDefinition {
  readonly name: string;
  readonly description: string;
  readonly args: readonly ConsoleCommandArgument[];
  readonly example: string;
  /** Set when the command needs an optional capability the host may not enable. */
  readonly requires?: "background_runs" | "cost_anomaly";
  /**
   * Present exactly on the commands a front executes itself rather than through
   * `executeConsoleControl`; it names the front-side effect. A front selects on
   * this instead of matching a command name literally, so the registry stays the
   * one source of dispatch (`docs/contracts/cli.md`).
   */
  readonly frontAction?: "exit";
  /**
   * Set when the command's single argument is the whole remainder of the line
   * rather than a whitespace-split token. Declared here, like `frontAction`, so
   * parsing selects on a registry property instead of matching a command name
   * literally (`docs/contracts/cli.md`).
   */
  readonly argMode?: "verbatim";
}

export interface ConsoleCommandHelpEntry {
  readonly name: string;
  readonly usage: string;
  readonly description: string;
  readonly args: readonly ConsoleCommandArgument[];
  readonly example: string;
  readonly available: boolean;
  /** Present only when `available` is false; names how to enable the command. */
  readonly unavailableAction?: string;
}

export type ConsoleControlResult =
  | { type: "console_help"; commands: readonly ConsoleCommandHelpEntry[] }
  | { type: "console_control"; command: "interrupt"; status: "interrupted" | "idle" }
  | { type: "background_list"; runs: ReturnType<BackgroundRunManager["list"]> }
  | { type: "background_start"; run: { runId: string; lifecycle: "requested" } }
  | {
      type: "background_events";
      runId: string;
      events: unknown[];
      nextCursor: number;
      gap: boolean;
    }
  | { type: "background_status"; run: unknown }
  | { type: "background_result"; result: unknown }
  | { type: "background_cancel"; run: unknown }
  | {
      type: "cost_status";
      blocked: readonly { provider: string; model: string; block: Readonly<CostAnomalyBlock> }[];
    }
  | {
      type: "cost_release";
      provider: string;
      model: string;
      released: Readonly<CostAnomalyBlock>;
    };

/**
 * The cost-anomaly surface a console control needs. Declared structurally so
 * the console reaches the SAME headless decision the `cost` CLI command reaches
 * -- one detector, two renderings -- without the control layer depending on the
 * economics module's construction (`docs/contracts/cli.md`).
 */
export interface CostAnomalyControl {
  blocked(): Array<{ provider: string; model: string; block: Readonly<CostAnomalyBlock> }>;
  release(provider: string, model: string): Readonly<CostAnomalyBlock> | undefined;
}

export class ConsoleControlError extends Error {
  readonly code: ConsoleControlCode;
  /**
   * `cause` keeps the originating failure for programmatic callers while only
   * `failure` crosses human, model, and machine boundaries (docs/contracts/errors.md).
   */
  constructor(
    readonly failure: ConsoleControlFailure,
    options?: { cause: unknown },
  ) {
    super(failure.message, options);
    this.name = "ConsoleControlError";
    this.code = failure.code;
  }
}

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const DEFAULT_CONSOLE_CONTROL_PAGE_SIZE = DEFAULT_BACKGROUND_RUN_LIMITS.maxPageSize;

const EXAMPLE_RUN_ID = "123e4567-e89b-12d3-a456-426614174000";

/**
 * The ONE declaration of the console's command surface. Dispatch, argument
 * validation, failure guidance, and `/help` all render from this registry, so a
 * command cannot exist without usage text or drift from a hand-written list
 * (`docs/contracts/cli.md`).
 */
export const CONSOLE_COMMANDS: readonly ConsoleCommandDefinition[] = [
  {
    name: "/help",
    description: "List every console command with its arguments and an example.",
    args: [],
    example: "/help",
  },
  {
    name: "/list",
    description: "List background pipeline runs in this owner scope.",
    args: [],
    example: "/list",
    requires: "background_runs",
  },
  {
    name: "/start",
    description: "Start a background pipeline run on a task, without dispatching a model turn.",
    args: [
      {
        name: "<task>",
        required: true,
        // The whole remainder is one argument: a task is a sentence, not a token.
        description: "Task for the run; the rest of the line is taken verbatim.",
        label: "a task description",
      },
    ],
    example: "/start add a regression test for the retry path",
    requires: "background_runs",
    argMode: "verbatim",
  },
  {
    name: "/events",
    description: "Read a bounded page of one background run's lifecycle events.",
    args: [
      {
        name: "<run-id>",
        required: true,
        description: "Background run identifier from /list.",
        label: "a background run identifier",
      },
      {
        name: "[cursor]",
        required: false,
        description: "Exclusive event cursor; defaults to 0.",
        label: "an event cursor",
      },
      {
        name: "[limit]",
        required: false,
        description: "Maximum events; bounded by the page size.",
        label: "an event limit",
      },
    ],
    example: `/events ${EXAMPLE_RUN_ID}`,
    requires: "background_runs",
  },
  {
    name: "/status",
    description: "Show one background run's lifecycle, steps, and cost.",
    args: [
      {
        name: "<run-id>",
        required: true,
        description: "Background run identifier from /list.",
        label: "a background run identifier",
      },
    ],
    example: `/status ${EXAMPLE_RUN_ID}`,
    requires: "background_runs",
  },
  {
    name: "/result",
    description: "Show one terminated background run's result.",
    args: [
      {
        name: "<run-id>",
        required: true,
        description: "Background run identifier from /list.",
        label: "a background run identifier",
      },
    ],
    example: `/result ${EXAMPLE_RUN_ID}`,
    requires: "background_runs",
  },
  {
    name: "/cancel",
    description: "Cancel one background run.",
    args: [
      {
        name: "<run-id>",
        required: true,
        description: "Background run identifier from /list.",
        label: "a background run identifier",
      },
    ],
    example: `/cancel ${EXAMPLE_RUN_ID}`,
    requires: "background_runs",
  },
  {
    name: "/cost",
    description:
      "Show models blocked for billing above their declared price, or accept a model's new price.",
    args: [
      {
        name: "[release]",
        required: false,
        description: "Accept the new price for one scope; omit to list what is blocked.",
        label: "the release action",
      },
      {
        name: "[provider/model]",
        required: false,
        description: "Scope to release, spelled exactly as the refusal names it.",
        label: "a provider/model scope",
      },
    ],
    example: "/cost release openrouter/@preset/deepseekflash",
    requires: "cost_anomaly",
  },
  {
    name: "/interrupt",
    description: "Interrupt only the current orchestrator turn; the session stays open.",
    args: [],
    example: "/interrupt",
  },
  {
    name: "/exit",
    description: "Close the console session; detached background runs keep running.",
    args: [],
    example: "/exit",
    frontAction: "exit",
  },
];

const BACKGROUND_RUNS_ACTION =
  "restart the console with --workflows pipeline to enable background runs";
const COST_ANOMALY_ACTION =
  "restart the console in a project directory so its cost-anomaly state can be read";

export function findConsoleCommand(name: string): ConsoleCommandDefinition | undefined {
  return CONSOLE_COMMANDS.find((command) => command.name === name);
}

/** Render one command's usage line from the registry; never hand-maintained. */
export function consoleCommandUsage(command: ConsoleCommandDefinition): string {
  return [command.name, ...command.args.map((argument) => argument.name)].join(" ");
}

/** The known command names, for a front that needs to recognize them before dispatch. */
export function consoleCommandNames(): readonly string[] {
  return CONSOLE_COMMANDS.map((command) => command.name);
}

function fail(failure: ConsoleControlFailure, cause?: unknown): never {
  throw new ConsoleControlError(failure, cause === undefined ? undefined : { cause });
}

function invalidArguments(command: ConsoleCommandDefinition, reason: string): never {
  fail({
    code: "invalid_command",
    command: command.name,
    message: `${command.name} ${reason}`,
    action: `use: ${consoleCommandUsage(command)} (example: ${command.example})`,
    // The operator can retype the command immediately with correct arguments.
    retryable: true,
  });
}

function runId(command: ConsoleCommandDefinition, value: string | undefined): string {
  if (value === undefined) invalidArguments(command, "requires a background run identifier");
  if (!RUN_ID.test(value)) invalidArguments(command, "received an argument that is not a run UUID");
  return value;
}

function integer(command: ConsoleCommandDefinition, value: string | undefined): number {
  if (value === undefined || !/^(0|[1-9][0-9]*)$/.test(value))
    invalidArguments(command, "requires non-negative whole numbers for cursor and limit");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed))
    invalidArguments(command, "received a cursor or limit outside the safe integer range");
  return parsed;
}

function costAnomalyFor(
  command: ConsoleCommandDefinition,
  value: CostAnomalyControl | undefined,
): CostAnomalyControl {
  if (value === undefined)
    fail({
      code: "not_available",
      command: command.name,
      message: `${command.name} needs cost-anomaly state, which this console session did not enable`,
      action: COST_ANOMALY_ACTION,
      // Retrying the same command in this session cannot succeed.
      retryable: false,
    });
  return value;
}

function managerFor(
  command: ConsoleCommandDefinition,
  value: BackgroundRunManager | undefined,
): BackgroundRunManager {
  if (value === undefined)
    fail({
      code: "not_available",
      command: command.name,
      message: `${command.name} needs background runs, which this console session did not enable`,
      action: BACKGROUND_RUNS_ACTION,
      // Retrying the same command in this session cannot succeed.
      retryable: false,
    });
  return value;
}

function helpEntries(controls: {
  backgroundRuns?: BackgroundRunManager;
  costAnomaly?: CostAnomalyControl;
}): ConsoleCommandHelpEntry[] {
  return CONSOLE_COMMANDS.map((command) => {
    const available =
      command.requires === "background_runs"
        ? controls.backgroundRuns !== undefined
        : command.requires === "cost_anomaly"
          ? controls.costAnomaly !== undefined
          : true;
    const unavailableAction =
      command.requires === "cost_anomaly" ? COST_ANOMALY_ACTION : BACKGROUND_RUNS_ACTION;
    return {
      name: command.name,
      usage: consoleCommandUsage(command),
      description: command.description,
      args: command.args,
      example: command.example,
      available,
      ...(available ? {} : { unavailableAction }),
    };
  });
}

/** Parse content-free console controls before a prompt reaches a model. */
export function executeConsoleControl(
  input: string,
  controls: {
    backgroundRuns?: BackgroundRunManager;
    /** The same detector the `cost` CLI command drives; the console only renders it. */
    costAnomaly?: CostAnomalyControl;
    interrupt: () => Promise<boolean>;
    /** Must match a validated manager page limit; protects untrusted adapters too. */
    maxPageSize?: number;
  },
): Promise<ConsoleControlResult> | undefined {
  if (!input.startsWith("/")) return undefined;
  const trimmed = input.trim();
  const parts = trimmed.split(/\s+/);
  const name = parts[0] as string;
  const maxPageSize = controls.maxPageSize ?? DEFAULT_CONSOLE_CONTROL_PAGE_SIZE;
  if (!Number.isSafeInteger(maxPageSize) || maxPageSize <= 0)
    throw new RangeError("maxPageSize must be a positive safe integer");
  const command = findConsoleCommand(name);
  if (command === undefined)
    fail({
      code: "unknown_command",
      message: `${name} is not a console command`,
      action: "use /help to list every console command",
      retryable: true,
    });
  // A verbatim command takes a sentence, not a token, so its whole remainder is
  // ONE argument; every other command is whitespace-split.
  const rest = trimmed.slice(name.length).trim();
  const args = command.argMode === "verbatim" ? (rest === "" ? [] : [rest]) : parts.slice(1);
  // Arity is checked against the registry, so a missing argument names the
  // argument the operator omitted rather than a bare count.
  const requireArgs = (): void => {
    const missing = command.args[args.length];
    if (missing?.required) invalidArguments(command, `requires ${missing.label}`);
    if (args.length > command.args.length)
      invalidArguments(
        command,
        command.args.length === 0
          ? "takes no arguments"
          : `takes at most ${command.args.length} ${command.args.length === 1 ? "argument" : "arguments"}`,
      );
  };
  try {
    switch (command.name) {
      case "/help":
        requireArgs();
        return Promise.resolve({
          type: "console_help",
          commands: helpEntries(controls),
        });
      case "/cost": {
        requireArgs();
        const detector = costAnomalyFor(command, controls.costAnomaly);
        if (args.length === 0)
          return Promise.resolve({ type: "cost_status", blocked: detector.blocked() });
        if (args[0] !== "release") invalidArguments(command, "takes release as its only action");
        const scope = args[1];
        if (scope === undefined) invalidArguments(command, "requires a provider/model scope");
        const separator = scope.indexOf("/");
        // A model name may itself contain slashes (`@preset/name`), so the FIRST
        // separator splits provider from model -- the same spelling `cost release`
        // parses, so a scope pastes between the two fronts unchanged.
        if (separator <= 0 || separator === scope.length - 1)
          invalidArguments(command, "requires a scope spelled <provider>/<model>");
        const provider = scope.slice(0, separator);
        const model = scope.slice(separator + 1);
        const released = detector.release(provider, model);
        // A scope that was not blocked is reported, not treated as success: a
        // typo would otherwise read as released while the real block stood.
        if (released === undefined)
          fail({
            code: "not_found",
            command: command.name,
            message: `${command.name} found no price block recorded for ${scope}`,
            action: "use /cost to list the scopes this project has blocked",
            retryable: false,
          });
        return Promise.resolve({ type: "cost_release", provider, model, released });
      }
      case "/interrupt":
        requireArgs();
        return controls.interrupt().then((active) => ({
          type: "console_control",
          command: "interrupt",
          status: active ? "interrupted" : "idle",
        }));
      case "/start": {
        requireArgs();
        const manager = managerFor(command, controls.backgroundRuns);
        // Detached, not in-process: a console run must outlive the turn that
        // asked for it, and the operator keeps the dialogue while it runs.
        return manager.startDetached(args[0] as string).then(
          (run) => ({ type: "background_start", run }) as const,
          (error: unknown) => managerFailure(command, error),
        );
      }
      case "/list": {
        requireArgs();
        return Promise.resolve({
          type: "background_list",
          runs: managerFor(command, controls.backgroundRuns).list(maxPageSize),
        });
      }
      case "/events": {
        requireArgs();
        const id = runId(command, args[0]);
        const cursor = args.length >= 2 ? integer(command, args[1]) : 0;
        const limit = args.length === 3 ? integer(command, args[2]) : maxPageSize;
        const page = managerFor(command, controls.backgroundRuns).events(
          id,
          cursor,
          Math.min(limit, maxPageSize),
        );
        return Promise.resolve({ type: "background_events", runId: id, ...page });
      }
      case "/status":
        requireArgs();
        return Promise.resolve({
          type: "background_status",
          run: managerFor(command, controls.backgroundRuns).status(runId(command, args[0])),
        });
      case "/result":
        requireArgs();
        return Promise.resolve({
          type: "background_result",
          result: managerFor(command, controls.backgroundRuns).result(runId(command, args[0])),
        });
      case "/cancel":
        requireArgs();
        return Promise.resolve({
          type: "background_cancel",
          run: managerFor(command, controls.backgroundRuns).cancel(runId(command, args[0])),
        });
      default:
        // Reached only by a caller that dispatches control commands without
        // handling the front commands first. Fail typed rather than letting the
        // command fall through and reach the model as a prompt.
        fail({
          code: "invalid_request",
          command: command.name,
          message: `${command.name} is executed by the console front, which did not handle it`,
          action: `dispatch ${command.name} on the front by its registry frontAction before calling executeConsoleControl`,
          // Re-sending the identical command to this dispatch cannot succeed.
          retryable: false,
        });
    }
  } catch (error) {
    managerFailure(command, error);
  }
}

/**
 * Collapse a manager error to a safe public console failure. Shared by the
 * synchronous dispatch and by `/start`, whose launch failure only surfaces once
 * the host's detached launcher has been awaited.
 */
function managerFailure(command: ConsoleCommandDefinition, error: unknown): never {
  if (error instanceof ConsoleControlError) throw error;
  // Manager errors intentionally collapse to safe public codes.
  const message = error instanceof Error ? error.message : "";
  if (message === "not_found")
    fail(
      {
        code: "not_found",
        command: command.name,
        message: `${command.name} found no background run with that identifier`,
        action: "use /list to see the background runs in this owner scope",
        retryable: false,
      },
      error,
    );
  if (message === "not_terminal")
    fail(
      {
        code: "not_terminal",
        command: command.name,
        message: `${command.name} needs a run that has already terminated`,
        action: "use /status to watch the run, then retry once it reports a terminal lifecycle",
        retryable: true,
      },
      error,
    );
  if (message === "launch_failed")
    fail(
      {
        code: "launch_failed",
        command: command.name,
        message: `${command.name} could not launch a detached pipeline worker`,
        // The record is already failed, so a retry is a fresh run, not a resume.
        action: "use /list to see the failed record, then retry the task",
        retryable: true,
      },
      error,
    );
  if (message === "resource_limit")
    fail(
      {
        code: "resource_limit",
        command: command.name,
        message: `${command.name} was refused: a background run limit is already reached`,
        action: "use /list to see active runs, then wait or /cancel one before retrying",
        retryable: true,
      },
      error,
    );
  fail(
    {
      code: "invalid_request",
      command: command.name,
      message: `${command.name} was rejected by the background run manager`,
      action: "use /list to confirm the run identifier and owner scope",
      retryable: false,
    },
    error,
  );
}
