# Stage-limit calibration contract

For whoever dispatches or reviews a long plan/coder stage: what stage ceiling has a live probe
already learned for this model and shape, and what is allowed to move it next?

Learned ceilings come from deliberate probe raises — "reconnoitre by fire": raise one bounded
step to answer a question ("does this shape fit at 1.5x?"), observe, record the number that
worked. A same-shape dispatch starts from the learned value; never rewrite a learned number from
a single observation without a second confirming one. Pre-committed branches: success records the
number below; failure means **no second raise** — classify the next snapshot as loop (identical
repeated attempts, no progress) vs too-large (real progress still ongoing), then stop-and-report
or decompose instead.

A standalone role that reaches its final-response reserve is paused with the
structured `stage_closeout` fact; its partial final answer is not a completed
task. Resume requires raising that exhausted ceiling (or disabling it), then
continues the durable session rather than replaying the partial answer.

| Stage | Limit reason | Shape | Learned ceiling | Evidence |
|-------|--------------|-------|-----------------|----------|
| plan | duration | slice-planning of one bounded medium slice inside a complex feature | **810000 ms** — learned on @preset/zai-glm53flash, so model- and shape-specific | run `4c26d8d9-f682-4587-8e5e-07f1de1f8e82`, plan stage, 2026-09-18 local |

Two moments the ceiling rests on; they are not one continuous effort and must not be compared as one:

- **Pause** — the 540000 ms limit exhausted mid-composition. Pause block {phase plan, code
  stage_limit, limitReason duration, limit 540000} in the run file, and in the console session
  transcript (the console's own read of the run's workflow state) the stage-limit snapshot
  {elapsedMs 539999.521382, modelTurns 19, toolTurns 23, inputTokens 432801, lastInputTokens
  42516, costUsd 0.03854530999999999} plus paused stageMetrics (durationMs 539999.521382,
  input 432801, cachedInput 300032, freshInput 132769, output 19258, reasoning 16831,
  readFiles [], readFilesTotal 0).
