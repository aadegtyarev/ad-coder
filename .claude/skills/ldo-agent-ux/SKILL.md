---
name: ldo-agent-ux
description: Design the interface a model works in — context blocks, labels, markers, command names, state — the way you'd design a dense console interface
---

The model reads text the way a human reads a terminal. Everything you hand it — system state, memory, commands, file listings, its own prior output — **is its interface**, and it costs tokens to load. Design it like a console interface: named, described, structured, dense, stable. Most agent context is unreadable *and* bloated, because nobody applied either discipline.

UX-for-the-model is console-interface design. TUI is the richer layer on top (closer to web). Get the console layer right; the model never sees the color.

## The failure, concretely

A real one: memory and system info emitted as numbered tags and codes, redone because neither model nor operator could read it.

Bad:
```
[1] switched auth to JWT
[2] postgres pool = 20
cmds: git, dep, mem, cfg
```
What is `[1]`? The model memorizes a number to refer back. `dep` has no description, so it guesses usage.

Good:
```
### memory / recent-decisions
- auth: switched to JWT
- infra: postgres pool raised to 20

### commands
- `git <sub>`    run git (status, diff, commit)
- `deploy <env>` ship branch to <env>; auto-rollback on health fail
```
Now the model can say "regarding `memory/recent-decisions: auth`" and any reader knows what's meant. Commands are self-documenting.

## Principles

1. **Name by function, not code.** `memory/recent-decisions`, not `MEM_042`. `deploy`, not `dep`. A name that says what the thing is saves a lookup.
2. **Markers that survive being read.** Section headers and slot paths (`### commands`, `memory/recent-decisions`), not `[1] [2]`. A marker quoted elsewhere should carry its meaning.
3. **Describe every affordance.** Each command, tool, slot, knob: name + one-line what-it-does. An undescribed affordance is one the model uses wrong.
4. **Dense, not padded.** Every line earns its place. No filler headers, no restating the obvious, no decoration. Token cost is real and recurring — a context block loads on every call. If a line doesn't help the model decide or act, cut it.
5. **Structure you can scan.** Headers, grouping, one item per line where it matters. If a human can't scan it, a model under load can't either.
6. **Show state explicitly.** Never make the model infer its mode, what's available, or what changed. Console interfaces show the prompt; agent context shows working state.
7. **Stable layout.** Same names, same order, every run. The model reads faster, and identical prefix bytes keep the prompt cache warm. A layout that drifts colds the cache each call.

## The same rules govern what the model produces

Output becomes the next reader's input, so they apply in reverse: **verdict before detail** (first line is the answer), **evidence not assertion** ("`pytest`: 42 passed" beats "tests pass"), **name your uncertainty**, **stable shape**. The canonical long-run report:

```
VERDICT: <succeeded | partial | failed> — <why>
CHANGED: <concern/file> — <what's different>
VERIFY:  <the 1–3 things that matter>
UNCERTAIN: <what you couldn't establish, and why>
NEXT: <one action, or "ready to merge">
```

## Anti-patterns

- **Numbered-tag soup** — `[1] [2] [3]` with no names
- **Opaque IDs** — `MEM_042`, `CTX_007`, `dep`
- **The dump** — unstructured listing, no grouping or description
- **Description-free affordances** — commands by name only
- **The shifting prompt** — layout changes per call (colds cache)
- **Padding** — headers and prose that don't help the model decide or act

## In LDO

The **Planner's `codebase_context`** is the canonical interface surface — markers like `### Stack`, `### Files`, `### Commands` are this skill applied; keep them stable and named. **Coder's summary** and **Reviewer's verdict** are handoffs: verdict first, evidence, uncertainty. The **workflow's final result** gets the report shape above.
