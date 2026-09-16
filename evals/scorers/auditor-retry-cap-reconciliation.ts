import * as fs from "node:fs";
import * as path from "node:path";

interface SurfaceVerdict {
  surface?: string;
  status?: string;
  contract?: string | null;
  evidence?: string;
}

/** See the medium auditor scorer for why a surface is matched by function name rather than exact spelling. */
function statusOf(verdicts: readonly SurfaceVerdict[], fn: string): string | undefined {
  const needle = fn.toLowerCase();
  const match = verdicts.find((verdict) => {
    const words = (verdict.surface ?? "").toLowerCase().split(/[^a-z0-9]+/);
    return words.includes(needle);
  });
  return match === undefined ? undefined : (match.status ?? "").toLowerCase();
}

const file = process.argv[2];
if (!file) throw new Error("usage: auditor-retry-cap-reconciliation <audit.json>");
/** See the medium auditor scorer for why an unreadable answer fails rather than throws. */
function readAnswer(path: string): SurfaceVerdict[] {
  const raw = fs.readFileSync(path, "utf8");
  const end = raw.lastIndexOf("]");
  if (end < 0) return [];
  try {
    return JSON.parse(raw.slice(0, end + 1)) as SurfaceVerdict[];
  } catch {
    return [];
  }
}

const verdicts = readAnswer(file);

/**
 * What the fixture actually contains: its contract and decision files, and
 * the exported function names its source declares. See the medium auditor
 * scorer for why this is read relative to THIS FILE rather than to the
 * scored artifact.
 */
const FIXTURE = (() => {
  const root = path.resolve(import.meta.dir, "../fixtures/auditor-retry-cap-reconciliation");
  const contracts = [
    ...fs.readdirSync(path.join(root, "docs/contracts")).map((name) => `docs/contracts/${name}`),
    ...fs.readdirSync(path.join(root, "docs/decisions")).map((name) => `docs/decisions/${name}`),
  ];
  const exported = new Set<string>();
  for (const name of fs.readdirSync(path.join(root, "src"))) {
    const source = fs.readFileSync(path.join(root, "src", name), "utf8");
    for (const match of source.matchAll(/export function ([A-Za-z0-9_]+)/g))
      exported.add((match[1] as string).toLowerCase());
  }
  return { contracts, exported };
})();

/** The file part of a cited contract, however the model spelled the reference. */
function citedFile(contract: string): string {
  return (contract.split(/[\s#:]/)[0] ?? "").replace(/^\.?\//, "").toLowerCase();
}

/** Whether a cited contract resolves to a real file in the fixture. */
function citesRealFile(contract: string): boolean {
  const cited = citedFile(contract);
  return FIXTURE.contracts.some((raw) => {
    const known = raw.toLowerCase();
    return cited.endsWith(known) || known.endsWith(`/${cited}`);
  });
}

const checks = [
  {
    // `scheduleRetry` still hardcodes the STALE cap of 3 from
    // docs/contracts/retry.md, which docs/decisions/0021-retry-cap-raise.md
    // supersedes with 5. The enforceable value is 5, so the function
    // violates it. Citing either source is accepted -- what matters is the
    // VERDICT, since an audit that names the ADR as the reason is reading
    // the reconciliation correctly and one that names the contract alone is
    // also reading the right rule, just its stale text.
    id: "finds-stale-cap-violation",
    passed: statusOf(verdicts, "scheduleRetry") === "violates",
  },
  {
    // `attemptsRemaining` correctly implements the reconciled cap of 5. This
    // is the false-positive trap: an audit that reads only the contract's
    // literal "3" and never opens docs/decisions/ sees "5 != 3" and wrongly
    // calls this a violation. The honest verdict requires having reconciled
    // the two sources and preferring the ADR.
    id: "confirms-reconciled-surface-conforms",
    passed: statusOf(verdicts, "attemptsRemaining") === "conforms",
  },
  {
    // `logAttempt`'s message omits the job id, violating the contract's
    // third clause -- unrelated to the ADR entirely. This proves the audit
    // still catches an ordinary defect rather than only performing the
    // reconciliation exercise.
    id: "finds-missing-job-id-violation",
    passed: statusOf(verdicts, "logAttempt") === "violates",
  },
  {
    // `backoffDelay` conforms to the contract's untouched backoff clause,
    // which the ADR does not mention. `contract_missing` is the tempting
    // wrong answer for a surface an auditor did not carefully check against
    // both documents.
    id: "confirms-untouched-clause-conforms",
    passed: statusOf(verdicts, "backoffDelay") === "conforms",
  },
  {
    // EVERY CLAIM RESOLVES IN THE FIXTURE. See the medium auditor scorer for
    // why an over-claiming audit -- an invented contract file, a function
    // nobody exported -- must not score as well as one that did the work.
    // A `contract` of null is the honest answer for an ungoverned surface
    // and is exempt rather than wrong; here every surface is governed, so
    // this fixture has no `contract_missing` case, unlike the medium task.
    id: "cites-only-real-material",
    passed:
      verdicts.length > 0 &&
      verdicts.every((verdict) => {
        const surface = (verdict.surface ?? "").toLowerCase().split(/[^a-z0-9]+/);
        if (!surface.some((word) => FIXTURE.exported.has(word))) return false;
        const contract = verdict.contract;
        if (contract === null || contract === undefined || contract.trim() === "") return true;
        return citesRealFile(contract);
      }),
  },
  {
    // Four exported functions, so at most four verdicts. An audit that
    // invents surfaces to look thorough is the failure that makes a cheap
    // auditor unusable -- the same discipline the medium task measures, with
    // the bound set from what this fixture actually exports.
    id: "audits-only-what-is-there",
    passed: verdicts.length >= 1 && verdicts.length <= FIXTURE.exported.size,
  },
];
process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
