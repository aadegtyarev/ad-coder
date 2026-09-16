# OpenCode Go economics

What a $10/month OpenCode Go subscription actually buys, why its allowances do
not track token prices, and which models a role grid should sit on. Recorded
2026-09-16 from the provider's published tables and a live account.

## The allowance is a multiplier, not a ceiling

Go is a flat $10/month subscription. Each model carries its own monthly
allowance denominated in list-price dollars, and the allowances are per model
rather than one shared wallet. The published windows are proportions of it:
5 hours is 20% of the monthly allowance, a week is 50%, a month is 100%.

So a model allowed $60 returns six list-dollars of usage for every dollar paid,
a $30 model three, a $15 model one and a half. Where OpenCode negotiated bulk
capacity the multiplier is 6x; where the model is new, or its vendor already
discounts it heavily, it is 1.5x.

**The allowances multiply across models rather than adding up.** Spreading roles
over four models allowed $60 each yields $240 of included usage for the same
$10. A role grid is therefore not only a quality decision on this provider — it
is how the budget is multiplied, and ad-coder's grid happens to be shaped for it.

## What the multiplier is worth in tokens

Blended at 90% input / 10% output, which is the shape agent traffic actually has:

| model | allowance | list in/out | ≈ tokens/month | multiplier |
| --- | --- | --- | --- | --- |
| `glm-5.3-flash` | $60 | 0.15 / 0.50 | 324M | 6x |
| `deepseek-v4.1-flash` | $60 (promo) | 0.15 / 0.60 | 307M off-peak | 6x |
| `deepseek-v4-flash` | $30 | 0.14 / 0.28 | 195M | 3x |
| `minimax-m3` | $60 | 0.30 / 1.20 | 154M | 6x |
| `qwen3.7-plus` | $60 | 0.40 / 1.60 | 115M | 6x |
| `kimi-k2.7-code` | $60 | 0.95 / 4.00 | 48M | 6x |
| `glm-5.2` | $60 | 1.40 / 4.40 | 35M | 6x |
| `glm-5.3` | $15 | 1.40 / 4.40 | 8.8M | 1.5x |
| `kimi-k3` | **$15** | — | — | **1.5x** |
| `glm-5.2` | $60 | 1.40 / 4.40 | 35M | 6x |
| `longcat-2.0` | $60 | — | — | 6x |
| `minimax-m2.5` | $60 | — | — | 6x |
| `qwen3.8-flash` | $30 | — | — | 3x |
| `qwen3.8-max` | **$15** | — | — | **1.5x** |
| `deepseek-v4-pro` | **$15** | — | — | **1.5x** |
| `grok-4.6` | $15 | — | — | 1.5x |
| `gpt-5.6-luna` | $15 | — | — | 1.5x |
| `mimo-v2.5` | $60 | — | — | 6x |

Allowances are published on `opencode.ai/docs/go/`, not on the marketing page,
which lists ten of twenty-seven models. The same page states how the ceiling is
spent: a five-hour window is 20% of the monthly figure, a week is 50%.

**Measured quality and allowance disagree, and the allowance wins.** Of the four
models that reached 1.00 on `coder-retention-v1`, `glm-5.2` carries a $60
allowance and `kimi-k3` and `qwen3.8-max` carry $15 -- so the two that look
cheapest per token buy a quarter of the work. `longcat-2.0` and `minimax-m2.5`
are $60 but score 0.88. The buy is `glm-5.2`: best allowance among the models
that actually reach 1.00.

**`kimi-k3` is the second instance of the trap this document was written for.**
It reaches 1.00 on `coder-retention-v1` and its list price is about half
`glm-5.2`'s, which reads as the better buy -- and its allowance is $15 against
`glm-5.2`'s $60, so it is four times the worse one. Checked only after a live
sweep had already recommended it here; the recommendation is withdrawn.

`gpt-5.6-luna` is listed at $15 and answers HTTP 500 on every request. Listed,
allowanced, and unavailable are three different states.

The find worth naming is `kimi-k2.7-code`: 48M monthly tokens of a strong
code-specialized model, inside the same $10. No comparable rate exists on
OpenRouter.

## Two traps

**Identical price, four times the allowance.** `glm-5.3` and `glm-5.2` are
priced the same and allowed $15 and $60. The newer model is the worse buy by a
factor of four, which no reading of the price list reveals.

**DeepSeek charges peak rates** between 01:00-04:00 and 06:00-10:00 UTC on
weekdays — double price, so the allowance drains twice as fast for half the
working day. `deepseek-v4.1-flash` also carries a promotional lift from $15 to
$60 that ends 2026-09-20, after which `deepseek-v4-flash` becomes the better
middle tier despite its smaller allowance.

## Starting grid

Written from the price list on 2026-09-15, marked "to be moved by measurement
rather than defended", and moved by measurement on 2026-09-16. What follows is
what eleven models on `coder-retention-v1` actually showed; the superseded
guesses are named so the change is auditable rather than silent.

- **cheap** (summarizer, trivial planner/auditor) — `glm-5.3-flash`. Unchanged
  for the summarizer, and now for a measured reason rather than a rate: holding
  the role fixed and varying the summarizer across three models left the score
  identical, so the summarizer slot should hold the cheapest acceptable model,
  and it is exercised on every context overflow.
- **middle** (medium coder) — **`glm-5.2`**, replacing `glm-5.3-flash`. Five
  runs: 1.00, 1.00, 1.00, 1.00, 0.94, against 0.88/0.88/0.78 for
  `glm-5.3-flash`. It is also four times the better buy under the allowance
  arithmetic above, at the same token price. Two independent reasons, and the
  price list showed neither.
- **strong** — **not `minimax-m3`**. It is the fastest model measured by a wide
  margin, 25 seconds against 95 for the next, and it scored 1.00, 0.94, 0.94,
  0.41 and 0.25 across five runs on one task. That spread is the whole argument
  for repeats: any single one of those numbers decides the cell differently.
  Place it where a bad run is cheap to absorb, not where it is not.
- **quality-first** — `kimi-k2.7-code` stands, and `kimi-k3` is the candidate to
  displace it: 1.00 on the coder task at 143 seconds.

Two findings that change how the list is read. **The dearest model is not the
best**: `deepseek-v4-pro` scored 0.88 in five minutes where free-by-subscription
`kimi-k3` and `glm-5.2` reached 1.00. And **three models the list advertises
cannot be reached at all** — `grok-4.6` answers 401 not-supported,
`minimax-m2.7` and `gpt-5.6-luna` answer 500. Listed and available are different
facts.

Full per-model numbers are in `model-calibration.md`; the raw measurements, with
provider and harness outcome, are in `calibration-evidence.jsonl`.

Routing from these numbers is a procedure in its own right — bands against a
reference, the allowance rather than the list price, cost and latency reported
together. See [benchmark-method.md](benchmark-method.md) §4.

## What ad-coder cannot yet represent

The pi-ai catalog carries a single list price per model, so none of the above is
visible to routing: not the allowance, not the peak split, not the promotion's
end date. Worse, two catalog entries disagree with the published prices —
`glm-5.3-flash` is listed at half its real rate, which would report this plan's
central model at a 12x multiplier instead of 6x. See
[#132](https://github.com/aadegtyarev/ad-coder/issues/132).

Requests also require a stable `x-opencode-session` header, which the provider
uses for routing and prompt caching; without it the API answers HTTP 400
`MissingSessionID`. See [#120](https://github.com/aadegtyarev/ad-coder/issues/120)
and `docs/provider-catalogs.md`.

Sources: <https://opencode.ai/docs/go/>, <https://opencode.ai/docs/zen/>.
