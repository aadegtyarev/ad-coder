---
name: ldo-code-audit
description: Read the codebase cold for what accretion did to it — file bloat, comment sprawl, duplicated logic, decomposition candidates — then route findings into real fixes, not just a report
---

Every individual change is disciplined: the Coder writes tests, the Reviewer checks the diff, contracts hold. None of that stops a file from becoming three files' worth of responsibility fifty small changes later, or a function from growing a comment for every edge case anyone ever hit instead of a name that says what it does. No single change looks wrong. The accumulation does.

This is the code-side counterpart to `/ldo-docs-audit` — same reason to exist (no per-diff review can see decay that happens *across* diffs), same discipline (read cold, verify, rank), aimed at the codebase's structure instead of its documentation. Run them together; they usually surface related findings — a bloated module often has the doc describing it going stale at the same time.

## Run it fresh

Same rule as `/ldo-docs-audit`: **delegate to a subagent with no prior context on this project.** If you've been working in this codebase this session, you already have a model of "how it's organized" in your head, and that model is exactly what's supposed to be in question. A fresh read doesn't inherit it.

Read the codebase structurally first — directory layout, file sizes, what imports what — before reading any single file end to end. Form an impression of where the weight is before zooming in.

## What to look for

**Module and file bloat.** Not a line-count threshold — a well-decomposed 800-line file can be fine, a tangled 150-line one might not. The question is whether a file still does the one thing its name says, or has accumulated a second and third responsibility nobody split out. Check: can you describe what this file is for in one sentence that's still true of everything in it?

**Comment sprawl.** A comment earns its place only when it states a constraint the code can't show itself — everything else is narration. Look for: comments restating what the next line already says, comments explaining history ("we used to do X, but Y happened, so now Z" — that belongs in the commit message, not living code), comments that were true when written and are now describing something the code no longer does, and comment-to-code ratios that have grown because someone explained instead of naming things clearly. Verify each one you flag actually adds nothing a clearer name or a shorter function wouldn't — don't flag a comment stating a genuine non-obvious constraint.

**Duplicated logic.** The same pattern implemented independently in two or more places, often drifted slightly apart in the process — one has a bug fix the other doesn't, one handles an edge case the other forgot. This is worse than the tokens spent maintaining two copies; it's two copies that can silently disagree.

**Decomposition candidates.** A function or module doing several unrelated things, where touching one requires reading and understanding all of it. The tell: you can't describe what changed to someone without describing what it sits next to.

**Dead surface.** Exports, functions, or entire files nothing calls anymore. Verify with a real grep for callers/imports before flagging — a false positive here (something used via reflection, a dynamic import, a public API surface for consumers outside this repo) is expensive to get wrong. When genuinely unsure, say so as a question rather than asserting it's dead.

## How to verify

Same standard as `/ldo-docs-audit`: don't report from a skim.

- A "duplicated" pattern — read both copies fully; near-duplicates that actually diverge in real ways aren't the same finding.
- "Dead" code — grep for every call site and import, including string-based dynamic references and non-code consumers (tests, config, docs referencing a function name).
- A "bloated" file — you should be able to name the two or three distinct responsibilities living in it, not just gesture at its size.

## Output

Rank by cost to a future reader/editor, same ordering discipline as `/ldo-docs-audit` — a handful of prioritized findings beats forty:

1. **Duplicated logic that's already drifted** — the two copies disagree; whichever is stale is a live bug waiting to be hit
2. **Dead surface** — actively misleading (a reader assumes it does something because it's still there)
3. **Decomposition candidates** — costs every future editor, compounding
4. **Comment sprawl and minor bloat** — real but lower-stakes cleanup

For each: exact file:line, what's wrong, and why it costs a future reader specifically — not just "this is messy."

## Routing findings to a fix — this is the part that isn't a report

A list of findings that nobody acts on is the same failure this skill exists to prevent, one level up. Route each confirmed finding by what kind of change it needs:

- **Mechanical, no behavior change** — trimming a stale comment, deleting verified-dead code, renaming for clarity. Hand this to `/simplify` — it's exactly built for cleanup-only passes with no bug hunt, no reason to rebuild it here.
- **Doc now describes something that changed or moved** — don't rewrite it yourself as a side effect; that's `/ldo-docs-audit`'s job specifically (it verifies claims against code the same rigorous way). Flag it and suggest running that skill, or run both audits in the same pass since they were probably triggered by the same round of accumulation.
- **Structural — decomposing a file, extracting a shared module, splitting a function that grew too many responsibilities.** This changes behavior-adjacent structure enough to deserve the same scrutiny any real change gets. Don't hand-edit it directly. File it as a task and run it through the pipeline: `Workflow({ name: "ldo", args: { task: "extract the rate-limiter's bucket logic from middleware/rate_limit.go into its own package — currently it's tangled with HTTP handling, making both hard to test independently" } })`. The Planner scopes it, the Coder does the extraction with tests proving nothing broke, the Reviewer checks it didn't just move the mess. Decomposition is exactly the kind of change most likely to silently break something subtle — it deserves review, not a quick pass because it "should" be safe.

Don't try to fix everything found in one pass. Same discipline as `/ldo-docs-audit`: pick the highest-cost few, route those, leave the rest recorded (as backlog items, or just in the audit's own output) for next time.

## When to run it

- Alongside `/ldo-docs-audit`, when the drift-log counter in `CLAUDE.md` suggests a housekeeping pass is due (see `/ldo-init`)
- After a stretch of fast iteration on one area — the kind of period that produces exactly this accumulation
- When something that used to be a quick change starts feeling slow to make, and you can't point at why

Not after every task — like its doc counterpart, this is the periodic full read that per-change review structurally can't do, not a replacement for the Reviewer's per-diff simplification check.
