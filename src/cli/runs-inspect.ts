/** Render the shared, read-only standalone-run owner diagnosis for the CLI. */
import { inspectStandaloneRun } from "../orchestration/run-stop";

export interface RunsInspectParams {
  runId: string;
  targetDir: string;
  json: boolean;
}

export async function runsInspectCommand(params: RunsInspectParams): Promise<void> {
  const result = inspectStandaloneRun(params.targetDir, params.runId);
  if (params.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  switch (result.status) {
    case "live":
      process.stdout.write(`run ${result.runId}: live (pid ${result.pid}); ${result.nextAction}\n`);
      return;
    case "owner_lost":
      process.stdout.write(
        `run ${result.runId}: owner lost (${result.reason}, recorded pid ${result.pid}); ${result.nextAction}\n`,
      );
      return;
    case "owner_unknown":
      process.stdout.write(`run ${result.runId}: owner unknown; ${result.nextAction}\n`);
      return;
    case "recorded":
      process.stdout.write(`run ${result.runId}: ${result.recordedStatus}; ${result.nextAction}\n`);
      return;
    default:
      process.stdout.write(`run ${result.runId}: ${result.status}; ${result.nextAction}\n`);
  }
}
