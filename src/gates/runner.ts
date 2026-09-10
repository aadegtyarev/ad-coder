import * as fs from "node:fs";
import type {
  CommandExecutor,
  GateReport,
  GateResult,
  QualityGate,
} from "./types";

/**
 * Default ceiling on a single gate's captured output, in characters. External
 * tools can print unboundedly (a lint run over a large tree, a hostile or broken
 * tool spewing megabytes); capping here keeps a report small enough to feed back
 * as a model turn's input and denies a verbose tool the ability to flood it.
 */
const DEFAULT_MAX_OUTPUT_CHARS = 4000;

/**
 * Runs declared quality gates over a set of file paths and returns a fail-loud
 * report. The whole external path goes through an INJECTED `CommandExecutor`
 * seam — the runner never spawns a process itself — so the entire runner is
 * testable with a fake and nothing shells out.
 *
 * Two invariants hold the security surface flat, and both are enforced here, not
 * merely documented:
 *  - Commands are always argv ARRAYS handed straight to the executor. The runner
 *    never builds a shell string and never routes through a shell.
 *  - File PATHS are appended as discrete trailing argv elements. File CONTENTS
 *    are never read into or interpolated into a command — the size gate reads
 *    contents in-process only, and never to build argv.
 */
export class GateRunner {
  private readonly executor: CommandExecutor;
  private readonly cwd: string;
  private readonly maxOutputChars: number;

  constructor(deps: {
    executor: CommandExecutor;
    cwd?: string;
    maxOutputChars?: number;
  }) {
    this.executor = deps.executor;
    this.cwd = deps.cwd ?? process.cwd();
    this.maxOutputChars = deps.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  }

  /**
   * Run every gate in order over `files` and aggregate. `passed` is the AND of
   * all results, so one failing gate fails the report while every result is
   * still reported — the caller sees exactly which gates failed.
   */
  async run(gates: QualityGate[], files: string[]): Promise<GateReport> {
    const results: GateResult[] = [];
    for (const gate of gates) {
      results.push(await this.runOne(gate, files));
    }
    return { results, passed: results.every((r) => r.passed) };
  }

  /**
   * Run one gate, converting any thrown failure into a failed GateResult rather
   * than letting it escape `run()`. A gate's executor can reject (a real spawn
   * hitting ENOENT/EACCES on a missing tool) and the size gate's readFileSync
   * can throw (missing file, permission denied, non-utf8); either must surface
   * as THAT gate failing, never as the whole report rejecting for every gate and
   * file. This is the same fail-loud-but-don't-throw idiom the Ledger and
   * Compactor already use.
   */
  private async runOne(gate: QualityGate, files: string[]): Promise<GateResult> {
    try {
      if (gate.kind === "size" && gate.command === undefined) {
        return this.runSizeGate(gate, files);
      }
      return await this.runExternalGate(gate, files);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        name: gate.name,
        kind: gate.kind,
        passed: false,
        output: this.truncate(`gate ${gate.name} (kind ${gate.kind}) errored: ${message}`),
      };
    }
  }

  /**
   * External gate. When `autofix` is declared it runs FIRST — its argv plus the
   * files — to mutate files into shape; its result is surfaced only through the
   * later check and never decides pass/fail. The check argv plus the files then
   * runs, and the gate passes iff the check's exitCode is 0. Both invocations
   * hand the executor a discrete argv array — the files are appended as separate
   * trailing elements, never joined.
   */
  private async runExternalGate(
    gate: QualityGate,
    files: string[],
  ): Promise<GateResult> {
    if (gate.command === undefined) {
      return {
        name: gate.name,
        kind: gate.kind,
        passed: false,
        output: `gate ${gate.name} (kind ${gate.kind}): no command declared`,
      };
    }
    if (gate.autofix !== undefined) {
      await this.executor([...gate.autofix, ...files], this.cwd);
    }
    const check = await this.executor([...gate.command, ...files], this.cwd);
    return {
      name: gate.name,
      kind: gate.kind,
      passed: check.exitCode === 0,
      output: this.truncate(`${check.stdout}${check.stderr}`),
    };
  }

  /**
   * In-process size gate. Reads each file's contents (utf8) only to COUNT lines
   * — contents never touch an argv — and fails the gate if any file exceeds
   * `maxLinesPerFile`. On failure `output` names each offending file and its
   * exact line count, so a caller reads what to shrink without re-reading the
   * files.
   */
  private runSizeGate(gate: QualityGate, files: string[]): GateResult {
    if (gate.maxLinesPerFile === undefined) {
      return {
        name: gate.name,
        kind: gate.kind,
        passed: false,
        output: `size gate ${gate.name}: maxLinesPerFile not declared`,
      };
    }
    const max = gate.maxLinesPerFile;
    const offenders: string[] = [];
    for (const file of files) {
      const count = countLines(fs.readFileSync(file, "utf8"));
      if (count > max) {
        offenders.push(`${file}: ${count} lines exceeds max ${max}`);
      }
    }
    return {
      name: gate.name,
      kind: gate.kind,
      passed: offenders.length === 0,
      output: this.truncate(offenders.join("\n")),
    };
  }

  /**
   * Cap `text` at `maxOutputChars` and append a marker naming how much was cut,
   * so a bounded excerpt is self-describing. Applied to every result's output.
   */
  private truncate(text: string): string {
    if (text.length <= this.maxOutputChars) {
      return text;
    }
    const kept = text.slice(0, this.maxOutputChars);
    return `${kept}… [truncated ${this.maxOutputChars} of ${text.length} chars]`;
  }
}

/**
 * Count logical lines in file contents. A trailing newline is the terminator of
 * its line, not the start of a new empty one: "a\nb\n" is 2 lines, "a\nb" is 2,
 * "" is 0. This fixes the `split('\n').length` off-by-one so the threshold
 * comparison is unambiguous.
 */
function countLines(contents: string): number {
  if (contents.length === 0) {
    return 0;
  }
  const withoutTrailing = contents.endsWith("\n") ? contents.slice(0, -1) : contents;
  return withoutTrailing.split("\n").length;
}
