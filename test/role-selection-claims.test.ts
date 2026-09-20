import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveSkills } from "ad-coder";

/**
 * The surfaces a model reads as instructions, and the surfaces that only
 * describe them -- pinned to each other.
 *
 * The role-selection rule (#527) lives in three places that no compiler reads:
 * the shipped skill (its description, which is what makes a model load it, and
 * its instructions), and two dated contract entries that state the same order
 * for a human. The eval probe that measures the trigger is a fourth: it replays
 * a prompt and scores the run's recorded tool activity. Measured in review
 * round 5 (#527): replacing the probe's target prompt with "What is the
 * weather?" left every test green, and inverting either contract entry did the
 * same -- the rule was pinned on the skill's own text and nowhere else, so the
 * probe could stop probing and the contracts could start contradicting the
 * skill in silence.
 *
 * So these tests read the probe and the contracts and compare them to the
 * shipped surface they describe. The order is pinned as an ORDER (positions),
 * not as the presence of three phrases: a rewritten sentence that keeps the
 * words but reverses the rungs is exactly the drift this is for.
 *
 * Each half was measured against its own removal before it was claimed: the
 * probe's target prompt replaced by "What is the weather?" in both of its
 * copies, and in the top-level copy alone; a non-target prompt given the
 * target's own trigger; the `Phrases:` clause dropped from the description
 * while the manifest still resolves; the order inverted on the skill, in
 * docs/contracts/operation-modes.md and in docs/contracts/skills.md -- seven
 * edits, seven red runs, each turning red the one test named below for that
 * surface. The description control is the one that can take both tests down
 * instead of one: a manifest that no longer resolves the skill at all -- its
 * `description` key gone rather than its phrase list -- fails at
 * `resolveSkills` before either test's claim is reached, measured 0 pass /
 * 2 fail against 1 pass / 1 fail for the phrase list alone. Still a red gate
 * for the same edit, and worth knowing which one you are looking at.
 */

const REPO_ROOT = path.join(import.meta.dir, "..");

function read(relative: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relative), "utf8");
}

/** Prompts and contracts are hard-wrapped; a phrase may straddle a newline. */
function flat(text: string): string {
  return text.replace(/\s+/g, " ");
}

function skill(id: string): { description: string; instructions: string } {
  const resolved = resolveSkills([id])[0];
  if (resolved === undefined) throw new Error(`${id} did not resolve`);
  return resolved;
}

/**
 * Case- and punctuation-insensitive: the description quotes its triggers
 * lowercased and unpunctuated ("should I delegate or run it myself"), the probe
 * asks them as a person does ("Should I delegate or run it myself?").
 */
