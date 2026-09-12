---
name: ldo-contract
description: Record a project contract — a rule that must hold regardless of task size, read only when a change touches the area it governs
---

Some rules aren't conventions the Coder should *match* — they're constraints that must hold no matter what. "Every user action emits an audit event." "No raw SQL string concatenation, ever." "This is a single-user tool — never add authentication." These don't come from reading the code; they come from the operator, because they're decisions, not observations.

This skill records one. It's interactive — you elicit the contract, classify it, and write it to the right file.

For a project that already has these decisions made — just not written down anywhere LDO can read — see **Discovering contracts in an existing project**, below, instead of eliciting from scratch.

## Why not `CLAUDE.md`

`CLAUDE.md` loads every session, for every kind of work. A security floor has no business loading when the task is renaming a variable — it costs tokens for nothing, and stuffing every contract into one file over time turns it into an unmaintainable pile nobody rereads. Contracts live in `docs/contracts/`, one file per area, and the Planner reads only the file whose area the task actually touches. `CLAUDE.md` carries a single pointer line, not the contracts themselves.

## Process

### 1. Elicit

If invoked with a description ("add a contract: every user action must emit an audit event"), start from that. If invoked bare, ask: what's the rule, and what happens if it's violated — does the task get refused, does it need a security review, does the diff get blocked?

### 2. Classify

Every contract is one of four kinds. Ask which, if it isn't obvious from the description:

| Kind | File | Meaning | Checked by |
|---|---|---|---|
| **Scope boundary** | `docs/contracts/scope.md` | What this application does and deliberately does not do | Planner, before writing the plan |
| **Accepted risk** | `docs/contracts/security.md` (Accepted section) | A risk the operator has knowingly chosen not to mitigate | Security, so it doesn't re-raise a closed question |
| **Security floor** | `docs/contracts/security.md` (Required section) | A security property that must hold regardless of what the task looks like | Security + Reviewer, always |
| **Code contract** | `docs/contracts/code.md` | A cross-cutting structural rule about how code must be written — observability, error handling, data flow | Reviewer, as a blocking check |
| **Product/area contract** | `docs/contracts/<area>.md` | A product or domain rule that does not belong to scope, security, or cross-cutting code policy | Planner + Reviewer when that area is touched |

A rule can be both a scope boundary and a security floor ("never add a network listener" reads both ways) — ask which enforcement path matters, or write it to both files if it genuinely does double duty.

Do not use `code.md` as a miscellaneous bucket. If candidates govern different product areas, give each area its own narrowly named file (or reuse an existing applicable one); never create one catch-all file just because the candidates arrived in the same research run.

### 3. Write it precisely

A contract is a rule an agent can check against a diff or a plan, not a wish. Write it so violation is checkable:

- Bad: "handle errors well"
- Good: "every function that can fail returns a typed error, never throws across a module boundary"

Bad: "be secure"
Good: "no raw SQL string concatenation — only parameterized queries or the query builder"

Four disciplines keep an entry cheap to read on every run without losing what makes it checkable:

**(i) Rule, not reasoning, target ≤200 characters, one line.** The contract file is re-rendered into the Planner's and Reviewer's prompt on every run that touches its area — the rule is read every time, the reasoning behind it is read once, when the operator decided it. State the imperative, checkable rule; leave the "why we decided this" out of the line entirely.

**(ii) Reference, don't restate, when the rule already lives somewhere.** When the rule already exists as an agent instruction (`agents/*.md`) or in another doc, the contract's job isn't to repeat it — it's to point at it and declare the enforcement the contract adds (what severity a violation gets, who checks it). Worked example, this repo's own error-swallowing entry:

Before (628 characters, restates the rule agents/coder.md already states):
```
- [2026-08-01] Never swallow an error silently. A caught exception is handled only when the caller can tell what happened — logged with enough context to act on, rethrown, or turned into a typed result the caller checks. `catch { }`, `catch (e) { return null }` with no logging, and `except: pass` are not error handling. If a specific, expected failure is genuinely safe to ignore, say so at the point where it's ignored — one line on why — so it reads as a decision, not an oversight. (Source: `agents/coder.md`; the two `catch` blocks in `workflows/ldo.js` already follow this — both log and return an explicit error object.)
```

