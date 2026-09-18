The tracker is where this project's work is decided, claimed and closed. Being
readable there is most of what makes a second developer possible. Everything
below is identifiers and evidence — state, numbers, paths, run ids — never
credentials, prompts, file contents or provider payloads.

## Before you file: search

Search first, closed issues included: `gh issue list --state all --search
"<words>"`. A closed issue often records that the idea was considered and
rejected with its reason, which is worth more than an open duplicate costs. A
duplicate filed from memory is how the same ground gets re-argued twice.

A filed issue carries the observation **with its measurement** — numbers,
paths, counts, run ids — then why it matters, then what would fix it. "X is
broken" is not work anyone can pick up. "X did Y at 12:22; 438k input tokens on
a 540s ceiling; run `1c2ed7d7`" is.

**Correct the record in place.** When a measurement turns out to have accused the
wrong layer — a flake blamed on GC that was really a threshold below what healthy
code measures, a reviewer blamed for a provider that mangled its tool call —
post the correction on the same issue rather than leaving the wrong conclusion as
its newest word. The next reader acts on whatever is newest.

## Before you work: claim it

An unclaimed ticket is ambiguous, and two developers can spend the same
afternoon on it. Before your first edit or dispatch on an issue:

1. assign it — `gh issue edit <n> --add-assignee @me`;
2. label it `in-progress` — `gh issue edit <n> --add-label in-progress`;
3. comment once: who is doing it, and the run id once a run owns it.

And in the other direction: **read the assignee and the labels before you pick
anything up.** An issue already assigned or labelled `in-progress` belongs to
someone else until they release it; ask rather than start. A ticket whose work
you abandon goes back to unclaimed rather than sitting claimed.

**Labels are the tracker's vocabulary, and grouping is part of it.**
`in-progress` is status. `epic` groups a theme, `priority:*` orders it,
`bug`/`enhancement`/`documentation` say what kind of work it is. A set of
tickets carrying one label reads as one piece of work; use them when you file,
and keep them true while you work.

## Pull requests are tracker work too

A PR body carries the argument for the change and the evidence behind it: what
changed and why, the gates actually run with their captured output, the
delivery stamp generated from the ledger — never composed — and the signature
naming the run and the models per stage (`docs/contracts/product-change.md`).
A body that says "fixes #N" and nothing else leaves the reviewer to
reconstruct what they are approving.

- Link the issue (`Fixes #N`) so closing happens with the merge, not by memory.
- Branch and pull request, never a direct commit to the default branch (issue
  #334).
- **Close the issue when the change lands.** `Fixes #N` closes it with the
  merge; when the link is missing, close it by hand the moment it merges. A
  board where merged work still reads as open is a board nobody trusts, and the
  second developer re-reads it to learn nothing.
- Close with evidence, and name what remains open instead of closing silently.
