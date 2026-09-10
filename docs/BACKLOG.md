# Backlog

## 2026-09-10

- [low] UsageDeltaTracker (src/ledger/usage.ts): Map growth unbounded when stream IDs are unique per run — either add explicit `forget(key)` call on stream end, or cap with LRU eviction and document the cap. Alternative: accept that per-run unique keys do not accumulate across runs (directory `.ad-coder/ledger/` is gitignored, cleaned externally).
- [low] Ledger (.ad-coder/ledger/): Files accumulate with no stated retention policy — document in README that directory is gitignored and subject to external pruning; consider CI/CD cleanup strategy.

## 2026-09-11

- [minor] src/context/budget.ts: ContextBudgetError's message text says "measured N tokens against maxTokens M" but does not surface the effective ceiling (min(maxTokens, model.contextWindow)) that actually determined the throw. When a role defined against a 200000-window model is invoked with a 1000-window model, the error displays "maxTokens 100000" despite the real determining threshold being 1000. Adding the effective ceiling to ContextBudgetError fields and message text would make error messages self-consistent with why they fired (cosmetic/debugging-clarity; pass/fail behavior is correct).
- [minor] src/capabilities/capabilities.ts: isLocalHost LOOPBACK_HOSTS contains bare string "::1", but `new URL(...).hostname` for any syntactically valid IPv6-loopback URL always returns the bracketed form "[::1]" (unbracketed "http://::1/v1" throws). The "::1" entry can never match; a legitimate baseUrl like "http://[::1]:11434/v1" is silently misclassified as prepaid instead of local. Fix: strip surrounding brackets before the lookup (`const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;` then check LOOPBACK_HOSTS.has(bare)), or add "[::1]" itself to the set. Verify with bun -e check after applying.
