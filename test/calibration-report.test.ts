import { describe, expect, test } from "bun:test";
import { buildOrchestratorReport, extractJsonArtifact, statedTier } from "../evals/runner/report";
import type { LedgerRecord } from "../src/ledger/types";

function row(role: string, step: string): LedgerRecord {
  return {
    ts: 1,
    runId: "run",
    lane: "main",
    role,
    step,
    provider: "test",
    model: "m",
    stopReason: "stop",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

describe("orchestrator run report", () => {
  test("credits a classification only when nothing delegating ran first", () => {
    const early = buildOrchestratorReport({
      taskId: "t",
      turns: [{ assistantText: "evidence...\nCOMPLEXITY: complex" }],
      ledger: [],
    });
    expect(early).toMatchObject({
      predictedComplexity: "complex",
      predictedBeforeDelegation: true,
    });

    const late = buildOrchestratorReport({
      taskId: "t",
      turns: [
        {
          assistantText: "COMPLEXITY: complex",
          toolCalls: [{ toolName: "run_role" }],
        },
      ],
      ledger: [],
    });
    expect(late).toMatchObject({
      predictedComplexity: "complex",
      predictedBeforeDelegation: false,
    });
  });

  test("proves planner delegation from the ledger, not from the tool name", () => {
    // The console projection carries tool NAMES only, so `run_role` alone can
    // never say WHICH role was delegated; the ledger step does.
    const turns = [{ assistantText: "", toolCalls: [{ toolName: "run_role" }] }];
    expect(buildOrchestratorReport({ taskId: "t", turns, ledger: [] }).plannerDelegated).toBe(
      false,
    );
    expect(
      buildOrchestratorReport({
        taskId: "t",
        turns,
        ledger: [row("planner", "role:planner")],
      }).plannerDelegated,
    ).toBe(true);
  });

  test("derives the mode from the tools called, not from what the task declared", () => {
    const manual = buildOrchestratorReport({
      taskId: "t",
      turns: [{ toolCalls: [{ toolName: "run_step" }, { toolName: "choose_transition" }] }],
      ledger: [],
    });
    expect(manual.mode).toBe("manual-workflow");
    const automatic = buildOrchestratorReport({
      taskId: "t",
      turns: [{ toolCalls: [{ toolName: "run_step" }, { toolName: "run_pipeline" }] }],
      ledger: [],
    });
    expect(automatic.mode).toBe("automatic-pipeline");
  });

  test("takes the planner tier and approval from the workflow checkpoint", () => {
    const report = buildOrchestratorReport({
      taskId: "t",
      turns: [{ assistantText: "PLANNER_COMPLEXITY: medium" }],
      ledger: [row("reviewer", "review")],
      workflowState: { complexity: "complex", approved: true },
    });
    expect(report).toMatchObject({
      plannerComplexity: "complex",
      approved: true,
      roles: ["reviewer"],
    });
  });

  test("falls back to the relayed tier only when no checkpoint carries one", () => {
    const report = buildOrchestratorReport({
      taskId: "t",
      turns: [{ assistantText: "PLANNER_COMPLEXITY: medium" }],
      ledger: [],
    });
    expect(report.plannerComplexity).toBe("medium");
    expect(report.approved).toBe(false);
  });

  test("ignores a tier mentioned in prose", () => {
    expect(statedTier("this looks COMPLEXITY: complex to me", "COMPLEXITY")).toBeNull();
    expect(statedTier("COMPLEXITY: enormous", "COMPLEXITY")).toBeNull();
    expect(statedTier("COMPLEXITY: Complex", "COMPLEXITY")).toBe("complex");
  });

  test("extracts a fenced JSON artifact out of surrounding prose", () => {
    const stdout =
      'Here you go:\n```json\n[{"code":"a","note":"}] not the end"}]\n```\ncost: $0.10\n';
    expect(JSON.parse(extractJsonArtifact(stdout))).toEqual([
      { code: "a", note: "}] not the end" },
    ]);
    expect(() => extractJsonArtifact("no json here")).toThrow(/no JSON artifact/);
    expect(() => extractJsonArtifact('[{"a":1}')).toThrow(/unterminated/);
  });

  test("skips brackets in the prose before the answer", () => {
    // A live planner explained an id format as `[a-z0-9-]` above its plan. The
    // extractor returned that character class as the model's whole answer, the
    // scorer could not read it, and a run that passed every check was recorded
    // as `unreadable_answer` at quality 0.12 -- a model failure the harness
    // invented. A prose bracket does not parse; the answer does.
    const stdout = 'Ids match [a-z0-9-] only.\n[{"code":"a"}]\ncost: $0.01\n';
    expect(JSON.parse(extractJsonArtifact(stdout))).toEqual([{ code: "a" }]);
    // An object literal quoted in the explanation is balanced and still not the
    // answer, so balance alone cannot be the test.
    const quoted = 'Shape: {code: string}\nAnswer:\n{"code":"a"}\n';
    expect(JSON.parse(extractJsonArtifact(quoted))).toEqual({ code: "a" });
    // Nothing readable anywhere is distinct from nothing at all, and from a
    // truncated answer, because the three call for different responses.
    expect(() => extractJsonArtifact("ids match [a-z0-9-] only")).toThrow(/no readable JSON/);
  });

  test("the answer is the last top-level span, not the first thing that parses", () => {
    // Requiring the span to PARSE fixes the character-class case and not the
    // next one: prose can contain valid JSON too. The answer is what the role
    // finished with.
    const stdout = 'We considered {"a":1} first.\n{"answer":true}\ncost: $0.10\n';
    expect(JSON.parse(extractJsonArtifact(stdout))).toEqual({ answer: true });
    expect(JSON.parse(extractJsonArtifact('note [1,2] here\n[{"code":"x"}]\n'))).toEqual([
      { code: "x" },
    ]);
    // A nested span is part of the answer, never a rival to it: without skipping
    // the interior of an accepted span, an array's own last element would win.
    expect(JSON.parse(extractJsonArtifact('[{"code":"a"},{"code":"b"}]\n'))).toEqual([
      { code: "a" },
      { code: "b" },
    ]);
    // An answer spanning several lines still resolves: the line skip below only
    // applies to a bracket that closes NOWHERE, not to one closing further down.
    expect(JSON.parse(extractJsonArtifact('note\n[\n  {"code":"a"}\n]\n'))).toEqual([
      { code: "a" },
    ]);
  });

  test("an unclosed bracket does not make the scan quadratic", () => {
    // Every bracket after an unclosed one is also unclosed, and each rescanned
    // to the end: `"[ x"` repeated took 38 seconds at 288KB, which would stall a
    // sweep on one malformed answer. The scan now resumes at the next line.
    const hostile = "[ x".repeat(96_000);
    const started = Date.now();
    expect(() => extractJsonArtifact(hostile)).toThrow(/unterminated/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
