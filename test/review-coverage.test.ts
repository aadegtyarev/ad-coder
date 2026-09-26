/**
 * The ONE covered-path scope declaration (issue #566).
 *
 * review-coverage.ts is the module every digest fold, capture, settle, gate,
 * and the CI fallback read so that "covered" cannot be re-defined apart. These
 * tests pin the four things its consumers rely on: the default list (in the
 * contract's declared order first), the glob semantics, the resolution order
 * (add extends, replace substitutes), and the marker's `coverage` /
 * `coverage-add` parse.
 */
import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  readStampsMarker,
  resolveReviewCoverage,
  STAMPS_MARKER_FILE,
} from "../src/stamp/record-review-stamp";
import {
  coverageValidationError,
  DEFAULT_REVIEW_COVERAGE,
  isCoveredPath,
  resolveCoverageList,
} from "../src/stamp/review-coverage";

test("the default list leads with the contract's five patterns, in order", () => {
  // docs/contracts/review-evidence.md declares this order as the bundled
  // pipeline scope; the code must not re-spell it differently.
  expect(DEFAULT_REVIEW_COVERAGE.slice(0, 5)).toEqual([
    "src/**",
    "test/**",
    "scripts/**",
    "evals/**",
    "docs/contracts/**",
  ]);
});

test("the default list additively covers the paths that shape behaviour", () => {
  // The contract's five patterns are EXTENDED, never narrowed: each addition
  // below names a tracked path whose content decides what compiles, runs, or
  // ships (see review-coverage.ts's own WHY list and the contract sentence).
  const extended = DEFAULT_REVIEW_COVERAGE.slice(5);
  expect(extended).toContain("prompts/**");
  expect(extended).toContain("bin/**");
  expect(extended).toContain("examples/**");
  expect(extended).toContain(".github/workflows/**");
  expect(extended).toContain("package.json");
  expect(extended).toContain("tsconfig.json");
  expect(extended).toContain("biome.json");
  expect(extended).toContain("bunfig.toml");
  expect(extended).toContain("bun.lock");
  expect(extended).toContain("docs/readability.json");
  expect(extended).toContain("ad-coder.stamps.json");
  expect(extended).toContain("AGENTS.md");
  expect(extended).toContain("CLAUDE.md");
  expect(extended).toContain(".gitignore");
  // The deliberately-exempt prose never appears in the covered set.
  expect(DEFAULT_REVIEW_COVERAGE).not.toContain("README.md");
  expect(DEFAULT_REVIEW_COVERAGE).not.toContain("CHANGELOG.md");
  expect(DEFAULT_REVIEW_COVERAGE).not.toContain("LICENSE");
  expect(DEFAULT_REVIEW_COVERAGE).not.toContain("docs/**");
});

test("glob matching: `*` and `?` do not cross `/`; `**` is a whole-segment globstar", () => {
  expect(isCoveredPath("src/a.ts", ["src/**"])).toBe(true);
  expect(isCoveredPath("src/x/y.ts", ["src/**"])).toBe(true);
  expect(isCoveredPath("src/a.ts", ["src/*.ts"])).toBe(true);
  expect(isCoveredPath("src/a/b.ts", ["src/*.ts"])).toBe(false);
  expect(isCoveredPath("src/a.ts", ["src/?.ts"])).toBe(true);
  expect(isCoveredPath("src/ab.ts", ["src/?.ts"])).toBe(false);
});

test("glob matching: a globstar cannot swallow a directory prefix", () => {
  expect(isCoveredPath("docsx/readme.md", ["docs/**"])).toBe(false);
  expect(isCoveredPath("docs/readme.md", ["docs/**"])).toBe(true);
  expect(isCoveredPath("srcx/a.ts", ["src/**"])).toBe(false);
});

test("glob matching: a leading globstar matches the root and deeper", () => {
  expect(isCoveredPath("x.ts", ["**/x.ts"])).toBe(true);
  expect(isCoveredPath("a/b/x.ts", ["**/x.ts"])).toBe(true);
  expect(isCoveredPath("x.ts", ["**"])).toBe(true);
});

test("glob matching: regex metacharacters in a pattern are literal", () => {
  expect(isCoveredPath("a.b.ts", ["a.b.ts"])).toBe(true);
  expect(isCoveredPath("axb.ts", ["a.b.ts"])).toBe(false);
  expect(isCoveredPath("a+b.ts", ["a+b.ts"])).toBe(true);
  expect(isCoveredPath("ab.ts", ["a+b.ts"])).toBe(false);
});

