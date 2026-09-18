**This instruction is mandatory.** Where this skill's description matches the work in front of you, the method below is required: an approach that contradicts it is a defect to fix, not a preference to keep.

Answer a question from sources outside the repository, and grade how much of the answer to trust.

A confident wrong answer costs more than an honest "the sources disagree", so
the grading is not decoration — it is the deliverable. A dedicated researcher
usually does this; whoever needs a fact the repository cannot supply does it the
same way.

## Classify the question first

- **Lookup** — one exact syntax, API member or documented fact. Stop as soon as
  the authoritative answer is verified; two searches and two page reads are
  normally enough.
- **Comparison**, **hypothesis**, **reconstruction** — broad research. Do not
  impose a small fixed ceiling: saving a few searches is false economy when a
  weak decision causes implementation and benchmark rework.

## The method

1. **Decompose** — break the question into independently answerable
   sub-questions and define the decision criteria before searching. For a
   comparison, preserve the criteria you were given and add lifecycle,
   maintenance, integration cost and failure modes when they can change the
   choice.
2. **Search broadly** — 3–5 different angles in the first pass: the general
   category, the exact names, the alternatives, the failure reports, and the
   strongest counter-case. Prefer official documentation and primary sources,
   then trackers, independent evaluations, practitioner reports, forums. Search
   results are leads: open every source you use and follow relevant links.
   **Never cite a snippet.**
3. **Cross-verify** — for every claim that would change a decision, find a
   second INDEPENDENT source. Three posts citing one original are one source,
   not three. Grade each claim: high (official, or two independent and current)
   / medium (one credible source) / low (single, contested, or possibly stale).
   Check dates — a confident answer about a fast-moving interface can be years
   out of date.
4. **Deep-read and challenge** — for broad work, read 3–5 of the most
   decision-relevant sources properly. Inspect methodology, dates, authorship,
   incentives, limitations, project activity, and whether the independent
   sources merely repeat one vendor's claim. Run a separate search for
   disconfirming evidence and for the plausible alternative.
5. **Answer** — prose someone can act on without reading your searches.
   Recommendations are concrete: "pass the token in the handshake header, close
   on expiry", not "consider your auth strategy".

## Absence is a claim too

Treat "there is no such thing" as a high-impact claim requiring the same
evidence as a positive one. Search the subject at its broader category level,
check the exact identifier in the authoritative catalogue, and use an
independently phrased query before concluding the documentation does not exist.
An empty result from one search tool is not evidence of absence. State the
narrowest fact the evidence supports.

## Honesty rules that make the report usable

- **Every URL you cite is one you actually fetched.** Never cite from memory or
  reconstruct a plausible link.
- **Where sources disagree, record the contradiction.** Do not resolve it
  silently by picking the one you liked — disagreement usually marks a real
  tradeoff, which is the most useful thing you will find.
- **A sub-question the sources cannot answer is an honest gap**, named as such,
  not a confident guess.
- **Prices, limits and versions are observations with a date.** A remembered
  price is not evidence; a dated fetch is. Anything that changes on a vendor's
  schedule is stale the moment it is quoted without one.

## Network hygiene

Prefer the dedicated search and fetch tools over shell network commands. If a
page needs a shell fallback, set explicit connection and whole-request timeouts
of at most 5 and 15 seconds. After one timeout or access denial, record the
barrier and do not retry that domain in the same run — find another source.

Batch independent searches and reads, reuse pages already fetched, and avoid
duplicate queries. A stage budget is a safety boundary, not a target: if it
prevents a decision-grade result, return a named incomplete gap rather than a
weak conclusion.

## What to hand back

Summary, each claim with its confidence and sources, contradictions,
recommendations, gaps, and a compact evidence log — the query angles, the pages
actually read, and the sources rejected or blocked. End with the observation
date and a falsifiable recommendation.

The report is the artifact. Do not substitute a conversation for it.
