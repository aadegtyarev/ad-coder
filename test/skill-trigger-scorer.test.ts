import { describe, expect, test } from "bun:test";
import {
  parseCapture,
  scoreSkillTrigger,
  taskFileFromSample,
} from "../evals/scorers/skill-trigger";

/**
 * The scorer reads recorded captures, so its tests feed recorded-shaped
 * fixtures: the lines a `console --json` session writes to stderr -- progress
 * markers, tool_activity records, drop notices -- with the prose lines a real
 * capture also carries. Nothing here dispatches a model.
 */

const TASK = {
  id: "skill-trigger-fixture-v1",
  prompts: ["the target prompt", "a non-target prompt", "another non-target prompt"],
  skillTrigger: {
    skill: "delivery-calibration",
    targetPromptIndex: 0,
    nonTargetPromptIndexes: [1, 2],
  },
};

const MARKER = JSON.stringify({
  type: "progress",
  event: "started",
  stage: "console-turn",
  elapsedSeconds: 0,
});

function loadSkill(
  skillId: string | undefined,
  toolCallId = "call-1",
  lifecycle = "completed",
): string {
  return JSON.stringify({
    schemaVersion: 1,
    type: "tool_activity",
    sequence: 1,
    timestamp: "2026-09-19T10:00:00.000Z",
    lifecycle,
    activity: "Read",
    role: "orchestrator",
    runId: "run-x",
    operationId: "op-1",
    turnId: "turn-1",
    toolCallId,
    parentOperation: "console",
    toolName: "load_skill",
    droppedCount: 0,
    ...(skillId === undefined ? {} : { projection: { skillId } }),
  });
}

const CHANNEL_DROP = JSON.stringify({
  schemaVersion: 1,
  type: "tool_activity_drop",
  sequence: 40,
  timestamp: "2026-09-19T10:00:02.000Z",
  dropped: 2,
  droppedCount: 2,
});

const RENDER_DROP = JSON.stringify({
  schemaVersion: 1,
  type: "tool_activity_render_drop",
  dropped: 1,
});

/** A three-turn session capture, one line-group per declared prompt. */
function session(...turns: string[][]): string {
  const lines: string[] = ["ad-coder: ledger=/tmp/run/ledger.jsonl"];
  for (const turn of turns) {
    lines.push(MARKER);
    lines.push(...turn);
  }
  return `${lines.join("\n")}\n`;
}

const CHECK_IDS = [
  "activity-captured",
  "target-prompt-loads-skill",
  "non-target-prompts-do-not-load-skill",
  "load-skill-calls-attributable",
];

function passed(checks: { id: string; passed: boolean }[]): boolean[] {
  expect(checks.map((check) => check.id)).toEqual(CHECK_IDS);
  return checks.map((check) => check.passed);
}

