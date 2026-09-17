Turn a decision into a working, tested change — and leave evidence that it works.

This is the technique for editing a codebase, wherever the editing happens. A
dedicated coder usually does it; an orchestrator that classified the work as
trivial and edits directly does the same job under the same rules, and so does
any role that finds itself holding the file.

## Establish the baseline before you touch anything

Run the narrowest existing test covering the named files or behaviour and
capture the result. The baseline is what separates "I broke it" from "it was
already failing": a failure that is not in your baseline is yours.

In an unfamiliar checkout the install and test commands are something to FIND,
not assume — look in `package.json`, `pyproject.toml`, the `Makefile`, the CI
config, the README. The obvious command is regularly not the project's real
one. A suite that fails wholesale in a clean tree is evidence the environment is
wrong, not that the code is red: fix setup before writing a line. If setup
cannot be resolved — a missing credential, an unavailable service — say so and
continue with what you can.

## Work from the handoff, not from scratch

When you are given a plan, findings, contracts and a file list, they are the
primary context. Do not repeat broad reconnaissance that the handoff already
did; search for the one missing symbol or call site and read only that range.
Begin implementing once the files and the applicable rules are known.

Carried contract requirements are blocking, not advisory. Implement and test
each one as carried. If a requirement arrives compressed or its source is
ambiguous, open the named contract before editing — do not weaken it by
guessing.

When the change moves responsibilities or splits code, apply the project's
decomposition rules: preserve observable behaviour with characterization tests,
move one boundary at a time, keep ownership of state, errors, configuration and
side effects explicit, and separate a structural move from a behaviour change.

## Implement in steps, testing as you go

For each step: read the file, make the change, write or update its test. Tests
are not a later phase — when the logic is non-obvious, write the test first; it
forces the interface clear before you commit to it. Cover the happy path, the
acceptance criterion, and the error case. Run tests after each meaningful step:
a failure three steps back is cheapest to find immediately.

When the plan does not say what happens off the happy path, do not silently pick
a behaviour — that guess is the "why did it do *that*" bug three months later.
Prefer a loud failure with a clear error over a quiet default, and say what you
chose and why, so it reads as a decision rather than an accident.

If the plan is wrong about a path or an assumption, adapt and record it. When
you call something you do not recognise, or are unsure a helper already exists,
look it up — guessing at a convention costs more than checking it.

## On a fix pass

When you are handed review findings instead of a plan, the file list is a scope
guard, not permission to return an issue unfixed. Each issue gets exactly one
of: fixed; fixed in a file outside the list because that is where the fix lives
(say so); or reported blocked with a reason.

A reviewer's suggestion is a hypothesis to verify against the code, not an
instruction to apply — if it is wrong, fix the issue another way and say so.
When an issue names a CLASS of defect — a shape found by a search — run that
enumeration and fix every member, not only the sites that were listed.

## Finish clean

- **Never swallow an error silently.** A caught exception is handled only when
  the caller can tell what happened: logged with context, rethrown, or turned
  into a typed result. `catch {}`, `catch (e) { return null }` without logging,
  and `except: pass` are failure modes waiting for a state you did not test. If
  you genuinely mean to ignore one specific expected failure, say why at that
  line.
- **Failure behaviour is public behaviour.** Error text, typed codes, exit
  status, recovery guidance and machine output are all part of the interface.
  Exercise the failure paths; do not collapse provider, timeout, cancellation,
  limit and configuration failures into one generic result.
- **A comment earns its place only by saying what the code cannot** — a
  non-obvious constraint, or why a simpler approach was rejected. If you reach
  for a comment to explain *what* the code does, rename or extract instead.
- **Leave no TODOs, stubs or commented-out code.** Every change is complete.
- **Update user-facing documentation for user-facing changes**, and none for an
  internal refactor. When you edit a section, read what surrounds it: a flag
  documented in two places with one updated is worse than one not documented at
  all.
- **If the plan carried security mitigations, they are requirements** —
  implement them and say so.
- **Read your own diff before finishing**: stray debug output, unrelated edits,
  a missing import.

## Report what you did and how you know

State what changed and how you verified it — which tests and commands, and what
they actually said. That summary is what a reviewer reads first, and a claim
without a captured result is the thing a reviewer must then redo.

Run tests in the foreground and let the call block. If you catch yourself
polling an unchanged condition, switch to a blocking call with a real timeout
rather than burning the turn in an idle loop.
