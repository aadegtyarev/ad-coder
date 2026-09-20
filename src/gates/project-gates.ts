/**
 * The declared gate set, and the real executor for a declared gate.
 *
 * WHY DATA AND NOT PROMPT TEXT. The issue behind this (#227) is that a model
 * picks its own checks when nothing names them: it verified `npx tsc
 * --noEmit` while this project's gate `bun run check` stayed red. A declared
 * list -- `QualityGate` values carrying real argv -- is executed by the
 * EXISTING `GateRunner` regardless of what any role believes, and a DIFFERENT
 * project substitutes its own list (e.g. `cargo clippy`, `make lint`) by
 * handing the pipeline its own `gates` array; no role, prompt, or runner line
 * changes.
 *
 * The executor seam stays where `runner.ts` put it: this module only OWNS the
 * default wiring, so runner tests remain hermetic and the pipeline can inject
 * a fake the same way.
 */
import { spawn } from "node:child_process";
import type { CommandExecutor, ExecResult, QualityGate } from "./types";

/** Default per-gate capture ceiling, in bytes, across stdout and stderr combined. */
export const DEFAULT_GATE_CAPTURE_BYTES = 64 * 1024;

/**
 * One `QualityGate` per project command. These are WHOLE-PROJECT checks: the
 * caller runs them with an EMPTY file list -- the runner appends zero path
 * elements, so the argv is exactly what an operator would type and decides
 * over the whole working directory. `kind: "project"` marks each because none
 * of them reads per-file arguments.
 */
export const DEFAULT_PROJECT_GATES: readonly QualityGate[] = Object.freeze([
  {
    name: "bun-install --frozen-lockfile",
    kind: "project",
    command: ["bun", "install", "--frozen-lockfile"],
  },
  { name: "bun run typecheck", kind: "project", command: ["bun", "run", "typecheck"] },
  { name: "bun run test", kind: "project", command: ["bun", "run", "test"] },
  { name: "bun run check", kind: "project", command: ["bun", "run", "check"] },
  { name: "bun run check:release", kind: "project", command: ["bun", "run", "check:release"] },
  { name: "bun run check:docs", kind: "project", command: ["bun", "run", "check:docs"] },
  // Issue #474: a rebase-resolved tree can carry markers no other gate reads;
  // deterministic, whole-project, cheap `git grep --cached` over the index projection.
  {
    name: "bun run check:conflict-markers",
    kind: "project",
    command: ["bun", "run", "check:conflict-markers"],
  },
  { name: "bun run smoke:artifact", kind: "project", command: ["bun", "run", "smoke:artifact"] },
  // NOT here, deliberately (issue #271): `bun run stamp:check` is this
  // repository's PRE-MERGE gate, run by the operator or CI, not an in-run
  // gate. Its property only exists at settle: the review stamp is derived from
  // the settled result (verdict, run ids, per-stage reviewer, tree digest of
  // the reviewed tree) by `runPipeline`'s settle path -- the ONLY writer, and
  // deliberately not a model (issue #239). Inside a run the gate report is
  // always stale-red on a moved tree, a red report returns to the coder with
  // blocking evidence, and the code's assigned fix -- write the stamp -- is
  // exactly what the run performs itself, later, only once the gate lets it
  // reach review: the review-then-stamp loop is unresolvable from inside a
  // run. No stamp, a malformed stamp, or a digest mismatch therefore fails the
  // MERGE like any red gate, after the run that owns the write has settled. A
  // different project substitutes its own gate list and never sees either
  // layer.
]);

/**
 * The real spawn executor the GateRunner was designed around (its module doc
 * holds the seam and `runner.ts` says wiring one is a deliberate, separate
 * follow-up -- this is that follow-up, at the declared-gate boundary, not
 * inside the runner).
 *
 * Invariants held in code, not merely documented:
 *  - argv is handed to `spawn` as a DISCRETE array -- no shell, no shell
 *    string, nothing interpolated (the flat security surface the runner
 *    established).
 *  - Captured output is capped at `maxCaptureBytes` across both streams
 *    combined, with a positive mandatory default (the DoS ceiling
 *    `docs/contracts/quality.md` requires for gate output). Once the cap is
 *    hit the extra data is discarded and a marker appended -- a tool that
 *    prints megabytes cannot flood memory or the next model turn.
 *  - A spawn-level failure (missing binary, permission denied) becomes a
 *    failed `ExecResult` with the error in `stderr`, letting the runner's
 *    fail-loud conversion mark THAT gate red instead of rejecting the report.
 */
export function createSpawnCommandExecutor(
  maxCaptureBytes: number = DEFAULT_GATE_CAPTURE_BYTES,
): CommandExecutor {
  if (!Number.isSafeInteger(maxCaptureBytes) || maxCaptureBytes <= 0)
    throw new Error("maxCaptureBytes must be a positive safe integer");
  return async (argv: string[], cwd: string): Promise<ExecResult> => {
    const chunks: string[] = [];
    let captured = 0;
    let truncated = false;
    const drain = (stream: NodeJS.ReadableStream): void => {
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        if (captured >= maxCaptureBytes) {
          truncated = true;
          return;
        }
        const bytes = Buffer.byteLength(chunk);
        if (captured + bytes > maxCaptureBytes) {
          // Keep a prefix within the ceiling; the surplus is discarded and the
          // marker (appended at close) says so.
          chunks.push(chunk.slice(0, Math.max(0, maxCaptureBytes - captured)));
          captured = maxCaptureBytes;
          truncated = true;
          return;
        }
        captured += bytes;
        chunks.push(chunk);
      });
    };
    // noUncheckedIndexedAccess: a declared argv without leading program text is
    // a BAD DECLARATION, not something to hand the spawn -- fail that gate.
    const program = argv[0];
    if (program === undefined) {
      return { exitCode: 1, stdout: "", stderr: "gate command argv is empty" };
    }
    const child = spawn(program, argv.slice(1), {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.on("error", (error: Error): void => {
      chunks.push(`spawn failed: ${error.message}`);
    });
    drain(child.stdout);
    drain(child.stderr);
    return await new Promise((resolve) => {
      child.on("error", (error: Error): void => {
        resolve({ exitCode: 1, stdout: "", stderr: `spawn failed: ${error.message}` });
      });
      child.on("close", (code: number | null): void => {
        const text = chunks.join("");
        resolve({
          exitCode: code ?? 1,
          stdout: "",
          stderr: truncated ? `${text}\n[capture truncated]` : text,
        });
      });
    });
  };
}
