# Human-CLI: Config Resolution and Role Subcommand (Part 1)

**Date:** 2026-09-11  
**Verdict:** APPROVED  
**Complexity:** medium  
**Security surface:** low  
**Coder passes:** 1

## Verification

| Criterion | Status | Evidence |
|-----------|--------|----------|
| resolvePipelineConfig provider precedence (deepseek/openrouter/override) | passed | bun test 'test/cli-config.test.ts': 10 pass, 0 fail; live CLI: deepseek via presence, openrouter when only OPENROUTER_API_KEY present, openrouter via --provider override when both present |
| missing_credential throw for absent forced provider | passed | test assertion: RegistryError('missing_credential','DEEPSEEK_API_KEY'); live CLI: `bun run src/cli.ts role reviewer x --target-dir /tmp --provider deepseek` (no keys) exits 1 with 'environment variable "DEEPSEEK_API_KEY" ... is not set' |
| derived context budget validates for all presets | passed | Ad-hoc script: deepseek maxTokens 57600/window 64000, openrouter 115200/128000, openai-codex 244800/272000; reserve+keepRecent < maxTokens verified for all three |
| resolvePrompt called for each role (planner/coder/reviewer/security) | passed | buildRole read-through: each role constructed via defineRole(..., resolvePrompt(name)) |
| PipelineConfig defaults and structure | passed | test/cli-config.test.ts assertions: maxRounds===3, defaultComplexity==='medium', models===registry.models, MemoryLedgerSink defined and empty on return |
| `role bogus ...` exits 2 with usage | passed | Live: `bun run src/cli.ts role bogus "x" --target-dir /tmp/x` exits 2 with 'usage: ad-coder run\|role' |
| `role reviewer ...` without --target-dir exits 2 | passed | Live: no --target-dir argument exits 2 with 'usage:' message |
| Existing test/cli.test.ts still passes | passed | `bun test test/cli.test.ts`: 6 pass, 0 fail (run command unchanged) |
| runRoleStandalone drives faux turn and extracts text+cost | passed | test/cli-role.test.ts: extracted text contains 'looks good to me', cost is non-negative number, ledgerSink.records().length > 0; no raw OperationResultRecord printed to stdout |
| resolvePipelineConfig exported and pinned | passed | src/index.ts exports resolvePipelineConfig; test/package-exports.test.ts asserts typeof===function and type-only pins; `tsc --noEmit` clean |
| New tests pass with faux provider, no network/TTY/credentials | passed | bun test 'test/cli-config.test.ts' 'test/cli-role.test.ts': 10 pass, 0 fail, 121 expect() calls, 343ms; fauxProvider-backed, fake env accessor |
| CHANGELOG/README/CLAUDE.md updated | passed | CHANGELOG [Unreleased]/Added has both bullets plus `ad-coder drive` follow-on note; README documents `ad-coder role`, provider precedence, sandbox posture, follow-on note; CLAUDE.md gained one new drift-log line before <!-- /ldo:features --> |

## Attacks

| Vector | Outcome | Evidence |
|--------|---------|----------|
| Unknown role name (bogus) | held | Exit 2 with usage string |
| Missing --target-dir | held | Exit 2 with usage string |
| --max-rounds non-numeric (abc), negative (-1), zero (0) | held | All three rejected with 'invalid --max-rounds: ... (expected a positive integer)', exit 2 |
| Invalid --default-complexity (bogus) and --provider (aws) | held | Both rejected at argument boundary with expected set named, exit 2 |
| Embedded newline in role-name positional | held | Treated as unrecognized role; newline echoed verbatim in error string (cosmetic), exit 2, no crash/injection |
| Forced deepseek provider with no key | held | Both unit test and live CLI: 'environment variable "DEEPSEEK_API_KEY" ... is not set', exit 1, no partial/garbled output |
| Codex oauth fallback with no local session, no keys | broke | `bun run src/cli.ts role reviewer hello --target-dir /tmp/x` (all provider env vars unset): exit 0, empty printed text, $0.00000000 cost, no outbound traffic detected via proxy capture. Silent no-signal completion rather than clear failure or warning. Filed as minor issue #1 (pre-existing design, not introduced by this diff). |
| Nonexistent --target-dir path | held | 'ad-coder: targetDir does not exist: /tmp/does-not-exist-xyz', exit 1 (pre-existing resolveTargetDir check, reused correctly) |

