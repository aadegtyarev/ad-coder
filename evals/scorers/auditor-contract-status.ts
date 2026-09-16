import * as fs from "node:fs";
import * as path from "node:path";

interface SurfaceVerdict {
  surface?: string;
  status?: string;
  contract?: string | null;
  evidence?: string;
}

/**
 * WHY A VERDICT PER SURFACE, NOT A FINDING COUNT. An audit that answers
 * `violates` to everything finds both seeded defects, so counting findings would
 * score a model that read nothing. The fixture therefore carries four surfaces
 * with four DIFFERENT correct verdicts, and each check asks for the verdict on
 * one named surface. Blanket answers now cost as much as they gain: the two
 * violation checks and the conformance check cannot both be satisfied by one
 * uniform status.
 *
 * The surface name is matched on its function name rather than on the exact
 * `file:function` spelling the prompt requests, because a model that writes
 * `src/queue.ts#readJob` or `queue.readJob` has identified the same function.
 * Omitting the requested format is an instruction-following miss and belongs in
 * the acceptance signal, not in zeroing a correct audit.
 */
function statusOf(verdicts: readonly SurfaceVerdict[], fn: string): string | undefined {
  const needle = fn.toLowerCase();
  const match = verdicts.find((verdict) => {
    const words = (verdict.surface ?? "").toLowerCase().split(/[^a-z0-9]+/);
    return words.includes(needle);
  });
  return match === undefined ? undefined : (match.status ?? "").toLowerCase();
}

const file = process.argv[2];
if (!file) throw new Error("usage: auditor-contract-status <audit.json>");
/**
 * The model's answer, or an empty one when it did not produce something this
 * scorer can read.
 *
 * WHY NOT THROW. A scorer that throws on malformed output turns a MODEL failure
 * into a HARNESS failure: the runner sees a non-zero exit and drops the run, so
 * the measurement leaves the sample entirely. That silently flatters the model,
 * because the runs it loses are its worst ones -- a live sweep lost a third of
 * one cell's runs this way, every one of them bad. An empty answer fails every
 * check instead, which is what a prompt demanding strict JSON means when the
 * answer is not JSON.
 */
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
 * What the fixture actually contains: its contract files, and the exported
 * function names its source declares.
 *
 * Found relative to THIS FILE rather than to the scored artifact, for the reason
 * the planner scorer states: a live run scores `<target>/artifact.json` with the
 * materialized fixture beside it, while the corpus smoke scores a flat sample
 * under `evals/samples/` with no fixture anywhere near. Scorers and fixtures are
 * fixed sibling directories, so this path holds for both.
 */
const FIXTURE = (() => {
  const root = path.resolve(import.meta.dir, "../fixtures/auditor-contract-status");
  const contracts = fs
    .readdirSync(path.join(root, "docs/contracts"))
    .map((name) => `docs/contracts/${name}`);
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

const checks = [
  {
    // `readJob` catches everything and throws a fresh `Error("queue read
    // failed")`. The error contract requires the original error to survive as
    // `cause`, and the bare `catch {}` also swallows its own `invalid id`.
    id: "finds-replaced-cause",
    passed: statusOf(verdicts, "readJob") === "violates",
  },
  {
    // `enqueue` writes and closes without an `fsync`. The persistence contract
    // requires the record to be flushed before the call returns.
    id: "finds-unflushed-write",
    passed: statusOf(verdicts, "enqueue") === "violates",
  },
  {
    // `src/metrics.ts` has no governing contract at all. The auditor prompt is
    // explicit that silence is not conformance, so the honest verdict is
    // `contract_missing` -- not `conforms`, and not a violation of a rule that
    // does not exist. Any metrics export answers it.
    id: "reports-uncontracted-surface",
    passed: ["increment", "snapshot", "reset"].some(
      (fn) => statusOf(verdicts, fn) === "contract_missing",
    ),
  },
  {
    // `parseJob` matches the error contract's wording exactly. Marking it a
    // violation is the false positive this fixture plants; so is quietly
    // calling a governed surface `contract_missing`.
    id: "confirms-conforming-surface",
    passed: statusOf(verdicts, "parseJob") === "conforms",
  },
  {
    // EVERY CLAIM RESOLVES IN THE FIXTURE. Until this existed the scorer read
    // the JSON the model asserted and checked its shape and vocabulary, so an
    // audit of confident, well-formed, wholly invented surfaces -- a contract
    // file that is not in the repository, a function nobody exported -- scored
    // exactly as well as one that did the work. Over-claiming is the failure
    // this project has already caught itself doing, and it propagates: a
    // fabricated citation becomes the next role's justification.
    //
    // Two things are checkable without guessing at prose. A cited contract must
    // be a file that exists, and an audited surface must name a function the
    // source actually exports. A `contract` of null is not a citation and is the
    // honest answer for an ungoverned surface, so it is exempt rather than
    // wrong.
    id: "cites-only-real-material",
    passed:
      verdicts.length > 0 &&
      verdicts.every((verdict) => {
        const surface = (verdict.surface ?? "").toLowerCase().split(/[^a-z0-9]+/);
        if (!surface.some((word) => FIXTURE.exported.has(word))) return false;
        const contract = verdict.contract;
        if (contract === null || contract === undefined || contract.trim() === "") return true;
        // Matched in BOTH directions: `docs/contracts/errors.md` and a bare
        // `errors.md` both name a file that exists, and the second is less
        // precise rather than invented. This check exists to catch a citation of
        // material that is not there, so an imprecise reference to real material
        // must not fail it -- the prompt's format request is an
        // instruction-following matter, not a fabrication.
        const cited = citedFile(contract);
        return FIXTURE.contracts.some((raw) => {
          const known = raw.toLowerCase();
          return cited.endsWith(known) || known.endsWith(`/${cited}`);
        });
      }),
  },
];
process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
