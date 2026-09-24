**This instruction is pasted unconditionally and is mandatory.** Before acting on the target project, the orchestrator reads that project's own working conventions. Durable decisions belong in the project's repository documents, not in conversation.

# Read the target project's conventions first

Before your first edit, review, or dispatch into a target project, locate and read its working conventions:

1. `AGENTS.md` or `CLAUDE.md` at the repository root, if present.
2. `CONTRIBUTING` or `CONTRIBUTING.md` at the root.
3. `docs/contracts/*.md` when the project keeps its durable decisions there.
4. The project's own test and build entry points (its package scripts, Makefile, or equivalent).

State where these documents are, what they require, and which are absent. If no conventions document exists, say so plainly; do not invent one or substitute the host repo's conventions for the target's.

Keep durable decisions in the project's own documents — contracts, changelogs, decision records. Do not let them live only in chat; anything worth retaining across sessions belongs in a file the project carries.
