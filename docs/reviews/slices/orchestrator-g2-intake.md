# Slice audit: orchestrator guarantee `orchestrator.md:13` (g2-intake)
Audit base: ff07c9988923aeb4fa0b66106f3574103eb4b4cd, date 2026-09-24.
Rule text: "- Intake states the outcome, scope exclusions, mode, measured task shape,
  budget, ceilings, and any ambiguity that changes the result. It decomposes
  large tasks rather than requiring operator-supplied slices."

## Verdict
violating (partially, for the pipeline/orchestration intake surface): mode, task shape,
decomposition and ceilings are implemented and exercised by passing tests, but no intake
surface states the outcome, scope exclusions, budget or ambiguity that the rule requires;
silence on four named fields is a rule gap, not conformance. Surfaces examined:
`src/orchestration/{orchestrator,control-plane,pipeline,plan,decompose,follow-up}.ts`,
`src/orchestration/types.ts` (`Plan`, `PipelineResult`), the pipeline tool registrations,
and contract docs `orchestrator.md`, `work-decomposition.md`, `decomposition.md`,
`task-estimation.md` (grep only). Not examined: conversation-level intake
(`src/conversation/` prompts beyond grep), CLI drive surface (`src/cli/drive.ts`),
`src/orchestration/session.ts`, background-run intake text in full — all `unverified`.

## Checks executed
| Command | Result |
| --- | --- |
| `git rev-parse HEAD` | `ff07c9988923aeb4fa0b66106f3574103eb4b4cd` |
| `bun test test/decompose.test.ts` | 7 pass, 0 fail, 14 expect() calls, exit 0 (308ms) |
| `bun test test/orchestration.test.ts` | 110 pass, 0 fail, 593 expect() calls, exit 0 (6.97s) |
| `grep -rn "intake"; grep -rn "ambiguity"; grep -rn "budget" over intake code/contracts` | `ambiguity`: no hit in any `src/**/*.ts` naming an intake statement; `intake`: no identifier at all in `src/` |

Behaviour actually exercised: `test/decompose.test.ts` and `test/orchestration.test.ts`
cover the decomposition half of the rule — `deriveChildSpecs` child derivation,
`decomposition_required` outcomes, ceilings and follow-up handling — and pass. No test
in those files, and no code identifier anywhere in `src/` (grep returned no `intake`,
no intake ambiguity/budget field), was found that exercises the "states the outcome,
scope exclusions, budget, ambiguity" half; that half is therefore contradicted by
absence, not merely untested.

## Evidence read
- `src/orchestration/orchestrator.ts:1208-1270` — `decompose_task` tool: parameters are
  only `task` and optional `complexity`; it returns complexity, security surface,
  summary and surfaces. No scope, budget, ceiling or ambiguity field in the request or
  the stated result. Its own comment (1263-1264, "Pre-read classification
  (issues #263/#264)") contradicts "measured": complexity is a classification, not a
  measurement.
- `src/orchestration/orchestrator.ts:1272-1324` — `run_pipeline` takes only
  `task`/`complexity`; `start_pipeline` takes only `task`. Neither states outcome,
  scope exclusions, budget or ambiguity; there is no operator-supplied-slice parameter
  for the tool to require (the decomposition clause is honoured here).
- `src/orchestration/control-plane.ts:576-622` — `start()` validates and records `mode`
  (`auto`/`manual`, rejected otherwise) and `scope: normalizedScope(input.scope)` where
  `input.scope` is optional and defaults to `{}` (control-plane.ts:362, 399-415): an
  intake that states no exclusions is admitted by default rather than refused, and no
  code path states the exclusions positively.
- `src/orchestration/types.ts:185-199` — `Plan` fields are
  `complexity, securitySurface, summary, contractRequirements, affectedFiles,
  surfaceAnalysis`. No outcome, scope-exclusion, budget, ceiling or ambiguity field.
- `src/orchestration/types.ts:449-460` — `PipelineResult.outcome` is the SETTLED
  outcome; the rule's "intake states the outcome" clause has no intake-side
  counterpart anywhere I read.
- `src/orchestration/decompose.ts:1-31` — decomposition of large tasks is real:
  `MAX_DERIVED_CHILDREN = 4`, `decomposition_required` drives child derivation with
  `host-supplied` precedence noted in `work-decomposition.md:12`.
- Ceilings are the one strongly evidenced field: `src/orchestration/orchestrator.ts:237-284`
  (raised-ceiling records and the "unchanged ceiling" guard), stage-limits contract
  references in `orchestrator.ts:88-97`.
- Contract cross-checks: `docs/contracts/work-decomposition.md:5-24` (decomposition and
  probe guarantees, all field-nameable, no outcome/scope-exclusion intake field),
  `docs/contracts/autonomy.md:11` ("Intake asks once about mode") — the only intake
  behaviour named by any sibling contract is the mode question.

## Gaps and unverified
- The rule's clause list is unreviewable exactly where the violation lives: "outcome"
  (does the intake state the product outcome, or the mode outcome?), "budget"
  (sentence-level budget vs the context budget that exists in `session.ts:614-628`),
  and "any ambiguity that changes the result" have no code anchor and no sibling
  contract sentence, so an implementer cannot currently be said to violate or satisfy
  them unambiguously — a clarifying edit to `orchestrator.md` precedes any fix here.
- This slice did NOT run any CLI end-to-end intake (e.g. `cli-drive` flows) and did not
  read `test/decompose.test.ts` assertions line-by-line beyond the run result; the two
  passing files prove the decomposition half's mechanism, not full coverage of every
  signal in `work-decomposition.md:9-14` (probe refusal paths are covered there but I
  did not trace them to assertions).
- Conversation intake (the weak path: who states scope exclusions to a conversational
  task) is `unverified`; findings apply to the pipeline/control-plane surface only.
- No evidence at all was found for "ambiguity" as any persisted or stated field
  (`grep "ambigu"` over `src/` headlines only journal ambiguity in `src/cli.ts`,
  unrelated to intake).
