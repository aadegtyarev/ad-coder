# Backlog

## 2026-09-10

- [low] UsageDeltaTracker (src/ledger/usage.ts): Map growth unbounded when stream IDs are unique per run — either add explicit `forget(key)` call on stream end, or cap with LRU eviction and document the cap. Alternative: accept that per-run unique keys do not accumulate across runs (directory `.ad-coder/ledger/` is gitignored, cleaned externally).
- [low] Ledger (.ad-coder/ledger/): Files accumulate with no stated retention policy — document in README that directory is gitignored and subject to external pruning; consider CI/CD cleanup strategy.
