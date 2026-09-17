/**
 * Write what a role was actually sent, when the operator asks for it.
 *
 * The ledger's `requestBytes` (issue #317) answers "did a system prompt arrive
 * and how big was the brief". It cannot answer "was it the RIGHT prompt": a size
 * distinguishes an empty prompt from a present one, not one prompt from another
 * of similar length. Settling that by hand means reading the source to work out
 * what is appended where, which is how a debugging session turns into an
 * afternoon.
 *
 * OFF unless `AD_CODER_DUMP_REQUEST` is set. A request carries the task text and
 * whatever the role has read from the project, so writing it durably is a
 * deliberate act, never a default. The file lands under the project store's
 * `scratch` area, which is already excluded from the package and from git.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectStore } from "../project-store/project-store";

export interface DumpedRequest {
  runId: string;
  role: string;
  step: string;
  systemPrompt: string;
  prompt: string;
  /** Tool NAMES only: the definitions are large and their shapes are in the source. */
  toolNames: readonly string[];
}

/**
 * Best-effort: a failed dump must never fail the run it is observing. Debugging
 * output that can abort the thing being debugged is worse than none.
 */
export function dumpRequest(store: ProjectStore, request: DumpedRequest): string | undefined {
  try {
    const dir = path.join(store.layout.scratch, "requests");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${store.validateId(request.runId)}-${safeStep(request.step)}.txt`);
    const body = [
      `# role: ${request.role}`,
      `# step: ${request.step}`,
      `# runId: ${request.runId}`,
      `# tools: ${request.toolNames.join(", ")}`,
      "",
      "=== SYSTEM PROMPT ===",
      request.systemPrompt,
      "",
      "=== PROMPT ===",
      request.prompt,
      "",
    ].join("\n");
    fs.writeFileSync(file, body, { mode: 0o600 });
    process.stderr.write(`ad-coder: request dumped to ${file}\n`);
    return file;
  } catch (error) {
    process.stderr.write(
      `ad-coder: could not dump the request (${error instanceof Error ? error.message : "unknown"})\n`,
    );
    return undefined;
  }
}

/** A step becomes a file name, so it is constrained like one. */
function safeStep(step: string): string {
  const cleaned = step.replace(/[^A-Za-z0-9_-]/g, "-");
  return cleaned === "" ? "step" : cleaned.slice(0, 64);
}