test("resolution order: absent declaration is the default list", () => {
  expect(resolveCoverageList({})).toBe(DEFAULT_REVIEW_COVERAGE);
});

test("resolution order: coverage-add extends the default, in declared order", () => {
  const resolved = resolveCoverageList({ coverageAdd: ["docs/**", "legacy/**"] });
  expect(resolved).toEqual([...DEFAULT_REVIEW_COVERAGE, "docs/**", "legacy/**"]);
});

test("resolution order: coverage replaces the default wholesale", () => {
  expect(resolveCoverageList({ coverage: ["src/**", "docs/**"] })).toEqual(["src/**", "docs/**"]);
  // A replacement that declares both sides prefers the replacement (the
  // marker's parse refuses that ambiguity before this helper sees it).
  expect(resolveCoverageList({ coverage: ["src/**"], coverageAdd: ["docs/**"] })).toEqual([
    "src/**",
  ]);
});

test("validation: an empty replacement is refused; an empty add is a harmless no-op", () => {
  expect(coverageValidationError([], "coverage")).toContain("replacement coverage cannot be empty");
  expect(coverageValidationError([], "coverage-add")).toBeUndefined();
});

test("validation: patterns must be non-empty strings without whitespace or commas", () => {
  expect(coverageValidationError(["ok/**"], "coverage")).toBeUndefined();
  expect(coverageValidationError([""], "coverage")).toContain("non-empty strings");
  expect(coverageValidationError([42], "coverage")).toContain("non-empty strings");
  expect(coverageValidationError(["a b/**"], "coverage")).toContain("cannot contain whitespace");
  expect(coverageValidationError(["a,b/**"], "coverage")).toContain("cannot contain a comma");
});

function markerDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-coverage-marker-")));
}

test("the marker parse reads `coverage` as a replacement list", () => {
  const root = markerDir();
  try {
    fs.writeFileSync(
      path.join(root, STAMPS_MARKER_FILE),
      JSON.stringify({ file: "stamps.log", coverage: ["src/**", "docs/**"] }),
    );
    expect(readStampsMarker(root)).toEqual({
      file: "stamps.log",
      coverage: ["src/**", "docs/**"],
    });
    expect(resolveReviewCoverage(root)).toEqual(["src/**", "docs/**"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the marker parse reads `coverage-add` as an extension list", () => {
  const root = markerDir();
  try {
    fs.writeFileSync(
      path.join(root, STAMPS_MARKER_FILE),
      JSON.stringify({ "coverage-add": ["docs/**"] }),
    );
    expect(readStampsMarker(root)).toEqual({ coverageAdd: ["docs/**"] });
    expect(resolveReviewCoverage(root)).toEqual([...DEFAULT_REVIEW_COVERAGE, "docs/**"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the marker parse refuses the ambiguous and malformed shapes loudly", () => {
  const root = markerDir();
  try {
    fs.writeFileSync(
      path.join(root, STAMPS_MARKER_FILE),
      JSON.stringify({ coverage: ["src/**"], "coverage-add": ["docs/**"] }),
    );
    expect(() => readStampsMarker(root)).toThrow(
      "declare coverage replace or coverage-add, not both",
    );

    fs.writeFileSync(path.join(root, STAMPS_MARKER_FILE), JSON.stringify({ coverage: "src/**" }));
    expect(() => readStampsMarker(root)).toThrow("coverage must be a list of glob patterns");

    fs.writeFileSync(path.join(root, STAMPS_MARKER_FILE), JSON.stringify({ coverage: [] }));
    expect(() => readStampsMarker(root)).toThrow("replacement coverage cannot be empty");

    fs.writeFileSync(path.join(root, STAMPS_MARKER_FILE), JSON.stringify({ coverage: ["a b/**"] }));
    expect(() => readStampsMarker(root)).toThrow("cannot contain whitespace");

    fs.writeFileSync(path.join(root, STAMPS_MARKER_FILE), JSON.stringify({ wat: true }));
    expect(() => readStampsMarker(root)).toThrow("unknown field wat");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an absent marker resolves to the default list, never a narrower scope", () => {
  const root = markerDir();
  try {
    expect(readStampsMarker(root)).toBeUndefined();
    expect(resolveReviewCoverage(root)).toBe(DEFAULT_REVIEW_COVERAGE);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
