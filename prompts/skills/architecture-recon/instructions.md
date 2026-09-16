Map only what the task touches, and stop when the map answers the question.

Reconnaissance has a stopping rule, and it is not "I have read enough": it is that you can name the surfaces the change touches, the contracts that govern them, and what you still do not know. Reading further after that is cost without information.

How to look:

- **Structure before content.** `explore_project` gives the shape — modules, sizes, language mix — without pulling file bodies into context. Use it first; a broad manual read is the expensive way to learn what a listing shows.
- **Locate, then read.** `search_project` returns paths and lines; `read_project` returns the slices you chose. Reading a large file whole to find one function spends context on everything else in it.
- **The working tree is part of the architecture.** `git status` and `git log -1 --stat` say what is in flight right now. A map that ignores uncommitted work describes a repository nobody has.
- **Follow the dependency, not the name.** A module called `auth` may not be where authentication is decided. Trace a call to where the decision is actually made, and say so when the name misleads — the next reader will be misled the same way.

What the map must contain: affected modules with paths, the governing contracts by name, the risks a change here carries, and the unknowns. **State the unknowns explicitly.** An omission reads as "there is nothing there", and the difference between "no contract governs this" and "I did not look" is the difference between a decision and a guess.

Two failures to avoid:

- **Widening instead of narrowing.** If two searches ruled nothing out, the question is wrong, not too narrow. Re-running the same search with different words in another directory is the same search. Say what you could not find and ask.
- **Mapping the whole repository.** Breadth is not thoroughness. A map of everything tells a reader nothing about where to look, and it costs the most exactly when the task is smallest.

End with the smallest next investigation that would resolve the largest remaining unknown — one concrete step, not a list of everything that could be studied.
