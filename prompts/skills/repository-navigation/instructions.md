Ask the repository one question per call, and prefer the tool built for the question.

## Which tool answers what

- **State of the working tree** — `git status --short`, `git diff --stat`, `git diff -- <path>`. These answer "what changed here" completely and in one call. Hunting through history, session files or grep for a change that is sitting uncommitted is wasted motion.
- **Where something is** — `search_project`. It returns ranked `path:line`, bounded, without pulling file bodies into context.
- **What it says** — `read_project` for the slices you chose; `read` when you need the whole file.
- **Shape of the project** — `explore_project`. Structure and sizes without contents.
- **Everything else** — `bash`. Its own description says what it is for and what it is NOT for: the escape hatch for what no specialised tool covers. The failure that gives it that reputation is passing the narrow contract's look-small check: when a specialised tool's contract fits (read, write, edit, search), use it even when bash seems quicker, and say to yourself which one you are declining and why.

## Git, specifically

- **`git status` before archaeology.** When the operator refers to recent work — "the thing we touched", "that contract" — the answer is almost always uncommitted, in the last few commits, or in the branch's diff against its base. Look there first.
- **One commit, one call.** `git show <sha> --stat` gives the file list; `git show <sha> -- <path>` gives one file's change. Re-running the same `git show` through different `sed`/`head` windows to read it in pieces costs a call per ten lines and loses the thread between them.
- **Compare branches with a range, not a hunt.** `git log base..HEAD --oneline` and `git diff base...HEAD -- <path>` answer "what does this branch change" directly. `git log --all | grep` is a search for something you already know the name of.
- **`git log -S "<text>"`** finds the commit that introduced or removed a string — the right tool for "when did this appear", far cheaper than reading history forward.
- **Never resolve a conflict by picking a side.** Read both, decide what the file should say, and say why in the commit message. Two changelog sections added at the same anchor both belong; a version number does not — it resolves to the one the release requires.
- **Do not fetch or push to a remote you were not asked about**, and never rewrite published history to tidy something. A wrong remote is a change to someone else's repository.
- **A tree another writer is using is not yours to move.** A pipeline run, a background worker, another session or another developer may be mid-turn in this repository, and switching its branch, stashing in it or committing under them corrupts work in flight. Take your own worktree instead — `git worktree add <path> -b <branch> origin/main` — and leave the shared tree on the branch its owner left it on. A branch switch is a change to everyone at once.
- **Work lands through a branch and a pull request.** A direct commit to the default branch skips review, the gates and the release step in one move, and with a second developer it also silently rewrites the base they are branching from (issue #334).

## Reading

Read a file once. Drawing it through `sed -n '20,35p'`, then `40,70p`, then again with a different range costs one call per window and makes you reconstruct what you have already seen. If the file is genuinely large, `search_project` narrows to the lines worth reading.

Chaining unrelated commands with `;` to save a call rarely does: the outputs arrive interleaved under one exit status, a failure in the middle is invisible, and the usual next step is re-running the parts separately.

## Long commands

Run a long command in the foreground and let the call block: the harness
tolerates minutes-long tool calls and returns exactly when the command finishes,
which is the only completion signal you have. Backgrounding a job and then
`sleep`-polling for it guesses an interval, and a wrong guess costs either the
wait or a re-read of the whole conversation — usually spent waiting on something
that finished before the sleep was even issued.

## Stopping

Before a third search, state what the previous two ruled out. If the honest answer is "nothing", the task is ambiguous — ask rather than widen. Broadening a pattern, dropping a filter, moving to another directory and re-running the same grep with different words are one move, not three, and repeating it is how a turn spends minutes finding nothing.
