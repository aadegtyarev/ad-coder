# GPT-5.6 model research for ad-coder

**Observed:** 2026-09-13  
**Researcher:** GPT-5.6 Terra; independently checked by Orchestrator  
**Accepted run:** `1d97dfad-105b-4a51-b756-d1221e85f402`  
**Usage:** 233.5s, 20 model turns, 30 tool turns, 405,009 input tokens,
5,930 output, 1,211 reasoning, $0.2535684 provider-reported cost

This replaces the rejected report from run
`98b47f85-9aab-4230-9ab7-a66785955300`. That report falsely classified Luna,
Terra, and Sol as undocumented aliases because it checked exact catalogs but
missed OpenAI's GPT-5.6 family announcement.

## Decision summary

OpenAI documents three GPT-5.6 variants:

- **Luna** is the cheapest family member and the starting candidate for
  deterministic, bounded, high-volume tasks.
- **Terra** balances capability and cost and is the starting candidate for
  ordinary multi-step engineering and broad cataloguing research.
- **Sol** is the flagship and strongest coding variant and is the starting
  candidate for ambiguous, consequential, security-sensitive, or long-horizon
  work.

These are vendor-supported starting hypotheses. They do not establish ad-coder
quality. The first empirical pass holds effort at `low` for every model so model
choice and effort are not confounded. Effort is raised only for a failed or
economically ambiguous cell.

## Verified common API facts

The three official model pages report a 1,050,000-token context window and
128,000 maximum output tokens. They list reasoning levels `none`, `low`,
`medium`, `high`, `xhigh`, and `max`, with `medium` as the API default.

Direct OpenAI API list prices per million input, cached-input, and output tokens:

- Luna: $0.20, $0.02, $1.20.
- Terra: $2.00, $0.20, $12.00.
- Sol: $4.00, $0.40, $20.00.

For prompts above 272K input tokens, the official pages state that the whole
request is charged at 2× input and 1.5× output; cache writes cost 1.25× uncached
input. This makes early projection and compaction economically significant.

OpenRouter showed a lower Sol price than direct OpenAI during this observation.
That is a provider-specific offer, so profiles must store pricing per provider,
model, date, and context band rather than attach one universal price to a model.
Codex subscription capacity remains unknown and must stay separate from API
token economics.

The fetched Codex pricing page lists Plus at $20/month and Pro from $100/month,
with Pro described as 5x or 20x Plus usage depending on tier. It does not publish
fixed per-model quotas or reset windows. Enterprise accounting lists credits per
million input/cached/output tokens: Sol 100/10/500, Terra 50/5/300, and Luna
5/0.5/30. Credits are plan accounting units, not USD token prices.

OpenRouter's fetched catalog records list Luna at $0.20/$0.02/$0.25/$1.20,
Terra at $2/$0.20/$2.50/$12, and Sol at $2/$0.20/$2.50/$10 per million
input/cached/cache-write/output tokens. The direct Sol page marks its
$4/$0.40/$20 pricing promotional through at least 2026-11-21, creating a dated
recheck trigger rather than permission to predict a future price.

## Luna decision record

**Best initial workload:** exact classification, structured extraction,
deterministic transformations, concise triage, and narrow single-file changes
with executable checks.

**Initial roles:** simple Orchestrator routing, bounded Planner decomposition,
Researcher extraction from already identified sources, Security evidence
collection, mechanical Coder work, checklist Reviewer, and format Auditor.

**Avoid initially:** architecture, independent broad research conclusions,
security disposition, subtle regression review, unfamiliar multi-component
changes, and long tool-recovery loops.

**Evidence:** strongest on price and vendor positioning; independent exact-Luna
coding and agentic evidence was not verified. Tool reliability must therefore be
measured locally.

**Start:** `low`. Escalate to Terra after first-pass gate failure, substantive
review correction, repeated tool/schema recovery, or more than one component
boundary.

## Terra decision record

**Best initial workload:** ordinary multi-file implementation with clear
acceptance tests, implementation planning, repository-scoped investigation,
routine code review, moderate debugging, and multi-source cataloguing.

**Initial roles:** normal Orchestrator, Planner, Researcher, Coder, Reviewer, and
Auditor work. For Security, use it for triage and candidate mitigations while
keeping consequential disposition on Sol or independent human review.

**Avoid initially:** final authority for high-risk security or architecture and
unbounded autonomous loops where failure is expensive.

**Evidence:** official balanced positioning and price are verified. Vals reports
73.41% Terminal-Bench 2.1 for Terra, but displayed aggregate figures differed
between its pages, so aggregate quality remains low-confidence.

