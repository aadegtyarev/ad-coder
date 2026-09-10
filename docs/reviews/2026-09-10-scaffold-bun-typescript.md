# Scaffold ad-coder Bun+TypeScript Project

**Date:** 2026-09-10  
**Verdict:** APPROVED  
**Complexity:** medium  
**Security surface:** elevated  
**Coder passes:** 1 fix pass (after security review)

## Verification

| Criterion | Status | Evidence |
|-----------|--------|----------|
| `bun install` completes and creates bun.lock | passed | Ran `bun install --frozen-lockfile` after fix pass — no-op output confirming lock is canonical |
| `bun run typecheck` exits 0 on full source | passed | `tsc --noEmit -p tsconfig.json` completed, no errors; includes new examples and all strict config rules applied |
| `.gitignore includes node_modules and .ad-coder` | passed | `git check-ignore -q node_modules .ad-coder/` both exit 0; `grep -c ldo .gitignore` returns 4 (pre-existing LDO entries intact) |
| tsconfig.json has moduleResolution "bundler" | passed | `grep moduleResolution tsconfig.json` shows `"moduleResolution": "bundler"` — required for pi .d.ts explicit .ts extension re-exports |
| `bun test` passes full suite | passed | `bun test` output: 36 pass, 0 fail, 190 expect() calls; includes ledger-delta synthetic tests and new package-exports regression test |
| Ledger writes JSONL to .ad-coder/ledger/<runId>.jsonl | passed | Handler appended 2 JSONL lines per synthetic turn; `file -b $(ls -t .ad-coder/ledger/*.jsonl \| head -1)` shows ASCII text with `{"ts":`, no headers map present |
| CLI `ad-coder run` loads workflow and prints result | passed | `bun run src/cli.ts run examples/hello.workflow.ts` exited 0, printed `{"greeting":"hello from ad-coder",...}` |
| CLI rejects missing args, bad paths, URL specifiers with exit 2 | passed | (1) no args → exit 2, stderr "missing command"; (2) `./nope.ts` → exit 2, stderr ENOENT; (3) `https://...` → exit 2, stderr "refuses URL" |
| Role/defineRole/toHarnessOptions types pass strict tsconfig | passed | `tsc --noEmit` on probe code constructing full Role with getBuiltinModel, createModels, and compaction disabled — exit 0 |
| activeToolNames is unconditional in harness options | passed | Inspection of src/role.ts toHarnessOptions: `activeToolNames: [...role.activeToolNames]` emitted unconditionally, never conditionally spread |
| diffUsage handles non-monotonic sequences | passed | test/ledger-delta.test.ts includes case: negative delta clamped to 0, anomaly field set to "non_monotonic" |
| Optional usage fields (cacheWrite1h, reasoning) absent when absent on both sides | passed | src/ledger/usage.ts uses conditional spread `...(v !== undefined && { reasoning: v })`; test asserts field omitted from result |
| CLAUDE.md gains exactly one drift-log line | passed | `git diff CLAUDE.md` shows single added line inside features block; LDO version block and all other content unchanged |
| README documents the public API and CLI correctly | passed | README lists install/test/typecheck/`ad-coder run` with clear example; states "Pi's compaction disabled so context strategy stays in ad-coder" |
| Package exports public bindings by name | passed | test/package-exports.test.ts imports Role from "ad-coder" (package name) and from relative path, asserts identical binding; 2/2 pass |

## Attacks

| Vector | Outcome | Evidence |
|--------|---------|----------|
| activeToolNames omitted / undefined grants all tools | blocked | toHarnessOptions emits activeToolNames unconditionally — empty array is a valid deny-all and harness honours it. Verified: test/role.test.ts asserts Role with `activeToolNames: []` produces options object with `"activeToolNames" in opts === true` and value `[]` |
| runId injection into filesystem path (no charset validation) | blocked | Ledger constructor validates runId against `/^[A-Za-z0-9_-]{1,64}$/` and throws TypeError if invalid. CLI generates runId via `crypto.randomUUID()` which always satisfies the regex |
| Symlinks and pre-existing loose directory in ledger path | blocked | After `mkdir(dir, { recursive: true })`, explicit `chmod(dir, 0o700)` corrects pre-existing directories. Record file opened with `O_NOFOLLOW | O_CREAT | O_EXCL, 0o600`, fstat validates nlink===1 and no group/other bits before write. Accept criterion extended to symlink-target and pre-existing-0777 cases |
| Missing file creation if dir is read-only | blocked | Extended accept criterion: path resolution validated, parent directory required writable, and fstat refusal documented. `bun test test/ledger-security.test.ts` covers EACCES scenario |
| Newline injection in role/step/lane into JSONL record | blocked | Record assembled as single plain object, emitted via `JSON.stringify(record) + "\n"` (never template interpolation). test/ledger-injection.test.ts asserts role name with embedded `\n` produces exactly one JSONL line that round-trips via JSON.parse |
| Concurrent delta reads on same key double-count tokens | blocked | `delta(key, cumulative)` is fully synchronous — no await between Map.get and Map.set. Comment in code marks it sync-only for refactor safety |
| Concurrent file appends race | blocked | Each record appended via single write(fd, ...) with O_APPEND; records < 4KB atomic-append size. If async writes added, they must be serialised through a per-Ledger promise chain |
| Write errors fail silently | blocked | Handler catches write errors, emits one-line warning to stderr on first failure, and exposes `droppedRecords` count on Ledger. CLI prints count at exit if non-zero; test/ledger-errors.test.ts injects throwing sink and asserts counter increments |
| Arbitrary code execution: `ad-coder run <script>` | constrained | lstat on resolved path requires regular file (rejects directories, FIFOs, devices, symlinks). Refuses group/world-writable files and files not owned by current uid. README states plainly: workflow module runs in-process with full access to environment, so path must be treated as trusted input |
| Provider SDK errors leak to stdout | blocked | Error handling catches and logs `error.message` + optional stack only, never dumps error object. Never console.log SettledAssistantMessage or after_response event. Successful result printed as `JSON.stringify(returned value)` only; README warns workflow return value reaches stdout, must not contain secrets |

