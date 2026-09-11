# Profiles Role-Routing Composer Module

**Date:** 2026-09-11
**Verdict:** APPROVED
**Complexity:** medium
**Security surface:** none
**Coder passes:** 1

## Verification

| Criterion | Status | Evidence |
|-----------|--------|----------|
| ProfileError mirrors RegistryError/OrchestrationError | passed | src/profiles/errors.ts code discriminant + names-only detail + name='ProfileError'; test 'resolveProfile throws missing_mapping...' asserts (err as ProfileError).detail === 'security:complex' and instanceof ProfileError |
| types.ts compiles, CacheRetention imported verbatim from pi-ai | passed | bun run typecheck: clean (tsc --noEmit, no output/errors); src/profiles/types.ts line 1 imports CacheRetention from @earendil-works/pi-ai |
| parseProfile: accept well-formed, reject duplicate/unknown_role/invalid_complexity/missing model, names-only detail | passed | bun test src/profiles/profiles.test.ts: all parseProfile tests pass; scratch attack tests confirming NaN/Infinity maxOutput and type-confusion inputs also rejected correctly |
| resolveProfile: entry lookup, override precedence, unknown_model rethrow (never RegistryError), missing_mapping | passed | profiles.test.ts tests for all four cases pass; 'resolveProfile rethrows...' explicitly asserts err not instanceof RegistryError |
| buildDefaultProfile: 15 entries, correct routing per role, parseProfile accepts output unchanged | passed | test 'buildDefaultProfile routes each role...' passes: 15 entries, parseProfile(profile).entries.length===15, and each role/complexity resolves to the expected model id |
| Append-only exports from src/index.ts, pinned in test/package-exports.test.ts, import compiles | passed | bun run typecheck clean; grep confirms all 4 value exports + 6 type exports present in src/index.ts and asserted/typed in test/package-exports.test.ts |
| bun test passes: new profiles tests + extended package-exports test green | passed | bun test (full suite): 140 pass, 0 fail — matches Coder's claimed 140/0; scoped command also 17 pass / 0 fail |
| Tests genuinely catch the defect (not decorative) | passed | Revert-and-restore proof: moved non-test profiles/*.ts aside + reverted src/index.ts -> scoped test command failed (2 fail, module-not-found/missing-export errors); restored via git apply + file move-back -> diff byte-identical to pre-revert, scoped tests passed again (17 pass) |
| Docs updated and accurate: CHANGELOG/ARCHITECTURE/CLAUDE.md drift log | passed | Read all three diffs; CHANGELOG Added bullet and ARCHITECTURE profile-layer paragraph accurately describe the shipped resolveProfile/parseProfile/buildDefaultProfile behavior (cross-checked against source), CLAUDE.md gained the one expected drift-log line |

## Attacks

| Vector | Outcome | Evidence |
|--------|---------|----------|
| maxOutput = NaN / Infinity in a profile entry | held | parseProfile threw ProfileError code invalid_config for both NaN and Infinity maxOutput values (scratch test, 8 pass / 0 fail) |
| entries as a non-array object, entry itself an array, role as an array (type confusion) | held | each rejected with the expected ProfileError code (invalid_config / unknown_role) in the scratch attack test |
| __proto__ as a role-name string (prototype pollution attempt) | held | rejected as unknown_role; {}.polluted stayed undefined afterward |
| 1000-entry profile collapsing to 3 duplicate (role,complexity) keys | held | parseProfile threw duplicate_entry promptly, no hang or resource blowup (19ms total for all 8 attack tests) |

## Issues found and fixed

- [none]

## Issues left unfixed (advisory)

- [none]

## Security findings (if any)

- [none]

## Cost

Output tokens only — no input tokens, no cache reads, no cache writes — so this figure cannot say whether prompt caching is helping, and on a measured run it was 0.2% of the bill. For the rest, run `scripts/ldo-cost.sh <transcriptDir>` after the run: the cache figures exist in the per-agent transcripts, just not here. A per-phase number is a delta measured around that phase, not an attribution: the token pool is shared across the whole turn.

- Total: 67377
- planner (Plan): 30296
- coder (Code): 23743
- reviewer (Review): 13338
