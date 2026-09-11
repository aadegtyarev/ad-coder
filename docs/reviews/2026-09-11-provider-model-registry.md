# Provider/Model Registry Module

**Date:** 2026-09-11  
**Verdict:** APPROVED  
**Complexity:** complex  
**Security surface:** elevated  
**Coder passes:** 1

## Summary

Implemented the leaf module src/registry/ for provider and model configuration — the bottom layer of the project's 4-layer config model. The module captures ProviderConfig (id, api-kind, baseUrl, credential source) and ModelConfig (modelId, contextWindow, cost metadata) as plain data. Three core pieces: strict fail-loud validator (parseRegistryConfig), registry resolver (resolveRegistry) that builds a pi Models collection with injected env accessor for credentials, and exactly five preset builders (deepseek, openrouter, openai-compatible, anthropic-compatible, openai-codex). All two operator-resolved conflicts applied: openai-codex stays as a preset with OAuth credential source, delegated to pi's factory with no local token handling; exactly five presets delivered with no separate native-openai/native-anthropic presets (users reach native via the custom-compatible presets pointing to api.openai.com / api.anthropic.com). Security review findings (SSRF, scheme validation, envVar format, compat pass-through, credential boundary) all addressed and verified by targeted attack scripts.

## Verification

| Criterion | Status | Evidence |
|-----------|--------|----------|
| Step 1: types.ts compiles, no sibling runtime imports | passed | tsc --noEmit clean; file reads only type-only pi-ai Model/Models/Api imports |
| Step 2: RegistryError exposes code+detail, no credential values interpolated | passed | grep errors.ts resolve.ts shows only names (envVar, provider id, model name) in messages, never a resolved key value |
| Step 3: parseRegistryConfig accepts valid, rejects all named cases with correct code+detail | passed | bun test test/registry.test.ts 27/27 pass; duplicate_provider/duplicate_model/unsupported_api/empty_envVar/non-numeric_cost/non-https/non-URL/userinfo cases all covered and correct |
| Step 4: exactly five presets, validator-accepted, byte-match pi-ai baseUrl/api/credential | passed | grep src/registry/presets.ts export counts exactly 5; test 'preset baseUrl/api/credential match' passes; deepseek=https://api.deepseek.com openai-completions, openrouter=https://openrouter.ai/api/v1, codex=https://chatgpt.com/backend-api oauth, custom presets reject empty/non-https baseUrl |
| Step 5: resolveRegistry builds Models, resolves lookup by name, throws missing_credential (name-only) / unknown_model, delegates codex to openaiCodexProvider() | passed | registry.test.ts 'missing_credential contains name only' and 'unknown_model throws' and 'codex resolves via openaiCodexProvider' pass; custom decoy-env attack confirms injected accessor is what flows to models.getAuth() |
| Step 6: every new name exported from src/index.ts and pinned in test/package-exports.test.ts; nothing wired into runner/orchestration | passed | grep -rn registry src/runner src/orchestration returns no matches; package-exports test imports all new exports and passes |
| Step 7: bun test test/registry.test.ts passes, no network, no API key in env | passed | 27/27 pass, 0 fail; only decoy env set and cleaned in afterEach; no real provider keys present |
| Step 8: README/CHANGELOG/ARCHITECTURE/CLAUDE.md updated, five-preset model + native-via-custom + cacheRetention note | passed | All four files read and verified: README 'Configure providers' section lists exactly five presets with oauth caveat and native-via-custom+cacheRetention note; CHANGELOG has Added entry; ARCHITECTURE describes credential-resolution flow; CLAUDE.md drift log has dated line |
| Revert-and-restore proof: tests fail on reverted code, pass on restored | passed | Reverted tracked docs + moved src/registry/ aside → both test files failed with SyntaxError (missing exports); restored via git apply --exclude + moving src/registry back → diff confirmed byte-identical, tests green again (27/27), full suite 125/125, tsc clean |

## Attacks

| Vector | Outcome | Evidence |
|--------|---------|----------|
| provider id / model name = '__proto__' (prototype pollution) | held | parseRegistryConfig accepted as plain string key in Set/Map (not object property assignment); no pollution |
| baseUrl pointed at 169.254.169.254 (cloud metadata host) with arbitrary env-var credential | held | Accepted by validator — exact SSRF gap security review flagged; Coder explicitly disposed of via trust-boundary documentation (config author trusted, https-only is scheme-hardening not host control); disposition stated plainly in validate.ts JSDoc, resolve.ts JSDoc, README, CHANGELOG, ARCHITECTURE, CLAUDE.md — behaves exactly as documented |
| 20,000-model provider (scale stress) | held | parseRegistryConfig validated in 29ms, no hang or resource blowup |
| Infinity as a cost field | held | 'model.cost.input must be a finite number' — Number.isFinite check caught it |
| 50 concurrent resolveRegistry() calls against independent configs | held | all 50 resolved correctly, no shared-state corruption (each call builds its own createModels() instance) |
| env-var provider declaring api: 'openai-codex-responses' (bypass oauth-only path) | held | Correctly rejected: 'unsupported_api bad-codex api openai-codex-responses cannot be resolved for an env-var provider; codex-responses is OAuth-only' |
| newline embedded in envVar name | held | Accepted by validator (no format check); resolveRegistry correctly threw missing_credential with newline-containing name in detail — functionally correct but confusing error message; filed as minor finding |