describe("skill-trigger scorer", () => {
  test("a target turn that loaded the skill and clean non-targets scores every check", () => {
    const checks = scoreSkillTrigger(
      session(
        [
          loadSkill("delivery-calibration", "call-1", "requested"),
          loadSkill("delivery-calibration"),
        ],
        [],
        [],
      ),
      TASK,
    );
    // A turn whose marker exists but produced no tool call still counts as a
    // turn: an orchestrator that answers without tools is a real outcome, not
    // a missing turn.
    expect(passed(checks)).toEqual([true, true, true, true]);
  });

  test("a JSON-array capture is read the same as the recorded JSONL", () => {
    const array = JSON.stringify([
      JSON.parse(MARKER),
      JSON.parse(loadSkill("delivery-calibration")),
      JSON.parse(MARKER),
      JSON.parse(MARKER),
    ]);
    expect(passed(scoreSkillTrigger(array, TASK))).toEqual([true, true, true, true]);
  });

  test("a non-target prompt that loads the expected skill is a finding", () => {
    const checks = scoreSkillTrigger(
      session(
        [loadSkill("delivery-calibration")],
        [loadSkill("delivery-calibration", "call-2")],
        [],
      ),
      TASK,
    );
    expect(passed(checks)).toEqual([true, true, false, true]);
  });

  test("a non-target prompt that loads a DIFFERENT skill is correct behaviour", () => {
    // The situations are adjacent on purpose: the role-selection phrasing in a
    // delivery-calibration task may legitimately load role-selection. Only a
    // load of the EXPECTED skill is a misfire.
    const checks = scoreSkillTrigger(
      session([loadSkill("delivery-calibration")], [loadSkill("role-selection", "call-2")], []),
      TASK,
    );
    expect(passed(checks)).toEqual([true, true, true, true]);
  });

  test("a target prompt that never loads fails the target check alone", () => {
    const checks = scoreSkillTrigger(session([], [loadSkill("task-slicing", "call-2")], []), TASK);
    expect(passed(checks)).toEqual([true, false, true, true]);
  });

  test("a load through the advertised address is a load of that skill (issue #524)", () => {
    // The catalogue shows `<id>@<version>` and the loader accepts it, so the
    // capture of a role that copied the row must score as a trigger. Before
    // this, the projected identity `delivery-calibration@3` was compared to the
    // bare expected id and every address-shaped load scored a MISS -- an eval
    // that reports the loader's fix as a regression.
    const checks = scoreSkillTrigger(session([loadSkill("delivery-calibration@3")], [], []), TASK);
    expect(passed(checks)).toEqual([true, true, true, true]);
    // A version is any non-empty string, `@` inside one included: the row is
    // matched whole, never re-split at the last `@`.
    const atInVersion = scoreSkillTrigger(
      session([loadSkill("delivery-calibration@v@2")], [], []),
      TASK,
    );
    expect(passed(atInVersion)).toEqual([true, true, true, true]);
  });

  test("the address boundary is the `@`, not a prefix and not a bare one", () => {
    // An id that merely STARTS with the expected one is a different skill.
    const neighbour = scoreSkillTrigger(
      session([loadSkill("delivery-calibration-extra@1")], [], []),
      TASK,
    );
    expect(passed(neighbour)).toEqual([true, false, true, true]);
    // `id@` names no version, so it is not an address for `id`: the load is not
    // credited, and the record is still attributable (it names a skill id).
    const dangling = scoreSkillTrigger(session([loadSkill("delivery-calibration@")], [], []), TASK);
    expect(passed(dangling)).toEqual([true, false, true, true]);
    // The advertised address also fires on a NON-target turn -- the misfire rule
    // is about the skill, not about the spelling it was named in.
    const misfire = scoreSkillTrigger(
      session([loadSkill("delivery-calibration")], [loadSkill("delivery-calibration@3", "c2")], []),
      TASK,
    );
    expect(passed(misfire)).toEqual([true, true, false, true]);
  });

  test("an unattributable load_skill record is a finding, never a pass", () => {
    for (const skillId of [undefined, "unknown"]) {
      const checks = scoreSkillTrigger(session([loadSkill(skillId)], [], []), TASK);
      // The target check cannot credit an unknown id, and the attribution
      // guard fails on its own; a capture from a build older than the
      // identifier field fails loudly rather than passing silently.
      expect(passed(checks)).toEqual([true, false, true, false]);
    }
  });

  test("an empty capture fails every check", () => {
    const checks = scoreSkillTrigger("", TASK);
    expect(passed(checks)).toEqual([false, false, false, false]);
    expect(checks[0]?.detail).toContain("no tool_activity records");
  });

  test("a capture with fewer turn markers than declared prompts fails every check", () => {
    const checks = scoreSkillTrigger(session([loadSkill("delivery-calibration")], []), TASK);
    expect(passed(checks)).toEqual([false, false, false, false]);
    expect(checks[0]?.detail).toContain("found 2");
  });

  test("records before the first turn marker fail every check", () => {
    const capture = ["ad-coder: ledger=/tmp/run/ledger.jsonl", loadSkill("delivery-calibration")]
      .concat(session([loadSkill("delivery-calibration", "call-2")], [], []).split("\n"))
      .join("\n");
    const checks = scoreSkillTrigger(capture, TASK);
    expect(passed(checks)).toEqual([false, false, false, false]);
    expect(checks[0]?.detail).toContain("before the first turn marker");
  });

  test("a capture that dropped events fails every check, whatever it did record", () => {
    for (const drop of [CHANNEL_DROP, RENDER_DROP]) {
      const capture = `${session([loadSkill("delivery-calibration")], [], [])}${drop}\n`;
      const checks = scoreSkillTrigger(capture, TASK);
      expect(passed(checks)).toEqual([false, false, false, false]);
      expect(checks[0]?.detail).toContain("drop notice");
    }
  });

  test("prose lines on the recorded stream do not affect the score", () => {
    const checks = scoreSkillTrigger(
      session([loadSkill("delivery-calibration")], [], []).replace(
        "ad-coder: ledger=/tmp/run/ledger.jsonl",
        "ad-coder: ledger=/tmp/run/ledger.jsonl\nad-coder: context compacted 1 time(s)",
      ),
      TASK,
    );
    expect(passed(checks)).toEqual([true, true, true, true]);
  });

  test("malformed expectations stop the scorer instead of scoring nothing", () => {
    for (const task of [
      { prompts: [] },
      {
        prompts: ["a"],
        skillTrigger: { skill: "x", targetPromptIndex: 0, nonTargetPromptIndexes: [] },
      },
      {
        prompts: ["a", "b"],
        skillTrigger: { skill: "x", targetPromptIndex: 0, nonTargetPromptIndexes: [0, 1] },
      },
      {
        prompts: ["a", "b"],
        skillTrigger: { skill: "x", targetPromptIndex: 5, nonTargetPromptIndexes: [1] },
      },
      { prompts: ["a", "b"] },
    ]) {
      expect(() => scoreSkillTrigger("", task)).toThrow();
    }
  });

  test("a checked-in sample's name resolves its task file", () => {
    const task = taskFileFromSample(
      "/anywhere/evals/samples/skill-trigger-delivery-calibration-v1.fail.json",
    );
    expect(task.endsWith("evals/tasks/skill-trigger-delivery-calibration-v1.json")).toBe(true);
    expect(() => taskFileFromSample("/anywhere/activity.jsonl")).toThrow("cannot infer");
  });

  test("the capture parser keeps only the events the scorer can attribute", () => {
    const events = parseCapture(
      [MARKER, loadSkill("delivery-calibration"), CHANNEL_DROP, "not json at all", ""].join("\n"),
    );
    expect(events).toHaveLength(3);
    expect(events.map((event) => event.kind)).toEqual(["turn-start", "activity", "channel-drop"]);
  });
});