- **Completion** — after the ceiling was raised to the probed 810000 ms, same run. Checkpoint
  stageMetrics in the coordinator run file: status closed_out, durationMs 726866.161581,
  stageCloseout {code stage_closeout, reason model_turns, detail "20/30 model turns used,
  12 reserved"}, input 544898 (cachedInput 300032, freshInput 244866), readFiles [].
Standalone closeout resume is verified the same way rather than only asserted:
a paused standalone session resumes only after its exhausted ceiling is raised
and continues the durable session, never replaying the partial answer.

Absolute source paths (`<W>` is the worktree the run executed in, `/home/adegtyarev/Develop/Hobby/ad-coder-wt-scale`):

```
<W>/.ad-coder/runs/background/4c26d8d9-f682-4587-8e5e-07f1de1f8e82.json
<W>/.ad-coder/runs/coordinator-4c26d8d9-f682-4587-8e5e-07f1de1f8e82.json
<W>/.ad-coder/sessions/--home-adegtyarev-Develop-Hobby-ad-coder-wt-scale--/2026-09-18T17-27-21-026Z_cdac318e-2ed0-47a1-88d2-92628030ed85.jsonl
<W>/.ad-coder/sessions/--home-adegtyarev-Develop-Hobby-ad-coder-wt-scale--/2026-09-18T17-31-01-911Z_5f17aa41-7447-4ba8-921f-b29ee4158ee3.jsonl
```

The `readFiles` blind spot is not the whole field but the sliced tools. The runner's after_tool
hook (src/runner/runner.ts) fills `readFiles`/`readFilesTotal` only from successful calls of a
tool literally named "read" resolved to real in-target files; every pipeline role gets that
literal "read" in addition to the project tools read_project/search_project/explore_project
(src/cli/resolve-config.ts, src/project-tools/read.ts), so the field can fill on a pipeline
stage. What never appears is the sliced project tools: the probe's plan stage closed 23 tool
turns with `readFiles: []` while its continuation transcript (17-31-01-911Z) shows its reads
through read_project and search_project with no literal-read call — an empty `readFiles` is
**not** evidence of zero reconnaissance. Weigh fresh-input accumulation and turn pace first.

## 2026-09-19 (issue #405): the learned numbers reach the shipped defaults

The plan-stage ceiling this contract learned on 2026-09-18 (810000 ms, run
`4c26d8d9`) never reached anyone who did not pass `--stage-max-duration-ms` by hand: the shipped
per-role default stayed at the pre-probe 540000 ms, and the probe's own console had been given the
learned value as a flag. Measured over the fleet's 72 coordinator run records on 2026-09-19: 16
duration pauses (**15 of them `phase: plan`**) and 4 input-token pauses (all coder), against
**zero** pauses on model turns, tool turns or cost.

The defaults move one bounded step (duration and turns x1.5, input x1.6; cost unchanged) and the
planner's duration takes the learned 810000 itself, with its model-turns ceiling following the
closeout reason of the same probe (`reason model_turns, "20/30 model turns used, 12 reserved"`).
The rule from the top of this contract still governs: this is a probe, not a settled number. If a
same-shape plan dispatch pauses again, that is the second observation, and the next step is chosen
from the snapshot rather than from this table — classify loop vs too-large first.

Two properties of the per-role table are worth stating plainly, because the `--help` text did not:

- A global `--stage-max-*` flag **replaces every role's own ceiling** for that dimension with the
  one value passed. It is a flattening tool, not a floor and not an offset: `--stage-max-cost-usd 6`
  gives the coder 6 where its own ceiling was 2.4, and gives the planner 6 where its own deliberate
  ceiling was 0.3. There is no way to raise ONE role's ceiling from the command line, which is why
  cost cannot be "raised a little" this way and why the numbers above are edited in the table
  instead.
- The global defaults therefore only apply to dimensions a role does not override, and to
  `orchestrator`, the one role with no entry of its own. A host embedding the pipeline can still
  move one role alone — `roleStageLimits` in the pipeline config is the LAST spread, so it wins over
  both the role's default and a global flag — and so can the orchestrator's own pause/raise path.
  What does not exist is a CLI flag for it.

## 2026-09-19 (issue #405, second pass): the same drift in the reserves and the README

The help-text defect was not five lines. Parsing the rendered help against the constants turned up
four more: all four `--stage-final-response-reserve-*` lines stated the pre-raise values
(4 model turns / 30000 ms / 8 tool turns / 100000 input tokens) against the code's 12 / 90000 / 24 /
300000. Both sets moved in one commit on 2026-09-18 (`d4407b2`, PR #325) — the ceilings from
600000/32/128/500000/2 and the reserves together — and neither the help, nor the README, nor the
dated entry in `docs/contracts/config.md` moved with them. The README repeated the pre-raise
figures and added one more claim that was never true: it documented `--role-stage-limits <file>` as
the way to constrain a single role, and the CLI rejects that option as unknown — the string has
appeared only in the README since the commit that wrote it, never in `src/`. All nine help lines
are interpolated from `DEFAULT_STAGE_LIMITS` now, and the README states the flattening rule, the
reserve defaults and the real per-role surface.

The lesson worth keeping: a default that is read from a constant cannot drift, and a default typed
into prose will. The three surfaces that drifted were exactly the three that spelled the numbers
out by hand.

## 2026-09-23: bounded standalone reviewer closeout

A standalone GLM reviewer given a one-commit error-classification diff spent
449 seconds, 16 model turns and 21 tool turns on repository-wide discovery,
then was stopped before it submitted a verdict. The old reviewer ceiling
(72 turns, 180 tools, 1.35m ms, 1.68m input) could not have protected that
review for another implementation-sized interval. This is one incident, so the
new reviewer defaults are a bounded probe rather than a permanent measurement:
540000 ms, 24 model turns, 48 tool turns, 600000 input tokens and $0.30, with
8 turns, 8 tools and 100000 input tokens reserved for closeout. The values are
ordinary `roleStageLimits` and remain fully configurable. A submission tool is
still admitted after closeout; a run that has no verdict is durably paused with
`stage_closeout` and resumes only after the exhausted ceiling is raised or
disabled. Confirm a same-shape outcome before changing this probe again.
