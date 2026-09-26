/**
 * The covered-path scope of a review stamp (issue #566).
 *
 * A review stamp answers "has the tree the review covered changed since the
 * review?" -- and "the tree the review covered" is a SET, not a synonym for
 * "every tracked file". Before this module the digest hashed ALL of
 * `git ls-files`, so an edit to a pure prose document invalidated a stamp of
 * source code exactly like an edit to a source file: the gate never knew what
 * changed, only that something did. The contract
 * (docs/contracts/review-evidence.md) declares the default review scope and
 * permits a project to add paths or replace it; this is the ONE declaration
 * every surface reads.
 *
 * Everything downstream derives from here by construction:
 *
 * - `computeTreeManifest`/`computeTreeDigest` (review-stamp.ts) hash COVERED
 *   tracked paths only, so the stamp digest is coverage-relative;
 * - the round-start capture and the settle's `ReviewedTreeMovedError` compare
 *   covered paths only, so a prose move outside coverage cannot fail a round;
 * - `checkReviewStamps` (record-review-stamp.ts) recomputes the CURRENT
 *   covered digest, and verifies the stamp names what it was reviewed under;
 * - the CI fallback (`scripts/check-stamp-fixup.ts`) folds the stamp commit's
 *   parent tree under the stamp's OWN recorded patterns -- the same helper,
 *   never a second implementation of "covered".
 *
 * The patterns are glob patterns over git's repo-relative `/`-separated paths.
 */

/**
 * One glob segment's regex: `*` and `?` do not cross `/`; every other
 * character matches literally.
 */
function segmentToRegex(segment: string): string {
  let out = "";
  for (const char of segment) {
    if (char === "*") out += "[^/]*";
    else if (char === "?") out += "[^/]";
    else out += char.replace(/[.+~^${}()|[\]\\]/g, "\\$&");
  }
  return out;
}

/**
 * ONE glob pattern -> one anchored regex. A `**` SEGMENT, not the last one,
 * expands to zero or more FULL segments (so `docs/**` does not match
 * `docsx/readme.md`), and a leading globstar makes its tail matchable at the
 * root too, so `star-star/x.ts` (spelled the usual way) also matches `x.ts`.
 * As the LAST segment a globstar expands to anything, including further
 * separators.
 */
function patternToRegex(pattern: string): RegExp {
  const segments = pattern.split("/");
  let regex = "^";
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index] as string;
    const isGlobstar = segment === "**";
    if (isGlobstar) {
      if (index === segments.length - 1) regex += ".*";
      else regex += "(?:[^/]+/)*";
    } else {
      regex += segmentToRegex(segment);
      if (index !== segments.length - 1) regex += "/";
    }
  }
  return new RegExp(`${regex}$`);
}

/**
 * True when a repo-relative tracked path lies inside one of the patterns.
 * Git paths always use `/` separators; input here comes straight from
 * `git ls-files`.
 */
export function isCoveredPath(entry: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => patternToRegex(pattern).test(entry));
}

/**
 * The default review scope, in the contract's declared order first (the
 * bundled-pipeline list), then the additive declaration this change reconciles
 * with it. The declared prose list and this constant must agree, so the
 * contract bullet is edited in the same change.
 *
 * WHY each addition, stated once (the reconcile-before-narrow rule, issue
 * #566): narrowing the digest from "every tracked file" to the contract's
 * five patterns would silently DROP protection from paths that shape
 * behaviour:
 *
 * - `prompts/**` IS every role's behaviour: the role prompts are the rules a
 *   model executes in this repo;
 * - `bin/**` and `examples/**` are executable code, exactly what
 *   "all executable code" covers;
 * - `.github/workflows/**` is the CI definition itself;
 * - the named configuration -- `package.json`, `tsconfig.json`, `biome.json`,
 *   `bunfig.toml`, `bun.lock`, `docs/readability.json`, and the stamp
 *   marker `ad-coder.stamps.json` (whose own fields ARE the stamp policy) --
 *   gates what compiles, runs, and ships;
 * - `AGENTS.md`/`CLAUDE.md` and `.gitignore` are prose/policy that
 *   establishes rules: the contract exempts only prose that establishes NO
 *   rule, and these files' entire purpose is rules.
 *
 * DELIBERATELY exempt (named, not forgotten): `README.md`, `CHANGELOG.md`,
 * `LICENSE`, and `docs/**` outside `docs/contracts/**` (plus
 * `docs/reviews/**`, stamp paperwork) -- prose that establishes no rule.
 * Nothing is dropped blind: every path today tracked and outside this list
 * was accounted. The stamp's storage (the stamps log) is excluded from
 * coverage separately in the manifest, wherever a project's scope names it.
 */
export const DEFAULT_REVIEW_COVERAGE: readonly string[] = [
  "src/**",
  "test/**",
  "scripts/**",
  "evals/**",
  "docs/contracts/**",
  "prompts/**",
  "bin/**",
  "examples/**",
  ".github/workflows/**",
  "package.json",
  "tsconfig.json",
  "biome.json",
  "bunfig.toml",
  "bun.lock",
  ".gitignore",
  "docs/readability.json",
  "ad-coder.stamps.json",
  "AGENTS.md",
  "CLAUDE.md",
];

/**
 * Marker-declared coverage: `coverage` REPLACES the default scope wholesale;
 * `coverage-add` EXTENDS it (the contract's "add paths or replace the
 * scope"). Declaring both is ambiguous and refused, as is a replacement
 * that covers nothing -- a stamp gate whose coverage set is empty can never
 * go stale, so an empty replacement is a defect, not a choice. Values are
 * validated strings that can also ride the stamp line (no whitespace, no
 * comma, which joins patterns there).
 */
export interface CoverageSelection {
  /** Replaces the default scope; [] is refused at the marker's parse. */
  coverage?: readonly string[];
  /** Extends the default scope; [] is a harmless no-op but validated. */
  coverageAdd?: readonly string[];
}

/**
 * The covered-pattern list a project declares: add first in declared order,
 * then the replacements. This is the ONE resolution every surface shares.
 */
export function resolveCoverageList(selection: CoverageSelection): readonly string[] {
  if (selection.coverage !== undefined) return selection.coverage;
  return selection.coverageAdd === undefined
    ? DEFAULT_REVIEW_COVERAGE
    : [...DEFAULT_REVIEW_COVERAGE, ...selection.coverageAdd];
}

/**
 * Validate one raw side of the marker's coverage declaration; returns the
 * typed error text before the caller throws a ConfigError-shaped line.
 */
export function coverageValidationError(
  raw: readonly unknown[],
  key: "coverage" | "coverage-add",
): string | undefined {
  if (key === "coverage" && raw.length === 0)
    return `${STAMPS_MARKER_FIELD}: replacement coverage cannot be empty -- a stamp over nothing covered can never go stale`;
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.length === 0)
      return `${STAMPS_MARKER_FIELD}: coverage patterns must be non-empty strings`;
    if (/\s/.test(entry))
      return `${STAMPS_MARKER_FIELD}: coverage patterns cannot contain whitespace`;
    if (entry.includes(","))
      return `${STAMPS_MARKER_FIELD}: coverage patterns cannot contain a comma (patterns are comma-joined onto the stamp line)`;
  }
  return undefined;
}

/** The marker fields, spelled once for every message about them. */
const STAMPS_MARKER_FIELD = "ad-coder.stamps.json coverage";
