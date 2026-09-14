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
  readonly requires?: "background_runs";
  /**
   * Present exactly on the commands a front executes itself rather than through
   * `executeConsoleControl`; it names the front-side effect. A front selects on
   * this instead of matching a command name literally, so the registry stays the
   * one source of dispatch (`docs/contracts/cli.md`).
   */
  readonly frontAction?: "exit";
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
  | {
      type: "background_events";
      runId: string;
      events: unknown[];
      nextCursor: number;
      gap: boolean;
    }
  | { type: "background_status"; run: unknown }
  | { type: "background_result"; result: unknown }
  | { type: "background_cancel"; run: unknown };

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

function helpEntries(backgroundRuns: BackgroundRunManager | undefined): ConsoleCommandHelpEntry[] {
  return CONSOLE_COMMANDS.map((command) => {
    const available = command.requires !== "background_runs" || backgroundRuns !== undefined;
    return {
      name: command.name,
      usage: consoleCommandUsage(command),
      description: command.description,
      args: command.args,
      example: command.example,
      available,
      ...(available ? {} : { unavailableAction: BACKGROUND_RUNS_ACTION }),
    };
  });
}

/** Parse content-free console controls before a prompt reaches a model. */
export function executeConsoleControl(
  input: string,
  controls: {
    backgroundRuns?: BackgroundRunManager;
    interrupt: () => Promise<boolean>;
    /** Must match a validated manager page limit; protects untrusted adapters too. */
    maxPageSize?: number;
  },
): Promise<ConsoleControlResult> | undefined {
  if (!input.startsWith("/")) return undefined;
  const parts = input.trim().split(/\s+/);
  const name = parts[0] as string;
  const args = parts.slice(1);
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
          commands: helpEntries(controls.backgroundRuns),
        });
      case "/interrupt":
        requireArgs();
        return controls.interrupt().then((active) => ({
          type: "console_control",
          command: "interrupt",
          status: active ? "interrupted" : "idle",
        }));
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
}
