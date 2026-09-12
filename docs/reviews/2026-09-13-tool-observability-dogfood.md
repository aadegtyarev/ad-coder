# Tool-observability dogfood interruption — 2026-09-13

This is an exceptional incident handoff, not an approval receipt. It exists so a
cold session can resume without reconstructing the run from chat history.

## Resume point

- Branch: `feat/tool-observability-dogfood`
- Base: merged `main` commit `35ecddf`
- Coordinator run: `8e4c95bd-04eb-4c90-af18-2db55a889fef`
- Checkpoint:
  `.ad-coder/runs/coordinator-8e4c95bd-04eb-4c90-af18-2db55a889fef.json`
- Terminal workflow state: `code`, round 1; no Reviewer ran.
- Terminal error: `invalid_follow_up: follow-up has an unknown field`.
- Implementation state: Coder edits remain in the working tree and are
  intentionally unapproved pending verification and independent review.

The run was started from the repository root with:

```sh
bun src/cli.ts drive "Implement the proposed semantic tool-activity stream in docs/proposed-contracts/tool-observability.md. Treat it as the product contract to satisfy, but move it into docs/contracts only after implementation and tests conform. Emit bounded safe structured lifecycle events from the headless core for requested/started/completed/failed/cancelled/timed-out tool activity; expose an optional subscription/consumer API usable by all fronts; render compact semantic Read/Search/Edit/Run/Web/Inspect image progress in console while preserving heartbeat when no activity arrives; emit stable JSON progress events on stderr without polluting result stdout. Respect configuration, error, architecture, documentation, compatibility, quality, and product-change contracts. Preserve existing APIs where possible, add focused unit/integration tests including secret projection, dropped-event visibility, JSON/human rendering, zero-heartbeat behavior, and failure/cancellation. Update architecture, README, changelog, and backlog honestly. Record per-stage model, duration, input/cache/output/reasoning tokens, cost, review rounds, and context strategy for this dogfood run so profile efficiency can be evaluated." --provider openai-codex --target-dir . --auto --max-rounds 3 --request-timeout-ms 240000 --heartbeat-ms 10000
```

## Measured run

All stages used `openai-codex` / `gpt-5.6-sol`. Values below come from the
persisted session usage envelopes; they are provider-reported, not estimates.

| stage | thinking | duration | fresh input | cache read | output | reasoning | total tokens | cost |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Planner | off | 5m 52s | 210,079 | 990,976 | 15,492 | 5,629 | 1,216,547 | $2.010643 |
| Security | off | 3m 35s | 30,662 | 40,960 | 6,221 | 4,524 | 77,843 | $0.360420 |
| Coder | medium | 31m 25s | 419,572 | 20,224,128 | 49,630 | 10,744 | 20,693,330 | $13.698824 |
| **Total** | | **40m 52s** | **660,313** | **21,256,064** | **71,343** | **20,897** | **21,987,720** | **$16.069887** |

Review rounds completed: zero. The accepted-result total is zero because the
Coder stage did not close successfully. Context strategy recorded for planning
and security was `auto`; the failed checkpoint did not persist a Coder strategy.

## What the dogfood run established

1. Generic heartbeat does not explain the active stage or tool, so the feature
   being built is justified by direct operator evidence.
2. A schema-valid tool call can still be semantically invalid: the tool schema
   exposes `contract`, `document`, and `priority` together as optional, while
   the discriminated validator rejects fields irrelevant to the selected
   `kind`. The final Coder call supplied all six public keys. Its optional
   follow-up metadata invalidated the whole otherwise completed stage.
3. `request-timeout-ms` bounds an individual request, not the whole role loop.
   The Coder made 167 responses over 31 minutes and read 20.2M cached tokens.
   Stage wall-clock, model-turn, tool-turn, and token/cost budgets need durable
   pause/resume semantics.
4. The broad Planner plus monolithic Coder paid repeated-context cost. The next
   iteration should use scoped reconnaissance, small implementation slices, and
   adaptive review context, while retaining a broad first independent review.

## Cold-session continuation

1. Read this file, the coordinator checkpoint, and the diff; do not rerun
   Planner or Security.
2. Diagnose and preserve the Coder implementation. Run focused tests, then
   `bun run check`, the full test suite, typecheck, docs checks, release checks,
   and artifact smoke as defined by project scripts.
3. Correct failures in small slices. Do not silently weaken the proposed
   contract or security mitigations.
4. Run the independent Reviewer after the gates pass. Record its verdict,
   usage, cost, and any rounds here or in a successor exceptional receipt.
5. Keep this feature on its branch and open a PR; the operator merges.
