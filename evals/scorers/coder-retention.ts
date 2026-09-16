import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

interface Entry {
  id: string;
  writtenAt: number;
  lastReadAt?: number;
  pinned?: boolean;
}

const targetArg = process.argv[2];
if (!targetArg) throw new Error("usage: coder-retention <target-dir>");
const target: string = targetArg;

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1000 * DAY;
const MAX_AGE = 30;

/**
 * One entry set covering every case the fixture's two sources of truth
 * distinguish, plus the one neither states.
 *
 * `read-recently` is the interesting one: the CONTRACT does not mention reads
 * at all, and the dashboard's checked-in test asserts that a read defers expiry.
 * A model that reads only the contract will sweep it; one that reads only the
 * code will keep the majority behaviour and sweep it too. Reconciling the two
 * sources is the task.
 */
const ENTRIES: Entry[] = [
  { id: "old-unread", writtenAt: NOW - 40 * DAY },
  { id: "read-recently", writtenAt: NOW - 40 * DAY, lastReadAt: NOW - 2 * DAY },
  { id: "pinned", writtenAt: NOW - 40 * DAY, pinned: true },
  { id: "fresh", writtenAt: NOW - 1 * DAY },
];

/** Load a module from the target, or undefined when the model removed or broke it. */
async function load(file: string): Promise<Record<string, unknown> | undefined> {
  const full = path.join(target, file);
  if (!fs.existsSync(full)) return undefined;
  try {
    return (await import(`${pathToFileURL(full).href}?score=${Date.now()}`)) as Record<
      string,
      unknown
    >;
  } catch {
    return undefined;
  }
}

type Fn = (...args: unknown[]) => unknown;

/** Every source file in the target, so a check can ask what the tree looks like. */
function sources(): { file: string; text: string }[] {
  const dir = path.join(target, "src");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true })
    .map(String)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({ file: name, text: fs.readFileSync(path.join(dir, name), "utf8") }));
}

const sweeper = await load("src/sweeper.ts");
const preview = await load("src/preview.ts");
const dashboard = await load("src/dashboard.ts");
const alerts = await load("src/alerts.ts");

/**
 * What each surface says is expiring, as a set of ids.
 *
 * The three age-based surfaces are asked the same question with the same clock.
 * `expiringSoon` is deliberately excluded here: it answers a different question
 * (a week earlier) and has its own check.
 */
function reported(): { collect?: Set<string>; preview?: Set<string>; count?: number } {
  const call = <T>(fn: unknown): T | undefined => {
    if (typeof fn !== "function") return undefined;
    try {
      return (fn as Fn)(structuredClone(ENTRIES), NOW, MAX_AGE) as T;
    } catch {
      return undefined;
    }
  };
  const collected = call<Entry[]>(sweeper?.collectExpired);
  const previewed = call<string[]>(preview?.previewExpired);
  const counted = call<number>(dashboard?.countExpired);
  return {
    ...(Array.isArray(collected) && { collect: new Set(collected.map((entry) => entry.id)) }),
    ...(Array.isArray(previewed) && { preview: new Set(previewed) }),
    ...(typeof counted === "number" && { count: counted }),
  };
}

const answer = reported();

/** True when every age-based surface agrees that `id` is expiring (or is not). */
function allSay(id: string, expiring: boolean): boolean {
  const { collect, preview: previewed } = answer;
  if (collect === undefined || previewed === undefined) return false;
  return collect.has(id) === expiring && previewed.has(id) === expiring;
}

/**
 * Whether one expiry rule now serves every surface.
 *
 * Structural, so deliberately the lightest check: `refactor-config-v1` made the
 * opposite mistake and weighted shape above substance, so keeping the
 * duplication while breaking nothing scored most of the marks. What it catches
 * that behaviour cannot is three separately-corrected copies that happen to
 * agree today and diverge at the next rule change -- which is the defect the
 * fixture is about.
 */
function unifiesOnOneRule(): boolean {
  const files = sources();
  if (files.length === 0) return false;
  // The age comparison appears once in the tree. Each surface today writes its
  // own; a genuine extraction leaves exactly one, wherever the model put it.
  const comparisons = files.reduce(
    (total, { text }) => total + [...text.matchAll(/maxAgeDays\s*\*\s*DAY/g)].length,
    0,
  );
  return comparisons === 1;
}

const checks = [
  {
    // Contract line 1, asked of every surface. The sweeper and the preview both
    // delete a pinned entry today; only the dashboard knows better.
    id: "honours-pinned",
    passed: allSay("pinned", false) && answer.count !== undefined,
  },
  {
    // The rule the CONTRACT never states. It lives in the dashboard's
    // checked-in test, which asserts that a read defers expiry -- so a model
    // that reads only the contract, or that follows the majority of the code,
    // gets this wrong. Reconciling two sources that disagree is the work.
    id: "reconciles-read-refresh",
    passed: allSay("read-recently", false),
  },
  {
    // The rule still has to expire something: without this, deleting the
    // predicate and reporting nothing passes both checks above.
    id: "still-expires-the-expired",
    passed: allSay("old-unread", true) && allSay("fresh", false),
  },
  {
    // Contract line 2. The count is a separate surface computing the same
    // question, so it must land on the same answer as the other two.
    id: "surfaces-agree",
    passed:
      answer.count !== undefined &&
      answer.collect !== undefined &&
      answer.count === answer.collect.size,
  },
  {
    // Contract line 3. `expiringSoon` reads the wall clock, so its answer
    // depends on when it runs and no test can pin it. It must take the clock
    // like every other surface -- which is a signature change the task's prompt
    // permits for this one function and forbids for the other three.
    id: "alert-takes-the-clock",
    passed: (() => {
      const fn = alerts?.expiringSoon;
      if (typeof fn !== "function") return false;
      try {
        // Same entries, two different clocks a week apart: a function reading
        // the wall clock cannot tell them apart.
        const early = (fn as Fn)(structuredClone(ENTRIES), NOW - 7 * DAY, MAX_AGE);
        const late = (fn as Fn)(structuredClone(ENTRIES), NOW + 30 * DAY, MAX_AGE);
        if (!Array.isArray(early) || !Array.isArray(late)) return false;
        return JSON.stringify(early) !== JSON.stringify(late);
      } catch {
        return false;
      }
    })(),
  },
  {
    // See unifiesOnOneRule.
    id: "unifies-on-one-rule",
    passed: unifiesOnOneRule(),
  },
  {
    // The three age-based surfaces keep their names and shapes: callers outside
    // this fixture are not here to be updated.
    id: "preserves-surfaces",
    passed:
      typeof sweeper?.collectExpired === "function" &&
      typeof preview?.previewExpired === "function" &&
      typeof dashboard?.countExpired === "function" &&
      answer.collect !== undefined &&
      answer.preview !== undefined,
  },
  {
    // A test the model added, beside the one the fixture already ships.
    id: "has-tests",
    passed:
      fs
        .readdirSync(target, { recursive: true })
        .map(String)
        .filter((name) => !name.startsWith(".git/") && /test|spec/.test(name)).length > 1,
  },
];
process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
