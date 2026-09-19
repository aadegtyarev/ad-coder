import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Scores skill triggering from a run's RECORDED TOOL ACTIVITY, not from the
 * model's answer.
 *
 * The task declares its expectations (`skillTrigger`: which skill, which prompt
 * is the target, which prompts are non-target) and the capture proves what the
 * roles actually did: a `console --json` session's stderr stream, recorded
 * verbatim -- one `tool_activity` record per line among the stream's progress
 * markers and human lines (docs/contracts/skill-authoring.md, Verification).
 * The target prompt must have produced a `load_skill` of the expected skill id;
 * the non-target prompts must have produced no load of it. A non-target prompt
 * that loads a DIFFERENT skill is correct behaviour -- the situations are
 * adjacent on purpose -- and is not a finding.
 *
 * FAIL CLOSED. An unusable capture proves nothing, so it passes nothing: a
 * capture with no activity records, with a turn count that does not match the
 * declared prompts, with records outside any turn, or with dropped events --
 * channel `tool_activity_drop` or renderer `tool_activity_render_drop`, either
 * of which means events happened that the capture cannot account for -- fails
 * every check. A `load_skill` record whose projection carries no skill id, or
 * the explicit marker "unknown" (docs/contracts/tool-observability.md,
 * 2026-09-19), is an unattributable load and a finding of its own. A capture
 * from a build older than the identifier field therefore fails loudly instead
 * of passing silently.
 *
 * A `load_skill` counts as fired from its REQUEST onward -- the ledger's
 * toolCalls are a request signal too -- so a refused or failed load still
 * measures triggering.
 *
 * Usage: skill-trigger <activity-capture> [task.json]. With one argument the
 * task file is inferred from a checked-in sample's name
 * (`<task-id>.<kind>.json`), which is how the corpus smoke exercises it; the
 * runner passes the task file explicitly for live runs.
 */

export interface SkillTriggerExpectations {
  /** The skill id the task's target prompt must load, exactly as shipped. */
  skill: string;
  /** Index into the task's `prompts` of the prompt that must load it. */
  targetPromptIndex: number;
  /** Indexes of the prompts that must not load it. */
  nonTargetPromptIndexes: number[];
}

export interface SkillTriggerCheck {
  id: string;
  passed: boolean;
  /** Counts and identifiers only, never task text -- like the ledger itself. */
  detail?: string;
}

type StreamEvent =
  | { kind: "turn-start" }
  | {
      kind: "activity";
      lifecycle: string;
      toolName: string;
      toolCallId: string;
      skillId: string | undefined;
    }
  | { kind: "channel-drop" }
  | { kind: "render-drop" };

function eventOf(value: unknown): StreamEvent | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.type === "tool_activity")
    return {
      kind: "activity",
      lifecycle: typeof record.lifecycle === "string" ? record.lifecycle : "unknown",
      toolName: typeof record.toolName === "string" ? record.toolName : "unknown",
      toolCallId: typeof record.toolCallId === "string" ? record.toolCallId : "unknown",
      skillId:
        typeof record.projection === "object" &&
        record.projection !== null &&
        typeof (record.projection as Record<string, unknown>).skillId === "string"
          ? ((record.projection as Record<string, unknown>).skillId as string)
          : undefined,
    };
  if (record.type === "tool_activity_drop") return { kind: "channel-drop" };
  if (record.type === "tool_activity_render_drop") return { kind: "render-drop" };
  if (record.type === "progress" && record.event === "started" && record.stage === "console-turn")
    return { kind: "turn-start" };
  return undefined;
}

/**
 * Reads a capture: one JSON value per line (the recorded stream's own shape)
 * or a single JSON array of the same values. Lines that are not JSON -- the
 * stream also carries the ledger path and human notices -- are ignored, as
 * they are in any real capture; the fail-closed surface is what is MISSING
 * from the parse, not the presence of prose.
 */
export function parseCapture(raw: string): StreamEvent[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed))
        return parsed.flatMap((value) => {
          const event = eventOf(value);
          return event === undefined ? [] : [event];
        });
    } catch {
      // Fall through to line parsing: an unparseable array leaves nothing
      // usable either way, and the scored checks report it.
    }
  }
  const events: StreamEvent[] = [];
  for (const line of raw.split("\n")) {
    const text = line.trim();
    if (text === "") continue;
    try {
      const event = eventOf(JSON.parse(text));
      if (event !== undefined) events.push(event);
    } catch {
      // Prose on the recorded stream; not evidence of anything.
    }
  }
  return events;
}

interface SegmentedCapture {
  /** How many console turns the capture marks -- one per declared prompt. */
  turns: number;
  /** Events by zero-based turn index; a turn may legitimately hold none. */
  segments: Map<number, StreamEvent[]>;
  /** Events recorded before any turn marker, belonging to no declared prompt. */
  preamble: StreamEvent[];
}

function segmentByTurn(events: StreamEvent[]): SegmentedCapture {
  let turns = 0;
  const segments = new Map<number, StreamEvent[]>();
  const preamble: StreamEvent[] = [];
  for (const event of events) {
    if (event.kind === "turn-start") {
      turns += 1;
      continue;
    }
    if (turns === 0) {
      preamble.push(event);
      continue;
    }
    const bucket = segments.get(turns - 1) ?? [];
    bucket.push(event);
    segments.set(turns - 1, bucket);
  }
  return { turns, segments, preamble };
}

const UNATTRIBUTABLE = new Set(["", "unknown"]);

