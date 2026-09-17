/**
 * Quality gates are the "gates over prompts" principle made concrete: a
 * deterministic, mechanical check run BEFORE an LLM review round because it
 * costs no tokens. A gate that a machine can decide (does it format-clean, does
 * it lint, does it typecheck, is a file under a size ceiling) should never be
 * spent on a model turn — the model reviews what a gate cannot.
 *
 * Everything here is DATA. A `QualityGate` names a check and carries the argv to
 * run it; nothing about a language, linter, or provider is hardcoded. That keeps
 * the runner agnostic and, crucially, keeps the security surface flat: the
 * runner only ever assembles argv arrays from caller-declared commands plus
 * supplied file paths — never a shell string, never file contents.
 */

/**
 * The checks the runner understands. `format`, `lint` and `typecheck` are
 * external — they run through the injected executor against a caller-declared
 * command. `size` is in-process: it reads files and counts lines itself, with no
 * executor call and no external tool, so a project gets a cheap structural gate
 * with zero setup. `project` is external like format/lint/typecheck but runs a
 * WHOLE-PROJECT command over the declared file list (normally an EMPTY list,
 * i.e. no path arguments appended) — the declared project gates (#227) all land
 * here, because `bun run check` decides over the repository, not over files.
 */
export type QualityGateKind = "format" | "lint" | "typecheck" | "size" | "project";

/**
 * One declared check. `command` is the argv (program plus flags) whose exit code
 * decides pass/fail; supplied file paths are appended to it as discrete trailing
 * elements (for a `project` gate the caller passes none — the argv still decides
 * over the whole working tree). `autofix`, when present, is the argv run FIRST to mutate files into
 * shape before the check (e.g. `prettier --write`) — its result never decides
 * pass/fail. `maxLinesPerFile` applies only to a `size` gate.
 *
 * Optional fields use `?` and are simply absent when unset — never assigned
 * `undefined` — because exactOptionalPropertyTypes is on.
 */
export interface QualityGate {
  name: string;
  kind: QualityGateKind;
  command?: string[];
  autofix?: string[];
  maxLinesPerFile?: number;
}

/** What the injected executor returns for one command run. */
export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * The seam that actually runs an external command. Injected exactly like the
 * Ledger's sink and the Compactor's `Summarizer`: the runner never spawns a
 * process itself, so tests hand it a fake and nothing shells out. `argv` is
 * always a discrete array (spawn-style, no shell); `cwd` is the working
 * directory. No real spawn-based implementation ships in this module — wiring a
 * real executor is a deliberate, separate follow-up.
 */
export type CommandExecutor = (argv: string[], cwd: string) => Promise<ExecResult>;

/**
 * The outcome of one gate. `passed` is the machine verdict; `output` is a
 * BOUNDED excerpt of what the gate produced — for an external gate the truncated
 * stdout+stderr, for a size gate a fail-loud line naming each offending file and
 * its line count. Output is capped before it ever lands here so a verbose or
 * hostile tool cannot flood a caller's next-turn context.
 */
export interface GateResult {
  name: string;
  kind: QualityGateKind;
  passed: boolean;
  output: string;
}

/**
 * The aggregate. `passed` is the AND of every result, and `results` names each
 * gate's verdict in order — so a caller can feed exactly the failing gates back
 * as the next turn's input.
 */
export interface GateReport {
  results: GateResult[];
  passed: boolean;
}
