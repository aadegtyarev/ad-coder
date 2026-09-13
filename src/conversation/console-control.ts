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
export type ConsoleControlResult =
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
  constructor(readonly code: ConsoleControlCode) {
    super(code);
    this.name = "ConsoleControlError";
  }
}

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const DEFAULT_CONSOLE_CONTROL_PAGE_SIZE = DEFAULT_BACKGROUND_RUN_LIMITS.maxPageSize;

function runId(value: string | undefined): string {
  if (value === undefined || !RUN_ID.test(value)) throw new ConsoleControlError("invalid_command");
  return value;
}
function integer(value: string | undefined): number {
  if (value === undefined || !/^(0|[1-9][0-9]*)$/.test(value))
    throw new ConsoleControlError("invalid_command");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new ConsoleControlError("invalid_command");
  return parsed;
}
function managerFor(value: BackgroundRunManager | undefined): BackgroundRunManager {
  if (value === undefined) throw new ConsoleControlError("not_available");
  return value;
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
  const command = parts[0];
  const args = parts.slice(1);
  const maxPageSize = controls.maxPageSize ?? DEFAULT_CONSOLE_CONTROL_PAGE_SIZE;
  if (!Number.isSafeInteger(maxPageSize) || maxPageSize <= 0)
    throw new RangeError("maxPageSize must be a positive safe integer");
  const requireArgs = (count: number): void => {
    if (args.length !== count) throw new ConsoleControlError("invalid_command");
  };
  try {
    switch (command) {
      case "/interrupt":
        requireArgs(0);
        return controls.interrupt().then((active) => ({
          type: "console_control",
          command: "interrupt",
          status: active ? "interrupted" : "idle",
        }));
      case "/list": {
        requireArgs(0);
        return Promise.resolve({
          type: "background_list",
          runs: managerFor(controls.backgroundRuns).list(maxPageSize),
        });
      }
      case "/events": {
        if (args.length < 1 || args.length > 3) throw new ConsoleControlError("invalid_command");
        const id = runId(args[0]);
        const cursor = args.length >= 2 ? integer(args[1]) : 0;
        const limit = args.length === 3 ? integer(args[2]) : maxPageSize;
        const page = managerFor(controls.backgroundRuns).events(
          id,
          cursor,
          Math.min(limit, maxPageSize),
        );
        return Promise.resolve({ type: "background_events", runId: id, ...page });
      }
      case "/status":
        requireArgs(1);
        return Promise.resolve({
          type: "background_status",
          run: managerFor(controls.backgroundRuns).status(runId(args[0])),
        });
      case "/result":
        requireArgs(1);
        return Promise.resolve({
          type: "background_result",
          result: managerFor(controls.backgroundRuns).result(runId(args[0])),
        });
      case "/cancel":
        requireArgs(1);
        return Promise.resolve({
          type: "background_cancel",
          run: managerFor(controls.backgroundRuns).cancel(runId(args[0])),
        });
      default:
        throw new ConsoleControlError("unknown_command");
    }
  } catch (error) {
    if (error instanceof ConsoleControlError) throw error;
    // Manager errors intentionally collapse to safe public codes.
    const code =
      error instanceof Error && error.message === "not_found"
        ? "not_found"
        : error instanceof Error && error.message === "not_terminal"
          ? "not_terminal"
          : "invalid_request";
    throw new ConsoleControlError(code);
  }
}
