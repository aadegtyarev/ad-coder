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