export function readExpectations(task: unknown): {
  prompts: string[];
  expectations: SkillTriggerExpectations;
} {
  if (typeof task !== "object" || task === null) throw new Error("task must be a JSON object");
  const record = task as Record<string, unknown>;
  const prompts = record.prompts;
  if (
    !Array.isArray(prompts) ||
    prompts.length === 0 ||
    prompts.some((prompt) => typeof prompt !== "string" || prompt === "")
  )
    throw new Error("skill-trigger task must declare a non-empty prompts array of strings");
  const raw = record.skillTrigger;
  if (typeof raw !== "object" || raw === null)
    throw new Error("skill-trigger task must declare skillTrigger expectations");
  const expectations = raw as Record<string, unknown>;
  const skill = expectations.skill;
  if (typeof skill !== "string" || skill.trim() === "")
    throw new Error("skillTrigger.skill must name the expected skill id");
  const target = expectations.targetPromptIndex;
  if (
    typeof target !== "number" ||
    !Number.isInteger(target) ||
    target < 0 ||
    target >= prompts.length
  )
    throw new Error(`skillTrigger.targetPromptIndex must index the task's prompts: ${skill}`);
  const nonTargets = expectations.nonTargetPromptIndexes;
  if (
    !Array.isArray(nonTargets) ||
    nonTargets.length === 0 ||
    nonTargets.some(
      (index) =>
        typeof index !== "number" ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= prompts.length,
    )
  )
    throw new Error(`skillTrigger.nonTargetPromptIndexes must index the task's prompts: ${skill}`);
  if (new Set<number>([target, ...nonTargets]).size !== nonTargets.length + 1)
    throw new Error(`skillTrigger indexes must be distinct: ${skill}`);
  return {
    prompts: prompts as string[],
    expectations: {
      skill,
      targetPromptIndex: target,
      nonTargetPromptIndexes: nonTargets as number[],
    },
  };
}

function loadCallsOf(segment: StreamEvent[] | undefined, skill: string): Set<string> {
  const calls = new Set<string>();
  for (const event of segment ?? []) {
    if (event.kind !== "activity" || event.toolName !== "load_skill") continue;
    if (event.skillId === skill) calls.add(event.toolCallId);
  }
  return calls;
}

export function scoreSkillTrigger(capture: string, task: unknown): SkillTriggerCheck[] {
  const { prompts, expectations } = readExpectations(task);
  const events = parseCapture(capture);
  const { turns, segments, preamble } = segmentByTurn(events);
  const activity = events.filter((event) => event.kind === "activity");
  const channelDrops = events.filter((event) => event.kind === "channel-drop").length;
  const renderDrops = events.filter((event) => event.kind === "render-drop").length;
  // Fail-closed envelope: without a usable capture the declared prompts were
  // not observed, and every check would otherwise be answered by an absence.
  const unusable =
    activity.length === 0 ||
    channelDrops > 0 ||
    renderDrops > 0 ||
    turns !== prompts.length ||
    preamble.length > 0;
  const targetCalls = loadCallsOf(segments.get(expectations.targetPromptIndex), expectations.skill);
  const nonTargetCalls = expectations.nonTargetPromptIndexes.flatMap((index) => [
    ...loadCallsOf(segments.get(index), expectations.skill),
  ]);
  const unattributable = events.filter(
    (event) =>
      event.kind === "activity" &&
      event.toolName === "load_skill" &&
      (event.skillId === undefined || UNATTRIBUTABLE.has(event.skillId)),
  );
  const unusableReason = unusable
    ? activity.length === 0
      ? "the capture holds no tool_activity records"
      : channelDrops > 0 || renderDrops > 0
        ? `${channelDrops} channel and ${renderDrops} renderer drop notice(s): events happened that the capture cannot account for`
        : turns !== prompts.length
          ? `expected ${prompts.length} turn marker(s) for the declared prompts, found ${turns}`
          : "activity records appear before the first turn marker, outside every declared prompt"
    : `${activity.length} activity record(s) across ${prompts.length} turn(s), no drops`;
  const check = (id: string, passed: boolean, detail: string): SkillTriggerCheck => ({
    id,
    passed,
    detail,
  });
  return [
    check("activity-captured", !unusable, unusableReason),
    check(
      "target-prompt-loads-skill",
      !unusable && targetCalls.size > 0,
      `load_skill of ${expectations.skill} in the target turn: ${targetCalls.size} call(s)`,
    ),
    check(
      "non-target-prompts-do-not-load-skill",
      !unusable && nonTargetCalls.length === 0,
      `load_skill of ${expectations.skill} in non-target turns: ${nonTargetCalls.length} call(s)`,
    ),
    check(
      "load-skill-calls-attributable",
      !unusable && unattributable.length === 0,
      `load_skill record(s) without an attributable skill id: ${unattributable.length}`,
    ),
  ];
}

/**
 * The task file behind a checked-in sample: `evals/samples/<task-id>.<kind>.json`
 * names its task the way corpus smoke passes it -- one argument, the sample.
 */
export function taskFileFromSample(samplePath: string): string {
  const base = path.basename(samplePath).replace(/\.json$/, "");
  const match = /^(?<id>.+)\.(?<kind>pass|fail|alt|gamed)$/.exec(base);
  const id = match?.groups?.id;
  if (id === undefined)
    throw new Error(
      `cannot infer the task file from ${path.basename(samplePath)}; pass the task JSON as the second argument`,
    );
  return path.resolve(import.meta.dir, "..", "tasks", `${id}.json`);
}

if (import.meta.main) {
  const capturePath = process.argv[2];
  if (capturePath === undefined)
    throw new Error("usage: skill-trigger <activity-capture> [task.json]");
  const taskPath = process.argv[3] ?? taskFileFromSample(capturePath);
  const task = JSON.parse(fs.readFileSync(taskPath, "utf8")) as unknown;
  process.stdout.write(
    `${JSON.stringify(scoreSkillTrigger(fs.readFileSync(capturePath, "utf8"), task), null, 2)}\n`,
  );
}
