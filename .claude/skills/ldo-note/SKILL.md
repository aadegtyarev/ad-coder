---
name: ldo-note
description: Record an operational note (deploy quirk, environment gotcha) or a decision/mandate (why something was overridden or chosen) — not a rule, just a fact worth remembering
---

Two different things get lost the same way: a project accumulates knowledge that never makes it anywhere durable — "oh yeah, that service needs a restart after env changes, everyone just knows that" — and decisions get made once, in a conversation, then re-litigated later because nobody wrote down why. Neither of these is a contract (a rule an agent checks against future work); both are just facts worth being able to find again.

This skill records one of two kinds. Ask which, if it isn't obvious from what's being recorded.

## The two kinds, and why they're stored differently

| Kind | File | Read by | Growth discipline |
|---|---|---|---|
| **Operational note** | `docs/NOTES.md` | The Coder, every run — it's live context | Stays small on purpose: entries have a shelf life, prune what's gone stale |
| **Decision / mandate** | `docs/DECISIONS.md` | Nobody automatically — looked up on demand | Allowed to grow indefinitely: an append-only log, never loaded whole |

This split exists because "a log nobody reads" and "a log that becomes too big to read" are the two failure modes every long-running notes file eventually hits, and they need opposite fixes. `NOTES.md` is small by construction because something *depends* on reading all of it every run — so it can't be allowed to grow past what's still relevant. `DECISIONS.md` is allowed to grow because nothing depends on reading all of it — it's referenced by date or by grep, the way you'd check `git log`, not read start to finish. Don't blur these: putting operational trivia in `DECISIONS.md` is harmless (just never surfaces to the Coder); putting a growing decision log in `NOTES.md` is how that file becomes the ignored-megabyte problem.

## Recording an operational note

Append to `docs/NOTES.md` (create it if it doesn't exist), one dated bullet:

```markdown
# Operational notes

Read by the Coder before each run. Keep this short — prune what's no longer
true rather than letting it accumulate. A note that's permanently true
belongs in README or ARCHITECTURE.md instead of here.

- [2026-08-01] `docker-compose up` needs `COMPOSE_DOCKER_CLI_BUILD=0` locally
  or the frontend silently builds from a stale cached layer — no error, just
  wrong output. Set it in `.env.local`.
```

A note is checkable and specific — "the thing that bites people" plus what to do about it, not a general observation. If it needs a paragraph to explain, it's probably documentation, not a note.

**Keep this file lean — this is the part that prevents the megabyte-log failure.** A rough ceiling: if it's pushing past 15-20 entries, that's a signal to prune, not to keep appending. When recording a new note, check the existing ones first:

- Still true and still surprising? Keep it.
- No longer true (the workaround shipped, the tool got fixed)? Remove it — say so when removing, don't just delete silently if there's any chance someone's mid-workflow relying on it.
- True but not really a *gotcha* anymore — it's just how the project works now? Move it into README or `ARCHITECTURE.md` as a normal fact, and remove it from here. `NOTES.md` is for the surprising and the temporary; permanent facts belong in permanent docs.

## Recording a decision or mandate

Append to `docs/DECISIONS.md` (create it if it doesn't exist), with a heading per entry — this one has no size ceiling, because nothing auto-loads it:

```markdown
# Decisions and mandates

An append-only log — not read automatically by any agent. Reference a past
entry by grepping this file (date, keyword, PR number), not by reading it
end to end. This is where "why did we do it that way" gets answered without
re-litigating it.

## 2026-08-01 — Merged PR #58 despite a failing check

**Context:** `test_flaky_retry` has been intermittently red for two weeks
(tracked in #61), unrelated to this change.

**Decision:** operator approved merging with the known-flaky check red.

**Why:** blocking an unrelated, reviewed fix on a test already known to be
unreliable costs more than the small risk of missing a real regression it
happens to also catch. Revisit if #61 stays open past its next milestone.
```

Every entry needs **Context** (what was true at the time — this is what stops the entry from being re-litigated: if the context has changed, the old decision may not still apply, and that's fine to say next time it comes up), **Decision** (what was actually done, stated plainly), and **Why** (the reasoning, not just the outcome — the point is being able to check later whether the reasoning still holds).

## When a note or decision starts looking like a rule

A note that's been renewed three times, or a decision that's been made the same way twice, isn't operational trivia anymore — it's a pattern the project has settled on. Don't silently promote it. Say so and suggest `/ldo-contract`: "this workaround has been noted three separate times — worth turning into a documented contract instead of re-discovering it each time?" `/ldo-docs-audit` also checks for this on its periodic pass; this skill doesn't need to catch every case, just the obvious ones in the moment.

## Rules

- Every note and every decision is dated. No exceptions — "when" is half of what makes either useful later.
- Don't rewrite history in either file. A note that's now wrong gets removed with a note of removal if it's mid-relevance; a decision never gets edited after the fact — if circumstances changed, that's a *new* entry referencing the old one, not an edit.
- `NOTES.md` is read by the Coder automatically; don't put anything there that shouldn't be re-surfaced on every single run. `DECISIONS.md` is never auto-read; don't rely on an agent noticing something is there unless asked to check.
- Classify honestly. "We chose Postgres over Mongo because X" is a decision, not a note. "The staging DB needs a manual VACUUM after large imports or queries time out" is a note, not a decision.