## Issues found and fixed

- [major] activeToolNames: unset field would grant all registered tools via harness's default — emitted unconditionally instead
- [medium] runId injection: no charset validation on filesystem path — added regex validation and CLI's crypto.randomUUID() generation
- [medium] symlink and pre-existing-directory attacks on ledger path — added O_NOFOLLOW, explicit post-mkdir chmod, fstat validation, and extended accept criteria
- [medium] newline injection in JSONL record via unsanitized interpolation — record assembled as object, emitted via JSON.stringify only
- [medium] concurrent delta reads on one key double-count tokens — delta() method marked fully synchronous, comment notes refactor constraint
- [medium] write errors on ledger append fail silently, audit trail lost — handler catches errors, warns to stderr once, exposes droppedRecords counter
- [low] file permission bypass via mode-masked mkdir and follow-symlink append — explicit chmod, O_NOFOLLOW on open, fstat validation
- [low] Ledger accepts untrusted runId and filePath without validation — runId regex validated, filePath resolved and must stay inside base directory
- [low] Error objects leak detail (request/response) to stdout — log error.message and optional stack only, not error object
- [low] Workflow return value printed without warning — documented in README that result reaches stdout and must not contain secrets

## Issues left unfixed (advisory)

- [low] UsageDeltaTracker Map growth unbounded when stream IDs are unique per run — either add explicit `forget(key)` call on stream end, or cap with LRU eviction; document the ceiling. Alternatively: accept that per-run unique keys do not accumulate across runs (directory .ad-coder/ledger/ is gitignored, cleaned externally)
- [low] .ad-coder/ledger/ accumulates files with no stated retention policy — document in README that directory is gitignored and subject to external pruning; consider CI/CD cleanup strategy

## Security findings

- [critical] activeToolNames undefined → all tools granted: **FIXED** — unconditional emit closes this completely
- [critical] runId in filesystem path with no validation → path traversal/injection: **FIXED** — regex validation and bounded charset
- [critical] symlink and pre-existing directory attacks → permissions bypass: **FIXED** — O_NOFOLLOW, explicit chmod, fstat gating
- [critical] newline in JSONL fields → record forgery: **FIXED** — JSON.stringify with no interpolation
- [critical] write errors silent → audit trail lost: **FIXED** — warning logged, droppedRecords counted
- [high] concurrent Map read-modify-write → double-count tokens: **FIXED** — fully synchronous delta, comment notes refactor boundary
- [high] file permission races (umask, append-follows-symlink): **FIXED** — O_NOFOLLOW, fstat, explicit chmod
- [high] Error object dump to stdout → secret exposure: **FIXED** — error.message only, documented return value constraint
- [medium] .ad-coder/ledger retention unbounded: **LEFT UNFIXED** — document policy, accept per-run uniqueness and external cleanup
- [medium] UsageDeltaTracker Map unbounded growth: **LEFT UNFIXED** — either forget on stream-end or document ceiling

## Cost

Output tokens only — no input tokens, no cache reads, no cache writes — so this figure cannot say whether prompt caching is helping, and on a measured run it was 0.2% of the bill. For the rest, run `scripts/ldo-cost.sh <transcriptDir>` after the run: the cache figures exist in the per-agent transcripts, just not here. A per-phase number is a delta measured around that phase, not an attribution: the token pool is shared across the whole turn.
- Total: 117762
- security (Security): 29745
- coder (Code): 49231
- reviewer (Review): 19577
- coder-fix-1 (Code): 10237
- reviewer-1 (Review): 8972

Your own Record phase is NOT in these figures: this block was composed before you were called, so nothing here could include it. The run log and the returned result carry a later total that does.
