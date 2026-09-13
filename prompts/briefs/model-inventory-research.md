# Model inventory research brief

Use this brief only when researching models available in an operator profile.

Search the provider's product index and the model family before exact API or
inventory identifiers. Follow official family-announcement links to comparisons,
system cards, pricing, limits, and evaluations. A transport prefix may differ from
the public product name; use it to find the named family and variant, but never
transfer specifications from a different variant.

Collect intended use, supported effort, context and output limits, cache behavior,
price tiers, subscription or rate limits, provider evals, and dated independent
evals. Separate API token economics from subscription capacity. Mark unknowns.

## Mandatory economics census

Never rely on a built-in price table or memory. Fetch current pricing during this
run for every `(provider, model)` in the inventory. Start with the provider's
official model/pricing page, then inspect each configured router or reseller.
For every number record: fetched date, direct URL, provider, exact public and
transport model identifiers, currency, billing unit, input, cached input, output,
cache-write price when applicable, batch discount, context threshold and its
multiplier, and whether the value is list price, provider-reported request cost,
subscription allowance, measured capacity, or estimate. Quote enough nearby page
text in the evidence log to audit that the number belongs to the model and unit.

Research subscription plans separately: plan name, published inclusion, stated or
observed capacity unit, range/reset window, overage behavior, and confidence. Never
convert a subscription into a token price without observed depletion evidence.
Record unavailable or account-dependent limits explicitly.

Cross-check current values against one independent price/catalog surface where it
exists. A disagreement is a provider-specific price or stale-data finding, not a
number to average. Compare with prior project research and emit an append-only
change record only for a confirmed change; never silently overwrite history.

The report is incomplete if any available model lacks a current sourced economics
record or an explicit explanation of why it could not be obtained.

A claim that the provider does not document a model requires a family/product
index search, an exact catalog check, and a direct provider-domain web query.
Record the narrower result when only the transport identifier is absent.

Finish with a falsifiable starting routing hypothesis. It seeds empirical
calibration; it does not override measured accepted-result quality or cost.

For every available model, produce a separate decision record covering intended
workload, relative capability, latency/token/cost evidence, coding and agentic
evidence, tool-use suitability, useful complexity range, suitable pipeline roles,
poor-fit roles, initial effort, and escalation trigger. Map the evidence to
Orchestrator, Planner, Researcher, Security, Coder, Reviewer, and Auditor. A
generic “strong / balanced / cheap” ranking is incomplete.

Treat this as a comparison, so use broad-search depth. Include the strongest
counterevidence to the proposed routing. Distinguish vendor benchmark claims,
independent reproductions, community reports, and ad-coder measurements. Fetch
every cited page. If independent exact-variant evidence is unavailable, retain
the official intended use as a vendor hypothesis and say which benchmark cell
must test it; do not discard the documented family.
