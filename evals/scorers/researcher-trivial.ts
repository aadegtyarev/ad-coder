import * as fs from "node:fs";

interface Claim {
  question?: string;
  answer?: string;
  confidence?: string;
  sources?: unknown;
}

interface Answer {
  claims?: Claim[];
  observedOn?: string;
}

const file = process.argv[2];
if (!file) throw new Error("usage: researcher-trivial <research.json>");

/** See the medium researcher scorer for why an unreadable answer fails rather than throws. */
function readAnswer(target: string): Answer {
  const raw = fs.readFileSync(target, "utf8");
  const end = raw.lastIndexOf("}");
  if (end < 0) return {};
  try {
    return JSON.parse(raw.slice(0, end + 1)) as Answer;
  } catch {
    return {};
  }
}

/** Any shape a model reached for, reduced to the text it carries. */
function flatten(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(flatten).join(" ");
  if (value !== null && typeof value === "object")
    return Object.values(value as Record<string, unknown>)
      .map(flatten)
      .join(" ");
  return value === null || value === undefined ? "" : String(value);
}

const answer = readAnswer(file);
const claims = answer.claims ?? [];
const of = (id: string): Claim | undefined =>
  claims.find((claim) => (claim.question ?? "").toUpperCase() === id);

const words = (text: string): Set<string> =>
  new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );

/**
 * WHY A TRIVIAL RESEARCH TASK IS NOT A SMALLER MEDIUM ONE.
 *
 * One question with one settled, published answer: no cross-verification
 * between disagreeing sources, no absence to establish. What it still has to
 * measure is the discipline the role exists for -- an answer carries a source
 * that was fetched, and a confidence that means something. The medium task
 * names its citation check `cites-a-well-formed-source` rather than
 * `cites-a-fetched-source` because the scorer sees only the artifact and cannot
 * tell a retrieved page from an invented one; the same limit applies here and
 * is stated rather than papered over.
 */
const checks = [
  {
    // RFC 9110 defines 428 Precondition Required. A settled, checkable fact.
    id: "answers-the-status-code",
    passed: (() => {
      const claim = of("Q1");
      if (claim === undefined) return false;
      const text = `${claim.answer ?? ""}`;
      const set = words(text);
      return /\b428\b/.test(text) && set.has("precondition") && set.has("required");
    })(),
  },
  {
    // A single settled fact deserves high confidence. Hedging on something the
    // RFC states outright is the failure that makes a researcher useless: every
    // answer arrives equally uncertain and none can be acted on.
    id: "is-confident-about-a-settled-fact",
    passed: (of("Q1")?.confidence ?? "").toLowerCase() === "high",
  },
  {
    // A source that is at least well formed and points at the standard. Named
    // for what it can see -- see the header comment.
    id: "cites-a-well-formed-source",
    passed: (() => {
      const cited = flatten(of("Q1")?.sources);
      return /https?:\/\/\S+/.test(cited) && /rfc|ietf|httpwg|iana/i.test(cited);
    })(),
  },
  {
    // One question, one claim. A researcher that answers questions nobody asked
    // is padding, and padding is the expensive failure at this tier.
    id: "answers-only-what-was-asked",
    passed: claims.length === 1,
  },
];
process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
