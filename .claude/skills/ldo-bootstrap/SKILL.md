---
name: ldo-bootstrap
description: Turn a rough project idea into a researched blueprint — prior art, stack choice, phased roadmap. Interactive: ask, decide together, then hand the first task to /ldo.
---

Turn a rough idea into a blueprint concrete enough to start building from.

Unlike the LDO pipeline, this is a **conversation**. Stack choices are decisions the operator owns — you research and recommend, they decide. Ask when it matters, then converge.

## When to use

At the start of a project, before there is a codebase to plan against. Once the stack is settled and Phase 0 is named, hand off: `/ldo "<the first task>"`.

## Process

### 1. Pin down the idea

Separate the *problem* from the *proposed solution*. "A CLI to track my reading" is a solution; "I lose track of half-finished books across three devices" is the problem — and it may have a better solution.

Establish:
- What problem, for whom?
- What is the smallest version that solves it?
- What constraints are implied — platform, scale, offline, real-time, regulatory?

**Ask when the answer changes the stack.** Single-user or multi-tenant, self-hosted or operated, terminal or browser — these branch everything downstream. Don't ask about things you can reasonably assume; do ask about the two or three that actually fork the decision.

### 2. Look for prior art

Search for what exists — 3-5 open-source projects, 2-3 commercial products. For each: what it does well, where it falls short of this idea.

Two outcomes matter, and both are useful:

- **Something already does this well.** Say so plainly. Recommending "use X instead" saves more than any blueprint.
- **The gap is real.** Now you know exactly what this must do that the alternatives don't — and that defines the MVP.

Note libraries that solve large chunks. Building on one beats building from scratch.

For a crowded or fast-moving space, consider `/deep-research "<the question>"` — it fans out across several search angles, has independent agents vote on each claim, and adversarially verifies before reporting. Slower and more expensive than a normal search pass, but worth it when the landscape is genuinely unclear or the decision is expensive to reverse.

### 3. Choose a stack — together

Pick the boring option unless something rules it out. Present each choice with a one-line rationale and the alternative you rejected, then let the operator push back.

What actually drives it:
- **Ecosystem fit** — mature libraries for this domain?
- **Deployment target** — a CLI users install has different constraints than a service you operate.
- **Operational weight** — Postgres is right for relational data at scale, wrong for a single-user desktop tool that could use SQLite.
- **Team reality** — a stack nobody can maintain is the wrong stack regardless of merit.

Don't pick a framework the idea doesn't need. A TUI doesn't need React; a five-endpoint API doesn't need Kubernetes.

### 4. Phase the roadmap

- **Phase 0 — Scaffold**: repo, dependencies, one passing test, one command that runs something. Must fit in a single working session.
- **Phase 1 — Core**: the one thing that makes this useful. Nothing else.
- **Phase 2 — Essential**: what Phase 1 needs to survive real use — persistence, error handling, auth if applicable.
- **Phase 3 — Polish**: UX, docs, onboarding.
- **Later**: everything you were tempted to put in Phase 1.

Deliverables must be concrete. "Set up authentication" is a wish; "email + password login with bcrypt, session cookie, /login and /logout routes" is a deliverable.

### 5. Hand off

Name the first task specifically enough to plan against — one Phase 0 deliverable, not the whole phase. Then:

```
/ldo "scaffold the Go module with Bubble Tea, rendering an empty list view that exits on q, with one test asserting the model initialises"
```

## Recommend the right plugins

Once the stack is known, point the operator at what already exists — no reason to rebuild it:

| If the project has | Suggest |
|---|---|
| A web frontend | `frontend-design` (Anthropic's — aesthetic direction, avoids the standard AI-design clichés) |
| Browser-visible behaviour to verify | `chrome-devtools-mcp` for visual checks, or `playwright-mcp` for cross-browser E2E |
| A design system in React | `/design-sync` to ground generated designs in the real components |
| Anything touching auth, secrets, or user input | `security-guidance` — reviews every edit, turn, and commit for vulnerabilities |
| A typed language | The matching LSP plugin (`typescript-lsp`, `gopls-lsp`, `rust-analyzer-lsp`, …) |

Install with `/plugin install <name>@claude-plugins-official`, or declare them in `.claude/settings.json` under `enabledPlugins` so teammates get prompted automatically.

TUI and console-UI projects have no equivalent plugin — that ground is currently unclaimed.

## Rules

- Ask about what forks the decision. Assume the rest and say what you assumed.
- Cap research at 3-5 open-source and 2-3 commercial findings. Enough to see the landscape, not a survey.
- Every stack choice needs a rejected alternative. If there wasn't one, you didn't choose.
- Phase 0 must be completable in one session. If it isn't, it's Phase 1.
- If an existing tool already solves this, say so. That's a finding, not a failure.
- Never cite a URL you didn't actually fetch.