## Issues found and fixed

None found during implementation. All eight step deliverables completed as specified.

## Issues left unfixed (advisory)

- [minor] `src/registry/validate.ts`: parseCredential's envVar check only requires non-empty string — does not restrict to valid environment-variable name format (alphanumeric/underscore only). Whitespace, newlines, control chars accepted and flow verbatim into RegistryError.detail/message. Minor log-injection / confusing-output vector if config is less carefully authored than assumed. Recommendation: optionally add /^[A-Za-z_][A-Za-z0-9_]*$/.test(envVar) check, rejecting with invalid_config. Not blocking given operator-trusted config trust boundary; verified this only affects error-message readability, not security controls.

## Security findings

[medium] **baseUrl host trust boundary**: The hard requirement constrains baseUrl to absolute https URL. Rationale states this stops attacker-influenced config from pairing arbitrary env vars with exfiltration hosts. Rationale overstates the guarantee. https-only prevents cleartext downgrade and non-http schemes (file:, http:, gopher:) — real hardening — but does NOT constrain the HOST. new URL('https://evil.example') passes. ProviderConfig independently pairs arbitrary baseUrl (host) with arbitrary env-var NAME, and envApiKeyAuth resolves whatever NAME handed, so a config reaching resolveRegistry can direct any named process-environment secret to any https host the config author chooses. → **Disposition (Coder implemented)**: Changed JSDoc/rationale in validate.ts, resolve.ts, and CLAUDE.md to state plainly this is scheme-hardening (no cleartext transmission), NOT an exfiltration control, with trust boundary (config author is trusted) documented in module doc. Removed overstated claim. Verified by reading code and attack script (metadata host 169.254.169.254 correctly rejected only by https-only scheme, accepted by validator, disposed of by documented trust boundary).

[low] **input_validation: scheme and userinfo**: Scheme check must be exact equality url.protocol === 'https:' (not startsWith/regex loose match like 'httpsx:' or 'https-evil:'). Parser must reject embedded userinfo (https://user:pass@host) which overrides auth intent. → **Disposition (Coder implemented)**: validate.ts line 82 uses new URL(baseUrl) with throw-on-parse-fail (non_url), then requires url.protocol === 'https:' by exact equality, and rejects when url.username or url.password is non-empty. Verified by reading code and attack script ('httpsx://evil.com' rejected, 'https://user:pass@host' rejected, 'https://host' accepted).

[info] **input_validation: compat pass-through**: ModelConfig.compat is typed unknown and not validated by parseRegistryConfig — only required to be a non-empty object (or absent). If compat flows into pi Model/provider construction and influences request shaping (headers, transport), unvalidated blob is a seam in otherwise no-coercion posture. → **Disposition (Coder implemented)**: toPiModel in resolve.ts does NOT forward compat into provider construction. Compat is stored on the internal model config for potential future use but never transmitted to pi's createProvider. Verified by reading code (compat parameter not passed to createProvider call) and tracing resolve path end-to-end.

[info] **data_exposure: credential boundary (env accessor)**: Credential boundary (injectable accessor for tests, never read target-dir dotenv) depends on where envApiKeyAuth actually resolves the key from. If envApiKeyAuth reads process.env directly rather than through authContext.env, injected sync accessor seam is only enforced by step-5 preflight and not by value pi actually transmits. → **Disposition (Coder implemented + verified)**: Checked installed pi-ai source (dist/auth/helpers.js) — envApiKeyAuth.resolve correctly routes through authContext.env (the injected seam), not process.env directly. Ran decoy-env attack script: set real process.env value to 'REAL', injected fake accessor returning 'FAKE', confirmed models.getAuth() yields 'FAKE'. Credential boundary holds.

## Cost

Output tokens only — no input tokens, no cache reads, no cache writes — so this figure cannot say whether prompt caching is helping, and on a measured run it was 0.2% of the bill. For the rest, run `scripts/ldo-cost.sh <transcriptDir>` after the run: the cache figures exist in the per-agent transcripts, just not here. A per-phase number is a delta measured around that phase, not an attribution: the token pool is shared across the whole turn.

- Total: 103635
- planner (Plan): 29842
- security (Security): 8533
- coder (Code): 42767
- reviewer (Review): 22493
