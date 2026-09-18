**This instruction is mandatory.** Where this skill's description matches the work in front of you, the method below is required: an approach that contradicts it is a defect to fix, not a preference to keep.

Map only what the task touches, and stop when the map answers the question.

Reconnaissance has a stopping rule, and it is not "I have read enough": it is that you can name the surfaces the change touches, the contracts that govern them, and what you still do not know. Reading further after that is cost without information.

How to look:

- **Structure before content.** `explore_project` gives the shape — modules, sizes, language mix — without pulling file bodies into context. Use it first; a broad manual read is the expensive way to learn what a listing shows.
- **Locate, then read.** `search_project` returns paths and lines; `read_project` returns the slices you chose. Reading a large file whole to find one function spends context on everything else in it.
- **The working tree is part of the architecture.** `git status` and `git log -1 --stat` say what is in flight right now. A map that ignores uncommitted work describes a repository nobody has.
- **Follow the dependency, not the name.** A module called `auth` may not be where authentication is decided. Trace a call to where the decision is actually made, and say so when the name misleads — the next reader will be misled the same way.

What the map must contain: affected modules with paths, the governing contracts by name, the risks a change here carries, and the unknowns. **State the unknowns explicitly.** An omission reads as "there is nothing there", and the difference between "no contract governs this" and "I did not look" is the difference between a decision and a guess.

- **Before adding a mechanism, look at what already arrives where you would add
  it.** Print the actual value — the prompt a stage receives, the record a
  reader gets, the argv a process is launched with — rather than reasoning from
  the code that should produce it. This is how you discover that the channel you
  were about to build already exists and carries something, which is a different
  fix from the one you were planning. A worked example: a session set out to
  pass read paths between pipeline stages, printed the prompt the second coder
  round actually received, and found the handoff already there — so the defect
  was never a missing channel, and the change it was about to write would have
  been a second path beside a working one.
- **A green test proves your code does what you wrote, not that it was needed.**
  A new test passing beside an existing mechanism looks identical to a new test
  passing because the mechanism is new. Check that the behaviour was absent
  before you added it.
- **Somebody has met this format before you.** Anything involving a third-party
  tool, protocol or wire format has almost certainly been handled elsewhere —
  in a library, in the framework you already depend on, or in the tracker you
  are about to file into. Look before building, and look inside the repository
  too: a duplicate issue is the same failure as a duplicate implementation. The
  outcome may well be "write our own" — reading someone else's first is what
  makes that a decision rather than an assumption, and their edge cases are
  worth having even when their code is not.

Two failures to avoid:

- **Widening instead of narrowing.** If two searches ruled nothing out, the question is wrong, not too narrow. Re-running the same search with different words in another directory is the same search. Say what you could not find and ask.
- **Mapping the whole repository.** Breadth is not thoroughness. A map of everything tells a reader nothing about where to look, and it costs the most exactly when the task is smallest.

End with the smallest next investigation that would resolve the largest remaining unknown — one concrete step, not a list of everything that could be studied.
