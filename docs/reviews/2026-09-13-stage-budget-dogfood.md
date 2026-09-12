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

Continue by implementing and reviewing the stage-limit domain/controller first,
then runner admission, then coordinator persistence, then CLI/configuration. Run
each slice through focused tests before using a native role on the next slice. Do
not repeat this monolithic Coder prompt.
