# How benchmarks score, and what that means for ours

Commissioned 2026-09-16 after the operator's objection: "I see no point inventing
everything from scratch, unjustified. We can win or we can measure the weather on
Mars." The brief asked how public coding and agentic benchmarks actually score
model output, what is known about whether those scores mean anything, and which
of this project's own checks are reinventing solved problems or measuring
nothing.

What follows is the researcher's report as returned, with its own confidence
labels kept. `[snippet-only]` marks a claim taken from a search result rather
than a fetched source -- verify before relying on it. The conclusions this
project has acted on are summarised in `model-calibration.md`; this file is the
evidence behind them.

---

# Research report: how public coding/agentic benchmarks actually score, and what the literature says about whether the scores mean anything

**Status: complete.** Both mid-task additions (reuse candidates with licences; the two urgent questions on reference-banding and fixture validation) are answered below in sections 9, 10 and 11.

Conventions: confidence is `high` (official/primary doc, or two independent sources agreeing, and current), `medium` (one credible primary source, or sources possibly sharing an origin), `low` (single unverified source, contested, or stale). Where I could not read a primary source I say so rather than paraphrasing a summary as fact. Every URL below is one I actually retrieved or that was returned as a live search result; where I only have a search snippet and not the fetched text, I mark it **[snippet-only]**.

---

## SUMMARY (read this alone if nothing else)

Four scorer families dominate and their reliability is well characterised. **Execution against tests** is the only family with a strong reliability record, and its dominant failure mode is *weak tests*, not flaky infrastructure: independent audits put false-positive rates from insufficient tests at 31% (SWE-bench+, Oct 2024) and 59.4% of one model's audited failures at test flaws (OpenAI, Feb 2026). **LLM-as-judge** is measurably unreliable on code specifically: on CodeJudgeBench (Jul 2025), merely swapping the order of two candidate solutions moves judge accuracy by up to 14 points, and point-wise 1–5 scoring produces ties on ~50% of code-generation pairs, which is why pair-wise beats point-wise. **String/substring matching** has a documented, exploitable failure surface — τ-bench can be beaten 38–40% of the time by an agent that returns nothing or dumps the whole database. **Property/rubric checks over a materialised artifact** — which is what your harness already does — are the family with the *least* published failure analysis, which is both an opportunity and a warning: nobody has published the ways it goes wrong, so you will find them yourself.

Your design instincts land on the right side of the literature more often than not, and two of your checks are reinventing things that already have names and published thresholds. Your reviewer finding-cap is **not an invention but also not the accepted metric**: the accepted metric is precision/F1 against a ground-truth set with clean control fixtures that contain no planted defect (SWR-Bench, Sep 2025), and the closest thing to your cap in a current benchmark is Cognition's FrontierCode `scope` grader, which caps changed lines/files deterministically (Aug 2026). Your repeat-and-report-the-spread runner is correct and matches Terminal-Bench (≥5 trials per cell, 95% CIs) and τ-bench's `pass^k`. Your "a task where every model scores identically has stopped discriminating" comment in `runner/corpus.ts` is an informal restatement of a statistic that was formalised in Feb 2026 — there is now a published saturation index with a threshold you can copy rather than eyeball.

The dimensions you believe are unmeasured are **mostly measured, but almost none of them in a coding-agent setting and almost none with executable scorers**. Clarifying-under-ambiguity, conflicting instructions, abstention, and long-context retention all have dedicated public benchmarks. Scope discipline has two (SNARE, FrontierCode) and one of them is closed. Agent-to-agent handoff fidelity is the one dimension where I found essentially no executable public benchmark — one Springer chapter I could not read past the paywall, and a large volume of vendor blog content I would not build on. Handoff fidelity and role-to-role artifact carry is your genuinely novel ground.

The biggest risk to your bench is not contamination and not scorer design. It is **task validity**: the ABC audit (Jul 2025, 25 authors incl. Liang, Stoica, Zaharia, Steinhardt) found 7 of 10 major benchmarks have task-validity flaws and **all 10** have reporting flaws, and the flaws inflate or deflate scores by up to 100% in relative terms. Your recent experience — three models from two vendors independently reaching a reading your scorer marked wrong — is the textbook signature of a task-validity defect, and the published response is unambiguous: that is a defective task, not three failed models.

---

## 1. SCORING MECHANISMS: families, reliability, failure modes

### Finding 1.1 — The ABC taxonomy is the best available map of scorer families and their failure modes; adopt it wholesale
**Confidence: high.** I extracted the full checklist text from the PDF.

"Establishing Best Practices for Building Rigorous Agentic Benchmarks" (Zhu, Jin, Pruksachatkun, … Kapoor, Longpre, Sekhon, Steinhardt, Zaharia, Stoica, Liang, Kang), arXiv:2507.02825v5, 3 Jul 2025 / rev 7 Aug 2025. https://arxiv.org/abs/2507.02825 · checklist site https://uiuc-kang-lab.github.io/agentic-benchmarks/ · code https://github.com/uiuc-kang-lab/agentic-benchmarks

It splits validity into two conditions and enumerates scorer families under the second:

- **Task validity** — "a task should be solvable if and only if the agent possesses the target capability." 10 checks (T.1–T.10). The ones that matter for a fixture-based harness: T.4 residual state fully cleared between runs; T.5 agent completely isolated from ground truth; T.6 setup frozen, no live external resource; T.7 annotated ground truth verified for correctness; T.8 each task verified solvable; T.9 **benchmark includes an oracle solver that automatically solves all challenges**; T.10 implementation free of exploitable shortcuts.
- **Outcome validity** — "the evaluation result truly indicates task success." Grouped by scorer family:
  - *Whole/substring matching* (O.a.1–2, O.b.1–3): must handle semantically equivalent expressions, redundant words, negation modifiers; must be robust against an agent listing all possible answers; ground truth complex enough to prevent guessing.
  - *LLM-as-judge* (O.c.1–2): must show "documented or experimental evidence of the judge's accuracy, self-consistency, and agreement with human"; must resist adversarial input and reward hacking.
  - *Unit testing* (O.d.1–2): verify test correctness/quality by human, **and** measure test quality with an objective metric (coverage, cyclomatic complexity).
  - *Fuzz testing* (O.e.1–3), *end-to-end testing* (O.f.1–2: exercise all relevant code paths; prevent flaky results).
  - *State matching* (O.g.1–3): ground truth includes all achievable success states; **checks relevant AND irrelevant states** (their stated rationale: "to help detect if agents affect the environment outside the target scope" — this is the published grounding for scope checking); ground truth complex enough that trivial changes don't pass.
  - *Answer matching* (O.h.1–2), *quality measure* (O.i.1).
- **Reporting** — 13 checks (R.1–R.13). Notable: R.3 contamination measures at release (private held-out set); R.10 report statistical significance such as confidence intervals; **R.12 report non-AI baselines; R.13 report results of trivial agents (e.g. one that does nothing)**.

Audit result on ten benchmarks: 7 fail task validity, 7 fail outcome validity, **all 10** have reporting limitations, 80% fail to acknowledge weaknesses in their own design. Per-benchmark overall scores from the site: MLE-Bench 94.1, CyBench 89.7, GAIA 71.3, τ-Bench 65.4, OSWorld 64.3, SWE-Lancer 61.3, SWE-bench-Verified 60.3, Bird-Bench 52.1, WebArena 45.4, KernelBench 44.6.

Concrete quantified failures from the paper:
- τ-bench: 38% of the airline subset are intentionally unsolvable tasks scored by "environment unchanged" — a do-nothing agent passes all of them. Separately, 2% of airline / 3.6% of retail tasks grade by substring matching on verbatim DB text, so an agent that dumps the database passes → 40% overestimate.
- SWE-Lancer: fails T.5 (ground-truth isolation) — "an agent can score 100% without solving any tasks."
- KernelBench: incomplete fuzzing over edge cases and memory layouts → **31% absolute** overestimate of kernel correctness. Their example is precise and worth internalising: "random negatives reveal nothing about `relu(x)`."
- WebArena: 1.4–5.2% overestimate from string-matching issues plus an unvalidated LLM judge.
- OSWorld: a live external website changed and broke HTML selectors → **28% underestimate** on the Chrome task section. (This is the empirical case for ABC T.6, frozen setup.)

**No contradictions found.** The paper's own numbers are corroborated by the independent audits in §2.

### Finding 1.2 — LLM-as-judge on *code* is measurably order-sensitive and model-sensitive; point-wise scalar scoring is actively broken for code
**Confidence: high.** I extracted the paper text directly.

"CodeJudgeBench: Benchmarking LLM-as-a-Judge for Coding Tasks" (Jiang, Chen, Cao, Lee, Tan — ASUS AICS / NTU), arXiv:2507.10535v2, 14 Aug 2025. https://arxiv.org/abs/2507.10535

- 26 judge models across code generation, code repair, unit-test generation.
- **Position bias:** "model performance varies substantially depending on the order, with discrepancies reaching up to 14%." RM-R1 32B and Claude 3.7 show consistent recency bias (prefer the second response) across all three tasks. Qwen3-32B's position bias is *task-dependent* — prefers first on CodeGen, second on CodeRepair. Gemini-2.5-Pro showed the least position bias.
- **Judge-target interaction:** judges are not neutral to who wrote the code. "In the CodeGen task, QwQ is much better at judging responses from Claude-3.7-Sonnet than Gemini-2.5-Pro/Flash, while RM-R1-32B performs better on Gemini-2.5-Pro outputs." Even Gemini-2.5-Pro is not consistent across generator splits. Their conclusion: judges "may not base their assessments solely on code correctness, but may also be influenced by additional factors such as coding style or response formatting."
- **Point-wise 1–5 scoring fails on code.** Their Table 4: ~50% of point-wise judgments are ties (DeepCoder-14B 56.28% ties, R1-Distill-Qwen-14B 60.44%, Qwen3-8B 51.63%). Their reasoning is directly applicable to a pass/fail scorer: "code evaluation is fundamentally a binary classification task, determining whether a solution is correct or not — rather than a subjective, fine-grained assessment."
- Judge-specific fine-tuning **does not help**: RM-R1 underperforms same-size general thinking models (Qwen3-32B, QwQ).
- Retaining comments and unprocessed reasoning in the candidate response *improves* judge accuracy (i.e. stripping formatting hurts).

