import * as fs from "node:fs";
import * as path from "node:path";

interface SurfaceVerdict {
  surface?: string;
  status?: string;
  contract?: string | null;
  evidence?: string;
}

const file = process.argv[2];
if (!file) throw new Error("usage: auditor-trivial <audit.json>");

/** See the medium auditor scorer for why an unreadable answer fails rather than throws. */
function readAnswer(target: string): SurfaceVerdict[] {
  const raw = fs.readFileSync(target, "utf8");
  const end = raw.lastIndexOf("]");
  if (end < 0) return [];
  try {
    return JSON.parse(raw.slice(0, end + 1)) as SurfaceVerdict[];
  } catch {
    return [];
  }
}

/**
 * What the fixture contains, read relative to THIS FILE for the reason the
 * other scorers state: a live run has the fixture beside the artifact, the
 * corpus smoke does not, and scorers and fixtures are fixed siblings.
 */
const FIXTURE = (() => {
  const root = path.resolve(import.meta.dir, "../fixtures/reviewer-trivial");
  const exported = new Set<string>();
  for (const name of fs.readdirSync(path.join(root, "src"))) {
    const source = fs.readFileSync(path.join(root, "src", name), "utf8");
    for (const match of source.matchAll(/export function ([A-Za-z0-9_]+)/g))
      exported.add((match[1] as string).toLowerCase());
  }
  const contracts = fs
    .readdirSync(path.join(root, "docs/contracts"))
    .map((name) => `docs/contracts/${name}`.toLowerCase());
  return { exported, contracts };
})();

const verdicts = readAnswer(file);

/** The verdict on one function, matched on its name however the surface is spelled. */
function statusOf(fn: string): string | undefined {
  const needle = fn.toLowerCase();
  const match = verdicts.find((verdict) =>
    (verdict.surface ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .includes(needle),
  );
  return match === undefined ? undefined : (match.status ?? "").toLowerCase();
}

/**
 * WHY A TRIVIAL AUDIT IS NOT A SMALLER MEDIUM ONE.
 *
 * One exported function, one governing contract, one question: does it conform?
 * No surface map to build and no contract corpus to search. What it still has to
 * measure is that the auditor CHECKED rather than assumed -- `auditor.md` says
 * never to treat silence as conformance -- so the fixture's function violates
 * its contract in a way visible only by reading the operator, and the scorer
 * demands the citation resolve in the fixture.
 */
const checks = [
  {
    // `retryCount` returns the default for a supplied 0 while the retry
    // contract says zero is honoured exactly. The only right verdict.
    id: "finds-the-violation",
    passed: statusOf("retryCount") === "violates",
  },
  {
    // The contract exists and governs this surface, so `contract_missing` is
    // the tempting wrong answer -- it is what an auditor says when it did not
    // look. `auditor.md`: never treat silence as conformance.
    id: "does-not-claim-the-contract-is-absent",
    passed: verdicts.length > 0 && statusOf("retryCount") !== "contract_missing",
  },
  {
    // Every claim resolves in the fixture: a cited contract is a file that
    // exists, and an audited surface is a function `src/` exports. A `contract`
    // of null is the honest answer for an ungoverned surface, not a citation.
    id: "cites-only-real-material",
    passed:
      verdicts.length > 0 &&
      verdicts.every((verdict) => {
        const named = (verdict.surface ?? "").toLowerCase().split(/[^a-z0-9]+/);
        if (!named.some((word) => FIXTURE.exported.has(word))) return false;
        const cited = verdict.contract;
        if (cited === null || cited === undefined || cited.trim() === "") return true;
        const path =
          cited
            .toLowerCase()
            .split(/[\s#:]/)[0]
            ?.replace(/^\.?\//, "") ?? "";
        return FIXTURE.contracts.some(
          (known) => path.endsWith(known) || known.endsWith(`/${path}`),
        );
      }),
  },
  {
    // One exported function, so one verdict. An audit that invents surfaces to
    // look thorough is the failure that makes a cheap auditor unusable.
    id: "audits-only-what-is-there",
    passed: verdicts.length >= 1 && verdicts.length <= FIXTURE.exported.size,
  },
];
process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
