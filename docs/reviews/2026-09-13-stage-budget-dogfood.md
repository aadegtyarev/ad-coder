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
