# Prompts-as-files loader implementation

**Date:** 2026-09-11
**Verdict:** APPROVED
**Complexity:** medium
**Security surface:** none
**Coder passes:** 1

## Verification

| Criterion | Status | Evidence |
|-----------|--------|----------|
| resolvePrompt('coder') returns bytes exactly equal to fs.readFileSync(repo prompts/coder.md, 'utf8') | passed | test/prompts.test.ts case 1 passes; `bun test test/prompts.test.ts` strict === verification |
| projectDir override with .ad-coder/prompts/<name>.md returns that content, not built-in | passed | test/prompts.test.ts case 2: temp dir override returned verbatim, asserted !== built-in |
| resolvePrompt('../evil') throws PromptError invalid_name with no fs access | passed | test/prompts.test.ts case 4 covers '../x','a/b','a.b','' all asserting pathsTried===[]; manual attack additionally tested '/etc/passwd', null-byte, backslash-traversal, unicode dot-leader — all invalid_name with empty pathsTried before any fs access |
| resolvePrompt('nope') throws not_found with pathsTried listing candidates and no leaked content | passed | test/prompts.test.ts case 3 passes; error message and fields explicitly verified to not contain real built-in's first line |
| trailing-whitespace/non-ASCII fixture round-trips byte-identical | passed | test/prompts.test.ts case 5 strict === on 'héllo \t\n'; verbatim fidelity confirmed |
| Exports resolvePrompt/PromptError/ResolvePromptOptions/PromptErrorCode from ad-coder, pinned in test/package-exports.test.ts | passed | `bun run typecheck` clean; `bun test test/package-exports.test.ts` passes as part of 155-pass full run |
| examples/pipeline.ts optionally adopts resolvePrompt while keeping inline read() fallback working | passed | systemPrompt() tries resolvePrompt(name,{projectDir}) and falls back to read(promptFile) only on PromptError code 'not_found', rethrows any other error; typecheck clean |
| Removing implementation makes new tests fail; restoring makes them pass | passed | Moved src/prompts/ out → `bun test test/prompts.test.ts test/package-exports.test.ts` => 0 pass/2 fail (module not found). Restored → same command => 7 pass/0 fail. git status confirmed tree unchanged. |
| Docs updated: CHANGELOG, ARCHITECTURE, CLAUDE.md drift log | passed | CHANGELOG.md has [Unreleased]/Added bullet; docs/ARCHITECTURE.md has Prompts component section; CLAUDE.md has one new dated drift-log line; README.md has one-sentence mention in roles paragraph |

## Attacks

| Vector | Outcome | Evidence |
|--------|---------|----------|
| resolvePrompt('/etc/passwd') — absolute-path-as-name injection | held | PromptError invalid_name, pathsTried=[] (regex rejects '/') |
| resolvePrompt('coder\0/../../etc/passwd') — null byte in name | held | PromptError invalid_name, pathsTried=[] |
| resolvePrompt('..\\..\\etc\\passwd') — backslash/Windows-style traversal | held | PromptError invalid_name, pathsTried=[] |
| resolvePrompt('‥') — unicode dot-leader look-alike for '..' | held | PromptError invalid_name, pathsTried=[] |
| resolvePrompt('a'.repeat(100000)) — oversized name (regex-valid but filesystem-invalid) | held | Node's ENAMETOOLONG rethrown raw (non-ENOENT per plan spec), not swallowed or leaked as PromptError; no content touched |
| resolvePrompt('-rf') — leading-dash name (regex-legal, could trick a shell caller) | held | PromptError not_found with single built-in-only candidate path, no unexpected behavior |

## Issues found and fixed

None. All five test cases passed; all manual traversal attacks held; the settled plan wf_e6cadafe-c26 matches the task prose exactly. Code reconciles step-for-step with the plan: validate-before-path-build mirrors assertRunId; PromptError carries name+paths only (verified no message/field contains file content); verbatim reads are proven via strict === in two test cases; project-overrides-built-in order is correct; leaf-module import constraint (only node:fs/node:path/./errors) holds.

## Issues left unfixed (advisory)

None.

## Security findings (if any)

None. The typed PromptError surface enforces the boundary: file contents are never carried in an error, only the name and the absolute paths tried. The validate-before-path-build discipline blocks traversal at the name validation gate, before any fs access. No content is ever leaked in error messages or fields.

## Cost

Output tokens only — no input tokens, no cache reads, no cache writes — so this figure cannot say whether prompt caching is helping, and on a measured run it was 0.2% of the bill. For the rest, run `scripts/ldo-cost.sh <transcriptDir>` after the run: the cache figures exist in the per-agent transcripts, just not here. A per-phase number is a delta measured around that phase, not an attribution: the token pool is shared across the whole turn.
- Total: 56756
- planner (Plan): 14407
- coder (Code): 29031
- reviewer (Review): 13318