**Start:** `low`. Escalate to Sol for contradictory requirements, trust-boundary
changes, broad blast radius, repeated failures, or reviewer disagreement.

## Sol decision record

**Best initial workload:** complex orchestration, architecture and migration
planning, broad research synthesis, threat modelling, difficult debugging,
large refactors, adversarial review, and final evidence reconciliation.

**Initial roles:** complex Orchestrator, Planner, Researcher, Security, Coder,
Reviewer, and Auditor work. For Coder/Reviewer diversity within this Codex-only
inventory, pair Sol Coder with Terra Reviewer and Luna/Terra Coder with Sol
Reviewer until a different model family is available.

**Avoid initially:** routine high-volume work where Luna or Terra clears the same
gate at lower accepted-result cost.

**Evidence:** OpenAI calls Sol its flagship and strongest coding model. Vals.ai
displayed 96.20% SWE-bench Verified, 85.77% Terminal-Bench 2.1, and 88.14%
CyberBench for Sol. This
is independent display evidence, but the Researcher did not fully verify its
snapshot, prompts, contamination controls, or run configuration; confidence is
medium and it cannot substitute for ad-coder tests.

**Start:** `low` in the controlled first pass. Raise effort only after a failed
or ambiguous hard-task cell. De-escalate future well-specified work to Terra when
tests and review show no quality loss.

## Initial low-effort routing hypothesis

- Trivial/bounded: Luna for every non-authoritative role; Sol reviews seeded
  semantic or security defects.
- Ordinary multi-step: Terra plans/codes/researches; Sol reviews consequential
  results.
- Complex/ambiguous/high-blast-radius: Sol plans/researches/codes; Terra reviews
  to reduce same-variant blind spots.
- Security and release authority always retain identical hard gates regardless
  of model price.

The benchmark moves a role only when accepted-result economics support it.
Repair, re-review, failed runs, and escaped defects are charged to the original
route.

## Required falsification cells

1. Luna-low versus Terra-low on trivial extraction, classification, mechanical
   edit, and single-file repair.
2. Terra-low versus Sol-low on ordinary multi-file feature and refactor tasks.
3. Terra-low versus Sol-low on complex debugging, migration, and long tool-use
   tasks; raise effort only for failed or ambiguous cells.
4. Blind Terra and Sol review of the same seeded semantic, security, and
   regression defects.
5. Every variant on malformed tool output, timeout, stale state, resume, and
   schema-recovery scenarios.
6. Retrieval and compaction at 64K, 272K, 512K, and 1M inputs, including the
   long-context price multiplier.
7. Orchestrator complexity prediction versus Planner prediction and observed
   rounds, scope, failures, review findings, and budget pressure.

Record accepted-result rate, hidden-defect recall, unnecessary edits, retries,
wall time, tool failures, fresh/cached/output/reasoning tokens, provider cost,
and subscription-limit events.

## Evidence limitations

- Exact subscription quotas and resets were not verified.
- Provider-reported ad-coder cost may be an API-equivalent estimate rather than
  subscription depletion.
- Independent exact-Luna and exact-Terra engineering benchmarks remain a gap.
- The independent Sol numbers need methodology verification before high
  confidence.
- The Researcher could not fetch the announcement through its own OpenAI path,
  although the Orchestrator fetched and read the Russian official page directly.
- Search failures and long shell fallbacks consumed substantial time. Absence of
  community evidence in this run is a collection limitation.

## Sources actually inspected

- OpenAI, [GPT-5.6 announcement](https://openai.com/index/gpt-5-6/).
- OpenAI, [GPT-5.6 announcement in Russian](https://openai.com/ru-RU/index/gpt-5-6/).
- OpenAI, [GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna).
- OpenAI, [GPT-5.6 Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra).
- OpenAI, [GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol).
- Vals.ai, [GPT-5.6 Sol](https://vals.ai/models/openai_gpt-5.6-sol).
- Vals.ai, [GPT-5.6 Luna](https://vals.ai/models/openai_gpt-5.6-luna).
- Vals.ai, [GPT-5.6 Terra](https://vals.ai/models/openai_gpt-5.6-terra).
- OpenAI, [Codex pricing](https://developers.openai.com/codex/pricing/).
- OpenAI, [Batch API](https://developers.openai.com/api/docs/guides/batch/).
- OpenRouter, [model catalog API](https://openrouter.ai/api/v1/models).
- OpenRouter, [GPT-5.6 Luna](https://openrouter.ai/openai/gpt-5.6-luna).
- OpenRouter, [GPT-5.6 Terra](https://openrouter.ai/openai/gpt-5.6-terra).
- OpenRouter, [GPT-5.6 Sol](https://openrouter.ai/openai/gpt-5.6-sol).
