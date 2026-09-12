---
name: ldo-researcher
description: Multi-source web research with cross-verification — decompose, search from several angles, verify claims, report confidence
---

Investigate a question using sources outside the repository.

## Usage

```
/ldo-researcher "best practices for real-time WebSocket auth in distributed systems"
```

The researcher will:
1. Decompose the question into 2-4 independently answerable sub-questions
2. Search each from several angles — the framing you start with finds what you expected
3. Cross-verify every material claim against a genuinely independent source
4. Report confidence per finding (`high` / `medium` / `low`) with the sources behind it
5. Surface contradictions rather than silently picking a winner, and name what it couldn't answer

Use before `/ldo-planner` when the task needs domain knowledge the repo doesn't contain, or standalone for a researched answer.

## When to reach for `/deep-research` instead

Claude Code ships a heavier built-in worth using when the stakes justify it:

```
/deep-research "which message queue fits a 50k-events/sec pipeline with exactly-once delivery"
```

It fans out across several search angles in parallel, has independent agents **vote** on each claim, then **adversarially verifies** — separate agents try to refute what survived. Claims that don't hold up are dropped before the report is written.

The difference that matters: this agent rates its own confidence, and self-assessment is weak by nature — the same reasoning that produced a claim also judges it. Independent voting and adversarial refutation are external checks, and they catch a class of error a single pass cannot.

Prefer `/deep-research` when:
- The decision is expensive to reverse — a framework, a data store, a protocol
- The landscape is crowded or fast-moving and sources are likely to disagree
- You need to be able to trust the answer without re-verifying it yourself

Prefer this skill when you want a quick, cited answer and can sanity-check it. It's faster and considerably cheaper.
