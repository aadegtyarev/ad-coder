# Incremental pipeline context dogfood

**Date:** 2026-09-13  
**Pipeline verdict:** CHANGES REQUESTED  
**Post-pipeline remediation:** APPROVED by independent focused re-review

The native pipeline implemented the first incremental-context cut and exercised a
real two-round Coder/Reviewer loop. Its second Reviewer correctly rejected the
cut because the risk-change trigger was unreachable, focused handoffs lacked a
bounded patch projection, behavior coverage was too narrow, and the worker could
not find `bun` on PATH. The run checkpoint is
`.codex/ldo/runs/20260913051815920-implement-the-roadmap-backlog-incrementa-899e32.json`;
Recorder wrote five findings to `docs/BACKLOG.md` before local remediation.

## Measured run

| Stage | Input | Cached input | Output | Total |
|---|---:|---:|---:|---:|
| Planner | 230,553 | 174,720 | 7,363 | 237,916 |
| Security | 49,289 | 23,936 | 1,903 | 51,192 |
| Coder 1 | 1,575,414 | 1,452,032 | 11,261 | 1,586,675 |
| Reviewer 1 | 263,909 | 207,616 | 4,184 | 268,093 |
| Coder fix 1 | 600,305 | 542,592 | 5,802 | 606,107 |
| Reviewer 2 | 225,275 | 167,936 | 4,954 | 230,229 |
| Recorder | 153,876 | 126,464 | 1,649 | 155,525 |
| **Total** | **3,098,621** | **2,695,296** | **37,116** | **3,135,737** |

Reviewer 2 used 14.6% fewer input tokens than Reviewer 1, but this run is not a
like-for-like before/after experiment and does not prove the target savings. It
does prove that Coder dominates current cost and that the LDO frontend exposes
only role boundaries while a worker is active. The attempted `codex-terra`
override also failed before dispatch because that legacy name is unsupported by
the current ChatGPT Codex runtime.

## Remediation and verification

The follow-up added a fixed-argv, byte-bounded UTF-8 diff projection, whole-line
redaction for credential-like additions, full-context fallback for sensitive or
untracked files, a reachable changed-risk fingerprint based on risk-bearing
paths, and prompt/config/report integration coverage. Raw diff text is used only
for the immediate handoff; durable state retains bounded paths, counts, sizes,
redaction count, and SHA-256 digest.

Commands used the repository's working launcher, `npm exec --offline -- bun`:

- focused suites: 125 passed, 0 failed;
- full suite: 410 passed, 0 failed, 2,035 assertions;
- `bun run typecheck`, `bun run check`, `bun run check:release`, and
  `bun run check:docs`: passed;
- `bun run smoke:artifact`: passed.

The earlier `bun: command not found` was a worker-environment/PATH issue, not a
missing project dependency. Comparable A/B dogfood remains required before
claiming the broader optimization complete.

The first independent re-review then found that hunk context could expose an
unchanged credential, staged-only changes were absent from the projected patch,
the mandatory defaults were separate scalar exports, and the architecture
readability warning required a whole-document audit. The follow-up now redacts
every non-header credential-like diff line, projects the combined `HEAD` index
and worktree delta, exports one typed defaults object, and covers staged-only and
unchanged-context-secret cases.

The required cold-reader audit read `docs/ARCHITECTURE.md` end to end. Its system
map, execution paths, trust boundaries, configuration, recovery, and publication
order remain coherent; workflow and pipeline terminology is consistent. The
audit repaired one run-on line in persistent-state documentation and clarified
that focused handoffs carry a bounded redacted diff while checkpoints retain
only metadata and its digest.

The final focused re-review approved all four remediations in about 44 seconds.
It used 144,553 input tokens (97,536 cached) and 1,780 output tokens. The preceding
broad independent review used 355,514 input tokens (297,984 cached) and 3,583
output tokens, so the focused pass used 59.3% fewer input tokens. These reviews
had different scopes, so the result supports the mechanism but is not the
like-for-like A/B evidence still tracked in the backlog.

A final native `drive --auto` run then verified live Search/Read/Run/Tool events
and 10-second heartbeats across Planner, Coder, and Reviewer. It exposed two more
issues. First, Reviewer instructions named surface IDs but omitted their exact
required contract IDs, causing repeated `malformed_verdict` submissions for a
documentation surface; the instruction and model-visible safe diagnostics now
carry the exact mapping and have a tool-level corrected-retry regression test.
Second, a Coder tool-turn pause wrote
a `coordinator-<id>.json` checkpoint but the advertised `operations
control-resume` path looked for `control-<id>.json`; the missing matching CLI
resume path remains explicitly tracked in `docs/BACKLOG.md`.

Using `codex-terra` for the second native Planner produced a correct medium plan
in 83.2 seconds for $0.14172920, with 39,345 fresh and 96,256 cached input tokens.
The earlier Sol Planner took about 140 seconds and cost $0.47316300 on the smaller
documentation-only task. The tasks differ, so this is operational evidence for
model routing rather than a controlled A/B result.
