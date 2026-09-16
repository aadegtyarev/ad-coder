import * as fs from "node:fs";

interface Contradiction {
  topic?: string;
  doc0009Says?: string;
  doc0014Says?: string;
  resolution?: string;
}

interface Claim {
  question?: string;
  answer?: string;
  confidence?: string;
  sources?: string[];
}

interface Report {
  claims?: Claim[];
  contradictions?: Contradiction[];
  gaps?: string[];
  observedOn?: string;
}

const file = process.argv[2];
if (!file) throw new Error("usage: researcher-retry-after-adr <report.json>");
/**
 * The model's answer, or an empty one when it did not produce something this
 * scorer can read.
 *
 * WHY NOT THROW. A scorer that throws on malformed output turns a MODEL failure
 * into a HARNESS failure: the runner sees a non-zero exit and drops the run, so
 * the measurement leaves the sample entirely. That silently flatters the model,
 * because the runs it loses are its worst ones. An empty answer fails every
 * check instead, which is what a prompt demanding strict JSON means when the
 * answer is not JSON.
 */
function readAnswer(path: string): Report {
  const raw = fs.readFileSync(path, "utf8");
  const end = raw.lastIndexOf("}");
  if (end < 0) return {};
  try {
    return JSON.parse(raw.slice(0, end + 1)) as Report;
  } catch {
    return {};
  }
}

const report = readAnswer(file);
const claims = report.claims ?? [];
const contradictions = report.contradictions ?? [];

const claimFor = (question: string): Claim | undefined =>
  claims.find((claim) => (claim.question ?? "").toUpperCase().includes(question));

/** Everything the report says about one question, claim body and gaps alike. */
function textFor(question: string): string {
  const claim = claimFor(question);
  const gaps = (report.gaps ?? []).filter((gap) => gap.toUpperCase().includes(question));
  return `${claim?.answer ?? ""} ${gaps.join(" ")}`.toLowerCase();
}

/** The single contradiction entry about the Retry-After header format, if reported at all. */
const formatContradiction = contradictions.find((c) =>
  /retry-after|retry after/i.test(`${c.topic ?? ""} ${c.doc0009Says ?? ""} ${c.doc0014Says ?? ""}`),
);

/** Word-pair matching against a resolution's text, the technique this corpus's planner scorers use. */
function wordsOf(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
}

/** True when `text` contains every word of some group. */
function containsGroup(text: string, group: string[]): boolean {
  const words = wordsOf(text);
  return group.every((word) => words.has(word));
}

/** Wordings that say BOTH forms are valid -- the correct resolution of Q1. */
const BOTH_VALID_GROUPS = [
  ["either", "date", "seconds"],
  ["both", "date", "seconds"],
  ["date", "or", "seconds"],
  ["either", "http-date", "delay-seconds"],
  ["date", "delay-seconds"],
  ["either", "date", "integer"],
  ["both", "valid"],
];

/** Wordings that wrongly side with ONE document instead of reconciling. */
const SIDES_WITH_0009_ONLY = ["http-date only", "must be an http-date", "always an http-date"];
const SIDES_WITH_0014_ONLY = ["integer only", "must be an integer", "always an integer"];

const checks = [
  {
    // The prompt hands the model two documents that directly disagree; reporting
    // the disagreement at all is the entry condition for reconciling it.
    id: "reports-format-contradiction",
    passed: formatContradiction !== undefined,
  },
  {
    // The reconciliation itself. RFC 9110 section 10.2.3 (and RFC 7231 section
    // 7.1.3 before it) permits EITHER an HTTP-date or a delay-seconds integer --
    // so neither ADR 0009 (HTTP-date only) nor note 0014 (integer only) is
    // correct, and the honest resolution says both forms are valid rather than
    // picking the newer-looking document. A resolution siding with either single
    // form fails this even if it mentions the RFC by number.
    id: "resolves-format-correctly",
    passed: (() => {
      const text = `${formatContradiction?.resolution ?? ""} ${textFor("Q1")}`.toLowerCase();
      const both = BOTH_VALID_GROUPS.some((group) => containsGroup(text, group));
      const sidesWithOne =
        SIDES_WITH_0009_ONLY.some((phrase) => text.includes(phrase)) ||
        SIDES_WITH_0014_ONLY.some((phrase) => text.includes(phrase));
      return both && !sidesWithOne;
    })(),
  },
  {
    // Note 0014's second claim -- that RFC 9110 now defines 429, superseding RFC
    // 6585 -- is a plain factual error the newer document introduced. 429 remains
    // defined by RFC 6585; RFC 9110's own 4xx sections run 400-426 and never
    // register 429. A model that defers to 0014 because it is more recent has
    // fallen into the trap the researcher prompt names: resolving disagreement by
    // picking the one that "feels" current rather than verifying it.
    id: "resolves-429-source-correctly",
    passed: (() => {
      const text = textFor("Q2");
      const names6585 = /\b6585\b/.test(text);
      // Any phrasing that concludes 9110 is now the source for 429 is the
      // specific wrong answer this check exists to catch -- whether or not the
      // same text also mentions 6585 along the way (a gamed answer can cite the
      // right RFC number while still concluding the wrong one governs).
      const wronglyConcludes9110 =
        /9110 (now |today )?(defines|is|governs|supersedes|replaces).{0,10}429|429.{0,20}(defined|governed).{0,15}9110|9110.{0,25}(correct citation|authoritative|current).{0,15}429/i.test(
          text,
        );
      return names6585 && !wronglyConcludes9110;
    })(),
  },
  {
    // Q3 has one right answer regardless of which RFC defines 429: a 429 response
    // MAY carry Retry-After. Phrased loosely since models word permission many
    // ways.
    id: "answers-429-retry-after-permitted",
    passed:
      /\b(may|can|permits?|allows?)\b/.test(textFor("Q3")) &&
      /retry-after|retry after/.test(textFor("Q3")),
  },
  {
    // The researcher prompt's central demand: grade your own certainty, on every
    // claim.
    id: "grades-every-claim",
    passed:
      claims.length >= 3 &&
      claims.every((claim) =>
        new Set(["high", "medium", "low"]).has((claim.confidence ?? "").toLowerCase()),
      ),
  },
  {
    // Shape only, same as researcher-absence-claim-v1's equivalent check: this
    // scorer has no fetch log, so it can verify a URL is well-formed and cannot
    // verify it was actually retrieved.
    id: "cites-a-well-formed-source",
    passed: ["Q1", "Q2", "Q3"].every((question) =>
      (claimFor(question)?.sources ?? []).some((source) => /^https?:\/\/\S+$/.test(source)),
    ),
  },
];
process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
