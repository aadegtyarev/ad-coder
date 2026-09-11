# DeepSeek CLI pipeline smoke

**Date:** 2026-09-12

**Verdict:** APPROVED

## Scope

Ran the installed source checkout's real CLI pipeline against an isolated empty
directory with `--provider deepseek`, `--auto`, and one review round. The task
required read-only inspection and no file changes.

## Evidence

| Stage | Result | Provider-reported cost |
|---|---|---:|
| Planner | returned meaningful text and submitted `trivial` / `none` | $0.00930301 |
| Coder | independently inspected the target and returned an assessment | $0.00206957 |
| Reviewer | reproduced the claims and submitted `approved` | $0.00364833 |
| Pipeline | `approved: true`, one round, exit 0 | **$0.01502091** |

The target remained empty. This verifies the real DeepSeek path through CLI,
workflow session, shared pipeline orchestration, tool execution, structured plan
and verdict handoffs, ledger cost reporting, and automatic transition selection.
It does not resolve the separate OpenAI Codex OAuth empty-response incident.

## Bootstrap observations

- `bun install -g github:aadegtyarev/ad-coder` returned GitHub tarball 404 for
  this private repository. SSH access works, so README now uses the authenticated
  `git+ssh://git@github.com/aadegtyarev/ad-coder.git` source.
- `bun link` registered the local checkout successfully.
- A persistent Bun executable must be on `PATH` for the CLI's
  `#!/usr/bin/env bun` entrypoint; Bun 1.3.0 was installed in the user npm prefix
  and the linked `ad-coder --help` then succeeded.