## Issues found and fixed

- [minor] src/cli.ts: The openai-codex OAuth fallback (default provider when no env-var key present — CLI's documented no-config happy path) completes `ad-coder role <name> ...` with exit 0, empty printed text, and $0.00000000 cost when no local OAuth session exists, with no detectable network attempt (verified via HTTP(S)_PROXY-pointed netcat listener capturing no traffic). Operator gets no signal that authentication is needed or that the turn did nothing meaningful — looks identical to a role that legitimately had nothing to say. **Root:** Pre-existing behavior in registry/runner's OAuth handling (resolveRegistry intentionally does not check codex credentials; runRole's getOrThrow pattern not tripped by this path). Already discussed and accepted in plan's security notes. **Fix:** (optional follow-on) Consider stderr warning in roleCommand or runRoleStandalone when empty text + zero cost from oauth-fallback provider (e.g. "turn produced no assistant text and no cost — check that `codex login` (or equivalent) has been completed").

## Issues left unfixed (advisory)

- [nit] src/cli.ts: `--max-rounds` accepted, validated, threaded into `resolvePipelineConfig`/`PipelineConfig.defaults` for `role` subcommand, but has zero effect on standalone single-turn role run (per plan and code review). README's wording ("to set the routing defaults") doesn't make this explicit. **Advisory:** Optional one-line README/usage clarification that `--max-rounds` is accepted for parity with future `ad-coder drive` loop and has no effect on single `role` invocation. Purely cosmetic; not noted to confuse anyone, just noting the gap.

## Security findings

- [low] data_exposure: Provider selected implicitly by env-var PRESENCE in precedence DEEPSEEK_API_KEY → OPENROUTER_API_KEY → codex-oauth when --provider not passed. Operator's task string and everything read from targetDir (via read/bash tools) is therefore determined by whatever key is in ambient environment, with no confirmation before the turn runs. **Mitigation:** Before running the turn, emit SELECTED provider id and model NAME to stderr (names only, never the key) so operator sees where task is being sent. Consider requiring explicit --provider when more than one provider key present rather than silently applying precedence. Keep on stderr, not stdout, to preserve stdout text/cost discipline. **Status:** Implemented — roleCommand and resolvePipelineConfig already emit to stderr.

- [info] input_validation: New --max-rounds (numeric) and --default-complexity (enum) flags from user argv. If unvalidated, --max-rounds could become NaN/negative/zero; --default-complexity an arbitrary string flowing into buildDefaultProfile/resolveProfile. Single-turn run does not use maxRounds, but defaultComplexity picks profile cell (and thus model), and unrecognized value surfaces only as later ProfileError('missing_mapping'). **Mitigation:** Validate --max-rounds as positive integer and --default-complexity against fixed Complexity set at parse time, failing with exit 2 and usage string exactly like unknown-command and missing-target-dir paths, so bad input rejected consistently at boundary rather than defaulting or throwing late. **Status:** Implemented — src/cli.ts validates both at argument boundary.

## Cost

Output tokens only — no input tokens, no cache reads, no cache writes — so this figure cannot say whether prompt caching is helping, and on a measured run it was 0.2% of the bill. For the rest, run `scripts/ldo-cost.sh <transcriptDir>` after the run: the cache figures exist in the per-agent transcripts, just not here. A per-phase number is a delta measured around that phase, not an attribution: the token pool is shared across the whole turn.

- Total: 182198
- planner (Plan): 27337
- security (Security): 10825
- coder (Code): 64394
- reviewer (Review): 79642

Your own Record phase is NOT in these figures: this block was composed before you were called, so nothing here could include it. The run log and the returned result carry a later total that does.
