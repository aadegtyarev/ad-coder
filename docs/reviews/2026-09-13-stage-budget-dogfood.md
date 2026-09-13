# Stage-budget dogfood interruption — 2026-09-13

This exceptional incident records why whole-stage budgets must be implemented in
small slices before another end-to-end pipeline run.

A standalone native Planner produced a focused stage-budget plan after about 95
seconds and reported $0.32359080. It proposed zero-disabled wall-clock, model-turn,
tool-turn, input-token, and provider-cost limits; runner admission; and a safe
coordinator checkpoint pause that resumes the incomplete stage without repeating
committed Planner or Security work.

A native Coder then received only that focused implementation task with a
120-second provider-request timeout. The role emitted heartbeat-only progress,
continued beyond the request boundary, and was stopped by the operator harness at
about 190 seconds. It produced no terminal result, cost envelope, checkpoint, or
working-tree change. This proves that request timeout is not a stage budget and
that standalone roles cannot preserve partial work unless they actually publish
tool edits.

An independent native Reviewer then completed in about 86 seconds for
$0.13613120. It found that the first controller draft admitted concurrent model
turns while cost was unsettled and omitted the public-API changelog entry. Both
findings were accepted: an enabled cost limit now reserves the single in-flight
admission until usage settles, and the exported API is recorded in CHANGELOG.
The focused re-review took about 122 seconds and $0.13958520; it caught that the
regression test exercised `assertActive` rather than a second model admission.
The final test now invokes `admitModelTurn` twice and proves the second dispatch
is rejected while cost is unsettled.

Continue by implementing and reviewing the stage-limit domain/controller first,
then runner admission, then coordinator persistence, then CLI/configuration. Run
each slice through focused tests before using a native role on the next slice. Do
not repeat this monolithic Coder prompt.

## Wired-budget dogfood

After runner, coordinator, CLI, and prompt integration, one standalone Reviewer
was launched with explicit ceilings of 180 seconds, 12 model turns, 48 tool
turns, 250,000 input tokens, and $0.50. It stopped after about 40 seconds instead
of running for hours, but surfaced the generic `AgentHarness storage or invariant
fault` and no verdict or cost envelope; its durable session artifact was about
666 KB. Do not repeat this review. The bounded stop is an improvement, while the
missing typed terminal projection and standalone usage envelope remain covered
by the existing activity/usage backlog item.

A subsequent full `drive --auto` dogfood used a 180-second, 16-model-turn,
48-tool-turn, 400,000-input-token, $1 per-stage envelope. Planner reached the
duration boundary before submitting a plan. The coordinator correctly preserved
a `stage_limit` pause at `plan` with no committed later work, but the `drive`
front mislabeled it `pending_decision`. Investigation showed the Models-boundary
limit had also been hidden by the harness fault wrapper. The runner now rethrows
the captured typed stage error, and `drive` projects the checkpoint's recovery
guidance before considering pending decisions. Focused regression tests reproduce
both boundaries without a live provider.

The next comparable standalone Planner run used the revised batching prompt and
hard ceilings of 120 seconds, six model turns, twelve executed tool turns,
200,000 input tokens, and $0.50. It stopped with the correctly typed
`stage tool_turns limit reached (12/12)` after about 50 seconds. The model had
requested fourteen `bash` calls in its transcript, but only the configured twelve
were admitted; the session artifact was about 462 KB. This is materially bounded
versus the earlier 180-second/26-command attempt, but it still produced no usable
plan. Further savings therefore require a task-specific reconnaissance tool/result
projection rather than more prompt wording or a larger limit.
### Task-specific reconnaissance projection

After the bounded Planner still spent 12 admitted tool calls without producing a
plan, the next optimization moved task lookup into a native tool instead of adding
more prompt instructions. `search_project` batches literal symbols, config keys,
error strings, and contract terms; ranks matching files; and bounds term count,
per-line excerpts, returned matches, Git output, and final result bytes. It also
includes untracked files so review can see newly added implementation. The normal
`read`/`bash` path remains available when the projection is insufficient.