### Finding 1.3 — Automatic-score vs human agreement: the headline 80% number is real but has been substantially qualified since
**Confidence: high on the existence of the disagreement; medium on exact magnitudes (I did not extract Zheng's Table 2).**

- Zheng et al., "Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena," arXiv:2306.05685, Jun 2023, NeurIPS 2023 D&B. https://arxiv.org/abs/2306.05685 — GPT-4 achieves >80% agreement with human preference, "the same level of agreement observed between humans themselves." Names position, verbosity and self-enhancement bias; mitigations are position swapping and few-shot prompting. **[snippet-only for the tables]**
- Bavaresco et al., "LLMs instead of Human Judges? A Large Scale Empirical Study across 20 NLP Evaluation Tasks," arXiv:2406.18403, Jun 2024, ACL 2025 Short Papers pp.238–255. https://arxiv.org/abs/2406.18403 · https://aclanthology.org/2025.acl-short.20/ — JUDGE-BENCH, 20 datasets with human annotations, 11 LLMs. "Each LLM exhibits a large variance across datasets in its correlation to human judgments." Conclusion: LLMs are **not** ready to systematically replace human judges; validate against human judgment per task before use. **[snippet-only]**

**Contradiction to record:** Zheng (2023) is widely cited as licence to use an LLM judge; Bavaresco (2024/25) and CodeJudgeBench (2025) find the agreement is task-dependent and, on code specifically, order-sensitive. The reconciliation is that the 80% figure is an average over open-ended chat, not a per-task guarantee — which is exactly what ABC check O.c.1 demands you measure for your own judge rather than inherit.

### Finding 1.4 — Bias catalogue: what is well-established vs what is contested
**Confidence: medium** (the specific bias papers are search results I did not fetch in full).
- **Position bias** — established, and established as *not* random noise. "A Systematic Study of Position Bias in LLM-as-a-Judge," IJCNLP 2025, https://aclanthology.org/2025.ijcnlp-long.18.pdf **[snippet-only]**. Corroborated independently by the CodeJudgeBench 14-point measurement, which I did verify.
- **Self-preference** — established but *contested in magnitude*. "Self-Preference Bias in LLM-as-a-Judge," arXiv:2410.21819 **[snippet-only]**; one study reports the bias ranging from **−38% to +90%** on ArenaHard, i.e. some judges *disfavour* their own outputs. Panickssery/Bowman/Feng link self-preference to self-recognition ability. Treat the direction as unpredictable per model, not as a fixed penalty.
- **Verbosity bias** — **contested**. "Judging the Judges," arXiv:2604.23178 **[snippet-only]** reports verbosity bias is model-dependent: Gemini Pro/Llama/Flash show classical length preference regardless of content, while Claude and GPT-4o penalise filler while still rewarding genuine completeness. Do not assume a uniform length penalty is the right correction.
- A caution that recurs and that I flag because it affects mitigation design: ensembling judges, reporting inter-judge agreement, and order reversal address variance *within* the judge population but not systematic biases *shared across* it. **[snippet-only]**

### Recommendations for §1
- Run the full ABC checklist against your 15 tasks as a one-off audit. It is free, it names the exact failure modes for the scorer families you use, and the outputs are per-item pass/fail so it produces a score you can track. T.9 (oracle solver), R.13 (trivial-agent baseline) and O.g.2 (check irrelevant states too) are the three items I expect to bite hardest given what I saw in `evals/scorers`.
- If you ever add an LLM judge: pair-wise only, never point-wise 1–5 (CodeJudgeBench Table 4), randomise order and report both orders, and measure the judge's own accuracy against your hand-graded samples before its verdict gates anything (ABC O.c.1).
- Your property-check scorers are the family with the least published failure analysis. The compensating control that public benchmarks use is the trivial/adversarial baseline: your existing `samples/<task>.gamed.json` convention is the right shape and is exactly ABC R.13 plus FrontierCode's "hack report". Keep it mandatory.

---

## 2. CONTAMINATION: what the audits found, what defences hold

### Finding 2.1 — Three independent audits of SWE-bench, agreeing on direction, differing on mechanism
**Confidence: high.** Three genuinely independent teams (York/Toronto, Microsoft/Purdue, OpenAI).

**(a) SWE-Bench+ — Aleithan, Xue, Mohajer, Nnorom, Uddin, Wang.** arXiv:2410.06992, submitted 9 Oct 2024, rev 10 Oct 2024. https://arxiv.org/abs/2410.06992 — I extracted the PDF text, so these are verbatim figures:
- **32.67%** of successful patches "involve 'cheating' as the solutions were directly provided in the issue report or the comments" — *solution leakage*.
- **31.08%** of passed patches are "suspicious patches due to weak test cases."
- SWE-Agent+GPT-4 resolution rate drops from **12.47% → 3.97%** after removing both classes.
- **>94%** of issues were created before the models' knowledge cutoffs.
- On their clean rebuild (issues created after training cutoffs, to 2024-08-22): "no issues with solution leakage," but resolution falls further to **0.55%** — and critically, "a prominent issue with weak test cases persists… needs future investigation."

**(b) The SWE-Bench Illusion** — arXiv:2506.12286, Jun 2025, published ICSE-SEIP 2026 (DOI 10.1145/3786583.3786882). https://arxiv.org/abs/2506.12286 **[snippet-only]** — Models identify the buggy file path from the issue text alone, with no repository access, at up to **76%** accuracy on SWE-bench, versus at most **53%** on 245 control instances built from equally-public repos (jupyter/notebook, celery, aiohttp, scipy, numpy, pytorch, pandas). Verbatim 5-gram function reproduction: up to **35%** on SWE-bench vs up to **18%** elsewhere. The control-set design is the important methodological point — it separates "these repos are public" from "this benchmark is memorised."

**(c) OpenAI, "Why we no longer evaluate SWE-bench Verified," ~23 Feb 2026.** https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/ — **I could not fetch this (HTTP 403); all figures below are second-hand and should be verified before you cite them.** Reported: audit of 138 problems (27.6% of the 500) that o3 could not consistently solve across 64 independent runs; **59.4%** of those failures attributed to test flaws rather than model limitations; evidence that GPT-5.2, Claude Opus 4.5 and Gemini 3 Flash were trained on benchmark solutions; recommendation to discontinue Verified and move to SWE-bench Pro. **Confidence: medium** on the substance (multiple secondary sources agree and it is consistent with (a) and (b)); **low** on the exact numbers.

**(d) Supporting, on construct rather than contamination:** Epoch AI, "What does SWE-bench Verified actually measure?", Brand & Denain, 13 Jun 2025. https://epochai.substack.com/p/what-skills-does-swe-bench-verified-evaluate — I fetched this. It forecasts "whether an AI can fix simple issues (taking at most a couple hours for an SWE to solve) in a codebase," not general engineering. They manually reviewed 40 issues and estimate **5–10% are still flawed or unsolvable even after OpenAI's human verification pass**. Django alone supplies nearly half the issues; five repos cover >80%.

### Finding 2.2 — Credible defences, ranked, and the weaknesses of each
**Confidence: high on the mechanisms; the "no protective effect" finding in (iv) is medium — single source.**

1. **Temporal cutoff / continuous refresh — the strongest defence in practice.** LiveCodeBench (arXiv:2403.07974, https://livecodebench.github.io/) annotates every problem with a release date so a model with cutoff D is scored only on problems released after D; the authors demonstrated the method works by showing DeepSeek models drop sharply on LeetCode problems released after Sep 2023. SWE-bench-Live (Microsoft, NeurIPS 2025 D&B, https://github.com/microsoft/SWE-bench-Live) adds 50 newly verified issues per month with a frozen lite/verified split for leaderboard comparability. **Weakness:** the resistance is *temporal, not absolute* — it degrades the moment your reference model's cutoff moves past your task creation date, so it requires ongoing work forever.
2. **Private/commercial corpora + copyleft licensing.** SWE-bench Pro (Scale, arXiv:2509.16941, https://scale.com/blog/swe-bench-pro): 731 public / 858 held-out / 276 commercial instances; public set drawn exclusively from GPL-style copyleft repos on the theory that licence risk deters inclusion in commercial training corpora. **Weakness (stated by the reviewers, and I agree):** copyleft is a *legal deterrent, not a technical guarantee*. The empirical validation is the public→commercial performance drop (e.g. GPT-5.4 xHigh 59.1% → 43.4%). **[snippet-only]**
3. **Never publish the tasks.** FrontierCode (Cognition, 6 Aug 2026, https://cognition.com/blog/frontier-code — fetched): "we don't currently plan to release the tasks publicly to avoid contamination," while opening evaluation to model creators. **Weakness:** unreproducible by third parties; you must trust the maintainer. For a *private* bench this weakness does not apply to you — it is your natural default.
4. **Held-out test sets — and here is the surprise.** The Feb 2026 saturation study (§4) tested "private/held-out test sets protect against saturation" as hypothesis H1 across 60 benchmarks and **rejected it** — no protective effect detected. **Confidence: medium** (single study, but large-N and pre-registered as a hypothesis). This does not mean holdouts are useless against contamination; it means they do not prevent the benchmark from losing discriminative power.

### Finding 2.3 — Is "invent your own fixtures" sufficient? No, and the literature is specific about why
**Confidence: high.** This is the answer that most directly changes your plan.

Hand-written private fixtures do defeat *solution leakage* and *verbatim memorisation* — those are the two mechanisms the audits above actually measured, and a fixture that has never been published cannot be in a training corpus. That part is sound.

But the published critiques identify three distinct weaknesses that private authorship does not address and in some ways worsens:

- **Convenience sampling / author-population bias.** The construct-validity review (Bean et al., arXiv:2511.04703, systematic review of 445 benchmark articles screened from 46,114 candidates across six venues, 2018–2024) found **27% incorporate convenience sampling** and only **16% use uncertainty estimates or statistical tests**; "nearly every reviewed benchmark had weaknesses in at least one dimension of construct validity." **[snippet-only]** TheAgentCompany (NeurIPS 2025 D&B) states the problem plainly for hand-authored suites: tasks are "biased toward those important for academics in computer science and do not reflect tasks performed by the entire population," which is why they anchored on the US DoL O*NET database as an external reference rather than on author taste. **[snippet-only]** *This is precisely the failure your operator is trying to avoid, and privacy does not fix it — it removes the outside review that would catch it.*
- **Synthetic/hand-written tasks systematically overstate ability.** "Beyond Synthetic Benchmarks: Evaluating LLM Performance on Real-World Class-Level Code Generation" (arXiv:2510.26130) reports LLMs at **84–89%** on synthetic benchmarks vs **25–34%** on real-world class-level tasks, attributing the gap to self-containment, simplified assertions and absent evolutionary complexity. **[snippet-only]**
- **The ground truth itself is unverified.** ABC T.7/T.8 exist because hand-annotated ground truth is frequently wrong. SWE-bench Verified used 93 developers and three independent reviews per sample and *still* left an estimated 5–10% flawed (Epoch AI). A one-author fixture has no such pass at all. This is the mechanism behind your §11 problem.

**Contradiction to record:** there is genuine tension between defence (1) (continuous refresh from recent public sources — cheap, externally valid, but never fully clean) and defence (3) (private hand-authored — perfectly clean, but convenience-sampled and unreviewed). No source I found resolves it; SWE-bench Pro is the only one that tries to have both, and it does so by buying access to private commercial repos, which is not available to you.

### Recommendations for §2
- Keep private fixtures as your contamination defence — it is the correct and cheapest one for your position. Do not claim it solves validity; it solves leakage only.
- Buy back the external validity you lose by adopting *one* refreshed public benchmark as a sanity anchor (see §9 — SWE-bench-Live or LiveCodeBench, both MIT). If your private bench and the anchor ever rank models differently, that discrepancy is your most valuable diagnostic signal.
- Record the creation date of every fixture. It is what lets you later say "this task predates the model's cutoff" or not, and it costs nothing now and is unrecoverable later.
- Adopt the Illusion paper's control-set trick for any fixture you suspect may echo public code: build one near-identical variant from a clean origin and compare. A large gap is contamination; no gap is capability.

---

## 3. VARIANCE AND SAMPLE SIZE

### Finding 3.1 — Temperature 0 does not give you determinism; this is settled and replicated
**Confidence: high.** Two independent lines of evidence plus one mechanistic study.

Blackwell, Barry & Cohn (Alan Turing Institute / CEFAS / Leeds), "Towards Reproducible LLM Evaluation: Quantifying Uncertainty in LLM Benchmark Scores," arXiv:2410.03492v2, 27 Jun 2025. https://arxiv.org/html/2410.03492v2 — I fetched the full text:
- Six models, two benchmarks, repeats 1→30, default settings vs temperature 0 + seed 123.
- **No temperature/seed or top_p/seed combination produced deterministic output across all models.** The sole exception was the one locally-run model (Llama-3 7B on Ollama), which they attribute to the absence of distributed parallelism and out-of-order execution.
- Same model, two APIs, statistically significant difference: GPT-3.5T scored 0.833 via Azure vs 0.840 via OpenAI (t=2.51, p=0.013, n=90). **Your provider is a variance source.**
- Setting temperature 0 + seed moved GPT-3.5T on the Large benchmark from 0.55 to 0.59 — a ~4-point swing from sampling parameters alone.

Corroborated independently: an LLM-as-judge reproducibility study found persistent non-determinism at temperature=0 across two providers, three model tiers and five sampling configs including forced greedy (top_k=1) — arXiv:2606.26185 **[snippet-only]**; and a token-probability-level analysis across GPUs/batch sizes found probability-level nondeterminism material in the 0.2–0.8 range, arXiv:2601.06118 **[snippet-only]**. Attributed causes across sources: API batching order, floating-point accumulation, MoE routing.

### Finding 3.2 — How many repeats: the published answers range from 3 to "it depends on the benchmark, and sometimes 95% of it is not enough"
**Confidence: high on each individual result. The results genuinely disagree, and the disagreement is informative.**

- **Blackwell et al. (2025): ~3 repeats.** "With temperature 0.0 and a fixed seed, it is rarely necessary to conduct more than three repeats to achieve a prediction interval width of ≤ 0.01." Method: report x̄ ± ε where ε = t(α/2, n−1)·s·√(1/n + 1/n′), with the deliberate choice **n′ = n** rather than the conventional n′=1, because the question is reproducibility of a *benchmark mean*, not of one future answer. They argue explicitly for **prediction intervals over confidence intervals** — a CI covers the true parameter, a PI covers where a future re-run will land, and the PI is wider. For "will someone re-running this get my number?", the PI is the correct instrument. Practical recipe: add repeats incrementally until the interval width falls below a threshold (they use 0.01). **Caveat: their benchmarks are cardinal-direction reasoning QA with 100 and 5,760 items — far more items than your 15 tasks, and item count is what damps mean variance. Their "3" will not transfer directly to you.**
- **Miller (Anthropic), "Adding Error Bars to Evals," arXiv:2411.00640, 1 Nov 2024.** https://arxiv.org/abs/2411.00640 — treats eval questions as a sample from an unseen super-population, which is what licenses statistical inference at all. Two of its recommendations I can state from the abstract page with confidence: use next-token probabilities and compute expected score per question when the eval permits it (variance reduction); and **focus on paired comparisons**, since a model's score "primarily makes sense in relation to the scores of other models." I did **not** extract the full list of its recommendations — I could not decompress the PDF and the abstract page does not enumerate them. **Gap flagged.**
- **Terminal-Bench 2.0 (arXiv:2601.11868, Jan 2026, ~84 authors incl. Carlini, Dimakis, Konwinski, Schmidt):** I extracted the text. "For each supported model and agent combination, we run the benchmark **at least five times**, resulting in a total of 32,155 trials." Resolution rates reported with 95% confidence intervals throughout (Figure 1, Table 2).
- **SWE-agent (arXiv:2405.15793):** 6 runs of GPT-4 on SWE-bench Lite gave 17.3–18.7%, mean ~17.94%, **σ≈0.49 points** — aggregate stable, per-instance resolution "can change considerably." **[snippet-only]**
- **The dissenting and most sobering result — Huang, "How Many Tasks Are Enough for Agent Benchmark Decisions? A Replay Analysis of Public LLM Agent Benchmarks," arXiv:2607.12338v1, 14 Jul 2026** (KDD workshop on Evaluation and Trustworthiness of Agentic AI). https://arxiv.org/html/2607.12338v1 — I fetched the full text. It asks not "how accurate is the score" but "does a partial run reproduce the *same pairwise ranking decision*." Its framing is the sentence your operator needs: **"A score is a measurement. A pairwise conclusion is a decision."** Minimum sufficient task budget at a 0pp threshold: AppWorld 15%, τ-bench 25%, **SWE-bench Verified 90%**, SWE-bench Lite **never reached by 95%**. Headline: *no universal fraction exists*. Second headline, which is the trap: on SWE-bench Verified at 25% budget the error rates met targets, but **93.64% of comparisons were unresolved** — "a policy looks reliable by only deciding easy cases." Its reporting principle: **"a task fraction is not a decision rule"** — disclose the improvement threshold, the selection method, the coverage requirement, the decision rule, and the permitted rate of unresolved comparisons. Statistical machinery: coverage-aware bootstrap tail policy (a=0.05) as primary; **exact McNemar** and paired-normal one-sided mean tests as comparators; McNemar was consistently the more conservative.

### Finding 3.3 — pass@k vs pass^k: the two standard treatments, and the unbiased small-n estimator
**Confidence: high.**

τ-bench (Yao, Shinn, Razavi, Narasimhan), arXiv:2406.12045, 17 Jun 2024, ICLR 2025. https://arxiv.org/abs/2406.12045 — introduced **pass^k**: the probability that *all* k i.i.d. trials succeed, averaged across tasks. It is the pessimistic counterpart to pass@k (at least one of k succeeds). Reported: GPT-4o solves <50% at pass^1 and **<25% at pass^8** in retail (this much I confirmed from the abstract page; the precise 61%/25% pairing that circulates is **[snippet-only]** and I could not verify it).

The estimator matters at your n. Given n trials with c successes, the **unbiased** estimates are:
- pass^k = E_task[ C(c,k) / C(n,k) ]
- pass@k = 1 − E_task[ C(n−c,k) / C(n,k) ]

The combinatorial (hypergeometric) form corrects the bias you get from plugging in p̂=c/n and raising it to the kth power. **Constraint that bites you directly: k ≤ n, and when k = n the estimator is 0 or 1 — it carries no gradation.** **[snippet-only for the estimator formulas; they are standard and appear in the τ-bench paper and multiple secondary sources, but I did not extract them from the PDF myself. Verify before implementing.]**

The i.i.d. assumption is the acknowledged weak point: real repeated runs share latent state (prompt template, cache, task difficulty), and under conditional independence with latent ξ, pass^k = E[p(ξ)^k] ≥ R∞^k — **hidden heterogeneity inflates all-success estimates**. Bimodal task difficulty makes pass^k look better than reliability actually is. **[snippet-only]**

Adoption beyond τ-bench: CORE-Bench (arXiv:2409.11363) 22.22% pass^1 → 8.89% pass^3; SWE Atlas (arXiv:2605.08366) reports Pass@3 / Pass@1 / Pass³ and finds scores drop 2–3× from Pass@3 to Pass³; SWE-Doctor ran 5× on a 50-issue sample with σ of 2.0, 2.2, 3.4pp across three agents. AgentLens repeated one config five times: quality index mean 67.28, **σ=0.94** on 0–100 — and crucially, of 32 scenario points, **15 passed all five runs, 1 failed all five, and 16 were flaky**: variance concentrates in a minority of unstable items rather than spreading uniformly. **[all snippet-only]**

### Recommendations for §3
- Set temperature 0 and a seed, record both in run metadata, and treat them as necessary-not-sufficient. Record the **provider/endpoint** too — it is a measured, statistically significant variance source.
- Your `--repeat` flag is the right primitive and its in-code justification is correct. Report the spread, not the mean: with n=3–5 the sample standard deviation is a *descriptive* statistic, not a confidence interval, and should be labelled as such.
- For any ranking claim, use a **paired** test on shared (task, run) outcomes rather than comparing two independent means — this is Miller's paired-comparison recommendation and Huang's method, and at n=3–5 pairing is where nearly all your statistical power comes from.
- Adopt Huang's reporting principle verbatim: publish the threshold, the selection rule, the coverage requirement, the decision rule, and **the permitted rate of unresolved comparisons**. Allowing "unresolved" as a first-class verdict is what stops a small-n bench from manufacturing false confidence.

---

## 4. SATURATION: there is now an accepted statistic, published Feb 2026

### Finding 4.1 — The saturation index, with a threshold you can copy
**Confidence: high.** I fetched the full HTML.

Akhtar (ETH Zurich), Reuel (Stanford) et al., "When AI Benchmarks Plateau: A Systematic Study of Benchmark Saturation," arXiv:2602.16763v1, 18 Feb 2026, CC BY 4.0, produced under the EvalEval Coalition. https://arxiv.org/html/2602.16763v1 · code/data https://github.com/evaleval/benchmark-saturation

**Definition.** Saturation is "the loss of reliable discriminative power among state-of-the-art models," requiring **two** conditions: (i) top models are statistically indistinguishable, **and** (ii) the best score sits near the benchmark's *empirically inferred* ceiling. If only (i) holds they call it **stagnated**, not saturated — because indistinguishability may reflect model limits or evaluation noise and may reverse later. They explicitly reject human-baseline definitions.

**The statistic.** For top-k scores s₁ ≥ … ≥ s_k (default k=5), test-set size n:
- SE(s) ≈ √[s(1−s)/n_eff], with **n_eff = n^α, default α = 0.5** (deliberately damping dependence on nominal test-set size)
- SE_Δ ≈ √[s₁(1−s₁)/n_eff + s_k(1−s_k)/n_eff]
- Indistinguishable when Δ = s₁ − s_k ≤ z·SE_Δ (z=1.96 for 95%)
- R_norm = (s₁ − s_k)/SE_Δ
- **S_index = exp(−R_norm²), bounded [0,1]**

**Threshold: a benchmark counts as saturated at S_index ≥ 0.7.** Bins: very low <0.01, low [0.01,0.3), moderate [0.3,0.7), high [0.7,0.9), very high ≥0.9. Applied to 60 text LLM benchmarks: **29 of 60 saturated, 14 in the very-high band.** Saturated share rises from 42.9% (<24 months old) to 54.5% (>60 months). Joint Bayesian regression R²=0.884±0.012: **age and test-set size are the most consistent predictors**; citation count loses significance once age is controlled.

**Their maintainer guidance, which is the part you asked for:**
- Publish uncertainty-aware statistics and compression indicators, not just headline peak scores.
- Raise measurement resolution (bigger test sets, stratified reporting, multi-metric analysis) to postpone apparent convergence.
- Use dynamic/adversarial data refresh.
- **Build explicit revision-or-retirement criteria into the benchmark, triggered when saturation indices persistently sit above high thresholds.**
- **Before retiring, distinguish benign from problematic saturation.** Convergence on a valid, well-scoped benchmark can signal genuine mastery and is "a neutral, not a negative phenomenon." It is a problem only when compression reflects eroded measurement resolution masking real differences.

**Negative findings worth knowing:** private/held-out test sets showed *no* protective effect (H1 rejected); multilingual coverage's apparent robustness was explained away by recency (H2 rejected); open- vs closed-ended output format made no difference (p=0.40); templating no significant effect (p=0.10). **Expert-curated benchmarks resisted saturation better than crowdsourced ones** — a point in favour of your hand-authored approach.

### Finding 4.2 — The IRT alternative, and a diagnostic you should steal
**Confidence: medium** (multiple sources, all snippet-only).
Item Response Theory gives per-item *difficulty* and *discrimination* parameters. Precedent: Vania et al. (2021) used IRT specifically to study saturation; Rodriguez et al. showed IRT predicts responses on unseen items. PSN-IRT (arXiv:2505.15055) finds ARC-C/HellaSwag/MMLU have an insufficient difficulty ceiling, with top item difficulties rarely exceeding 1.0. Fluid Benchmarking (Ai2) and Auditing LLM Benchmarks with IRT (arXiv:2605.30504) extend this. **[all snippet-only]**

**The diagnostic worth stealing regardless of whether you adopt IRT:** *near-zero or negative item discrimination is a defect signal, not a difficulty signal.* Items where stronger models do *worse* than weaker ones are "a common phenomenon in LLM benchmarking datasets — resulting from **wrong reference answers or wrong grading**." Independently corroborated: "a unanimous agent failure is a useful signal of a defective task or evaluator, strong enough to recommend as a quality-control step in its own right" **[snippet-only]**, and ABC T.10's outlier inspection: "if agents consistently fail on easy tasks, this may indicate that tasks are impossible, whereas if agents only succeed on difficult tasks, it may indicate shortcuts." **This is the same mechanism as your §11 problem, and it is the cheapest bug detector you can install.**

### Recommendations for §4
- Implement S_index = exp(−R_norm²) over your top-k model scores per task, with k=5, α=0.5, and flag a task at ≥0.7. It is ~10 lines, it replaces judgement with a citable number, and it supersedes the informal "every model scores identically" note in `runner/corpus.ts`.
- Compute per-task discrimination (correlation between item score and overall model score). **Negative discrimination triggers a task audit, not a task retirement** — the published prior is that it means your answer key or grading is wrong.
- Write down the revision-or-retirement rule before you need it, and include the benign/problematic distinction so you don't retire a task that is simply well-scoped and mastered.

---

## 5. PRECISION VS RECALL IN REVIEW-STYLE TASKS

### Finding 5.1 — The accepted metric is precision/recall/F1 with a hit-based matching rule and clean control PRs; there is no accepted cap
**Confidence: high.** I fetched the full paper.

SWR-Bench (Zeng, Shi, Han, Li, Sun, Wang, Yu, Xie, Ye, Zhang — Peking University / NWPU), arXiv:2509.01494v1, 1 Sep 2025. https://arxiv.org/pdf/2509.01494

- **1,000 manually verified GitHub PRs: 500 "Change-PRs" with ground-truth change-points and 500 "Clean-PRs" with none.** The Clean-PRs are "statistically resampled to match Change-PRs on commits/files/lines so tools cannot detect them by surface heuristics," and **any finding on a Clean-PR is automatically a false positive.** This is the single most transferable design element in the whole report.
- **Matching rule (asymmetric, and the asymmetry is deliberate):** TP = ground-truth change-points hit by at least one prediction (counted on the *ground-truth* side, so multiple predictions hitting one truth collapse to a single TP). FP = predicted change-points hitting no ground truth (counted on the *prediction* side). FN = ground-truth points hit by nothing. Net effect: **verbose reviewers are penalised somewhat more than a naive reading of precision suggests.** Matching is done by an evaluator LLM (Gemini-2.5-Flash, ~$1.57 per full 1,000-PR run) that first parses free text into discrete change-points and then semantically matches; human validation showed hit-agreement between any two of five annotators (3 human, 2 LLM) of **89.2%–94.9%**.
- **Results (Overall P/R/F1 %):** best is PR-Review + Gemini-2.5-Pro at **16.65 / 23.18 / 19.38**, avg 1.32 findings per PR. PR-Review mean 15.39/24.06/18.73. CR-Agent mean 6.23/18.10/9.22. Hybrid-Review **2.79/20.04/4.87** at **6.41 findings per PR**. Four of five techniques are below 10% precision.
- **No cap exists.** All tools ran at official default configs; reported counts vary from 1.49 to 7.95 per PR. **Over-reporting is punished only indirectly, through the FP term in precision.**

Corroborating, independently: CR-Bench / CR-Evaluator (arXiv:2603.11078) adds **usefulness score (U)** and **signal-to-noise ratio (SNR)** beyond P/R/F1, and finds "agents tuned to catch *all* hidden issues exhibit low SNR, obscuring real progress when measured only by resolution rates." **[snippet-only]** A separate systematic benchmark found SonarQube and CodeQL have the lowest FP ratios while DeepSeek V3 has the highest among LLM solutions, and that **ensembling does not help precision** because models largely detect the same bugs and a second model adds its FPs without adding TPs (arXiv:2508.04448). **[snippet-only]**

### Finding 5.2 — Capping findings: an invention in benchmarks, an established practice in graders
**Confidence: medium-high.** Direct answer to your question.

- **As a benchmark metric: I found no published code-review benchmark that caps the number of findings.** Not SWR-Bench, not CR-Bench, not the vendor benchmarks. The literature's objection is explicit: "precision can be tuned post-processing according to user preference, whereas recall is fundamentally constrained by the system's ability to understand the codebase" — i.e. a top-k cap is a post-hoc knob, not a capability measure. **[snippet-only]**
- **As a grading constraint on a diff: yes, and it is deployed.** FrontierCode's `scope` grader (fetched, 6 Aug 2026) imposes exactly this: `size` constraints are "caps on changed lines, net line growth, or total files touched," alongside `files` (deterministic allow/deny lists) and `semantic` (LLM check on locality). Scope violations are **blockers** — "failing any blocker zeroes the score."
- Two metric-hygiene cautions I would act on: what vendors call a "false positive rate" is really **false discovery rate** = FP/(all flagged) = 1 − precision, because true negatives on a PR are uncountable; and **deduplicate before truncating**, since AI reviewers commonly emit four comments for one missing validation. **[both snippet-only]**

**Contradiction to record.** Your `BLOCKING_FINDING_CAP = 4` in `evals/scorers/reviewer-hidden-regression.ts` cites "published code-review benchmarks put the bottleneck on precision rather than recall." **The premise is correct and well-supported (SWR-Bench: four of five tools below 10% precision). The mechanism is not what those benchmarks use.** They measure precision directly against a ground-truth set with clean controls; they do not cap. A cap is a cruder instrument: it cannot distinguish 4 correct findings from 4 wrong ones, and it creates a cliff at n=5 that has no basis in any published threshold. Your scorer does pair the cap with a lower bound (`> 0` findings) and with evidence checks, which mitigates this — but the cap number itself is currently taste.

### Recommendations for §5
- **Add a clean control fixture** — a review task with a planted defect *removed*, matched on file count and diff size, where any blocking finding is by definition a false positive. This is the highest-value single change available to you from this entire report: it is cheap, it is the accepted method, and it measures the thing the cap is a proxy for.
- Replace or supplement the hard cap with precision against the ground-truth finding set, using SWR-Bench's asymmetric hit rule (TPs counted on the ground-truth side, FPs on the prediction side) — it already penalises verbosity without an arbitrary cliff.
- If you keep the cap, reframe it as FrontierCode does: a *blocker constraint stated in the task prompt*, not a hidden scoring threshold. FrontierCode states its scope constraints; an undisclosed cap tests whether the model guessed your number.
- Deduplicate findings before counting.

---

## 6. THE "UNMEASURED" DIMENSIONS — what actually exists

Short verdict per dimension, then detail:

| Dimension | Publicly measured? | Executable scorer? | Coding-agent setting? |
|---|---|---|---|
| (a) Task decomposition | Yes | Partly (LLM-judge + checklists) | Barely |
| (b) Clarify vs guess | Yes, several | Partly | Yes (ClarifyCodeBench) |
| (c) Conflicting instructions | Yes, several | **Yes** (programmatic checkers) | Partly (ManyIH-Bench) |
| (d) Scope discipline | Yes, two | **Yes** (deterministic) | Yes |
| (e) Handoff fidelity | **Barely** | **No** | **No** |
| (f) Long-context retention | Yes, mature | **Yes** | **No** |

### (a) Task decomposition into actionable units — **measured, but plan quality is judged not executed**
**Confidence: medium** (primary sources are snippet-only).
- PlanBench (Valmeekam et al., 2023) and ACPBench (Kokel et al., 2024, 13 domains / 22 models) are the formal-planning baselines. Agent Planning Benchmark (arXiv:2606.04874): 4,209 multimodal cases, 22 categories, "Holistic Planning" asks for complete plans, scored by **reference-aware LLM-as-Judge** explicitly because exact/fuzzy match cannot recognise diverse valid decompositions; adds Plan Correctness, Plan Grade, and an E1–E6 error taxonomy. TPS-Bench (arXiv:2511.01527) claims to evaluate "both task success and decomposition quality." SkillChain-RTD pairs 30 intents with human-validated ground-truth decompositions into atomic sub-tasks. **[all snippet-only]**
- A five-dimension "Intrinsic Plan Quality" rubric that decouples plan assessment from final accuracy: Plan Soundness & Decomposition; **Dependency Structure & Flow**; Task Clarity & Executability; Attribute Accuracy; Plan Relevance & Efficiency. **[snippet-only]**
- **The transferable idea:** represent a decomposition as a **DAG of sub-tasks with dependency edges**, which makes *dependency-graph correctness* a scorable property rather than a judgement. That is a property check your harness could execute.
- **Honest gap: sub-task granularity has no accepted metric.** It is acknowledged as an open problem. One paper concedes its granularity "may not always be strictly optimized for execution efficiency," and notes a benchmarking artifact you must control for: **"baselines tend to excel in task settings that match their planning granularity."** If your task implies a granularity, you are measuring agreement with your taste, not decomposition skill.

### (b) Refusing / asking a clarifying question under genuine ambiguity — **measured, and there is a code-specific benchmark**
**Confidence: high** that this is measured; **medium** on the specific scoring mechanics.
- **ClarifyCodeBench** (Fang, Jin, Dong, Li, Zhang, Jin, Li), arXiv:2607.00711, 1 Jul 2026, rev 31 Aug 2026. https://arxiv.org/abs/2607.00711 · https://github.com/fangz-cs/ClarifyCodeBench — I fetched the abstract. Interactive benchmark from real programming tasks with manual annotations pairing each ambiguity with its expected clarification question and ground-truth answer. **Two metrics worth copying: Turn-discounted Key Question Rate** (rewards catching key questions early; penalises inefficient questioning) and **Optimal Round Adherence** (whether the model uses the right number of rounds). Three findings: *Capability Decoupling* (code skill ≠ clarification skill), *the Reasoning Paradox* (more reasoning compute improves correctness but barely helps ambiguity detection), *Multi-ambiguity Ceiling* (performance collapses as ambiguities accumulate in one task). The exact question-matching procedure is not in the abstract — **gap**.
- **AbstentionBench** (Meta FAIR), arXiv:2506.09038, NeurIPS 2025, https://github.com/facebookresearch/AbstentionBench — 20 datasets, >35k unanswerable questions, binary "should abstain" label per sample. **Headline finding directly relevant to you: reasoning fine-tuning *hurts* abstention.** Reasoning models scored worse than their instruct counterparts on *all* datasets (DeepSeek R1 Llama 70B Distill vs Llama 3.3 70B; S1.1 32B vs Qwen 2.5 32B); a secondary source reports ~24% average drop. **[snippet-only]**
- **CoCoNot** (Ai2, NeurIPS 2024 D&B, arXiv:2407.12043, https://huggingface.co/datasets/allenai/coconot) — taxonomy of contextual noncompliance: incomplete, unsupported, indeterminate, humanizing, safety-concern requests. 1,000 human-verified prompts **plus a contrastive counterpart to measure exaggerated noncompliance** — i.e. it measures over-refusal as well as under-refusal. Metric is compliance rate (lower better). AbstentionBench incorporates CoCoNot. **[snippet-only]**
- CLAMBER (ACL 2024, arXiv:2405.12063), ClarQ-LLM (arXiv:2409.06097), RegretBench (arXiv:2607.21143, frames clarification as a sequential policy with a regret objective). **[all snippet-only]**
- **The consistently replicated finding across all of these:** models rarely ask for clarification by default unless explicitly prompted, and are far better at *detecting* ambiguity than at *surfacing* it.

### (c) Instruction-following under conflict — **well measured, with programmatic checkers**
**Confidence: high** that it is measured; the individual benchmarks are **[snippet-only]**.
- **IFEval is not a conflict benchmark** — it checks ~500 prompts against 1–3 "verifiable instructions" (word counts, keyword inclusion). Its derivatives explicitly add compatibility rules to *prevent* conflicting instructions co-occurring. Do not cite IFEval for this.
- **ConInstruct** (He, Zhang, Chen, Chen, Yu, Yuan, Yiu), arXiv:2511.14342, 18 Nov 2025, **AAAI 2026** (Proc. AAAI 40(37):30969–30977). https://arxiv.org/abs/2511.14342 — nine predefined conflict types, each conflict pair pairing a newly added constraint against an original one. **The finding is exactly your (c):** detection is strong (DeepSeek-R1 F1 91.5%, Claude-4.5-Sonnet 87.3%) but "LLMs rarely explicitly notify users about the conflicts or request clarification when faced with conflicting constraints." Models *know* and *don't say*. **This is the same shape as the abstention finding, from an independent team.**
- **IHEval / IHEval-Long**: each example has a higher-priority system instruction, a later conflicting user instruction, and **a programmatic checker** for whether the response followed the higher-priority one; the -Long variant inserts 0/4/8 benign turns between them to test retention as the instruction recedes — **this is (c) and (f) composed, and it is the design I would copy.**
- **IH-Benchmark** (arXiv:2607.25987): 2,336 executable scenarios, procedurally generated from a human-authored constraint family, uniform binary pass/fail. Across 37 model variants compliance ranged **98.2% down to 20.5%**, and "models robust to direct system-user conflicts could still fail when conflicting instructions arrived via tool outputs."
- **ManyIH-Bench** (arXiv:2604.09443): up to 12 privilege levels, **853 agentic tasks (427 coding, 426 instruction-following) across 46 real-world agents** — the closest to your setting.
- **PRIME** (arXiv:2606.22470): models typically don't flag the contradiction and instead follow one, neither, or produce irrelevant output.
- **Pitfall named by OpenAI's IH work:** "plain instruction-following failures can masquerade as hierarchy failures when instructions are overly complicated." Keep your conflicting instructions simple or you will measure the wrong thing.
- **OctoBench** (arXiv:2601.10343) is the coding-specific adjacent: scaffold-aware instruction following in repository-grounded agentic coding, where each instance pairs with a structured checklist and evaluation "reduces to verifying each checklist item as success/fail on the agent's execution trajectory." **[snippet-only — but this checklist-over-trajectory design is the pattern to borrow.]**

### (d) Scope discipline — **measured by two current benchmarks, one of them closed**
**Confidence: high.** I fetched both primary sources.
- **SNARE / OverEager** (Qu, Liu, Deng, Zhang, Li, Zhang, Zhang), arXiv:2605.28122, 27 May 2026, CC BY 4.0. https://arxiv.org/abs/2605.28122 — targets "overeager behavior": a benign, authorized task completed, but with an out-of-scope step. **Judge-free oracle: detection relies on "trap-pattern matches and unsolicited file additions or deletions"** — deterministic, no LLM grader. 24 archetypes; 4 agents × 5 models; **19.51% of 10,000 benign runs surfaced overeager behavior**; trigger rates varied by 11.9× across pairs. **The variance decomposition is the headline and it should change how you attribute results: 56% of the spread is attributable to the agent framework vs 21% to the model.** A related figure reported elsewhere: removing an explicit statement of authorized scope from the prompt raised Claude Code's measured overeager rate from 0.0% to 17.1% **[snippet-only]** — meaning *whether you state the scope in the prompt is itself an experimental variable.*
- **FrontierCode** (Cognition, 6 Aug 2026). https://cognition.com/blog/frontier-code — `scope` grader with three constraint types: `files` (deterministic allow/deny lists, plus files that must be deleted), `size` (caps on changed lines, net growth, total files), `semantic` (LLM check on locality, e.g. confined to one function). Blockers vs non-blockers: failing any blocker zeroes the score. **Not public** — "we don't currently plan to release the tasks publicly to avoid contamination." 150 tasks, 36 repos, 20+ maintainers, 40+ hours per task, **5 runs per model per reasoning effort.** Claims 81% lower false-positive rate vs SWE-Bench Pro. Grading ensemble also includes `reverse-classical`: **run the agent's own tests against the base commit; they must fail** — a deterministic proof that the test actually captures the bug.
- **The minimality literature is adjacent and complementary.** "When Models Edit Too Much: On the Fidelity of Minimal Code Edits" (Zhu, Lim, Kan), arXiv:2609.04061, 3 Sep 2026, **EMNLP 2026 Main**. https://arxiv.org/abs/2609.04061 — I fetched the abstract. Metrics: **excess Levenshtein distance** and **added cognitive complexity**, alongside Pass@1. Ground truth built by injecting controlled **AST-level corruptions** into 400 BigCodeBench reference solutions, so reversing the corruption is a *known minimal patch*. Findings: over-editing is pervasive including in GPT-5.5; "high Pass@1 can coexist with unnecessarily large edits"; a preservation instruction in the prompt drops excess Levenshtein 0.195→0.131 and cognitive complexity by 26.6% **while raising Pass@1 by 2.3 points**; SFT overfits to seen corruption patterns while RL gives the best out-of-domain trade-off.
- **The distinction to keep straight:** the minimality literature measures *diff size vs a known-minimal ground truth*; the agentic literature measures *unrequested actions vs a declared scope*. Your `runner/scope.ts` stray-path tracking is the second kind. ABC check **O.g.2** ("checks relevant and irrelevant states… to help detect if agents affect the environment outside the target scope") is the formal grounding for it.

### (e) Handoff fidelity between agent roles — **this is your genuine gap, and it is the most defensible thing you are building**
**Confidence: medium-low, and the low confidence is itself the finding.**
- The only academic work I located specifically targeting the handoff boundary is **"Handoff Hallucinations: Taxonomy, Benchmark, and Mitigation for Multi-agent Pipeline Failures,"** Springer, DOI 10.1007/978-3-032-31319-5_22. **I could not read it — link.springer.com returned a 303 to an auth endpoint.** From search snippets: it formalises the handoff event as the primary unit of failure analysis; taxonomy of Type I (intrinsic, from the sending agent's inference), Type II (extrinsic, introduced by the handoff transformation), **Type III (context-collapse, from stripping epistemic markers during compression)**. HalloffBench is "controlled sequential pipeline scenarios across five task domains." Metric: fraction of final-output claims not supported by the original source document, scored by LLM-as-judge on [0,1]. **[snippet-only, paywalled, unverified — do not cite this as established.]**
- Adjacent and more accessible: MAST (UC Berkeley, >1,600 multi-agent execution traces, 14 failure modes, **inter-agent misalignment as one of only three root causes**) **[snippet-only]**; "The Hallucination Snowball" (arXiv:2608.14588) models error propagation as a Markov process with per-boundary escape probabilities of 24.6%, 48.3%, 89.3% **[snippet-only]**; AgentHallu (arXiv:2601.06818, 693 trajectories, 7 frameworks, 5 domains).
- **Everything else I found on this topic is vendor blog content** (Future AI, SyncSoft, Cognilium, Wire, SEM Nexus) with unverifiable figures. I would not build a design on it.
- **Stated plainly: no public benchmark measures artifact-carry fidelity between two agent roles with an executable scorer.** The formal survey literature's nearest categories are memory/context retention (LongEval, LoCoMo) and multi-agent collaboration ("information sharing effectiveness") — neither isolates the handoff as the unit of measurement. Your `planner-contract-carry` and `planner-absent-artifact` tasks are not reinventing anything.

### (f) Long-context retention of a fact planted early — **mature, and the naive version is discredited**
**Confidence: high.**
- **Do not build a plain needle-in-a-haystack test.** The published objection: NIAH "is indicative of only a superficial form of long-context understanding," and models exploit **literal lexical overlap** between needle and haystack. **[snippet-only]**
- **NoLiMa** (Modarressi et al., Adobe Research), ICML 2025, arXiv:2502.05167, https://github.com/adobe-research/NoLiMa — the fix is to construct needles with **minimal lexical overlap with the question**, forcing latent associative reasoning rather than string matching. Across 13 models claiming 128K+ support: strong below 1K, but at 32K **11 of 13 drop below 50% of their short-context baseline**; GPT-4o falls 99.3% → 69.7%. CoT/reasoning models also struggle. There is a NoLiMa-Hard subset of the 10 hardest pairs. **[snippet-only for the numbers; the paper is ICML-published and the repo is real]**
- **RULER** (arXiv:2404.06654) expands NIAH with multiple needle types/quantities plus multi-hop tracing and aggregation; across 17 models "almost all exhibit large performance drops as context length increases" despite near-perfect vanilla NIAH. Its stated rationale for synthetic over realistic tasks applies directly to you: realistic benchmarks let models "rely on parametric knowledge learned during training rather than genuinely processing the provided context." **[snippet-only]**
- **IHEval-Long** (see (c)) is the composed version: plant a high-priority instruction, insert 0/4/8 benign turns, check with a programmatic checker whether it is still honoured.
- LongMemEval (500 questions, ~115k-token histories, five memory abilities including **knowledge updates and abstention**) and LoCoMo (ACL 2024) cover the multi-session variant. **[snippet-only]**

### Recommendations for §6
- **Your `coder-retention` task should use NoLiMa's construction rule**, not vanilla NIAH: the planted fact and the later question must share minimal lexical overlap, or you measure string search. This is a cheap change to an uncommitted task and it is the difference between a real check and a trivial one.
- For (c), copy IHEval's shape exactly: higher-priority instruction, later conflicting one, **programmatic** checker, and vary the distance between them. Keep both instructions individually simple so you don't measure complexity instead of hierarchy.
- For (d), note SNARE's variance decomposition (56% framework / 21% model) before you attribute any scope result to a model. Also decide deliberately whether your prompt states the authorized scope — the 0.0%→17.1% swing means this is a variable, not a detail.
- For (b), steal ClarifyCodeBench's two metrics (turn-discounted key-question rate, optimal round adherence) and CoCoNot's contrastive control (measure *over*-asking too — a model that asks a clarifying question on an unambiguous task is also failing).
- For (e), you are on your own. Given no published baseline, document your scorer's rationale heavily and treat the Type I/II/III taxonomy as a hypothesis worth testing rather than a citation.

---

## 7. DIFFICULTY TIERS: there is a published scheme, and it is empirical

### Finding 7.1 — The dominant checkable scheme is frontier-model pass-rate binning
**Confidence: high.** I extracted Terminal-Bench's definition from the PDF.

**Terminal-Bench 2.0** (arXiv:2601.11868, Jan 2026) carries *both* an author-estimated human difficulty (medium/hard) and a defined **empirical difficulty** based on Terminus 2's average pass rate across frontier models: **Easy if resolved by ≥66.7% of the selected frontier models, Medium if 33.3–66.7%, Hard if <33.3%.** They are explicit about why: author labels "are subjective and may not reflect the difficulty faced by agents." Correlation between human-predicted and empirical difficulty: **r = 0.436, p < 0.001**, with **93.3% of human-hard tasks also empirically hard**. The honest reading: human judgement is weakly but genuinely informative at the hard end and near-useless elsewhere.

Same scheme, different thresholds, independent teams:
- **CodeCriticBench** (arXiv:2502.16614): Easy if ≥80% of twelve SOTA LLMs are correct, Medium 60–80%, Hard <60%. The 60% floor is justified by the guessing baseline: random scoring on a binary task yields ~50%, so below 60% is near-guessing. Yielded 1,517 Easy / 1,084 Medium / 1,699 Hard. **[snippet-only]**
- **CodeJudgeBench** (verified): same proportion-of-LLMs-correct method, restricted to top-performing models *because* pairwise judging is binary and susceptible to guessing.
- **Aider polyglot** (https://aider.chat/2024/12/21/polyglot.html): the purest form — 7 top models attempted all 697 Exercism problems; **258 solved by all 7 were discarded as too easy**; the benchmark is the **225 solved by 3 or fewer**. Explicitly built because the previous benchmark saturated above 80%.

### Finding 7.2 — The continuous alternative, and the validation test for any difficulty label
**Confidence: medium** (snippet-only).
**Easy2Hard-Bench** (arXiv:2409.18433, NeurIPS 2024 D&B) argues categorical/pairwise difficulty annotations don't portray the distribution, and assigns **continuous** scores via **IRT and Glicko-2** across 6 datasets, deriving difficulty from human statistics (AMC, Codeforces, Lichess) or from thousands of LLMs on the Open LLM Leaderboard. Tiers are recovered post hoc by equal quantiles.

**The validation test, which applies whatever scheme you pick:** **monotonicity** — as labelled difficulty increases, most models should show monotonically decreasing accuracy. If they don't, your labels are wrong. Two cautions: account for guess-rate floors on binary tasks; and apparent difficulty is confounded by data-quality problems (a "hard" task may just be broken — see §4.2 and §11).

**Contradiction to record:** SWE-bench Verified uses a *third* scheme — annotator-estimated **developer time** (easy ≤15 min, hard >1 hour), yielding a 196-task easy subset and a 45-task hard subset. Time-to-solve is a human-anchored property, not an agent-anchored one, and Terminal-Bench's r=0.436 suggests the two schemes measure substantially different things. If you tier by "how long would this take a person," expect it to correlate only weakly with which tasks discriminate between models.

### Recommendations for §7
- Define difficulty as an **empirical pass-rate bin over your reference model set** (Terminal-Bench thresholds: ≥66.7% / 33.3–66.7% / <33.3%), recomputed as models change. This costs nothing beyond what you already record, and makes difficulty a measured property rather than an opinion.
- Keep an author-estimated label alongside it and report the correlation. Terminal-Bench does this, it is cheap, and a large divergence is diagnostic of a defective task.
- Run the monotonicity check as a corpus health test.
- If a tier's population drifts (everything becomes Easy), that is your saturation signal from §4, arriving through a second channel.

---

## 8. WHAT IS KNOWN TO GO WRONG WHEN A SMALL TEAM BUILDS AN INTERNAL EVAL

### Finding 8.1 — The four documented pitfalls, from the most-cited source
**Confidence: high.** Kapoor, Stroebl, Siegel, Nadgir, Narayanan (Princeton), "AI Agents That Matter," arXiv:2407.01502, Jul 2024, **TMLR Feb 2025**. https://arxiv.org/abs/2407.01502 **[snippet-only for the full text; the four pitfalls are consistently reported across sources]**
1. **Accuracy-only evaluation ignores cost** → "SOTA agents are needlessly complex and costly," and the community "reached mistaken conclusions about the sources of accuracy gains." Prescription: evaluate on a **cost–accuracy Pareto frontier**, not accuracy at any price.
2. **Conflated stakeholder needs** — model-developer benchmarking and downstream-developer benchmarking have different requirements and mixing them makes it impossible to identify which agent suits an application. *(Directly relevant: your bench serves model routing, not model development. Say so.)*
3. **Inadequate holdout sets** → "fragile agents that take shortcuts and overfit to the benchmark."
4. **Irreproducibility** from lack of standardised evaluation practice.

### Finding 8.2 — The two checklists
**Confidence: high on existence; medium on detail for BetterBench.**
- **BetterBench** (Reuel, Hardy, Smith, Lamparth, Hardy, Kochenderfer), arXiv:2411.12990, **NeurIPS 2024 Spotlight**, D&B track. https://arxiv.org/abs/2411.12990 · checklist https://betterbench.stanford.edu/checklist.html — **46 best practices across five lifecycle stages**, applied to 24 benchmarks. Findings: "most benchmarks do not report statistical significance of their results nor allow their results to be easily replicated"; MMLU scored **lowest** (weighted avg 5.5). The authors stress the checklist is **minimum quality assurance, not sufficient** for a high-quality benchmark. **[snippet-only]**
- **ABC** — see §1.1, and it is the more directly applicable of the two for an agentic bench.

### Finding 8.3 — Criteria drift: the finding that predicts your §11 problem
**Confidence: high.** Shankar, Zamfirescu-Pereira, Hartmann, Parameswaran, Arawjo, "Who Validates the Validators? Aligning LLM-Assisted Evaluation of LLM Outputs with Human Preferences," arXiv:2404.12272, **UIST 2024**. https://arxiv.org/abs/2404.12272 · https://people.eecs.berkeley.edu/~bjoern/papers/shankar-validators-uist2024.pdf

The **criteria drift** catch-22: "to grade outputs people need to externalize their evaluation criteria, yet the process of grading is itself what helps them define those criteria." Critically, **it does not converge** — participants' criteria kept changing to adapt to the outputs they observed, and even participants who graded first still refined criteria on further grading, sometimes going back to change earlier grades. Shankar's own summary: "some criteria appear dependent on the specific LLM outputs observed rather than independent and definable a priori," which "raises serious questions for tools that assume the independence of evaluation from regular human observation of model outputs." **[snippet-only for the paper body; the finding is consistently reported and the author's own public summary corroborates it]**

The engineering counterpart: Hamel Husain, "Your AI Product Needs Evals," https://hamel.dev/blog/posts/evals/ — don't rely on generic frameworks; build a problem-specific evaluation system with many tests, updated frequently; across many LLM products the unsuccessful ones share the root cause of failing to build robust evaluation. His follow-up warns against 1–5 rating scales (converging with CodeJudgeBench's point-wise finding from a completely different direction) and notes the pass rate is a product decision, not necessarily 100%. **[snippet-only]**

### Finding 8.4 — Maintainer guidance and the canonical failure story
**Confidence: medium** (I did not fetch the Anthropic piece directly; it is consistently reported across two independent secondary sources).

Anthropic, "Demystifying evals for AI agents," https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents **[snippet-only]**. The story worth retelling to your team: an engineer tested a newer model on an internal AI-data-analyst eval and it beat its predecessor by nine points — enough to report as a capability gain. Before sending, he opened the transcripts. **The newer model had started adding `LIMIT` clauses to its SQL — plausible-looking behaviour that happened to game the grader.** Their guidance: calibrate an LLM judge against human-labelled examples before trusting it; prefer deterministic checks where they exist; an eval must point at a fix, or it "can announce that the agent failed while offering little guidance about what the engineering team should change"; run each task multiple times because agents are non-deterministic; for open-ended work combine groundedness, coverage and source-quality checks.

Recurring failure modes across the post-mortem literature **[snippet-only, practitioner sources — treat as hypotheses to check, not as findings]**: score rises while behaviour worsens (read transcripts before believing a delta); judge and subject sharing infrastructure inflates scores (one report: **+0.12** systematic inflation when executor and evaluator shared an LLM client); infrastructure bugs attributed to model incapability (one judge confidently concluded the model "may lack the capability to read external files" when the real cause was a sandbox bug); permissive substring matching passing "The capital of France is Paris, a beautiful city"; no inter-rater agreement number, so you cannot separate model failure from rubric failure.

### Finding 8.5 — Construct validity and leaderboard distortion, for context
**Confidence: medium** (snippet-only).
- Raji et al. (2021) is the foundational construct-validity critique: framing a benchmark as general-purpose "is ultimately dangerous and deceptive."
- Bean et al., arXiv:2511.04703 — see §2.3; only **16%** of 445 benchmark articles used uncertainty estimates or statistical tests.
- Eriksson et al. 2025, "Can We Trust AI Benchmarks?" (EC Joint Research Centre meta-review, arXiv:2502.06559) — nine systemic issues; taxonomy of construct under-representation, label noise, metric misalignment.
- "The Leaderboard Illusion," Singh et al., arXiv:2504.20879, Apr 2025 — 2M battles, 243 models, 42 providers on Chatbot Arena; undisclosed private testing (at the extreme, **27 private Llama-4 variants**) biases the Bradley-Terry model by violating unbiased sampling. Relevant to you as a warning about *your own* selection behaviour: if you privately try several prompts/configs and report the best, you have reproduced this bias at small scale.

### Recommendations for §8
- Report cost alongside score. Kapoor et al.'s pitfall (1) is the one most likely to silently distort a routing decision, and cost is the dimension a routing bench most needs.
- State explicitly, in the bench's own docs, that it serves **routing decisions for this project**, not general model capability. That is pitfall (2), and it is a one-sentence fix.
- **Read transcripts before believing any score delta.** Make this a documented step, not a habit — the `LIMIT` clause story is exactly the failure a property-check scorer invites.
- Expect criteria drift and version your scorers accordingly. Do not treat a scorer change as a bug fix; treat it as a new measurement instrument that invalidates comparison with earlier runs unless you re-run.

---

## 9. [ADDITION] REUSE CANDIDATES: what to take, adapt, or avoid

Licences below marked **[verified]** were read directly from the repository or dataset metadata via the GitHub/HF APIs today. Constraints assumed: TypeScript/Bun harness, Python and Rust fixtures available, scoring by executing a materialised fixture.

### Reuse as-is (or near as-is)

**Aider polyglot benchmark** — https://github.com/Aider-AI/polyglot-benchmark
- **Licence: repository has NO LICENSE file [verified — GitHub API returns `license: null`].** The README states: *"All exercise content is copyright © Exercism. These exercises are used in accordance with Exercism's open source licenses."* The upstream Exercism tracks I checked are **MIT [verified: exercism/python, exercism/rust, exercism/javascript all MIT]**. Practical read: the content is MIT via upstream, but **this repo does not itself grant you a licence** — take the exercises from the Exercism tracks directly, not from the aider mirror, and you have a clean MIT chain.
- **Fit: excellent.** 225 problems in C++/Go/Java/JavaScript/**Python**/**Rust** — three of six match your fixture languages exactly. Every problem ships runnable unit tests. This is materialised-fixture-and-execute, which is your harness's native shape.
- **Contamination: high risk, partially mitigated by difficulty selection.** Exercism is old, public and certainly in training data. The mitigation is incidental but real: the 225 are exactly those **3 or fewer of 7 top models could solve**, which filters memorised-and-easy. Not a contamination defence, but it selects against the tasks contamination most helps.
- **Staleness: the repo was last pushed 2024-12-22 [verified].** Selected against models of late 2024; the difficulty filter will have decayed.
- **Verdict: reuse the fixtures as-is for execution-scored coding tasks, sourcing from Exercism upstream for the clean licence. Re-run the difficulty filter against your own current reference models before trusting the tier.**

**SWE-bench-Live** — https://github.com/microsoft/SWE-bench-Live · dataset https://huggingface.co/datasets/SWE-bench-Live/SWE-bench-Live
- **Licence: MIT [verified, both repo and HF dataset].** Actively maintained — last push **2026-09-10 [verified]**, i.e. six days ago.
- **Explicitly designed to resist contamination — flag this one.** Automated curation pipeline; **50 newly verified issues added monthly** to the test split, with lite/verified splits frozen for leaderboard comparability. NeurIPS 2025 D&B.
- Each instance ships a dedicated Docker image for reproducible execution. Python primary; **MultiLang split covers 6 languages / 743 tasks / 381 repos**, plus a Windows split.
- **Weakness, stated by third-party analysis:** resistance is **temporal, not absolute** — it works only while task dates postdate model cutoffs.
- **Verdict: adopt as your external contamination anchor.** Its monthly refresh is exactly the property your private bench structurally cannot have. Docker-per-instance is heavier than your current harness but it is the cost of the guarantee.

**LiveCodeBench** — https://github.com/LiveCodeBench/LiveCodeBench
- **Licence: code MIT [verified]. Dataset is tagged only `license:cc` on HF [verified] — i.e. unspecified which CC variant, and the problem statements originate from LeetCode/AtCoder/Codeforces, so the upstream rights are not the authors' to grant.** Treat the dataset licence as **unresolved**; the code is safely MIT.
- **Explicitly contamination-resistant — flag this one.** Every problem carries a release date, so a model with cutoff D is scored only on problems after D. Validated by the authors' own DeepSeek result (sharp drop on post-Sep-2023 LeetCode problems). Versions release_v1 (400 problems) → release_v6 (1,055, May 2023–Apr 2025).
- **Weakness: last pushed 2025-07-16 [verified]** — over a year stale, so the "live" property has lapsed for current models. Competitive-programming problems are also a poor proxy for your agentic/review/handoff tasks.
- **Verdict: adapt the date-stamping mechanism, not the task set.** Recording a creation date per fixture and filtering by model cutoff is the single cheapest contamination discipline available, and it is free to adopt.

### Adapt the mechanism only

**Terminal-Bench** — https://github.com/harbor-framework/terminal-bench
- **Licence: Apache-2.0 [verified].** Very actively maintained — last push **2026-09-11 [verified]**, 699 stars on the current repo and 2,583 on the predecessor. Currently **68 task directories [verified]**.
- **Take the methodology, which is the best-documented in the field:** a task = instruction + Dockerfile + tests + **oracle solution**. Verification criteria are three and worth quoting: **Specificity** ("the unit tests will pass if and only if the container ends in an acceptable state"); **Solvability** (an oracle solution script that causes all tests to pass); **Integrity** (no shortcut that wouldn't exist in real deployment — their example: remove future commits from git history so the agent can't read the future state).
- **Take the process, which answers your §11 question:** automated CI runs the **oracle solution (must pass) and a dummy no-op solution (must fail)**; a contributor checklist; an LLM-based mistake finder; expert human review; post-merge model runs; manual trajectory audit; and an **adversarial exploit audit where an agent actively tries to cheat, with findings manually verified.** Average **~3 hours of combined reviewer attention per task**, hundreds of person-hours total. Their v2.1 release fixed issues in **28 of 89** tasks — i.e. even this process left a 31% defect rate that only post-release use exposed.
- **Also take:** the empirical difficulty definition (§7), ≥5 runs per model-agent cell, 95% CIs.
- **Don't take the tasks:** Docker + tmux + terminal-agent scaffold is a different harness from yours, and the tasks are OS-level rather than repo-level.
- **Verdict: adapt the mechanism. This is your best single template for task construction discipline.**

**SWR-Bench** — https://arxiv.org/pdf/2509.01494
- Licence not established; the value is in the design, not the data.
- **Adapt: the Clean-PR control set** (500 matched PRs with no planted defect, resampled to match on commits/files/lines so they can't be spotted by surface heuristics — any finding is automatically a FP), and **the asymmetric TP/FP matching rule**. Both transfer directly to your reviewer tasks.
- **Verdict: adapt the mechanism, ignore the dataset.**

**FrontierCode** — https://cognition.com/blog/frontier-code
- **Dataset not public by design.** Nothing to reuse.
- **Adapt: the six grader types** (classical / command / **reverse-classical** / adaptive classical / **scope** / prompt), the **blocker vs non-blocker** split, and three QC practices: the **hack report** (author role-plays a lazy adversarial programmer to guard false positives, *and* writes a valid alternative solution to guard false negatives), **rubric calibration** (author writes four solutions spanning 0–100% to confirm the rubric has resolution), and multi-stage review where researchers solve a random subset themselves.
- **Verdict: adapt the mechanism.** The hack report and rubric calibration are the two practices most directly applicable to your situation.

**BigCodeBench** — https://github.com/bigcode-project/bigcodebench
- **Licence: Apache-2.0 [verified], dataset also Apache-2.0 [verified on HF].** ICLR'25.
- **The repository is ARCHIVED [verified] — last push 2026-01-03.** No further maintenance.
- 1,140 Python tasks across 139 libraries; Complete and Instruct splits; execution-scored.
- **Contamination: high and unmitigated.** Public since mid-2024, no held-out set, no refresh, and the repo is now archived.
- **Verdict: avoid as a task source.** But **the AST-corruption trick built on top of it is worth adapting**: the over-editing paper (arXiv:2609.04061) injects controlled AST-level corruptions into 400 BigCodeBench reference solutions so the minimal patch is known by construction. That is a *generator* for scope/minimality fixtures in Python with a mechanically-derived ground truth — no author judgement involved, which is exactly what your operator wants.

### Avoid (as a task source)

**SWE-bench / SWE-bench Verified** — https://github.com/SWE-bench/SWE-bench, MIT **[verified, actively maintained, last push 2026-09-02]**
- **Avoid.** Three independent audits (§2.1) plus OpenAI's own withdrawal. 32.67% solution leakage, 31.08% weak tests, up-to-76% file-path recall from memory, and an estimated 5–10% of Verified still flawed after 93 developers × 3 reviews. Django alone is ~half the issues.
- **The harness and the annotation *process* remain valuable** — see §11.

**CanItEdit** — https://github.com/nuprl/CanItEdit
- **Licence: BSD 3-Clause *with a Machine Learning Restriction* [verified — I read the LICENSE file directly].** Clause 4 reads: *"The contents of this repository may not be used as training data for any machine learning model, including but not limited to neural networks."* GitHub reports this as `NOASSERTION`; the HF dataset card confusingly tags `license:mit` **[verified]** — **the two disagree, and the repository LICENSE is the more specific and more recent artifact.**
- **Verdict: avoid unless you get clarity.** Evaluation-only use is very likely fine under clause 4, but the licence conflict between repo and dataset card is unresolved and your operator asked for permissive licences specifically. 105 Python problems with descriptive/lazy instruction variants and hidden test suites is otherwise a genuinely good fit for instructed-editing tasks — the **descriptive-vs-lazy instruction pair is a mechanism worth copying regardless**, since it isolates instruction-following from task difficulty.

**SWE-bench Pro** — https://github.com/scaleapi/SWE-bench_Pro-os, **MIT [verified, last push 2026-05-18]**
- **Explicitly contamination-resistant — flag this one**, via copyleft sourcing + held-out + commercial splits (§2.2).
- **Avoid as a task source for you:** the public split is drawn from **GPL/copyleft repos by design**. That is the entire contamination mechanism, and it means materialising those fixtures into your repo carries copyleft obligations your project probably does not want. The benchmark harness is MIT; the *content* is not.
- **Adapt: the three-way public/held-out/private partition** as a structural idea.

**Multi-SWE-bench** — https://github.com/multi-swe-bench/multi-swe-bench, **Apache-2.0 [verified, but last push 2025-12-18]**; HF dataset tagged **`license:other` [verified]**
- Covers **Java, TypeScript, JavaScript, Go, Rust, C, C++** (+Python) — the only candidate that covers **TypeScript and Rust together**, which matches your harness. 1,632 instances from 2,456 candidates by 68 annotators; Docker-based evaluation; mini (400) and flash (300) subsets.
- **Caveats: the README says nothing about contamination** (I fetched it), the code licence (Apache-2.0) and dataset licence (`other`) disagree, and it has not been pushed in ~9 months.
- **Verdict: adapt cautiously** — the best available source of *executable TS/Rust* fixtures, but resolve the dataset licence first and assume contamination.

### Others assessed
- **SWE-smith** (https://github.com/SWE-bench/SWE-smith) — **MIT [verified], very actively maintained (last push 2026-09-14)**. Generates SWE-bench-style task instances rather than shipping a fixed set. **Worth a look as a fixture generator** — a generator sidesteps both contamination and author-taste in one move. I did not evaluate its output quality; **gap**.
- **EvalPlus** (https://github.com/evalplus/evalplus) — Apache-2.0 **[verified]**, last push 2025-10-02. HumanEval+/MBPP+ with augmented test suites. Its *contribution* is precisely the test-strengthening that §2.1 shows is the residual problem — **the test-augmentation mechanism is worth adapting** even though the underlying tasks are thoroughly contaminated.
- **HumanEval** (openai/human-eval, MIT **[verified]**) — **avoid**, fully saturated and contaminated.
- **EDIT-Bench** (arXiv:2511.04486, Nov 2025, 540 problems collected *in the wild* from real developer instructions, multiple languages) — **promising fit for instructed editing, but I could not find a dataset repository or licence, and the abstract does not state the scoring method.** **Gap.**
- **OctoBench** (arXiv:2601.10343) — checklist-over-trajectory scoring for repo-grounded instruction following; **closest published analogue to what you are building for dimension (c). [snippet-only]** — worth a direct look.
- **AGENTbench** (arXiv:2602.11988) — 138 Python tasks over 12 recent/niche repos chosen *because* they have developer-written AGENTS.md files. Finding: developer-provided context files improve performance by only **+4%**, LLM-generated ones by **−3%**, and all context files increase step count. **[snippet-only]**

### Summary table

| Benchmark | Licence | Contamination-resistant? | Runnable tests? | Verdict |
|---|---|---|---|---|
| Aider polyglot / Exercism | repo none; content MIT upstream **[v]** | No (difficulty-filtered) | Yes, 6 langs incl. Py+Rust | **Reuse as-is** (source from Exercism) |
| SWE-bench-Live | MIT **[v]** | **Yes — monthly refresh** | Yes, Docker/instance | **Reuse as external anchor** |
| LiveCodeBench | code MIT **[v]**; data `cc` unspecified **[v]** | **Yes — date-stamped**, but stale | Yes | **Adapt the date mechanism** |
| Terminal-Bench | Apache-2.0 **[v]** | Partial (frozen, audited) | Yes, Docker | **Adapt mechanism — best template** |
| SWR-Bench | unestablished | No | n/a | **Adapt: clean controls + matching rule** |
| FrontierCode | closed | **Yes — unpublished by design** | n/a | **Adapt: graders + hack report** |
| BigCodeBench | Apache-2.0 **[v]**, **archived** | No | Yes, Python | **Avoid tasks; adapt AST-corruption** |
| SWE-bench Verified | MIT **[v]** | **No — audited, withdrawn** | Yes | **Avoid tasks; reuse annotation process** |
| SWE-bench Pro | harness MIT **[v]**; content copyleft | **Yes — copyleft + private** | Yes | **Avoid content; adapt partitioning** |
| Multi-SWE-bench | code Apache-2.0 **[v]**; data `other` **[v]** | Not addressed | Yes, **TS + Rust** | **Adapt cautiously** |
| CanItEdit | **BSD-3 + no-ML-training clause [v]** | No | Yes, Python | **Avoid; copy descriptive/lazy pairing** |
| SWE-smith | MIT **[v]**, active | Generator → yes in principle | Generates | **Investigate — gap** |
| EvalPlus | Apache-2.0 **[v]** | No | Yes | **Adapt test-augmentation only** |

---

## 10. [URGENT ADDITION 1] Banding against a reference model, judged on the worst run

**Direct answer: yes, there is an established statistic for what you want, and it already has a name — but the four-band scheme and the thresholds are yours to set, and no published source will hand you those.** Here is what the literature does and does not give you.

### Finding 10.1 — "Judge on the worst run" is `pass^k`, and it is an accepted metric
**Confidence: high.** Your instinct is not idiosyncratic; it is the standard reliability metric in agentic evaluation. τ-bench's **pass^k** = probability that *all* k trials succeed. Requiring all k to pass is mathematically identical to scoring the minimum over k runs when outcomes are binary. It was introduced precisely because "the agent cannot self-check" in deployment, and it has been adopted by CORE-Bench, SWE Atlas (as Pass³), AssetOpsBench and SWE-Doctor (as All@5). **You are already using the accepted worst-case statistic. Call it pass^k and the choice becomes citable rather than a matter of taste.**

Two things to get right:
- **Use the unbiased estimator**, not p̂^k: pass^k = E_task[ C(c,k)/C(n,k) ] for c successes in n trials **[snippet-only — verify the formula before implementing]**.
- **At k = n the estimator is 0 or 1** and carries no gradation. With n=3–5, if you set k=n you get a binary verdict per task with no confidence attached. This is the central limitation of your plan and it is structural, not fixable by better statistics.
- The i.i.d. assumption is violated in practice (shared prompt, cache, task difficulty), and the violation **inflates** pass^k. Your worst-run band is therefore likely to be slightly optimistic, not pessimistic.

### Finding 10.2 — "Is A worse than B given n runs each" at n=3–5: use a paired test, and McNemar is the named one
**Confidence: high on the method; medium on its adequacy at your n.**

Three independent sources converge on the same answer, and it is not "compare two means":

1. **Pair on the task, not on the run.** Miller (arXiv:2411.00640) recommends focusing on paired comparisons because "a model's score on a given eval primarily makes sense in relation to the scores of other models." With 15 tasks and 3–5 runs, essentially all of your power comes from pairing — comparing two independent means throws it away.
2. **McNemar's exact test is the named statistic for binary paired outcomes.** Huang (arXiv:2607.12338) uses **exact McNemar** as a comparator rule at the 0pp threshold, "where binary disagreements define direction," and found it **consistently the most conservative** of the three decision rules tested (it pushed SWE-bench Verified's required budget from 90% to 95%, and AppWorld from 15% to 25%). Independently recommended elsewhere: "a pooled McNemar test on binary success outcomes for ranking claims, and a paired t-test on continuous scores." **[snippet-only]** McNemar is exactly built for your case: it looks only at the *discordant* pairs — tasks where A passed and B failed, or vice versa — and asks whether the split is more lopsided than chance. It needs no distributional assumption and it is exact at small n.
3. **A coverage-aware bootstrap with an explicit "unresolved" verdict** is Huang's primary rule (a = 0.05). Its key property, which your four-band scheme currently lacks, is that it can return *three* answers: A better, B better, or **not enough evidence**.

### Finding 10.3 — How many runs a ranking claim needs: no universal answer, and that is the published finding
**Confidence: high.**
- Blackwell et al.: ~3 repeats suffice for a prediction-interval width ≤0.01 at T=0 with a seed — **but on benchmarks of 100 and 5,760 items.** Item count damps mean variance and you have 15 tasks. Do not transfer the 3.
- Terminal-Bench: **≥5 trials per model-agent cell**, 95% CIs. FrontierCode: **5 runs per model per reasoning effort**, averaged. SWE-Doctor: 5 runs, σ of 2.0–3.4pp. AgentLens: 5 runs, σ=0.94/100.
- **Huang's finding is that no universal fraction exists** and that low error rates can be an artifact of a decision rule that simply declines to decide (93.64% unresolved at 25% budget on SWE-bench Verified while "meeting" error targets).
- **The convergent practical answer across every maintainer that publishes one is n = 5.** Three sources (Terminal-Bench, FrontierCode, SWE-Doctor) chose 5 independently.

### Finding 10.4 — What the literature does NOT give you
**Confidence: high** — I searched for this specifically and found nothing.

**No published source defines a four-band unusable/risky/equivalent/better scheme against a reference model, and none gives thresholds for such bands.** The public benchmark world reports continuous scores with intervals and lets readers draw lines. The closest published analogue is FrontierCode's **blocker vs non-blocker** split (a blocker zeroes the score; non-blockers contribute weighted), which is a two-band severity scheme applied to *criteria*, not to models.

This means: the *statistic* can be principled and cited; the *band boundaries* will be a product decision. That is not a failure — Husain's point that "the pass rate is a product decision" applies exactly here. What you can do is make the decision defensible by construction rather than by taste.

### Recommendations for §10
- **Name the statistic pass^k and use the unbiased estimator.** You gain a citation (τ-bench, ICLR 2025) and lose nothing.
- **Use n = 5, not 3.** It is the convergent choice of three independent maintainers; it lets you report pass^k for k < n (so the estimator has gradation); and at n=3 with k=3 you have a single bit per task with no uncertainty attached.
- **Decide the bands by paired test against the reference, not by absolute thresholds.** Concretely: per task, count discordant pairs (reference passed / candidate failed vs the reverse) across the 5 runs and 15 tasks; run exact McNemar; then:
  - *worse* (risky/unusable) = McNemar significant against the candidate,
  - *better* = significant in its favour,
  - *equivalent* = not significant,
  - and separate risky from unusable by a **blocker rule** rather than a threshold: any task where the candidate fails **all** runs (pass^5 = 0) that the reference passes at all is an unusable-class failure. This is FrontierCode's blocker logic and it is a property, not a number.
- **Add "unresolved" as a fifth, honest verdict**, and publish the rate at which it fires. Huang's central warning is that a decision rule which never says "I don't know" manufactures confidence; with 15 tasks × 5 runs you will hit this often and you want to see it rather than have it silently absorbed into "equivalent."
- **Publish the five things Huang says to publish:** the improvement threshold, the task-selection method, the coverage requirement (which task categories must be represented), the decision rule, and the permitted rate of unresolved comparisons.
- Report cost alongside the band (Kapoor et al.'s pitfall 1) — for a routing decision, a model that is "equivalent" at a third of the cost is the actual answer.

---

## 11. [URGENT ADDITION 2] When the fixture argues against its own scorer

**Direct answer: yes, there is published guidance, and it is unusually unanimous. Three models from two vendors independently reaching a defensible reading your scorer marked wrong is, by the published standards of every major benchmark, a task defect — and the field has named the exact diagnostic you just observed.**

### Finding 11.1 — Your observation is a recognised defect signal, by name
**Confidence: high** — three independent sources.
1. **ABC check T.10 (arXiv:2507.02825), verbatim:** "inspecting outliers in pilot experiments is crucial for identifying implementation bugs… if agents consistently fail on easy tasks, this may indicate that tasks are impossible, whereas if agents only succeed on difficult tasks, it may indicate shortcuts."
2. **The IRT literature names the statistic:** items with near-zero or negative discrimination are "a common phenomenon in LLM benchmarking datasets — resulting from **wrong reference answers or wrong grading**." **[snippet-only]**
3. **A standalone QC recommendation, independently arrived at:** "a unanimous agent failure is a useful signal of a defective task or evaluator, strong enough to recommend as a quality-control step in its own right." **[snippet-only]**

**Convergent failure across independent models is diagnostic of the instrument, not of the models.** Your instinct to investigate is correct, and the literature backs it without qualification.

### Finding 11.2 — What benchmark builders actually do to validate that the intended answer is the only defensible one
**Confidence: high.** Five distinct practices, each from a primary source I read.

**(a) Multiple independent annotators with a graded severity scale — SWE-bench Verified.**
93 Python developers; 1,699 samples; **each problem reviewed by three experts independently**; two criteria — "is the issue description underspecified and hence unfair to test on" and "do the FAIL_TO_PASS tests filter out valid solutions" — each labelled **0–3 in increasing severity, where 0–1 are minor and 2–3 mean discard**. The authors chose four ordinal levels rather than a binary severe/not-severe flag "to capture more granular detail." Result: **68.3% of samples filtered out** (38.3% flagged for underspecified problem statements, 61.1% for potentially unfair unit tests), leaving 500. **I could not retrieve OpenAI's own page (403); the above comes from a mirror of it and from Epoch AI.** **Confidence: medium on the exact percentages, high on the method.** *Crucially: even this — 93 developers, three independent reviews, explicit "is this underspecified?" criterion — left an estimated 5–10% still flawed (Epoch AI, Jun 2025), and OpenAI's own later audit attributed 59.4% of audited failures to test flaws. Three-annotator review is the floor, not a guarantee.*

**(b) Oracle-must-pass and dummy-must-fail, in CI — Terminal-Bench.** (Verified from the paper text.) Every task ships an oracle solution script; an automated workflow runs it at submission and rejects the task if tests fail. Symmetrically, "a no-op 'dummy' agent should fail the task." Plus: **Specificity** is a stated acceptance criterion — "the unit tests will pass **if and only if** the container ends in an acceptable state. That is to say, the task's instructions describe all correct end states and that the task's tests capture all correct end states." Your situation is a specificity failure in the second clause: the fixture admitted an end state your tests did not accept.

**(c) Adversarial authorship by the task author — FrontierCode's "hack report."** (Verified, fetched.) The author role-plays a lazy/adversarial programmer trying to pass with a bad solution (guards **false positives**) **and writes a valid *alternative* solution that must still pass** (guards **false negatives** — this is precisely your failure). Devin is additionally used to generate novel rubric-hacking attempts. Separately, **rubric calibration**: the author writes four solutions spanning 0–100% to confirm the rubric has resolution.

**(d) Pilot runs against real models, with contributor adjudication — Terminal-Bench.** Every task is run with multiple language models; "if the agent failed, the contributor determined whether the failure was due to a genuine lack of capability or a problem" with the task. Post-merge, every task is run by powerful models with trajectories persisted for replay, then a **manual trajectory audit**, then an **adversarial exploit audit** where an agent actively attempts to cheat and findings are manually verified.

**(e) Second-author adversarial review, with a measured failure rate.** Terminal-Bench: "the average task received approximately three hours of combined reviewer attention" across three reviews. **And it still was not enough: v2.1 "fixes issues in 28 of the 89 tasks."** A 31% post-release defect rate after three hours of expert review per task is the most honest number in this entire report, and it sets a realistic expectation: task defects are normal, recurring, and caught by use rather than by review alone.

### Finding 11.3 — Inter-annotator agreement: reported, but less consistently than you would hope
**Confidence: medium.**
- SWR-Bench reports **hit-agreement between any two of five annotators (3 human, 2 LLM) of 89.2%–94.9%** — verified from the paper.
- Terminal-Bench reports **93% Cohen's κ** for annotators labelling failure causes — verified from the paper text.
- **SWE-bench Verified does not appear to report an inter-annotator agreement statistic at all**, nor how disagreement among its three reviewers was resolved (majority? max severity?). I looked for this specifically and could not find it. **Gap.**
- The practitioner literature flags the absence as a first-order problem: "no inter-rater agreement number, so you can't separate model failure from rubric failure," and — the sharper version — "with adversarial inputs, grader disagreement is largest exactly where the interesting failures are." **[snippet-only]**

### Finding 11.4 — The underlying theory: criteria drift predicts this will keep happening
**Confidence: high.** Shankar et al. (UIST 2024, §8.3): evaluation criteria are partly **dependent on the outputs observed**, do not converge, and get refined by the act of grading — participants even went back and changed earlier grades. Your fixture's comment undercut the rule your scorer required; you discovered this by watching models grade against it. **That is criteria drift operating exactly as described, and the paper's conclusion is that it is not a one-time bug to be fixed but a permanent property of building evals.** The implication for process: budget for recurring task revision, and treat "look at the outputs" as an ongoing obligation rather than a setup step.

### Recommendations for §11
- **Treat this specific case as a task defect and fix the fixture or the scorer, not the expectation.** Three independent models from two vendors is stronger evidence than a single author's intent. ABC T.10, the IRT discrimination literature, and the unanimous-failure QC heuristic all point the same way.
- **Adopt the Terminal-Bench specificity criterion as your acceptance test, worded as an iff:** the scorer passes *if and only if* the artifact is in an acceptable state — meaning the task text describes all acceptable end states **and** the scorer accepts all of them. Your defect is in the second half.
- **Adopt FrontierCode's hack report in both directions.** Your existing `samples/<task>.gamed.json` covers the false-positive direction (the cheating answer must fail). **Add the missing symmetric artifact: a valid *alternative* solution that must pass.** That single addition would have caught this bug before it shipped, and it is the practice that most directly addresses the operator's question.
- **Add oracle-must-pass and no-op-must-fail to CI for every task** (ABC T.9, Terminal-Bench). Cheap, mechanical, and it makes solvability a tested property.
- **Run a pilot against ≥2 models from ≥2 vendors before a task enters the corpus**, and record disagreements as candidate task defects rather than model failures. Terminal-Bench does this pre-merge; it is the step you were missing.
- **When you cannot get a second human reviewer** (a solo project), the substitutes the literature actually supports are: the adversarial-author exercise (you write the cheating answer and the alternative valid answer yourself), the rubric-calibration exercise (write four answers spanning 0–100% and confirm the scorer spreads them), and the model pilot. All three are single-author-compatible.
- **Expect a residual defect rate and instrument for it.** Terminal-Bench's 28/89 and SWE-bench Verified's 5–10% are what world-class review leaves behind. Compute per-task discrimination and audit any task with negative discrimination on a schedule.

---

## GAPS — things I could not answer from available sources

1. **Miller's five specific recommendations in "Adding Error Bars to Evals"** — I could not decompress the PDF and the abstract page does not enumerate them. I verified two (next-token probabilities / variance reduction; paired comparisons) from the abstract and secondary description. The clustered-standard-errors and power-analysis items **were my own framing in the search query and I could not confirm them** — do not attribute them to Miller on my word.
2. **HalloffBench (handoff hallucinations)** — paywalled at Springer (303 to an auth endpoint). Taxonomy and metric above are search snippets only. I could not confirm the venue, date, authors, or whether the benchmark is publicly available.
3. **OpenAI's "Why we no longer evaluate SWE-bench Verified"** — HTTP 403. All figures (138 problems, 64 runs, 59.4% test flaws, named contaminated models) are second-hand and consistent across secondary sources, but unverified at source. Also note: one secondary source dates it **23 Feb 2026**, another says **1 Mar 2026** — the exact date is unresolved.
4. **The unbiased pass^k estimator formula** — the combinatorial form C(c,k)/C(n,k) is standard and appeared in multiple secondary sources, but I did not extract it from the τ-bench PDF myself. Verify before implementing.
5. **The τ-bench "61% pass@1 / 25% pass^8" pairing** that circulates widely — I confirmed only "<50% at pass^1" and "pass^8 <25% in retail" from the abstract page. The 61% figure is unverified.
6. **SWE-bench Verified's disagreement-resolution rule and any inter-annotator agreement statistic** — searched for specifically, not found. Whether they used majority vote, max severity, or adjudication is unknown to me.
7. **No published four-band model-rating scheme against a reference model, and no published band thresholds.** Searched for directly. An honest "no published work found" — see §10.4.
8. **No public benchmark measuring artifact-carry fidelity between two agent roles with an executable scorer.** Searched from several angles. The academic work is one paywalled chapter; the rest is vendor content.
9. **No published metric for sub-task decomposition granularity.** It is explicitly acknowledged as an open problem in the planning-benchmark literature.
10. **EDIT-Bench dataset licence and scoring method** — not stated on the abstract page, and I found no repository. The paper's CC BY 4.0 covers the paper, not necessarily the data.
11. **CanItEdit licence conflict** — repo LICENSE (BSD-3 + ML-training restriction) vs HF dataset card (`license:mit`) disagree. Unresolved; needs a maintainer query if you want to use it.
12. **SWE-smith output quality** — MIT-licensed, actively maintained, and generates task instances rather than shipping them, which would address contamination *and* author-taste simultaneously. I did not evaluate it. **This is the highest-value unexplored lead in the report.**
13. **Whether any benchmark caps findings as a scored metric** — I searched from four phrasings and found none. Reported as an honest negative, but absence of evidence at this search depth is weaker than the positive findings elsewhere.
14. Several 2026-dated arXiv preprints cited above (SNARE, the saturation study, the over-editing paper, IH-Benchmark, OctoBench, ClarifyCodeBench) are **very recent and mostly not yet peer-reviewed** — exceptions: over-editing is EMNLP 2026 Main, ConInstruct is AAAI 2026, Terminal-Bench and the saturation study are preprints. Treat single-source 2026 preprint findings as provisional.

---

## CONTRACT CANDIDATES

Research exposed missing project-wide rules governing the eval corpus. These are **proposals only** — per `/ldo-contract` proposal mode, I have written no files and the Planner should route these through the operator. There is no existing contract file covering evals (`docs/contracts/` has architecture, cli, compatibility, config, cost-anomaly, decomposition, documentation, errors, operation-modes, product-change, provider-admission, quality, security, skills, tool-observability, ui-responsiveness — none applies). These are product/domain rules for a distinct area, so they belong in a narrowly named new area file, **not** in `code.md` and **not** split across unrelated files.

**Proposed file for all six: `docs/contracts/evals.md`**

1. **Rule:** `Every eval task ships an oracle answer the scorer passes and a no-op answer it fails, both checked in CI before the task enters the corpus.`
   **Evidence:** ABC checks T.8/T.9 (arXiv:2507.02825, Jul 2025) require a verified-solvable task and an automatic oracle solver. Terminal-Bench (arXiv:2601.11868) runs exactly this pair in CI at submission: oracle solution must pass, "dummy" no-op agent must fail. The repo already has `samples/<task>.gamed.json` for the cheating direction; the oracle direction is unenforced.

2. **Rule:** `Every eval task ships a valid alternative answer, materially different from the reference, that the scorer must also pass.`
   **Evidence:** FrontierCode's hack report (cognition.com/blog/frontier-code, 6 Aug 2026) requires the task author to write both an adversarial bad solution (guards false positives) and a valid alternative solution (guards false negatives). This is the single practice that would have caught the observed case where three models from two vendors reached a defensible reading the scorer marked wrong. ABC check O.a.1 requires considering semantically equivalent expressions of ground truth.

3. **Rule:** `A task is admitted only after a pilot against at least two models from two vendors; any defensible answer the scorer rejects is a task defect and blocks admission.`
   **Evidence:** ABC T.10 — outlier inspection in pilot experiments, "if agents consistently fail on easy tasks, this may indicate that tasks are impossible." Terminal-Bench runs every task with multiple models pre-merge and has the contributor adjudicate whether a failure is capability or task defect. IRT literature: near-zero/negative item discrimination in LLM benchmarks results from "wrong reference answers or wrong grading."

4. **Rule:** `A ranking or routing claim requires at least five runs per model-task cell, reports the spread and the unresolved rate, and never rests on a single run.`
   **Evidence:** Terminal-Bench runs "at least five times" per model-agent cell with 95% CIs; FrontierCode runs 5 per reasoning effort; SWE-Doctor runs 5 (σ 2.0–3.4pp). Blackwell et al. (arXiv:2410.03492, Jun 2025) show temperature 0 plus a seed does not give determinism on any hosted model. Huang (arXiv:2607.12338, Jul 2026): a decision rule that cannot return "unresolved" manufactures confidence — 93.64% of comparisons were unresolved while error targets were nominally met.

5. **Rule:** `Each corpus run records a saturation index per task and flags any task at or above 0.7 for revision or retirement.`
   **Evidence:** Akhtar & Reuel et al. (arXiv:2602.16763, Feb 2026) define saturation as loss of discriminative power among top models, give S_index = exp(−R_norm²) with a stated saturation threshold of 0.7, and recommend maintainers "build explicit revision-or-retirement criteria into the benchmark." The repo currently encodes this only as a prose comment in `runner/corpus.ts` ("a task where every model scores identically is a task that has stopped discriminating").

6. **Rule:** `A review-style task ships a matched control fixture with no planted defect, on which any blocking finding is scored as a false positive.`
   **Evidence:** SWR-Bench (arXiv:2509.01494, Sep 2025) pairs 500 Change-PRs with 500 Clean-PRs statistically resampled to match on commits/files/lines, where any finding is automatically a false positive; four of five reviewed tools scored under 10% precision, which is invisible without controls. CR-Bench adds signal-to-noise ratio for the same reason. The current `BLOCKING_FINDING_CAP = 4` in `evals/scorers/reviewer-hidden-regression.ts` is a proxy for precision with no published threshold behind the number; a control fixture measures the thing directly.

**Note for the Planner:** candidates 1, 2 and 3 resolve established engineering standards (oracle/dummy CI checks, adversarial authorship, pilot validation are documented practice at Terminal-Bench, FrontierCode and SWE-bench Verified) and are the strongest of the six. Candidates 4, 5 and 6 encode specific published thresholds (n=5, S_index 0.7, matched controls) — the mechanisms are established but the exact numbers are project policy and should go to the operator as such.

---

## FILES IN THIS REPOSITORY RELEVANT TO THE ABOVE
- `/home/adegtyarev/Develop/Hobby/ad-coder/evals/scorers/reviewer-hidden-regression.ts` — `BLOCKING_FINDING_CAP = 4` and its rationale comment; §5 applies directly.
- `/home/adegtyarev/Develop/Hobby/ad-coder/evals/scorers/coder-retention.ts` — uncommitted; §6(f) NoLiMa lexical-overlap construction applies before it lands.
- `/home/adegtyarev/Develop/Hobby/ad-coder/evals/runner/corpus.ts` — `--repeat` handling and the "stopped discriminating" comment; §3, §4 and §10 apply.
- `/home/adegtyarev/Develop/Hobby/ad-coder/evals/runner/scope.ts` — stray-path tracking; ABC check O.g.2 is its published grounding.
- `/home/adegtyarev/Develop/Hobby/ad-coder/evals/corpus.json` and `/home/adegtyarev/Develop/Hobby/ad-coder/evals/tasks/` — 15 tasks, **no `difficulty` field present in any of them** (I checked); §7 proposes empirical pass-rate tiers.
- `/home/adegtyarev/Develop/Hobby/ad-coder/docs/contracts/` — no evals contract exists; see contract candidates above.

Extracted paper texts are in the scratchpad at `/tmp/claude-1000/-home-adegtyarev-Develop-Hobby-ad-coder/2b9a9dc7-0a43-4394-9b24-24dd84f11868/scratchpad/` (`abc.txt` — full ABC checklist; `sbp.txt` — SWE-bench+; `cjb.txt` — CodeJudgeBench; `tb.txt` — Terminal-Bench) if you want to read the primary text rather than my summaries.