After (~170 characters, references instead):
```
- [2026-08-01] Never swallow an error silently — see agents/coder.md, "Never swallow an error silently", for what counts as handled. A violation is blocking `critical`, not a nit.
```

Checkability is unchanged: the definition of "handled" is one reference away, exactly as precise as before, and the enforcement — `critical`, not a nit — is now stated explicitly, which the long version never actually said.

**(iii) Provenance moves to a `## Sources` section, out of the rule line.** Not because an agent reading the file skips it — it's because the Planner copies contract text verbatim into `risks` (`agents/planner.md`, step 1.7's carry-forward instruction) and from there it's re-rendered into every downstream prompt for the rest of the run. A `(Source: …)` tail welded to the rule line gets multiplied by every pass that carries it forward; a separate section at the bottom of the file never leaves the file. Put it there instead, keyed by the entry's date and first few words — one file per area is preserved, so the operator still audits everything in place.

**(iv) Price it.** This repo's own `docs/contracts/` — 4 entries, 1401 bytes across two files — costs roughly 350 tokens read into the Planner's and Reviewer's prompt on every run that touches code or scope. It measured about 1935 bytes before the `(Source: …)` tails moved into `## Sources` sections; that trim is what the discipline above buys, per run, forever. `scripts/check-contracts.sh` prints the current figure — run it rather than trusting this sentence, which is a measurement and will go stale the way the one it replaced did.

Keep each entry to one line. If it needs a paragraph to state, it's probably two contracts.

### 4. Append

Each contract file is a flat list, newest at the bottom, each entry dated:

```markdown
# Security — Required

- [2026-07-28] Every request handler validates and sanitizes input before it reaches business logic.
- [2026-07-28] Secrets are read from environment or a secrets manager — never hardcoded, never logged.
```

```markdown
# Security — Accepted risks

- [2026-07-28] CSRF protection is intentionally skipped — internal tool, VPN-only access, no browser session exposure.
```

Create the file (with the two-section header for `security.md`) if it doesn't exist. Append; don't rewrite existing entries — if a contract needs to change, that's a separate action (see Revising, below).

### 5. Wire up `CLAUDE.md`

If this is the first contract in the project, add one line to the `<!-- BEGIN ldo -->` block (run `/ldo-init` first if the block doesn't exist yet):

```
Project contracts live in `docs/contracts/`. When a task touches scope, security,
or structural rules, read the relevant file before planning.
```

Don't duplicate the contracts themselves into `CLAUDE.md` — the pointer is enough; the Planner reads selectively per task.

### 6. Measure what you wrote

Run the check against the project's own contracts — it takes `[repo-root] [contracts-dir]`, so it works on any project, not just LDO's:

```
"${CLAUDE_PLUGIN_ROOT:?}/scripts/check-contracts.sh" "$PWD" docs/contracts
```

Fully quoted, and resolved only through `CLAUDE_PLUGIN_ROOT`. This skill runs with the cwd set to the operator's project, so a bare `scripts/check-contracts.sh` resolves against whatever repo happens to be open — somebody else's script, the same defect class `/ldo-feedback` documents for `redact.sh`. **A `check-contracts.sh` found by any other means must not be executed.** If `CLAUDE_PLUGIN_ROOT` is unset or that file doesn't exist — a vendored install copies agents, skills and workflows only, never `scripts/` — do not go looking for it elsewhere: read the contract files yourself, count the characters of each entry, and tell the operator the script was not reachable and why.

Report per file which entries are over 200 characters. The fix shape is always the same one from (i)-(iii) above: the short imperative rule on the line, the evidence moved to a trailing `## Sources` section, as this repo's own `docs/contracts/code.md` does. Report it and offer — rewriting the operator's entries unprompted is the one thing this skill never does.

## Discovering contracts in an existing project

A project being migrated onto LDO usually already *has* these decisions — "single-user, no auth", "we accepted the CSRF risk because it's VPN-only", "handlers always validate input first" — they're just sitting in a README paragraph, a code comment, a security doc, or nowhere but the maintainer's head. `/ldo-init` triggers this automatically the first time it runs on a non-empty existing project (see its "Discover contract candidates" step); you can also run it standalone here if the operator asks to (re-)scan later.

The rule is the same either way: **read and propose, never write silently.** A contract is a decision the operator makes, not one an agent infers — get that wrong and every future task gets checked against a rule nobody actually agreed to.

1. **Read for evidence, not vibes.** Sources worth checking: README (especially "out of scope" / "won't do" / "why we don't" language), `SECURITY.md` or similar, code comments that read as a declared rule rather than an implementation note ("// intentionally no rate limiting — internal only"), CONTRIBUTING/architecture docs, and a code-level pass for a pattern that's *consistent everywhere* (every handler validates input the same way, every DB call goes through one query builder with zero exceptions). A pattern followed inconsistently isn't a contract candidate — it's just current practice; don't propose it.

2. **Every candidate carries its evidence.** Quote the source line or describe the pattern with file references — "`README.md:42`: 'this is a single-user CLI; we will not add network auth'" or "12/12 handlers in `src/routes/` validate via the same `assertValid()` call, no exceptions found." A candidate with no quotable evidence is a guess; drop it rather than propose it.

3. **Classify each candidate** using the table above, same as any contract.

4. **Present the full list to the operator before writing anything.** Group by kind, show the evidence, and ask which to accept, adjust, or skip — one pass, not one confirmation per line. Something that looks like a scope boundary to you might be an incidental fact of the current implementation, not a decision — the operator knows which.

5. **Write only what's confirmed**, exactly as in the normal Append step (dated entry, source file). Nothing gets written on inference alone, no matter how consistent the pattern looked.

6. **Offer to point the source at the contract, don't leave two copies to drift.** When a confirmed candidate's evidence was a documentation section — a README paragraph, a `SECURITY.md` entry — that prose still fully states the rule after `docs/contracts/` now also states it. Two independently-editable copies of the same decision is exactly the duplication this whole mechanism exists to avoid: the contract is now what's actually checked, so a copy left behind in README can drift from it silently and nobody would notice until the disagreement matters. Ask, per candidate, whether to trim that section down to a pointer ("see `docs/contracts/security.md` for the current policy") — never do this without asking, and never touch it at all for a candidate sourced from a code comment or an implicit pattern (there's nothing to trim there, the code itself is the evidence, not a doc). Default to asking once for the whole batch ("trim the source sections these came from to pointers?") rather than per line, unless the operator wants finer control.