Two focused native Reviewer attempts did not produce a verdict. The first hit
the 12-tool-turn ceiling after about 40 seconds; a narrower retry hit the
8-model-turn ceiling after about 90 seconds despite allowing 20 tool turns.
Both emitted only heartbeat at the standalone CLI. The bounded stops prevented
another multi-hour run, but they confirm that standalone semantic activity and
role-turn efficiency remain unresolved. Local review then caught and fixed two
projection defects: Git search now treats task terms literally, and result
metadata reports truncation caused by either match-count or byte ceilings.

The standalone front was then fixed at the actual wiring boundary: it now feeds
runner activity into the bounded human renderer, preserves selected plugin tools
such as `search_project`, writes the default target-local numeric ledger, and
prints a narrowed usage envelope. The earlier Reviewer prompts could not have
used `search_project` because the front had removed all plugin tools.

A post-fix Reviewer run visibly executed Search, Read, and Run lifecycles before
the 12-tool ceiling stopped it after about 22 seconds. Its private `0600` ledger
contained four provider records: 20,563 input tokens, 848 output tokens,
$0.05212120, and requested-tool counts of one `search_project`, twelve `read`,
and four `bash`. This both validates the wiring and shows the remaining waste:
the role still broadens from one projection into many reads. Failed standalone
runs now print their known partial-ledger path for immediate diagnosis.

A full native `drive --auto` validation of request-assembly telemetry stopped
the Planner at its eight-model-turn ceiling after about 117 seconds. The durable
session reached roughly 963 KB and the front again exposed only heartbeat,
revealing that activity had been wired to standalone and console fronts but not
pipeline drive. `drive` now consumes the same bounded activity stream for every
stage. Per-stage metrics also report effective system-prompt, handoff-prompt,
tool-definition, and total pre-serialization bytes, so subsequent reductions can
be attributed across the whole pipeline.

The first activity-visible retry showed why Planner still reached its 120-second
duration ceiling: it launched a shell operation lasting about 41 seconds and
continued reconnaissance afterward. Planner guidance now leaves suites, builds,
linters, and formatters to Coder and permits only a single cheap probe when
needed to establish the problem. Verification commands remain part of the plan.

The next retry removed the long verification command but stopped at the
20-tool-turn ceiling after about 42 seconds: Planner fanned out sixteen separate
`read` calls after bounded search. `read_project` now replaces that pattern with
up to eight exact line slices under one configurable 16 KB aggregate ceiling,
while retaining ordinary `read` as a visible correctness fallback.

The first full run to reach later stages completed Planner in about 130 seconds
for $0.19778680 and Security in about 120 seconds for $0.42746700. Security found
that the initial `read_project` implementation authorized a pathname before
reopening it and could allocate beyond `maxFileBytes` if a file changed between
`stat` and `readFile`. Coder reached its 20-tool ceiling after one partial edit.
The completed mitigation opens every component descriptor-relative with
`O_NOFOLLOW`, retains opened parents across pathname swaps, `fstat`s the opened
file, and reads at most `maxFileBytes + 1` from that same descriptor. Deterministic
tests cover ancestor replacement and post-stat growth.

The final native Reviewer completed in about 98 seconds for $0.12798840 after
running all gates in one combined shell call. It found one blocker: a NUL inside
a path segment was truncated at the FFI boundary, so `..\0ignored` reached
`openat` as `..`. The tool now rejects NUL before native traversal and a direct
regression test preserves the boundary. Reviewer otherwise confirmed telemetry
propagation, renderer cleanup, exports, contracts, and 406 passing tests.

The focused NUL fix re-review approved in about 27.6 seconds for $0.03508040.
It ran only `test/read-project.test.ts` (5/5) and mutation-checked the guard:
removing it made the regression fail at the native traversal boundary.
