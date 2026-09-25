# Architecture whole-document audit

Audit date: 2026-09-25. Audit base: version 0.181.70, commit
`f6a8321` (`f6a832118c3d5caafbb0d0017090783598c835c8`) -- the tree whose
`docs/ARCHITECTURE.md` was exactly as the readability gate reported it. Two
audit rounds carry the executed evidence; this record relays their verdicts and
does not re-audit anything. Round one: `.ad-coder/tmp/pr13-drift.txt`. Round
two: `.ad-coder/tmp/pr13b-drift.txt`, read-only, ran after round one's closeout,
its twelve settled claims taken as given, and re-verified drift items 1, 2 and
4 directly ("they hold as drift", round two). Both rounds also carried the
orchestrator's own verification, used here for three kinds of fact the drift
reports do not state: the threshold arithmetic and the word counts (this
record ran the gate's own computation on f6a8321's blob and on today's file),
and the new wording of the four fixes (quoted from today's file); the
handover commit `5438713` on this branch is where the four fixes and the
audit's rewrite were first preserved. Both rounds cut off at the
closeout reserve before the rewrite landed; each leaves its own residual list,
carried verbatim below. Line numbers cited without a file prefix are the
rounds' citations into the tree at the audit base; the rewritten line numbers
quoted in "The four fixes" are today's file.

## What "whole-document audit" means here

The rule is `docs/contracts/documentation.md`, Verification section: "Re-read a
canonical document as a whole when the readability gate reports it near its
budget. A diff-only review does not replace a whole-document audit."

The trigger is mechanical and is what activated the rule. `scripts/check-docs.ts`
counts the document as `content.trim().split(/\s+/).length` and prints
"(whole-document audit due)" when that count reaches
`warningAt = floor(maxArchitectureWords * architectureWarningRatio)`;
`docs/readability.json` sets `maxArchitectureWords: 2000` and
`architectureWarningRatio: 0.8`, so **the warning threshold is 1600 words**
(floor of 1600.0). At the audit base the document counted 1995. The gate's
original output, captured by round two while the document still read as found:

```
documentation readability valid: architecture 1995 words (whole-document audit due)
```

The count is reproduced from the base blob itself (1995 by the gate's own
computation), so the trigger is arithmetic, not memory. The gate's hard limit --
"has 2000 words; limit is 2000", a thrown failure -- was never in play: 1995 is
five words under the limit, so this was the warning's whole-document read, not
a limit repair. The task the audit had to leave behind is a document under the
1600-word threshold, so that the gate's pass line is warning-free.

The audit then read the document end to end, claim by claim, against the
current code, fixing only what the evidence contradicted and compressing the
rest.

## Drift list -- the document said this, the code says otherwise

Verified by the named round only; round one numbers are round one's.

| # | Claim in the document | Verdict | Evidence | Round |
| --- | --- | --- | --- | --- |
| 1 | "Closeout reserves 30 seconds, 4 turns, 8 tool turns, 100,000 input tokens by default" | **NOW FALSE** | `DEFAULT_STAGE_LIMITS` at `src/cli/resolve-config.ts:112-122` is 90s / 12 model turns / 24 tool turns / 300k input tokens (changed at 0.62.0, commit d4407b2). The old 8/8/100,000 numbers survive only as the reviewer role override (`resolve-config.ts:185-191`) -- likely the sentence's origin. | round 1, direct re-check by round 2 |
| 2 | Pipeline graph `plan -> research? -> security? -> code -> review` | **DRIFTED** | `WorkflowPhase` (`src/orchestration/types.ts:836`) includes a conditional `gates` phase between code and review, shipped by default with seven project gates (`src/gates/project-gates.ts:30`, wired unconditionally at `resolve-config.ts:1489`); a red gate returns to the coder, never reaching review (`types.ts:830-833`, `session.ts:1575`). | round 1, direct re-check by round 2 |
| 3 | "missing standards pause before code" | **LIKELY STALE, deleted** | No match for "missing standards" anywhere in `src/` or the contracts. Plan validation actually pauses via `plan_not_submitted` / `plan_not_json` (`run-coordinator.ts:1046-1056`); contract IDs must exist in `CONTRACT_INDEX` (`plan.ts:205-218`). Round 2 adds: unknown contract IDs pause as `requirements_unresolved` in research (`session.ts:1095-1105`). | round 1 (verdict), round 2 (what actually pauses) |
| 4 | "Metrics separate system-prompt, handoff, and tool-definition bytes" | **DRIFTED (wording)** | The categories are systemPrompt / prompt / toolDefinitions (`src/runner/runner.ts:215-220`, summed at `session.ts:832-837`); "handoff" names nothing in the metrics. | round 1, direct re-check by round 2 |

No further drift items were raised: every other claim at least one round
verified held.

## Claims the rounds verified as HOLDING (summary)

Round one's twelve settled rows, with the file:line its verdict cites:

| Claim | Verdict | Evidence |
| --- | --- | --- |
| Stage-limit precedence: built-in global, built-in role, caller global, caller role; zero disables | HOLDS | `resolve-config.ts:585-597`; `stage-limits.ts:193` |
| Incremental reviewer context: bounded untracked UTF-8 projection, credential redaction before the role | HOLDS | `appendSafeUntrackedDiffProjection` (`runner.ts:488-565`), `redactDiffText`/`DIFF_REDACTED_LINE` (`runner.ts:381-384`) |
| `research_rejected` leaves run ID + numeric metrics, never raw provider content | HOLDS | `run-coordinator.ts:1063-1088`; secret guard + digest-only persistence at `session.ts:1199-1224` |
| Standalone `role`: submissions removed (reviewer keeps verdict), SIGINT/TERM -> `interrupted`, `starting` before session creation, ownership-verified resume, raised-limit resume | HOLDS | `cli.ts:3382-3390` and `3374-3378`, `cli.ts:3423-3430` with pause code `interrupted` (`763-769`), `starting` doc (`727-731`), `cmdlineWitness` ownership check (`826-830`), `assertRaisedLimits` + unchanged-ceiling refusal (`orchestrator.ts:300-345`) |
| `explore_project` bounded, Git-ignore-aware, no file contents, safe failures | HOLDS | `project-tools/explore.ts:46` (`ls-files --exclude-standard`, maxFiles/maxDepth ceilings, typed safe causes at `225-241`) |
| Tool activity: schema-v1, bounded replay/queues, drop counts, NDJSON on stderr, grouping | HOLDS | `observability/tool-activity.ts:96,121,144-173`; `cli/tool-activity.ts:125-143,351-357` |
| System map paths, models.yaml routing, #513 JSON-inventory retirement, calibration row | HOLDS | named dirs exist; `--inventory` refused by name (`cli.ts:2152-2162`); snapshot matching `resolve-config.ts:918-937`; `useProjectCalibration` switch (`resolve-config.ts:311,927`) |
| RunCoordinator: digest-bound checkpoints, `stage_limit` checkpointed before return | HOLDS | `run-coordinator.ts:691-697`, `625`, `950` |

Round two additionally settled, with its own citations (its six grouped rows,
unfolded here one per line):

| Claim | Verdict | Evidence |
| --- | --- | --- |
| Credentials from configured store or explicit env accessor, never the target's config | HOLDS | `cli.ts:474-485`, `credentialEnvForTarget` `cli.ts:459-471` -- never `<targetDir>/.env` |
| Env-accessor disable inside targetDir, because Bun's startup dotenv destroys provenance | HOLDS | `src/auth/environment-boundary.ts:28-54` (snapshot before target code mutates env; lookups denied whenever cwd is inside targetDir; warn text matches live sessions) |
| Credential paths outside target/Git metadata, 0o600, atomic temp+rename, no symlink follow | HOLDS | `src/auth/credential-store.ts:13,84-107,296,309-345,484`; O_NOFOLLOW + descriptor re-check; gitdir-worktree coverage `98-107` |
| Publication preflight/protected bases/dirty fail closed, squash merge | HOLDS | `src/project-operations/repository-publishing.ts:43,53,63,178-181,229-238` (the repo's only "squash" site); the "CI gates" clause inside that sentence NOT traced -- residual below |
| Frozen, script-disabled dev install + `bun link` | HOLDS | `src/update/updater.ts:261,215,268` |
| Updater accepts clean tracking checkout, then ff-only, frozen-install, relink | HOLDS | `updater.ts:191-257`: not_checkout, executable-root check, dirty_checkout, detached_head, missing_upstream, `git pull --ff-only` |
| Orchestrator tool surface incl. conditional pipeline module, `--workflows`, pre-read `complexity`, `decompose_task` Planner-alone | HOLDS | `orchestrator.ts:113-124,2102,2173,1488,699,411-418`; `src/workflows/builtin-pipeline.ts:8-16`; `cli.ts:2648-2680` (default ON, comma selects, `^name` excludes, `false`/`off` disables) |
| Web/`inspect_image`: DNS + peer-address re-validation on every redirect, `private_network_denied`, trusted-override default off, bounded limits; pixels to a capable model or one bounded vision call with anti-injection systemPrompt | HOLDS | `src/web/tools.ts:44,150-192,254-279,647-700` |
| Optional-deadline durable waits (resolved by 0.181.70), `version_conflict` CAS, SO_PEERCRED peer-uid | HOLDS | `wait-service.ts:240,383,402`; `project-store.ts:402-412,442`; `src/session-manager/peer-credentials.ts:2-29` |
| Background runs: owner-scoped, lease liveness, bounded content-free tail hints, status/events/result/cancel methods | HOLDS | `background-runs.ts:77,627,716,1155,410,746,749,755,765` (the exact "resume" method name unconfirmed -- residual below) |
| Context ceiling `min(maxTokens, contextWindow)`, cross-provider opt-in, widening triggers exactly as documented | HOLDS | `src/context/preflight.ts:36,45,78`; `compactor.ts:225`; `session.ts:155-168,1449-1470` (projection_failure / projection_redacted / path_list_truncated / scope_drift / risk_changed / material_diff / insufficient_evidence) |
| Layered `Models` wrapper order applied-last-entered-first, digest-only admission scope, missing trustworthy usage = `cost_unknown` terminal reason | HOLDS | `runner.ts:691-728`; `src/provider-admission.ts:75,134`; `src/session-limits.ts:122-133` (code word is `cost_unknown`, not "poison"; document keeps prose) |

Round one's remaining table rows (pipeline, subsystems, "rules easy to break"
stems) produced no drift and are compressed here; the six rules survived both
rounds as policy statements with nothing contradicting them.

## The four fixes, and what the document states now

All four landed in the rewrite (the file as delivered with this record, at
1589 words):

| Fix | What the document states now (with today's line) |
| --- | --- |
| #1 closeout reserves | Names the constant instead of quoting rotting numbers: "closeout reserves per stage (time, model-turn, tool-turn, input-token) come from `DEFAULT_STAGE_LIMITS` in `src/cli/resolve-config.ts`, overridable by flags (zero disables each)" (`docs/ARCHITECTURE.md:170-172`). |
| #2 pipeline graph | The diagram reads `plan -> research? -> security? -> code -> gates? -> review` with rework returning to the coder (`docs/ARCHITECTURE.md:60-65`); the prose states the `gates` stage "ships by default with seven declared project gates, existing only when configured; a red gate returns captured output to the coder, never review" (`docs/ARCHITECTURE.md:70-74`). |
| #3 "missing standards" | The sentence is deleted. What remains on that seam is the mechanism that actually exists: the Planner derives allowed IDs from validation's `CONTRACT_INDEX` (`docs/ARCHITECTURE.md:124`). |
| #4 metrics wording | "metrics separate systemPrompt/prompt/toolDefinitions request bytes" (`docs/ARCHITECTURE.md:53-54`). |

## Word count, before and after

- Before (`f6a8321`'s `docs/ARCHITECTURE.md`): **1995** words -- above the
  1600-word warning threshold, printing "(whole-document audit due)".
- After (the current file, verified today): **1589** words -- below the
  threshold; the gate now passes without the warning. The limit (2000) was
  never breached on either side of this change.
- Measured with the gate's own count
  (`architecture.trim().split(/\s+/).length`), not any other counter.

## Residuals neither round verified (carried verbatim, not dropped)

From round one's unverified list, the items round two did NOT subsequently
settle, in round two's own closing words:

- Retry-policy "zero interval disables timers" (`src/runner/errors.ts:116`
  nearby only); "structured provider-limit errors pause the durable control
  plane before another dispatch" line.
- Publication "CI gates" and "isolated staging" clauses.
- Artifact-smoke specifics (`scripts/artifact-smoke.ts` exists, unread).
- Background-run `resume` method name and page-field list.
- Auto-mode "harness cuts the branch, ad-coder supplies the summary" internals.

The six "rules easy to break" items are policy statements; none contradicted
by anything found -- the document keeps all six, unmarked. A reader treating
one as load-bearing evidence should first verify it; none of the two rounds
claims any of them code-verified.

Round one's residuals that round two CLOSED by evidence (recorded here so the
carry-over does not re-open them silently): the entire Credentials section;
Publication/Updater beyond the "CI gates" clause; the orchestrator tool
surface; durable waits, CAS versions, session-manager socket + peer-uid;
background-run leases and tail hints minus the "resume" method name; context
policy; review-handoff widening triggers; layered `Models` wrapper order and
admission scope hashing; web/`inspect_image` network validation minus the
`web_read` normalized-links detail.

Round one's residual that round two closed differently: `web_read` "preserves
normalized links" -- round two confirmed the bounded/private-denied half
(`web/tools.ts:516`, tool description) and left the normalized-links detail
unverified (the residual above states the same clause, narrowed by round two's
evidence).

## Next audit due

The next whole-document audit falls due the next time `bun run check:docs`
prints "(whole-document audit due)" -- that is, when the document again reaches
**1600 words** by the gate's count (11 words of headroom above today's 1589).
This rewrite deliberately targets a margin under the threshold so ordinary doc
churn does not retrigger immediately; any change that adds more than ~10 words
should either audit as it lands or expect to re-trigger. Earlier than that: on
any structural re-arrangement of the document, or when a landed change touches
more than one subsystem paragraph. No calendar due date applies -- the gate's
count, not the clock, is what re-arms the rule.