function normalized(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** The trigger phrases a shipped description declares: `Phrases: 'a', 'b'.` */
function declaredTriggers(description: string): string[] {
  const list = /Phrases:((?:\s*'[^']*',?)+)/.exec(description)?.[1];
  if (list === undefined) return [];
  return [...list.matchAll(/'([^']+)'/g)].map((match) => match[1] ?? "");
}

test("the eval probe's target prompt is the trigger its description declares (#527)", () => {
  const task = JSON.parse(read("evals/tasks/skill-trigger-role-selection-v1.json")) as {
    prompt?: unknown;
    prompts?: unknown;
    skillTrigger?: {
      skill?: unknown;
      targetPromptIndex?: unknown;
      nonTargetPromptIndexes?: unknown;
    };
  };
  const prompts = Array.isArray(task.prompts) ? task.prompts : [];
  const target = task.skillTrigger?.targetPromptIndex;
  const nonTargets = task.skillTrigger?.nonTargetPromptIndexes;
  // The probe declares its own expectations, so a probe that stopped naming
  // the skill, the target turn, or its negative controls is a finding here
  // rather than a red gate at scoring time.
  expect(task.skillTrigger?.skill).toBe("role-selection");
  expect(typeof target).toBe("number");
  if (!Array.isArray(nonTargets) || nonTargets.length === 0)
    throw new Error("the probe declares no non-target prompts");
  const promptAt = (index: unknown): string => {
    const value = typeof index === "number" ? prompts[index] : undefined;
    if (typeof value !== "string")
      throw new Error(`the probe declares no prompt at index ${String(index)}`);
    return value;
  };
  const targetPrompt = promptAt(target);
  // The single replayed turn is the same text as the target turn: the fixture
  // carries the prompt twice (top level and in the list), and a copy that
  // drifted from the list would be scored as one prompt while quoting another.
  expect(task.prompt).toBe(targetPrompt);
  const triggers = declaredTriggers(skill("role-selection").description);
  // A description that stopped declaring triggers would leave the loops below
  // vacuously green, and a probe whose target carries nothing the description
  // promises is a probe measuring nothing.
  expect(triggers.length).toBeGreaterThan(0);
  for (const phrase of triggers) {
    expect({ phrase, targetPrompt: normalized(targetPrompt) }).toEqual({
      phrase,
      targetPrompt: expect.stringContaining(normalized(phrase)),
    });
  }
  for (const index of nonTargets) {
    const nonTargetPrompt = normalized(promptAt(index));
    for (const phrase of triggers) {
      // A negative control carrying the target's own trigger measures nothing:
      // the scorer reads a legitimate load of the skill as a misfire.
      expect({ index, phrase, nonTargetPrompt }).toEqual({
        index,
        phrase,
        nonTargetPrompt: expect.not.stringContaining(normalized(phrase)),
      });
    }
  }
});

const RUNGS = [
  { rung: "own hands", pattern: /own hands/i },
  { rung: "one role", pattern: /one (?:role|`run_role`)/i },
  { rung: "the pipeline", pattern: /the pipeline/i },
] as const;

/** The rungs a statement names, in the order it names them (first mention each). */
function rungOrder(statement: string): string[] {
  return RUNGS.flatMap(({ rung, pattern }) => {
    const at = statement.search(pattern);
    return at < 0 ? [] : [{ rung, at }];
  })
    .sort((left, right) => left.at - right.at)
    .map((found) => found.rung);
}

/**
 * The preference statement on a surface: from the anchor that introduces it to
 * the first mention of its last rung. Bounding it is what makes the pin about
 * the ORDER: both contract entries name "the pipeline" earlier, for other
 * reasons, and an unbounded read would sort those mentions instead of the
 * claim -- and the entry is prose, so the surrounding sentences are free to
 * move.
 */
function preferenceStatement(file: string, text: string, anchor: string): string {
  const at = text.indexOf(anchor);
  if (at < 0)
    throw new Error(`${file} no longer states the order of preference: missing "${anchor}"`);
  const tail = text.slice(at);
  const end = tail.search(/the pipeline/i);
  if (end < 0) throw new Error(`${file} names no pipeline in its preference statement`);
  return tail.slice(0, end + "the pipeline".length);
}

test("the order of preference reads the same in the skill and in both dated entries (#527)", () => {
  const surfaces = [
    {
      file: "the shipped role-selection skill",
      text: flat(skill("role-selection").instructions),
      anchor: "The order of preference is",
    },
    {
      file: "docs/contracts/operation-modes.md",
      text: flat(read("docs/contracts/operation-modes.md")),
      anchor: "Preference runs the orchestrator's own hands",
    },
    {
      file: "docs/contracts/skills.md",
      text: flat(read("docs/contracts/skills.md")),
      anchor: "The skill now holds the order of preference",
    },
  ];
  const expected = ["own hands", "one role", "the pipeline"];
  for (const { file, text, anchor } of surfaces) {
    const statement = preferenceStatement(file, text, anchor);
    // The file name rides in the compared object, so a failure says which
    // surface drifted instead of printing three bare arrays.
    expect({ file, order: rungOrder(statement) }).toEqual({ file, order: expected });
  }
});