If nothing turns up real evidence, say so plainly rather than manufacturing a thin candidate to have something to show — "no explicit contracts found; the project doesn't state any of these decisions anywhere I can read" is a legitimate, useful result.

## Revising or retiring a contract

A contract that gets overridden mid-run (an operator tells the Coder "you can break this one here") is a signal, not a one-off. Don't silently edit history — append a note under the existing entry:

```
- [2026-07-28] No raw SQL string concatenation — only parameterized queries.
  - [2026-08-03] Overridden for the migration script (one-off, not user-facing) — consider whether the contract needs a documented exception class.
```

If a contract is retired outright, mark it rather than deleting it — `~~struck through~~` with the date and reason. History matters here; a contract that was true and stopped being true is worth knowing.

## Rules

- Every contract is checkable against a diff or a plan — no aspirational language.
- One contract per line. Don't bundle three rules into one bullet.
- Classify honestly. A scope boundary checked only by Security won't catch a Planner writing a plan that violates it before Security ever sees it.
- Don't write contracts for things `conventions` already covers (naming, formatting, general style) — this is for rules with teeth, not preferences.
- Target ≤200 characters per entry: the rule, not the reasoning behind it.
- When the rule already exists as an agent instruction or another doc, reference it and state the enforcement the contract adds — don't restate it.
- Provenance goes in a trailing `## Sources` section, keyed by date and first few words — never in the rule line itself.
- A contract file's byte cost is paid on every run that touches its area; that's a reason to keep entries short, not an afterthought.
- `scripts/check-contracts.sh` measures the first three of these: it fails on an entry over 200 characters or carrying an inline `(Source: …)` tail, warns on a file with entries and no `## Sources`, and prints the recurring byte cost. It takes `[repo-root] [contracts-dir]`, so step 6 above runs it against the project's own contracts — it is not limited to this repo. What remains true is that LDO cannot run it from *inside* the pipeline: the workflow has no filesystem access, and by the time an agent could read the files the entries are already in the prompt. The signals that reach the operator from inside a run are the `⚠ Plan risks trimmed` line and the `CONTRACT OVER LIMIT:` risk the Planner raises when it reads an entry it cannot carry verbatim.
