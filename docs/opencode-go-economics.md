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

Provisional, to be moved by measurement rather than defended:

- **cheap** (summarizer, trivial planner/auditor) — `glm-5.3-flash`: the best
  rate available and already accepted 3/3 as a trivial Coder.
- **middle** (medium coder/security) — `deepseek-v4.1-flash` while the promotion
  lasts, `deepseek-v4-flash` after 2026-09-20.
- **strong** (complex coder) — `minimax-m3`: same price and allowance as
  `minimax-m2.7`, newer model.
- **quality-first** (complex reviewer and security) — `kimi-k2.7-code`.

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
