# Changelog

All notable changes to ad-coder are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project aims at
[Semantic Versioning](https://semver.org/).

## [0.36.0] - 2026-09-17

### Added
- **Ledger reporting** (issue #234): a CLI command an operator runs and a
  library function a role calls that read `.ad-coder/ledger/<runId>.jsonl`
  files and report how real work behaved -- per role, per provider/model, and
  in totals. `bun run src/cli.ts ledger report [files...] [--json]` (with no
  files it reads every `*.jsonl` in the project's ledger directory) is backed by
  `readLedgerFiles` / `aggregateLedgerRecords` in `src/ledger/analytics.ts`,
  exported from `src/index.ts`. Numbers read straight off the ledger: model
  calls, fresh input, cached input (read + write), output, reasoning,
  provider-reported cost, tool mix, bash calls per edit, cache fraction,
  `run_role` requests as the delegation signal, and time to first edit. Numbers
  the ledger does not store -- failed-edit rate and time to green tests, both
  outcome signals the request-only `toolCalls` and no test-outcome event cannot
  supply -- are deliberately absent rather than invented, and the new
  `docs/contracts/ledger-report.md` says so.
- The reader tolerates a ledger opened mid-write by a live run: a malformed,
  truncated, or blank line is a skipped line counted in per-file stats, never a
  crash; a file that cannot be opened fails with its path named.

## [Unreleased]

## [0.35.2] - 2026-09-17

### Fixed
- The explicit capability off now crosses the background-worker boundary
  (issue #245). `console` built a background launcher with three of four
  arguments, so `skillsDisabled` defaulted to `false` and `--no-skills` stopped
  at the console: the detached worker re-resolved skills from its own profile
  read and ran with the full catalogue while the operator's foreground `config`
  `show` reported the capability off. The launcher seam is now one shared
  function (`backgroundHostLauncherFor`) both the console session and the
  `background start` front build through, passing the resolved pin, the
  resolved off (flag or profile setting), and the operator's explicit
  `--workflows` / `--plugins` words verbatim into the worker command;
  tests no longer rely on a defaulted parameter to hold the boundary.
- The same boundary audit fixed two more capability switches that never
  reached a detached worker: `--workflows=false|<list>|^name` and `--plugins
  none|<list>` were also dropped, so a workflow module or plugin group an
  operator switched off resolved back to shipped-enabled inside the worker
  (docs/contracts/config.md, 2026-09-17).

### Added
- The #245 boundary test every gate lacked: a test-only seam observes the
  actual detached worker command and asserts the pin, the explicit off,
  `--workflows`, and `--plugins` reach it verbatim, and that an inherited
  pin and an inherited off stay mutually exclusive. It fails without a
  launch parameter arriving at the boundary (the #245 shape), which a defaulted
  parameter and all seven gates passed silently.
## [0.35.1] - 2026-09-17

### Fixed
- A delegated role invocation no longer lists workflow submission tools it can
  never call (#236). Delegated roles inherit the pipeline role's
  `activeToolNames`, which carried `submit_plan` / `submit_verdict` /
  `submit_follow_up` although those objects exist only inside a pipeline; the
  provider rejected the whole request as `configured_tools_unavailable` and the
  turn settled empty, so `run_role(role=reviewer)` was broken for every
  submission-tool role. The inheritance now drops submission-tool names
  (matching the delegated prompt's "do not expect pipeline submission tools"),
  sourced from one `SUBMISSION_TOOL_NAMES` list shared with the standalone `role`
  command.
- Added the #236 regression test: every name in a delegated role's
  `activeToolNames` must name a tool object the conversation registers. No gate
  exercised a live provider, so this is the check that can fail without one.

## [0.35.0] - 2026-09-16

### Added
- `ad-coder console` can receive a multi-line brief (#224, contract
  `docs/contracts/cli.md`, 2026-09-16). A TTY paste is assembled: the console
  requests bracketed paste, so the pasted lines join ONE message that dispatches
  as a single turn. `/task <path>` dispatches a whole file as one turn; its
  content is prompt text, never console controls. Both are declared in the
  shared control registry, so `/help`, `consoleCommandUsage`, and every front
  stay in one source of truth.

### Changed
- A piped (non-tty) console run is read whole until EOF and dispatched as ONE
  turn with interior newlines preserved — a piped brief is one message, not one
  turn per line (`#224`; the defect let a 30-line brief run as thirty turns).
  Command-looking lines inside such a message are prompt text, never controls,
  because the model is otherwise measured on a task it was never given.
  `maxInputBytes` now bounds ONE message instead of one line; the failure
  message says "input message exceeds the configured byte limit". A piped run
  that is a sequence of newline-separated controls no longer executes them one
  by one; drive the tty path for that.

## [0.34.0] - 2026-09-17

### Changed
> Skills on this branch answer to the enable-by-default capability rule in
> `docs/contracts/config.md` (2026-09-16); the reason the profile switch is an
> optional v1 field rather than a v2 bump is recorded there and in its PR text.
- Workflow modules ship enabled: a plain console session resolves the built-in
  `pipeline` module to its tools (`run_pipeline`, `decompose_task`, `run_step`,
  `choose_transition`, `show_cost`) without any flag. `--workflows` is now the
  shared set-valued launch parameter (declared once for every
  pipeline-capable command): a comma list selects modules, `^name` excludes
  from the built-in default, and `--workflows=false` disables the capability.
  `config show` reports the resolved workflow set and its source. The
  persistent-setting layer is recorded as an open gap in
  `docs/contracts/config.md`; issue #216 holds the whole-surface audit.
- `--no-skills` turns the skill capability off explicitly on every command that
  runs a role: no catalogue in any prompt, no `load_skill` tool registered. It
  cannot be combined with `--skills`.
- A persistent setting can now turn the skill capability off:
  `~/.config/ad-coder/profile.json` accepts an optional
  `"capabilities": {"skills": false}` under the unchanged v1 schema (no
  version bump; the field rides through export/import verbatim). Layer order:
  explicit flag beats the setting beats the built-in default, so `--skills`
  and `--no-skills` each disable the setting without it ever marking a flag.
  A missing profile is the enabled default, not an error; an unsafe or invalid
  profile store fails the command with the store's usual error codes. Skills
  remain catalogue-by-default otherwise; `--skills a,b` pins an exact set.
- `config show` reports a `skills` row that says whether the capability is ON
  or OFF, then lists every skill a run can reach with id, version, source tier
  (`builtin`/`project`), SHA-256 digest, and the winning layer (`cli`,
  `profile`, or `built-in-default`).

## [0.33.1] - 2026-09-16

### Added
- A `docs/contracts/telegram.md` front contract: the room model (`switchable`
  personal chat now, `fixed` topic room later), deterministic message routing
  keyed by room with no content inference, the input grammar (text to the
  selected session, one shared command schema), the pinned-dashboard views, and
  a two-kind notification policy (decision pushes interrupt; milestone pushes
  are informational and never block). It anticipates the later group-topic mode
  as a second room kind rather than a rewrite.
- A milestone rule in `docs/contracts/operator-flow.md` clarifying that
  informational milestone pushes (run started/finished, cost spike, transfer
  settled) are not interruptions and never demand a reply; only decision pushes
  interrupt.

## [0.33.0] - 2026-09-16

### Changed
- A role prompt now carries a CATALOGUE of available skills -- id, version, one
  line each -- and a role pulls the instructions it needs with the new
  `load_skill` tool after reading the task. Selecting every skill and pasting it
  shipped earlier the same day and reached **2106 words** of appendix for the
  orchestrator whether or not the task called for any of it; the operator caught
  the behaviour change immediately. `docs/contracts/skills.md` had named that
  boundary in advance -- discovery "must never silently inject full instructions
  into every role prompt" -- and this is the mechanism it was waiting for: which
  methodology a task needs is knowledge the model has and the operator does not,
  but only after reading the task, which is when a tool call can still happen
  and a prompt can no longer change.
- `--skills` keeps working as a pin: "use exactly these", pasted as before, for
  when the operator does know better. Loading obeys everything selection obeyed
  -- id pattern, the manifest's role scope, per-turn and byte ceilings, and a
  typed error that names its reason. A skill outside a role's scope is refused
  with what the catalogue already said, so the refusal cannot be used to
  enumerate skills written for other roles. (#129)

## [0.32.1] - 2026-09-16

### Added
- A capability rule in `docs/contracts/config.md`: every capability ad-coder
  ships is enabled at startup, a persistent setting can switch it off, a launch
  parameter can switch it off explicitly and beats the setting, and the
  resolved state of every capability is visible rather than silent. Set-valued
  capabilities can also select or exclude members. Exceptions stay possible
  but owe a dated entry naming the safety or cost reason. The rule generalises
  the 2026-09-11 configurability pair from values to switchable features; the
  audit that applies it to every startup capability is tracked on GitHub.

### Changed
- Skills are selected by default instead of opt-in. Every skill declares the
  roles it serves, and that declaration is now the selection; `--skills` narrows
  rather than enables. A skill nobody remembers to pass is a skill that never
  runs, and the operator had been typing the list by hand on every invocation.
- The four shipped skills are rewritten to carry something. They were 19-26
  words each -- `acceptance-review` in full was "compare the diff and test
  evidence with acceptance criteria and applicable contracts; report gaps and a
  decision", which the reviewer's own prompt already says. Against a 16 KiB
  ceiling they used about a two-hundredth of the room. Each now holds what a
  role prompt has no space for: the technique, the failure it prevents, and the
  stopping rule -- a claim of passing tests is not evidence of passing tests;
  reconnaissance stops when it can name surfaces, contracts and unknowns; a
  slice that cannot be tested is not ready; three different events wear the
  symptom of an exhausted stage and need different answers.
- A new `repository-navigation` skill, and the same rule in every role prompt
  that can call `bash`: ask the repository one question per call. `git status`
  and `git diff --stat` answer "what changed here" completely; locate with
  `search_project`, read with `read_project`, use `bash` where no specific tool
  exists. Read a file once rather than drawing it through `sed` in ten-line
  slices, and inspect a commit once rather than re-running `git show` with
  different ranges. A console turn spent 49 bash calls on a two-conflict merge,
  four of them re-reading one commit through different `sed` windows -- correct
  work, five times the calls it needed.

- The orchestrator prompt requires search to narrow or stop: before a third
  search, state what the previous two ruled out, and if the answer is "nothing",
  ask instead of widening. Broadening a pattern, dropping a filter, and
  re-running the same grep with different words elsewhere are the same move.
  A live console turn spent six minutes and eighteen bash calls hunting for a
  contract change that `git status` would have shown -- it even read the right
  file and went back to searching. Asking the working tree first is now stated,
  as is: when the operator refers to recent work, look in the tree, the last
  commits, or the branch diff, and if it is not there, say what you checked.

### Fixed
- Every line of a tool call's lifecycle names its subject. Arguments arrive only
  on the request event, so reading them per-event produced one line with the
  command and the next two blank -- `Run  ls -la ...  started` followed by a bare
  `Run  25ms`. The subject is now remembered for the call and released when it
  ends.
- The console stops printing the role on every line. It runs one role, so the
  name is noise there; a pipeline alternates roles and still shows them, because
  the renderer starts naming roles once it has seen a second one.
- Twelve durable-run control tools were still rendering as an anonymous `Tool`.
  All shipped tool names are now classified.

## [0.32.0] - 2026-09-16

### Changed
- Console activity lines say who is working, on what, and when. They read
  `17:03:41  coder·glm53flash  Edit  src/cli/console.ts +12 -3  1.2s` instead of
  `Activity: Edit — completed 1234ms`: time first so the left edge is scannable,
  then role and model together, then the subject -- the path read or written,
  the command run, the URL fetched, the query searched, and the line counts an
  edit moves. A read shows the window it asked for -- `plan.ts:120+40` is a
  slice, a bare path is the whole file -- because reading in slices and
  swallowing a large file cost differently and the difference was invisible. A
  successful line omits "completed", because saying it every time pushes the
  interesting words off the scan path.
- Projections now carry that subject. They had been declared in the event type
  and never populated, so every line was anonymous; the rule that kept them out
  ("arbitrary labels, commands, queries and URLs are never projected") protected
  nothing -- these events never leave the process, and anyone able to start
  ad-coder already reads every file on the machine. `docs/contracts/tool-observability.md`
  now draws the line where it belongs: the SUBJECT of a tool call is shown, the
  CONTENT a tool returns is not, and credential-shaped values inside a command
  are replaced (`echo API_KEY=***`) because terminal scrollback gets
  screenshotted.
- The orchestration tools are named. `submit_plan`, `run_role`, `decompose_task`
  and the rest rendered as a bare `Tool`, which is how four consecutive
  `submit_follow_up` rejections hid in plain sight earlier the same day until
  someone opened the ledger.

## [0.31.1] - 2026-09-16

### Fixed
- A rejected `submit_follow_up` or `submit_plan` call now tells the model what
  was wrong, not only that something was. Both returned `error.code` alone --
  `invalid_follow_up`, `malformed_plan` -- while the validator's own sentence
  ("evidence must be non-empty", "coverage.contractIds must be bounded non-empty
  strings") was discarded one line before the model saw it. A model holding only
  the code cannot repair the call, so it calls again unchanged: observed as four
  identical rejections in a row until the stage limit ended the run, with the
  failure reported as "research provider response was unavailable or invalid"
  while the provider was answering normally. `verdict.ts` had been doing this
  correctly all along, which is why the rule now lives in
  `docs/contracts/errors.md` rather than in one author's head. (#209)

## [0.31.0] - 2026-09-16

### Added
- `docs/contracts/operator-flow.md` states how the operator works with ad-coder
  as rules rather than as a feature list -- the product's UX, written down
  because everything else exists to make that shape possible. It fixes four
  things the session found by trying to work that way and failing:
  a brief is intent and constraint, never a file to edit; the budget for a
  feature is agreed before the work starts, and the system answers with an
  estimate, a counter-estimate with evidence, or an admission that it has none;
  routing is proposed, evidenced and persisted by the system rather than
  hand-edited by the operator; and an interruption must be a decision the
  operator can make. "The stage ran out, shall I raise it?" is not one -- the
  only available answer is yes, and the system knows more than the operator
  does at that moment.

## [0.30.1] - 2026-09-16

### Changed
- The Coder/Reviewer family rule in `docs/contracts/config.md` becomes binding
  and covers the Auditor. It said Coder and Reviewer "may" use different model
  families; a matrix seeded on 2026-09-16 promptly put one model on Coder,
  Reviewer and Auditor at once and nothing objected. An author is blind exactly
  where they erred, so a same-family checker buys a review that cannot see the
  defect. Route them together only when the inventory offers no second family,
  and record that the constraint was unsatisfiable rather than leaving it
  looking like a choice.

### Added
- `docs/benchmark-role-fitness.md` -- an external review of what public
  benchmarks can and cannot say about routing a role, restated as a research
  note. It is the evidence base for seeding a routing matrix, and its central
  findings are why the local bench was retired rather than a casualty of it: the
  ABC audit (25 authors) found task-validity defects in 7 of 10 major
  benchmarks, and the IRT literature names uniform failure across models as the
  signature of a wrong answer key rather than a hard task -- which this corpus
  hit seven times. It also supplies what this project had been deciding by eye:
  a published saturation index with a 0.7 threshold, `pass^k` as the citable
  name for judging on the worst run, and exact McNemar for comparing two models
  at small n. The repository-audit section is dropped, since its subjects were
  deleted with the bench.

## [0.30.0] - 2026-09-16

### Removed
- The local model-ranking bench and everything that told a future session to
  rebuild it: `docs/benchmark-method.md`, `docs/benchmark-scoring-research.md`,
  `docs/model-calibration.md`, `docs/calibration-evidence.jsonl`, the
  `calibration:health` script, and the 113-line AGENTS.md program whose
  completion condition included "representative benchmark corpus built".

  A full round over nine models on 2026-09-16 showed why. Seven of twenty-two
  tasks scored 1.00 for every model. All twenty comparable cells were decided by
  a margin under 0.10, seventeen of them by exactly 0.00. And the same model on
  the same task produced 0.07 and 0.82 in one afternoon -- the run-to-run spread
  is an order of magnitude larger than any difference between models. The matrix
  measured noise, at one run per cell, for a day and $1.49.

  Public agentic benchmarks rest on thousands of tasks. Seeding the routing
  matrix from those and correcting it with signals real project work already
  emits -- rounds to acceptance, stage limits, rejected verdicts, rework, cost --
  is both cheaper and better evidenced. The mechanism was already half-built:
  `prompts/orchestrator.md` has told the orchestrator to treat its own routing
  as a calibration sample since before this round.

### Changed
- AGENTS.md replaces that program with "Model routing: seed from published
  evidence, correct with real work", stating what research must establish before
  a cell is seeded (primary sources, several benchmarks, dated checkpoint,
  provider, the effort the numbers were produced at, vendor-reported or not) and
  what the eval corpus is actually for: exercising the harness on adversarial
  shapes. Running it found two product defects that reading the code did not
  (#188, #190). Its scores may not seed or override a routing cell.
- Five rules survive, because they apply to any measurement including a public
  one: one run samples rather than measures; a failure is data; never compare
  across tasks; route per role; and when several models fail one check
  identically, read an artifact first -- in this corpus that signal meant the
  check was wrong seven times out of seven.

## [0.29.2] - 2026-09-16

### Fixed
- `planner-retry-reconcile-v1` scored markdown fidelity instead of comprehension.
  Its carried-rule check compared a quoted rule against the contract file
  verbatim, and the contract writes ``up to `CONCURRENCY` at once`` with the
  identifier fenced -- so a planner that carried the rule into prose, correctly,
  diverged at the 39th character and lost five weights. Three runs across two
  model families scored exactly 0.75 this way, every one of them right. Its
  acceptance check had the matching flaw: the correct plan leaves `src/queue.ts`
  untouched, and "git diff -- src/queue.ts is empty" is as runnable as a status
  code, but the observable list knew only status codes and test verbs. Seventh
  instance in this corpus of a check grading the author's vocabulary.

## [0.29.1] - 2026-09-16

### Fixed
- A single corpus run that aborts is now recorded as a failed measurement with a
  named `harnessOutcome` instead of taking the whole invocation down. The repeat
  path already caught, counted and continued; the single-run path threw, so the
  protection existed and reached one of its two callers. Two runs of the
  2026-09-16 round vanished this way -- a planner whose plan the product rejected
  for incomplete coverage fields -- and the runs that abort are the bad ones, so
  dropping them flatters the model. `classifyAbort` names which problem it was,
  because a rejected handoff, an exhausted stage and a failing provider are three
  different things to whoever reads the sweep. (#190)

## [0.29.0] - 2026-09-16

### Fixed
- The complexity rubric now tiers a change by what it *requires* rather than by
  how many lines it spans, and reaches every path that decides a tier: the
  pipeline's plan stage, a planner invoked through `run_role`, and the
  orchestrator classifying in its own turn. It previously said "trivial for a
  one-liner, complex for a cross-cutting or high-risk one" and lived only in the
  planner instruction, which reaches a model from the plan stage alone -- so two
  of the three paths decided tiers with no definition at all. Asked to rate
  "make `Pool.reserve` linearizable under concurrent calls", two model families
  answered `trivial`: one file, a few lines, and by the rubric we shipped that
  was the defensible reading. The same sweep measured a seeded race at 0.07 on
  one model and 1.00 on another, so concurrency is exactly where the choice of
  model decides the outcome, and a rubric priced by diff size routed that work
  to the cheapest cell. After the fix the cheapest model in the inventory
  answers `complex`, its planner agrees, and the task's score goes from 0.30 to
  0.80 -- the capability was there and the definition was not. One constant,
  quoted in one vocabulary shared with `docs/benchmark-method.md`. (#188)

## [0.28.0] - 2026-09-16

### Added
- Nine corpus tasks that close the last empty routing cells: every one of the
  eight roles now has a task at trivial, medium and complex, 24 of 24. The
  complex ones were built on properties the corpus had never tested -- an
  interleaving across an `await`, two documents that disagree and only one
  clause superseded, a revocation defeated by a stale cache, a constraint that
  must survive context eviction *and* be reconciled afterwards. The trivial ones
  measure restraint rather than capability, which is what that tier is for: a
  plan capped at two steps, a researcher that must not hedge on a settled fact,
  an orchestrator that must answer in one line instead of opening a pipeline.
  Every task ships the four samples the method requires, and every gamed sample
  was run rather than asserted.

## [0.27.0] - 2026-09-16

### Added
- `docs/benchmark-method.md` collects the three procedures this project had been
  carrying in its head, its scorer comments and its chat log: how to design a
  bench task, how to prove it before trusting it, and how to turn a sweep into a
  routing decision. Each rule names the wrong answer that produced it, because a
  rule whose cost is invisible gets dropped by the first person in a hurry. The
  routing half was written down nowhere at all.

## [0.26.2] - 2026-09-16

### Fixed
- `kimi-k3` was recommended on quality and list price and carries a **$15**
  allowance against `glm-5.2`'s $60 -- four times the worse buy, the same trap
  `glm-5.3` vs `glm-5.2` was written up for. Recommendation withdrawn, allowance
  recorded.
- The allowance table now covers every model measured, taken from the provider's
  documentation rather than its pricing page, which lists ten of twenty-seven.
  It changes the answer: of the four models reaching 1.00 on the coder task,
  `glm-5.2` is allowanced $60 while `kimi-k3` and `qwen3.8-max` are $15, so the
  two that look cheapest per token buy a quarter of the work.
- `gpt-5.6-luna` is listed with a $15 allowance and answers HTTP 500 on every
  request. Listed, allowanced and available are three different states.

## [0.26.1] - 2026-09-16

### Added
- `security-trivial-v1`: one route registered without the `requireSession` call
  every sibling makes, reusing the existing threat-modelling fixture. All three
  models score 1.00 twice at $0.0011 for the cheapest, so it ships as `smoke` --
  the trivial tier's answer rather than a failure to discriminate.

### Fixed
- Its first scorer demanded exactly one threat, and all three models scored
  0.57-0.79 against it. The artifacts showed an owner-scoping gap the fixture
  genuinely contains -- `listReports` filters by owner prefix, `deleteReport`
  takes a bare id -- which two models found unprompted. The restraint
  requirement was right and its ceiling was set from what the author imagined
  rather than from the fixture; the gap is now a bonus check and the cap is two.

## [0.26.0] - 2026-09-16

### Added
- `reviewer-trivial-v1` opens the trivial tier, which was empty for all eight
  roles while the profile assigned a model to every one of them (#174). A
  two-line diff swapping `??` for `||`; all three models score 1.00 twice, the
  cheapest at $0.0007 a run, so it ships as `smoke` -- that is the answer the
  tier exists to give. It still measures restraint: the fixture keeps a tempting
  non-defect and the scorer demands exactly one blocking finding, because a
  reviewer reporting two findings on a two-line diff is unusable however cheap.

### Fixed
- The new task's check scored the author's vocabulary, found before it shipped:
  five of six live runs scored exactly 0.57 while one artifact showed a model
  that had identified the defect, cited the contract and proven it by evaluating
  the changed expression. Fifth instance of this defect in this corpus, now
  written down in `model-calibration.md` as its recurring shape.

### Changed
- `deepseek-v4.1-flash` measured against `v4` on four role tasks: better at
  review and auditing, worse at threat modelling. Routing per role rather than a
  global swap, and seventeen more measurements recorded.

## [0.25.1] - 2026-09-16

### Changed
- Three middle-tier candidates taken to five runs each, the field's convergent
  minimum. `qwen3.8-max` is the only model measured that never dropped a run --
  and the slowest, at roughly 6.5 minutes against 2.5 for `glm-5.2`. Both halves
  belong to one routing decision, and the single-run numbers would have ranked
  all three as identical.

## [0.25.0] - 2026-09-16

### Changed
- The opencode-go starting grid is rewritten from measurement rather than from
  the price list, which is what it said it was waiting for. `glm-5.2` replaces
  `glm-5.3-flash` in the middle tier on five runs against three, and is also the
  better buy under the allowance arithmetic. `minimax-m3` leaves the strong tier:
  it is the fastest model measured and spans 0.25 to 1.00 across five runs on one
  task, which places it where a bad run is cheap and nowhere else. The superseded
  choices are named rather than quietly replaced.

## [0.24.3] - 2026-09-16

### Changed
- The first breadth sweep is recorded: ten models across four vendors on
  `coder-retention-v1`, with the three models the subscription lists but does not
  serve. The dearest model measured is not the best, `glm-5.2` beats
  `glm-5.3-flash` on quality while being the better buy under the subscription's
  allowance arithmetic, and `minimax-m3` is four times faster than anything else
  while spanning 0.25 to 1.00 across five runs.

## [0.24.2] - 2026-09-16

### Changed
- `docs/CHECKPOINT.md` records the second half of the bench rebuild: the three
  things a model could do freely while scoring 1.00, the alternative-valid sample
  that was the missing mirror of the cheating one, the two tasks that argued
  against their own scorers, why the summarizer's cell was empty and what filling
  it required, and what the commissioned research settled that had been asserted
  from taste.

## [0.24.1] - 2026-09-16

### Changed
- `docs/calibration-evidence.jsonl` gains the 56 measurements taken during the
  bench rebuild -- eleven models across four vendors on ten tasks, with the
  provider, effort, harness outcome, cost and duration of each. They had been
  sitting in a scratch directory where the next session would not have found
  them, which defeats the point of keeping an append-only record: the file
  exists so a tier can be revisited against evidence rather than re-run from
  scratch, and so the data can eventually be published.

## [0.24.0] - 2026-09-16

### Added
- `summarizer-retention-v1` measures the `summarizer`, the only role the corpus
  measured with nothing at any tier. It could not be measured the usual way --
  the summarizer is not dispatchable as a role and runs only inside compaction --
  so the task measures what compaction is for: a constraint stated once, twelve
  bulky files that must be read before answering, and a context budget small
  enough that the early messages are evicted first.
- A successful context compaction now says so on stderr, with numbers only:
  messages replaced, tokens measured, threshold. A compaction FAILURE was already
  announced and success was silent, so a finished run could not be distinguished
  from one that never needed to compact -- invisible in production, and fatal to
  a task trying to measure retention across eviction. The corpus runner counts
  the line into the measurement as `compactions`, and a task may declare
  `requiresCompaction` so a run that never compacted is reported rather than
  silently scored as if it had.

### Fixed
- A role that produced no readable JSON destroyed its own measurement: the
  artifact extractor threw, the runner dropped the run, and the runs dropped were
  the worst ones -- so a model was flattered by exactly the answers it botched.
  The same rule the scorers already follow now applies here, and an unreadable
  answer is recorded as a failing run.

## [0.23.0] - 2026-09-16

### Added
- Every artifact-scored task now ships `.alt.json`, an answer materially
  different from its pass sample that must still score every check. It is the
  mirror of `.gamed.json`: that one proves the scorer rejects a plausible
  evasion, this one proves it accepts a right answer that is not the author's.
  Writing both is what a single author can do in place of a second reviewer, and
  its absence is what let a task ship whose own fixture argued against its
  scorer.

### Fixed
- Two of eight tasks rejected a correct answer phrased differently, found by the
  new samples on the day they were written. A reviewer finding coded
  `primary-write-precedes-metadata` scored zero where `order-reversed` scored
  full; a security finding coded `failure-response-reveals-storage-layout`,
  carrying CWE-200 and an exploit naming the report path, scored zero for
  omitting the word "disclosure". Both checks were measuring the author's
  vocabulary rather than the finding.

## [0.22.0] - 2026-09-16

### Added
- `coder-retention-v1` measures the coder at medium complexity, the busiest
  routing cell and the one the corpus could not measure at all after
  `refactor-config-v1` saturated (#159). Four surfaces across four modules
  answer the same retention question four ways; the correct answer is split
  between a contract file and a checked-in test the contract never mentions, so
  the majority behaviour is wrong and a model that carefully preserves what the
  code does today fails. Calibrated on four models across two vendors before
  being committed: 0.78-0.88 for the cheapest with nothing accepted, 0.94-1.00
  for the dearest. A first version, with three surfaces in one file and both
  rules stated plainly, was solved outright by the cheapest model and rebuilt.

- `docs/benchmark-scoring-research.md` records how public coding and agentic
  benchmarks actually score model output, with sources and confidence labels:
  which scorer families are reliable and how they fail, what the contamination
  audits found, how many repeats a ranking claim needs, the published saturation
  index, and which of this bench's own checks were reinventing named techniques.
  Commissioned because a bench justified only by its author's taste is not
  defensible.

### Fixed
- `planner-contract-carry-v1` scored the task author's reading of "applicable"
  rather than the model's ability to select (#161). Six models across four
  families and two vendors scored 0.82 by failing one check identically, and the
  most expensive scored lowest -- the inverted signature this project's own
  health check calls a broken task. Three separate defects: the fixture's third
  rule governed identifier validation while the change reads a report by id, so
  carrying it was defensible; the check demanded exactly two rules, so a plan
  that also carried a real invariant read from the code was marked wrong; and
  verification demanded a verbatim contract quotation from entries sourced to
  the code, where no verbatim text exists. The rule is now plainly inapplicable,
  the check forbids that rule rather than everything unlisted, and verbatim
  matching applies only to entries claiming to quote a contract file.

## [0.21.1] - 2026-09-16

### Fixed
- A symlink to a DIRECTORY was invisible to the scope check, whatever the task's
  allow-list said. Reading one throws `EISDIR`, and the snapshot skipped any path
  it could not read, so the path left both snapshots and nothing could compare
  it. An unreadable path is now recorded by its error code instead of dropped:
  present, and unequal to any readable version of itself, so appearing,
  disappearing and changing kind all count as changes. Found by review.
- `extractJsonArtifact` rescanned to the end of the output from every unclosed
  bracket, so an answer carrying many of them cost 38 seconds at 288KB and would
  have stalled a sweep. A bracket that closes nowhere now resumes the scan at the
  next line, which leaves a multi-line answer reachable: 10ms on the same input.

## [0.21.0] - 2026-09-16

### Added
- Every target-scored task now measures what the model touched that nobody asked
  about. A task declares `writes`, an allow-list of path globs, and a
  `stays-in-scope` check; the runner snapshots the target before and after the
  run and fails the check when anything outside the list was added, rewritten or
  deleted, naming the offending paths as `strayPaths` in the measurement. Until
  now a model that fixed the named function and also pulled in a logging
  framework, reformatted a neighbouring module and left a scratch file behind
  scored a clean 1.00 in every task in the corpus.
- A task may forbid a tool. It declares `forbids` beside a
  `honours-prohibitions` check, and the runner reads the tool names every ledger
  row already carries, so one mechanism covers every role and every mode rather
  than needing a task per prohibition. `security-plan-threats-v1` forbids `bash`:
  its role prompt says not to run the project's test suite, and until now no
  prompt prohibition anywhere but one orchestrator task was verified at all.

- Three tasks now check their claims against the fixture rather than reading back
  what the model asserted. An auditor citing a contract file that does not exist
  or a function `src/` never exports, a reviewer citing a line past the end of a
  seventeen-line file, and a security answer filed against a plan step nobody
  wrote all scored full marks before; each is now the heaviest check in its task,
  and each task carries a `.gamed.json` sample proving it.

### Fixed
- The calibration artifact extractor read from the first bracket in the output,
  so a bracket in the prose before the answer was returned as the answer. A live
  planner explaining an id format as `[a-z0-9-]` had that character class scored
  as its entire plan: no scorer could read it, and a run that passed every check
  was recorded as `unreadable_answer` at quality 0.12. The answer is now the last
  top-level span that parses, since requiring a span to parse rules out a
  character class but not valid JSON quoted in the prose above the answer.
- Three boundary defects in the new reality checks, each of which punished an
  imprecise answer rather than an invented one, or missed the likeliest
  fabrication. A file's line count was one too high for any file ending in a
  newline, so a citation one line past the end passed. A bare `errors.md` was
  rejected although that file exists. A step written `"step 3"` parsed as NaN.
- The scope snapshot did not see `chmod +x`. Content changed and then restored is
  still deliberately not a change: `reviewer.md` instructs the Reviewer to revert
  a diff, run the test, and restore the tree exactly as it found it.

## [0.20.2] - 2026-09-16

### Changed
- `docs/CHECKPOINT.md` records the calibration bench rebuild and the `recorder`
  role retirement it rested on: what the bench stopped reporting falsely, what it
  stopped measuring by shape, the two capabilities it now measures, and the live
  results and costs behind those conclusions.

## [0.20.1] - 2026-09-16

### Fixed
- `refactor-config-v1` never ran a coder. It declared `role: coder` and mode
  `manual-workflow`, so the orchestrator did the work itself and the measurement
  reported `model: null` -- the measured role was absent from the ledger. It now
  runs as a `role` task, and `extracts-shared-parser` is weighted 5 of 13 rather
  than 2 of 10, since keeping the duplication while breaking nothing should not
  score most of the marks for a task about removing duplication.

### Changed
- `refactor-config-v1` is `smoke`. Re-measured properly, all three models score
  1.00, so the health check's saturation flag was right -- though for the wrong
  reason, since its samples had measured one orchestrator rather than three
  coders.

## [0.20.0] - 2026-09-16

### Added
- `planner-absent-artifact-v1`: a plan is requested against two documents that do
  not exist, in a fixture that is otherwise real. The honest answer reports the
  block, names both absent documents, proves it looked by naming what it did
  read, asks for something specific, and writes no steps for the spec nobody
  wrote. Public benchmarks reward answering rather than asking, so the shape is
  written here rather than adapted. Marked `smoke`: every model tried scores
  1.00, so it guards a behaviour the role prompt already secures rather than
  telling models apart.

## [0.19.0] - 2026-09-16

### Added
- `orchestrator-decompose-v1`: the first task measuring task decomposition, the
  operation `decompose_task` exists for and nothing measured. A six-requirement
  ticket where one requirement is already satisfied by the code, one reads as two
  and is one, two read as one and are two, and one pair carries the only real
  ordering dependency. Checks ask for those properties rather than for a single
  correct answer -- a decomposition has many right shapes and a few wrong ones.
- `OrchestratorReport.finalText` carries the last turn's own words, for a task
  whose answer is the text rather than the state a tool left behind.

### Fixed
- A repeat summary dropped each run's orchestrator report, so a manual-workflow
  task's only record of what happened was lost exactly when runs were repeated.

## [0.18.0] - 2026-09-16

### Added
- `calibration:health` names any corpus task that has stopped discriminating,
  from the recorded evidence. **Saturated**: every model of every price is
  accepted, so the task cannot inform a routing decision. **Inverted**: quality
  falls as price rises, which is the signature of checks scoring something other
  than capability -- exactly how `planner-contract-carry-v1` looked before its
  prompt was fixed. Both defects this project has found were caught by a person
  reading a printout; both were visible in the numbers. It reports rather than
  fails, since the evidence is observational.

## [0.17.2] - 2026-09-16

### Changed
- `docs/model-calibration.md` records the rule the day's three identical bugs
  earned: a failure is data, not an exception. Each of them destroyed
  measurements instead of recording them, and each was somewhere nobody was
  looking -- so wherever this pipeline meets the unexpected, the question is what
  to record rather than whether to stop.

## [0.17.1] - 2026-09-16

### Fixed
- A repeat series no longer loses every completed run when one run aborts. The
  first live use of `--repeat 5` hit a stage limit on its last run and took four
  finished measurements down with it -- the same failure the scorers had, one bad
  run erasing the sample it belongs to. Each run is now caught and the series
  continues; the summary reports `scored` beside `repeat` and names what aborted,
  since a stage limit and a provider refusal are different problems.

## [0.17.0] - 2026-09-16

### Added
- `calibration:corpus -- run <task-id> --repeat N` runs a task N times and reports
  the spread: how many runs were accepted, worst/mean/best quality, total cost,
  and a tally of `harnessOutcome` saying how many runs reached a scored answer at
  all. One run does not measure a model, it samples one -- the same model on the
  same task produced 0.43, 0.79, an unreadable answer and 1.00 in one sitting.
  The worst run is printed beside the mean because that is the one an operator
  lives with.

## [0.16.0] - 2026-09-16

### Added
- An artifact-scored task may ship a `.gamed.json` sample: the specific evasion
  its scorer claims to defend against, required to score at most two thirds of
  the task's weight. Pass and fail samples prove a scorer can separate good from
  bad; this one proves the claimed defence actually holds. It caught one
  immediately -- the reviewer task's precision check was weighted so that six
  blocking findings instead of two cost an evasion fourteen percent of the
  score, leaving a list of guesses scoring 0.86.

### Changed
- `bounded-blocking-findings` is weighted 7 of 19 on the reviewer task. Precision
  is not a footnote to a review: an evasion that reports both real defects and
  four plausible guesses now scores 0.63 against an honest review's 1.00.

## [0.15.2] - 2026-09-16

### Fixed
- The refactoring task's `extracts-shared-parser` check counted a `parse*`
  declaration and two call sites, which a model satisfies while leaving the
  duplication exactly where it was -- declare a wrapper, call it once, keep both
  original bodies. The task exists to test that ONE parser now serves both entry
  points, so the check asks for that: one parser declared, every entry point
  calling it, and no entry point still trimming the value itself.

## [0.15.1] - 2026-09-16

### Changed
- A corpus task declares its `purpose`: `calibration` for one whose result may
  move a routing cell, `smoke` for one kept because it proves the harness still
  dispatches, materializes and scores. The three trivial coder tasks are now
  `smoke`: the cheapest model on the provider scored nine of nine at quality 1.00
  across them, which says only that it is not broken, and unlabelled such a score
  can justify routing a tier the tasks cannot discriminate within. The corpus
  smoke reports the two counts separately.

## [0.15.0] - 2026-09-16

### Added
- A calibration measurement now records `harnessOutcome` beside `quality`:
  `clean`, `unreadable_answer`, `tool_error`, `stage_limit` or `provider_error`.
  A zero from a bad answer and a zero from a refused tool or an exhausted stage
  are different facts, and the quality number cannot separate them -- the last
  two are evidence about the harness, not the model. The value is derived from
  the ledger's own stop reasons where it can be, and stated by the runner for
  the one case the ledger cannot see: an answer no scorer could read.

## [0.14.1] - 2026-09-16

### Fixed
- A scorer that could not read a model's answer threw, which the runner reported
  as a failed run rather than a failed review -- so the measurement left the
  sample entirely. A live sweep lost a third of one cell's runs that way, every
  one of them a bad answer, which flattered the model. All five artifact scorers
  now treat an unreadable answer as an empty one and fail every check.
- Negative checks scored an empty answer for free: "avoided the false positive"
  and "kept findings bounded" were both satisfied by producing nothing, so
  garbage output earned points for restraint. They now require an answer first.
- The reviewer task asks for evidence per finding and bounds how many blocking
  findings a review may raise. Published code-review benchmarks put the
  bottleneck on precision rather than recall: a review that lists everything it
  suspects is as unusable as one that lists nothing, because the reader cannot
  tell which findings to act on. The cap is four against two seeded defects --
  room to split one defect in two, none for a list of guesses -- and the
  requirement is stated in the task prompt rather than assumed by the scorer.

## [0.14.0] - 2026-09-16

### Added
- A calibration measurement now names the **provider** that served each model,
  not only the model. The same name behind two providers can be a different
  quantization, context ceiling and set of supported thinking levels --
  `docs/provider-catalogs.md` already records `deepseek-v4-pro` accepting `low`
  on opencode-go and marked unsupported on openrouter. Measurements are meant to
  be published, and one without a provider invites a reader to carry a score to a
  host where it does not hold. Per-model shares aggregate on
  `(role, provider, model)`, so comparing one model across two hosts no longer
  sums them into a single row.

## [0.13.4] - 2026-09-16

### Fixed
- `planner-contract-carry-v1` scored two requirements its prompt never stated,
  and so failed every model put to it: 20 runs out of 20 across five models and
  four families, with the ranking inverted -- the most expensive model scored
  worst. The prompt now asks for what the checks measure: carry only the rules
  the change must obey, and rate evidence `asserted` when the task describes work
  to be done rather than a defect the code shows.

## [0.13.3] - 2026-09-16

### Fixed
- The calibration corpus now tells a run which routing cell it is measuring.
  Every task names the `(role, complexity)` cell it exists to measure and the
  measurement is labelled with it, but nothing passed that on, so each task ran
  at the built-in default of `medium`. A trivial task therefore reported a
  trivial-cell result taken on whatever model the medium cell named -- not a
  wrong number, a number crediting the wrong model. A later explicit
  `--default-complexity` still wins, so a task can still be aimed at a
  neighbouring cell deliberately.

## [0.13.2] - 2026-09-16

### Fixed
- The committed project calibration snapshot still named the `recorder` role, so
  every command that loads a user profile failed with `invalid user profile:
  calibrated routing profile is invalid` -- `ad-coder config show` would not run
  at all in a fresh clone. The 0.13.0 rename cleaned the code and the machine's
  own config but missed the data this repository carries in `.ad-coder/`, which
  is tracked deliberately so a project can ship its routing.

## [0.13.1] - 2026-09-16

### Fixed
- The `planner-contract-carry` calibration scorer no longer scores a keyword bag.
  It checked that some carried rule contained one of a group of words, which two
  answers satisfied without doing the task: pasting the whole contract file
  scored identically to selecting the two applicable rules, and boilerplate
  invented from the expected vocabulary, sourced to "made up", scored full marks
  too. A carried rule is a quotation, so it is now verified against the fixture's
  own contract file, and a new `carries-only-applicable-rules` check asks whether
  only the rules this change touches arrived.
- The researcher scorer's citation check is renamed `cites-a-well-formed-source`.
  It validates URL shape and nothing more -- the scorer sees the artifact alone,
  with no ledger and no fetch log -- so the old name `cites-a-fetched-source`
  claimed a verification it never performed and would have credited a fabricated
  citation as evidence of research.

### Added
- `docs/opencode-go-economics.md` records what an OpenCode Go subscription buys:
  the per-model allowance is a multiplier on the $10 paid rather than a ceiling,
  allowances multiply across models rather than adding up, and they do not track
  token price -- two identically priced GLM models are allowed $15 and $60. Also
  records the DeepSeek peak-hour split and the promotion ending 2026-09-20.

## [0.13.0] - 2026-09-16

### Changed
- The `recorder` profile role is gone. It was reserved while a recorder role was
  planned; nothing ever dispatched one, no prompt defined one, and `ROLE_NAMES`
  never listed one -- but the cell was quietly read for something real: it chose
  the compaction summarizer model. It is now named `summarizer`, which is what
  it does. A profile still naming `recorder` is rejected as `unknown_role`, like
  any other unknown role. **Breaking:** rename the role in any saved profile or
  inventory.
- `--summarizer-model` now overrides the `summarizer` profile cell the way every
  other `--<role>-model` flag overrides its own, instead of being resolved
  beside that path. Two consequences: the startup banner reports the model
  compaction will actually use rather than the cell the flag replaced, and an
  unregistered name raises `ProfileError('unknown_model')` like every other
  role rather than a bare `RegistryError`.

### Added
- `config show` reports `summarizerModel` and where it came from. Compaction
  rewrites the entire history, so which model performs it is a routing decision
  worth checking before a run; until now the only way to learn it was to read
  the profile and reimplement the override precedence by hand.

### Fixed
- CLI tests no longer read the developer's own saved profile. They spawn the
  real binary, which inherited `XDG_CONFIG_HOME`, so a profile the CLI rejects
  failed a test about something else entirely -- on one machine and not in CI.
  Each run now gets an empty config home unless the test chooses its own.

## [0.12.3] - 2026-09-16

### Added
- Calibration corpus coverage for the four roles that had none: planner,
  security, auditor and researcher. Each task ships a fixture or prompt with a
  planted false positive -- a validated id that only looks like path traversal,
  an authorization door that is genuinely closed, an invented HTTP header -- so
  a model that pattern-matches instead of reading scores worse than one that
  reads.
- Every corpus task must now declare where its shape came from: a link, a
  licence, and what was taken. Required of all tasks rather than only new ones,
  because a grandfather list rots and an absent field soon reads the same as an
  oversight. `docs/model-calibration.md` records the licence of each source the
  corpus draws on and the rule it follows: adapt forms, never copy content.
- `corpus.ts smoke` now exercises artifact- and report-scored tasks too, against
  checked-in pass/fail sample answers, and `bun test` runs it. Those scorers
  were previously unexercised until a live calibration run hours later, so a
  scorer stuck at `true` -- the failure that silently reports every model as
  perfect -- had no way to be caught early.

### Fixed
- A standalone role no longer receives two contradictory instructions. Role
  prompts are written for the pipeline, where a `submit_*` tool owns the result;
  the Planner's prompt forbids the plan in assistant text for exactly that
  reason. Standalone strips those tools, so the role was told both to withhold
  the result and to return it, and obeyed whichever it weighed higher. The
  override now names the rule it displaces.

## [0.12.2] - 2026-09-15

### Fixed
- Compaction no longer writes a prompt cache nobody can read. The summarizer
  request took pi-ai's default `cacheRetention` of `"short"`, so every
  compaction paid the cache-WRITE premium on the largest input a run produces --
  a transcript that is replaced by its own summary the moment the call returns,
  leaving the entry with no possible reader. On Anthropic that premium is 25%
  over the plain input price. The request now asks for `"none"`; role turns,
  whose prefix genuinely repeats, keep their configured retention.

## [0.12.1] - 2026-09-15

### Added
- `docs/pi-capabilities.md` records a research note on cross-model context handoff, verified by reading the installed
  pi-ai 0.85.1 adapter sources rather than its documentation. Handoff is already implemented inside those adapters:
  on a model mismatch they drop redacted thinking, downgrade ordinary thinking to text, strip tool-call thought
  signatures, renormalise tool-call ids for the target API, and backfill orphaned tool calls with synthetic error
  results. It fires on a model switch WITHIN one provider too, not only across providers -- so ad-coder need not
  reinvent signature and thinking splicing at the model boundary. What remains ours: compaction when moving to a
  smaller context window, pipeline resume not checking the model a stage previously ran on, and the fact that this
  degradation is invisible in the ledger and on stderr.

## [0.12.0] - 2026-09-15

### Added
- `bun run calibration:corpus -- run <task-id>` executes one corpus task for
  real: it materializes the fixture, invokes ad-coder in the task's declared mode
  (`role`, `drive --auto`, or a scripted `console --json` session), reads the
  ledger the front reports, scores it and emits the measurement. Until now the
  corpus could only list, validate and smoke-test its scorers -- it never ran the
  agent it was supposed to be measuring.
- Every front that runs model turns now names its run on stderr before the first
  turn: `ad-coder: runId=<id> ledger=<path>`. An operator (and the bench) can
  point at a run's evidence without guessing how the file was named.

### Changed
- `drive`, `console` and detached pipeline workers write the durable ledger file
  again. Each front needs a readable sink to report its own cost, and installing
  one used to REPLACE the file sink -- so whole multi-role sessions left nothing
  under `.ad-coder/ledger` while `ad-coder role` did. The readable sink now
  mirrors to that file instead of displacing it, and takes its in-memory copy
  first so a failing mirror cannot also cost the caller the numbers it reads back.
- A calibration measurement attributes cost per `(role, model)` pair instead of
  crediting the whole run to whoever took the first turn. `model` names the model
  that ran the roles the task measures; the new `models[]` lists every pair,
  costliest first. A task whose dispatch `role` is not itself a ledger role --
  every `automatic-pipeline` task dispatches as `pipeline`, while its rows carry
  `coder`/`reviewer` -- declares `measuredRoles`, and the corpus runner refuses to
  load one that does not. Without it those runs reported `model: null` silently,
  which is the one mode multi-role attribution exists for.
- The orchestrator complexity votes are read from the run instead of being passed
  in: `calibration:score` no longer takes the two complexity positionals, and the
  orchestrator scorer derives them from an observed report. It additionally
  requires the classification to PRECEDE any delegating tool call, and requires a
  ledger row stepped `role:planner` to credit the planner cross-check -- console
  JSON carries tool names without arguments, so nothing else can prove which role
  was delegated.

## [0.11.0] - 2026-09-15

### Added
- `orchestrator` is a routing role: it has its own `(role, complexity)` cell in
  every profile, so an operator can name its model per complexity and a
  calibration run can attribute its cost separately from the work it delegates.
  A default profile now emits 24 cells (8 roles x 3 complexities) and routes the
  orchestrator to the review tier -- it reads results and picks the next move
  rather than producing the work.

### Changed
- The orchestrator no longer falls back to the coder's profile cell when
  `--orchestrator-model` is absent. Borrowing that cell meant a profile could not
  route the orchestrator at all, and every measurement of it was really a
  measurement of the coder. An explicit `--orchestrator-model` now also reaches
  the override layer like every other role flag. A profile authored before the
  cell existed keeps working: a missing orchestrator cell falls back to the
  coder route it used to take and prints one stderr notice, so committed
  inventories are not invalidated by the new role. The fallback covers that one
  role only -- a missing cell for any other role still fails as before.

## [0.10.7] - 2026-09-15

### Fixed
- The startup banner reported three collapsed tiers instead of the routing the
  run will actually use. With an inventory, `strong`/`mid`/`cheap` all fall back
  to the same default model, so the line read `provider "custom" | strong "x" mid
  "x" cheap "x"` for a profile routing seven roles across four models -- true of
  nothing. It now names the routing source (the inventory by name, or the
  provider), the default complexity, and every role grouped by the model it
  resolves to at that complexity. The role list is walked from the profile
  layer's own exported vocabulary, so a role added there cannot go unreported.

## [0.10.6] - 2026-09-15

### Fixed
- The opencode-go examples in `README.md` and `docs/provider-catalogs.md` were
  copy-pasteable into an HTTP 400 `MissingSessionID`: the account rejects every
  request without an `x-opencode-session` header, and neither the shipped catalog
  nor pi-ai's own opencode provider supplies one. Both examples now name the
  header to declare by hand and link the issue that will make the provider carry
  it (#120).

## [0.10.5] - 2026-09-15

### Added
- `/cost` and `/cost release <provider>/<model>` in the console: list the models
  this project has blocked for billing above their declared price, and accept a
  model's new price without leaving the session. The console reaches the SAME
  detector the run refuses on -- it is handed the session's own object, not a
  second copy over the same file -- so a release lifts the block that is actually
  standing.

### Fixed
- A price block mid-turn no longer renders as the generic "console turn failed;
  retry the prompt". The console now has a typed `CostAnomalyBlockedError` branch
  naming the declared amount, the billed amount, the overcharge, how many
  responses confirmed it, and the `/cost release` that accepts it; the prompt
  comes back so the operator can type it. The old text advised a retry that could
  only fail again.
- `ad-coder cost release ...` failed with `targetDir must be a non-empty path`
  when run without `--target-dir`. It now defaults to the current directory, the
  same as `console`, so the refusal's own advice is followable.

### Changed
- Two contract lines: a front must branch on EVERY typed error its surface can
  raise (`docs/contracts/errors.md`), and every front offers the same
  capabilities, differing only in rendering, with the decision in shared headless
  code (`docs/contracts/cli.md`).

## [0.10.4] - 2026-09-15

### Added
- `/start <task>` starts a background pipeline run straight from the console.
  The rest of the line is taken verbatim as the task, the run is detached so it
  outlives the turn that asked for it, and no model turn is consumed -- the
  operator keeps the dialogue while the run proceeds. The command is declared in
  the console registry, so `/help` renders it and the "enable it with
  `--workflows pipeline`" guidance applies without a second declaration.

### Fixed
- The console now builds a background host launcher and a stable owner id of its
  own. Without them `start_pipeline` and `/start` could admit a run but never
  start one: only `ad-coder background start` wired a launcher, so every
  console-initiated run failed `launch_failed`.
- The default background owner id no longer embeds the target directory. The
  manager requires a bounded opaque token, which a path breaks on its first
  slash, so every `ad-coder background` command run without `--owner-id` failed
  `invalid_request` before it could reach a record. The directory is hashed
  instead, which also keeps a filesystem path out of durable state, and one
  user + one target still resolve to the same scope across processes.
- Console controls now render in the order they were typed. `/start` is the
  first control that awaits a host launcher, and an unserialized control lane
  rendered a later `/list` before the `/start` whose run it was meant to list.
  Shutdown waits for in-flight controls only up to `controlDrainMs`, so a host
  launcher that never spawns -- or a provider that ignores a `/interrupt`
  cancellation -- cannot hold `/exit` or Ctrl-C open, leave the session unclosed
  or strand the terminal in raw mode. An abandoned control is reported as
  `deadline_exceeded` rather than passing for a clean exit.
- `launch_failed` and `resource_limit` from the background run manager now
  surface as typed, retryable console failures naming the next action, instead
  of collapsing into an opaque `invalid_request`.

### Changed
- `background` and `console` share one declaration of the background run
  options (`--owner-id`, `--background-max-active`, `--same-target-policy`)
  rather than repeating them, which is exactly the drift the single command
  registry exists to prevent.
- A console command whose argument is a whole sentence declares `argMode:
  "verbatim"` in the registry, so parsing selects on a declared property the way
  dispatch already selects on `frontAction`, instead of matching `/start` by
  name.

## [0.10.3] - 2026-09-15

### Fixed
- The orchestrated session now owns ONE tool-activity channel and shares it with
  every delegated `run_role` worker and every pipeline stage. A conversation that
  is handed no channel builds a private one, so nested work published where
  nobody could subscribe: a console watching the session saw only the
  orchestrator's own tool calls and went silent for as long as a delegated role
  ran. `subscribeToolActivity` on the returned session now reads that shared
  channel. Existing bounds are unchanged -- per-subscriber pending capacity
  still caps each consumer's queue and over-capacity events are counted as
  drops -- and a channel supplied by the caller is neither closed nor
  double-subscribed by the session.

## [0.10.2] - 2026-09-15

### Changed
- Unresolved work moved out of `docs/BACKLOG.md` and into nine grouped GitHub
  epic issues (#100-#108), so more than one person can pick items up without
  colliding and so discussion sits next to the item instead of in a commit that
  rewrote a shared file. `docs/BACKLOG.md` is now an index of those epics; its
  prose history remains in git. `AGENTS.md`, `README.md`, `docs/ARCHITECTURE.md`
  and `docs/ROADMAP.md` now point unresolved work at an issue rather than at the
  file. No behavior changes.

## [0.10.1] - 2026-09-15

### Added
- Three operator-reported backlog items recorded, none implemented: report what
  a turn spent inside the turn rather than only against session limits; give the
  Orchestrator a bounded read-only view of its own spend history, so that asking
  what a run cost stops meaning shelling out to parse the ledger; and colour the
  console, which currently renders activity, turn boundaries and errors in one
  undifferentiated stream. A fourth records that the console has no command to
  report which provider and models the running session resolved to. A fifth
  records that one orchestration test
  pins a performance property by comparing wall-clock times, so it fails at
  random under full-suite load on an unchanged tree.

## [0.10.0] - 2026-09-15

### Fixed
- Cost-anomaly detection compared the configuration against itself and could
  never have worked. `usage.cost` is not a provider fact: pi-ai computes it by
  multiplying the settled token counts by the prices in the operator's own
  registry config. The detector read that as "provider-reported cost", so both
  sides of every comparison came from the same price table and a genuine
  provider reprice was mathematically invisible to it -- while the contract
  promised detection on the price actually charged.
- The detector now asks the provider for what it billed and compares that to
  what the configured price list predicts for the same response. OpenRouter
  reports the amount, on the streaming path runs actually use, when the request
  carries `usage: {include: true}`; under a caller's own upstream key it
  reports `is_byok`, zeroes that field and carries the real amount separately.
  Both are read, and never summed -- on a normal response they are the same
  charge printed twice, so adding them would report a 2x overcharge on correct
  billing.
- False blocks are gone, and they were not a tuning problem. The old observable
  was dollars per token, which varies by orders of magnitude at a completely
  constant price: within one price list an output token costs multiples of an
  input token and an input token multiples of a cache read. Measured on this
  project's own dogfood runs, one model's legitimate baseline spread was 8.3x
  against a 2.0x block threshold, and the run it blocked was billed at 1.0000,
  1.0000 and 1.0171 times its configured price -- correct billing, blocked. The
  ratio of charged to expected has composition in both halves, so it cancels.

- A response too large to scan no longer keeps its own body alive. The billed
  amount is read off a teed branch of the response, and a teed branch that is
  abandoned while the source still has bytes keeps buffering every one of them,
  so giving up on an oversized body by releasing the reader retained exactly
  the body the size guard existed to avoid retaining. The branch is now
  cancelled; the caller still receives every byte, because a teed source is
  only released once both branches let go.
- Upgrading past a 0.9.0 project no longer faults on its own saved state. The
  persisted scope shape changed with the reference, but the schema tag stayed
  1, so a file written by the previous release was read as though it were
  current: the first observation faulted on a missing field, and a scope that
  release had already blocked faulted at the Models boundary every generation
  passes through -- not a refusal, which is typed and actionable, but a crash.
  The tag is now 2 and a version-1 file is discarded like any other shape this
  release cannot read. Nothing needs rebuilding: the reference is declared, not
  learned, so the only loss is recent history.

### Changed
- The reference is the DECLARED price, not a learned baseline, and no traffic
  can move it. A learned baseline cannot tell a discount ending from a price
  rising: a backend billing under the declared price teaches the baseline that
  the discount is normal, so the ordinary price returning reads as a spike and
  blocks a session paying exactly what was agreed. It also absorbs a reprice
  that arrives in small steps, one acceptable-looking step at a time. Only an
  explicit `cost release` moves the reference, by recording the confirmed ratio
  as that scope's accepted ceiling.
- There is no warm-up and no `insufficient_evidence` state. With nothing to
  accumulate, the first settled response is already checkable, so a reprice
  already in effect before a project's first run is caught rather than silently
  learned as normal. `minBaselineSamples` and `baselineWindow` are gone with
  it; the default threshold is now 1.25, affordable because a correctly billed
  response sits at 1.00 whatever its token mix.
- A scope whose provider reports no billed amount now reports `no_charge_data`
  and never blocks, instead of manufacturing a verdict out of the very price
  list it is meant to be checking. Measured: OpenCode Zen returns token counts
  and no amount at all, and ignores `usage: {include: true}`. Asking for the
  amount is limited to providers known to report one, so an unknown field
  cannot turn every request to a strict provider into a 400.
- A block now names the dollars charged and the dollars expected across the
  confirming responses, rather than two per-token rates, so the operator can
  check them against a provider invoice directly.


## [0.9.0] - 2026-09-15

### Added
- Cost-anomaly detection: a per-`(provider, model)` price-step detector that
  refuses to START new runs on a scope whose observed cost-per-token has
  stepped up, until the operator explicitly releases it. On by default,
  disableable, and every threshold configurable.
- The baseline is the MEDIAN of a recent window, not the mean. A mean is
  dragged toward any outlier inside the window -- including the leading edge of
  the very repricing being detected -- so a real step can push the baseline far
  enough to mask itself. A measured case: with a baseline window carrying one
  large reading, the mean puts a genuine 3x step at ratio 0.14 and stays
  silent, while the median reports it at 3.0.
- A suspected spike is held in a separate `pending` list and never folded into
  the baseline it is measured against; otherwise the alarm would teach itself
  to stop ringing. A single reading never blocks -- a confirming count is
  required, and any return to normal discards the pending evidence, so
  unrelated artifacts hours apart cannot accumulate into a false alarm.
- The refusal is a START-only refusal, applied at the single `Models` boundary
  in the runner, OUTSIDE the session and stage limit controllers. Work already
  in flight is never killed, because that money is already committed, and a
  refused start does not consume one of the session's counted turns.
- A block names only scope, ratio and both rates, plus the release command --
  no prompts, payloads or credentials, in the error message or in persisted
  state.
- The detector is constructed for every run resolved through the CLI and
  threaded to the runner, so "on by default" is a property of the shipped
  pipeline rather than of a class nobody builds.
- Scope state is durable per project (`.ad-coder/cost-anomaly.json`), written
  whole through a temp file and renamed. A block raised by an unattended run is
  therefore still standing at the next start, and an accepted price stays
  accepted. A corrupt or unreadable file costs a baseline and re-learns it,
  rather than reading as a false all-clear that unblocks every scope.
- `ad-coder cost status` lists what is blocked and `ad-coder cost release
  <provider>/<model>` accepts a model's new price -- the command the refusal
  itself names, so its advice can actually be followed. Releasing a scope that
  is not blocked is reported rather than treated as success, so a mistyped
  scope cannot read as "released" while the real block stays up.

### Fixed
- A refusal no longer outlives the run it refused. The typed error stashed for
  replay past the harness boundary was never cleared, so one blocked scope
  reported its block for the next run on a DIFFERENT model, and kept reporting
  it after the operator released it -- wedging every model in the session shut.
  It is now cleared on entry to every admission and consumed when replayed.
## [0.8.4] - 2026-09-15

### Fixed

- The planner text fallback now reads the shapes planners actually emit, and a
  rejected submission is retried instead of being fatal on the first try. Three
  consecutive real runs died in the plan stage after the planner HAD produced a
  complete surface analysis: `parsePlanText` accepted only a bare `{...}`
  object, so a ```json fence, a `submit_plan arguments: {...}` prefix and a
  response truncated mid-field all returned `undefined` -- indistinguishable
  from a planner that said nothing. The caller consumed the attempt without
  recording a failure and finally reported `missing_plan`, "planner did not
  submit required surface analysis", which sent the operator looking for a stage
  that never ran instead of at the handoff that was refused.

  The fallback now extracts the first balanced object (string- and
  escape-aware), unwraps a fenced block, and splits its outcome three ways:
  a plan, `undefined` only for genuine silence, and `malformed_plan` whenever
  plan-shaped content was present but unusable -- including truncation, which
  now says so by name rather than passing as silence. The retry loop gives a
  rejected submission the same attempt budget a missing one already had (it used
  to break on the first rejection, punishing a near-miss harder than a total
  miss), tells the next turn which failure to correct, and reports the rejection
  itself once the budget is spent. `missing_plan` is now raised only when no
  attempt ever produced plan-shaped content. The retry text and the thrown
  message are fixed structure plus the validator's own wording; planner text
  never crosses the error boundary.

  Recovery does not get to guess. Every top-level object in the response is
  collected, and every candidate is parsed rather than just the first that
  validates: a planner that drafts a plan and then corrects itself emits two,
  and the real submission is the last -- so returning the first accepted a
  draft whose `securitySurface: "none"` overrode the correction's `"elevated"`
  and skipped the mandatory security phase with no error and no retry. Scanning
  only as far as the first balanced object made that protection depend on the
  shape of the response instead of its content: two fenced plans were caught,
  but a bare draft followed by a correction produced a single candidate and was
  returned silently -- the same bypass, still open for the commonest shape. Two
  DIFFERENT valid plans are now a rejection telling the planner to submit
  exactly one, which the retry budget can still fix; the same plan reaching the
  parser twice (a bare object and its own fenced copy) is one submission and
  still resolves. When every candidate fails, the one carrying `complexity` is
  reported rather than a nested `coverage` fragment the brace scan happened to
  lift out -- that fragment fails on whichever field it lacks first, and naming
  it sent the operator after a field the planner never got wrong.

- The planner instruction no longer forbids a shape the parser accepts. It
  demanded "no Markdown or prose", asking models to suppress the fenced form
  they emit by default; it now states that a complete object -- alone or inside
  one ```json fence -- is read, and that a cut-off object cannot be.

## [0.8.3] - 2026-09-15

### Added

- `config show` now reports the context window each role will ACTUALLY use, per
  role, with the source of that number and the budget derived from it
  (`contextWindow.<role>`, `contextBudgetMaxTokens.<role>`). The effective
  window was the one routing decision the command did not project: the number
  existed -- every role derives its budget from `model.contextWindow` -- but
  nothing surfaced it, so a config declaring `1000000` ran at `200000` with no
  way to see it. A window the resolver settled on its own now names what it was
  settled from: a catalog value clamped to the shared operating ceiling reads
  `catalog-clamped from 1000000`, not a bare `200000`.
- `ResolvedModelConfig` carries `contextWindowSource`
  (`declared` | `catalog` | `catalog-clamped` | `built-in-default`) and, when
  the clamp discarded something, `catalogContextWindow`. Provenance only -- a
  name and two integers.
- The provenance survives being validated twice, which is what every real
  `config show` does: the CLI validates the registry at its entry points and
  the config resolver validates again. Provenance was derived from whether a
  `contextWindow` was present, and after one pass it always is -- the pass
  itself wrote it -- so the second pass concluded an operator had declared
  every catalog window and dropped the clamped-from number. The projection was
  correct only when called as a library and wrong for the operators it was
  built for. Validation now carries an already-settled provenance through
  rather than re-deriving it, and refuses a source string it does not
  recognise.
- Two registry entries sharing one provider-native id but settling on
  different windows are now reported with the number and no source label,
  which is what the collision rule always promised. The comparison looked only
  at the source label, so two hand-declared entries -- both `declared`, both
  without a catalog number -- were judged identical and whichever was
  registered first answered for the other: a confident, specific, arbitrary
  attribution. The resolved window is now part of the comparison.
## [0.8.1] - 2026-09-15

### Changed

- Recorded four measured provider-admission and usage-accounting defects in the
  backlog. A provider whose API mandates a non-auth request header cannot be
  admitted at all, because `ProviderConfig` has no place to declare one;
  measured against OpenCode Zen, which rejects every completion without
  `x-opencode-session` and surfaces through ad-coder only as an empty turn with
  a zero-usage ledger record. `auth login` can persist an api key for exactly
  one hardcoded provider id. A per-role model override silently resets the
  selected inventory's provider destination. A provider that reports reasoning
  tokens outside its output count aborts an already-completed, already-paid-for
  role run over an accounting convention. The last of these now cites a
  durable evidence record in `docs/calibration-evidence.jsonl` rather than
  figures that lived only in a scratch ledger. Documentation only; no
  behavior change.
## [0.7.0] - 2026-09-15

### Fixed

- A provider that REFUSED a request is no longer reported as a missing
  credential. A settled failure with empty assistant text and zero usage has two
  very different causes and the transcript cannot tell them apart, so the runner
  called every one of them `empty_turn` and told the operator to "verify
  authentication and retry". A provider 400 over a malformed tool schema --
  rejected before the model ever ran, at zero cost -- therefore pointed at the
  one party that was not at fault, and the durable checkpoint recorded only
  "inspect the provider failure", naming neither the status nor the request.
  `runRole` and the conversation loop now read the settled failure's HTTP status
  and raise the new `ProviderRejectionError` for a client-error status,
  `RunCoordinator` pauses with `provider_rejected` and the status in its action,
  and the console offers the request -- model id, tool schemas, parameters --
  instead of an authentication command. 401 and 403 stay `empty_turn`, which is
  what those statuses actually mean; 429 is still `provider_limit`.
- The status is read from BOTH shapes pi-ai composes, not just one. Adapters
  that route through `formatProviderError` produce `"<status>: <body>"`, but
  `anthropic-messages` never calls it -- it assigns the provider SDK's own
  `APIError.message`, which is `"<status> <body>"` with a space and no colon.
  Matching only the first shape would have left every Anthropic-native model,
  and every OpenRouter model that overrides to `anthropic-messages`, still
  being told to verify authentication over a request the provider had refused
  on its merits -- the exact misattribution above, unfixed for one of the three
  request APIs this registry resolves. The second shape is anchored at the
  start and bounded to three digits followed by a space, so it reads a leading
  status and not a number appearing in prose.

### Added

- `ProviderRejectionError` and `providerRejectionStatusFrom` are exported.
  The error carries the run id and the numeric status ONLY: the response body
  that produced the status is read for the number and dropped, because an
  uncontrolled provider body must never cross an error boundary.
## [0.6.4] - 2026-09-15

### Added

- `docs/contracts/cost-anomaly.md`: an enforceable rule for what happens when a
  model suddenly starts costing more than it did. The failure it names is a step
  change in the unit price actually charged -- a provider repricing, a preset
  rerouting to a costlier backend, a cache that stopped being hit -- observed
  only after an unattended session has already paid it many times. Per-stage
  `maxCostUsd` does not catch it: every run stays under its own ceiling while
  every run costs several times yesterday's rate.

  Detection is on provider-reported cost per token for one `(provider, model)`
  scope, against a durable baseline of that same scope, confirmed by more than
  one settled observation, because providers report incomplete usage and a
  single anomalous reading is an artifact until it repeats. A first observation
  establishes a baseline and can never itself be a spike; too thin a baseline
  reports insufficient evidence rather than a verdict.

  On a confirmed spike new runs in the affected scope are REFUSED with a typed
  error naming the scope, the baseline, the observed rate, the ratio and the
  release action; work already in flight is not killed, since the money for the
  running stage is already committed and aborting it saves nothing. Release is
  an explicit, durable, per-scope operator act that re-baselines the scope, so a
  permanent reprice is accepted once rather than re-alarming forever. Enabled by
  default and configurable throughout. Implementation is tracked in
  `docs/BACKLOG.md`; no behavior ships in this release.
## [0.6.3] - 2026-09-15

### Fixed

- Two mandatory tool schemas no longer make a provider reject the whole
  request. `submit_plan` declared `surfaceAnalysis` as `Type.Any()`, which
  serialises to a bare `{}`, and `submit_follow_up` was a `Type.Union` of its
  four kinds, which serialises to a top-level `anyOf` rather than an object.
  Providers that validate tool schemas refuse both: DeepSeek answers
  400 "one of `type`, `anyOf`, `$ref` field is required" for the first and
  "schema must be a JSON Schema of `type: \"object\"`" for the second. Because
  `submit_follow_up` rides along on every workflow turn, a run against such a
  provider paused at the plan stage on an empty turn, having spent zero tokens
  and reporting only "inspect the provider failure" -- pointing the operator at
  the provider for a defect in this repository's own schemas. `surfaceAnalysis`
  is now spelled out structurally and the follow-up schema is one object with
  the per-kind fields optional. Neither change loosens a gate: the enum leaves
  stay plain strings exactly as `complexity` and `securitySurface` already did,
  and `parsePlan` and `validateFollowUpCandidate` remain the authoritative
  validators -- an unknown kind, or one kind carrying another kind's field, is
  still refused.
- An incomplete `submit_plan` or `submit_verdict` is now named instead of being
  reported as a submission that never happened. The harness validates tool
  arguments against the declared schema *before* `execute` runs, and a nested
  field that is not optional is listed in that schema's `required`. So a
  submission missing one leaf -- a coverage entry without `contractIds`, an
  issue without `what` -- was refused by the harness before the parser saw it:
  nothing was captured, the retry prompt told the role it had not called the
  tool when it had, and the run ended as `missing_plan` / `missing_verdict`.
  That is an invalid input reported as an absent one, which
  `docs/contracts/errors.md` forbids, and on the reviewer's side it also
  suppressed `parseVerdict`'s corrective message naming the exact contract IDs
  to resubmit -- the role's only route to a correct second attempt. Every
  nested field in both schemas is now optional, so each node still declares the
  `type` a validating provider demands while `parsePlan` and `parseVerdict`
  remain the single content gate. `submit_verdict` carried this defect before
  the schema work in this release; `submit_plan` acquired it with the fix
  above.

## [0.6.1] - 2026-09-15

### Fixed

- A profile's `cacheRetention` now reaches the request. It was parsed,
  validated, and carried as far as `ResolvedSelection`, where it was dropped:
  all three role-construction sites hardcoded `"short"` -- the two in
  `resolve-config` and, separately, the conversational role built by
  `startOrchestrator`, which read every neighbouring field off the resolved spec
  but restated this one as a literal. A declared `"long"` or `"none"` was
  silently inert, so the config said one thing while every request did another.
  On an Anthropic-shaped model that is the difference between a 5-minute and a
  1-hour cache TTL. A role whose profile states nothing still gets `"short"`.
  `maxOutput` remains advisory with no sink and is now documented as the only
  such field.

### Changed

- Every model ad-coder routes to now shares one 200000-token operating ceiling.
  A catalog-backed model previously inherited the provider's published window
  verbatim, which for several shipped models is 1000000 or more, so a run's real
  context ceiling depended on which model a routing cell happened to select, and
  a summarizer with a smaller window failed `assertSummarizerWindow` against the
  largest reachable model. The INHERITED window is now clamped to the same
  `DEFAULT_CONTEXT_WINDOW` a hand-declared model already received. An explicit
  `contextWindow` still wins verbatim, including one above the ceiling: the
  clamp is a default, not a cap. A window below the ceiling is left alone, since
  raising it would claim capacity the endpoint does not have. Shipped presets
  are aligned to the same number, except `deepseek-chat`, whose real window is
  64000 and which keeps it for that reason.

## [0.6.0] - 2026-09-15

### Added

- A registry provider can declare static request headers, so an API that
  mandates a non-auth header is reachable at all. Previously no such provider
  could be admitted: `ProviderConfig` had no header field, and while pi-ai
  accepts provider headers it never transmits them — both stream adapters read
  `model.headers` — so declared headers are flattened onto every model. Measured
  against a provider that rejects an unmarked request: without the header the
  role returned an empty turn with a zero-usage ledger record and no error at
  all; with it, all five models answered across both request APIs.
- A header value may contain `{{session}}`, expanded by the resolver to one
  opaque random identifier per resolved registry — the same value for every
  model of a run, a new value for the next — for APIs that demand a
  per-conversation routing marker a static config file cannot hold. Unknown
  placeholders are rejected rather than sent literally, where they would fail as
  an opaque provider routing error instead of a config error.
- A model can override the provider `baseUrl`, for one account fronting two
  request APIs under different path prefixes; each adapter appends its own
  suffix to the base URL it is handed.
- A provider can name a shipped model catalog (`"catalog": "openrouter"`, 31
  catalogs from 2 to 366 models) and take model ids, per-token costs, context
  windows, token ceilings, base URLs, request APIs and supported thinking
  levels from the pinned pi-ai data instead of restating them. Hand-written
  economics go stale silently and corrupt every routing and budget decision
  computed from them; building this surfaced four wrong values in our own draft
  inventory, including a price 2x over and a model assigned the wrong request
  API. Declared fields still win, `models` becomes an optional filter, and
  omitting it admits the whole catalog.
- Catalog-supplied thinking-level maps now reach the provider request, so a
  supported level is sent under the spelling that model expects rather than
  pi's. The map also names the levels a model does NOT support, which is a
  calibration input and not a repair: depending on the request format an
  unsupported level is forwarded verbatim, silently dropped, or replaced from a
  fixed table. Every `opencode-go` and OpenRouter model we route rejects at
  least one level we were using, and the same DeepSeek model accepts `low` on
  one provider and not the other — unknowable from a hand-written model list.
  Note that a level is in one of three states, not two: mapped, explicitly
  marked unsupported, or absent from the map entirely. The last two behave
  identically at dispatch, so only a mapped level is one to route at.

### Fixed

- The `reviewer-hidden-regression-v1` scorer matched finding codes against an
  exact string list, so it graded spelling rather than review quality: the task
  prompt asks for "concise stable defect codes" and names no vocabulary, and six
  models produced four spellings of the same path-traversal defect. Three
  reviews that found every seeded defect with executed evidence and correctly
  refused the tempting false positive scored 0.2. Codes are now reduced to word
  tokens and matched on a PAIR of words naming the specific defect, so a vague
  finding still fails and a non-blocking one still does not count. A finding
  that omits `blocking` but carries `severity: "blocker"` is read as blocking:
  an explicit `blocking: false` still wins, so a deliberate non-blocking finding
  is never credited.

### Security

- Declared headers are not a credential channel. The validator rejects any name
  that would carry or displace authentication (`authorization`, `x-api-key`,
  `cookie`, `cf-aig-authorization`, ...) or that the HTTP client owns
  (`user-agent`, `content-type`, ...), along with malformed field names, values
  outside printable ASCII (a newline would splice an extra header into the
  request), and duplicate names differing only by case. Failures name the
  header and never echo its value. Per-model `baseUrl` is https-only, as the
  provider field already was.
- A catalog provider must always resolve to a destination it named. Previously a
  provider that named a catalog, declared no `baseUrl`, and marked every one of
  its models `"catalog": false` produced `baseUrl: undefined` on the resolved pi
  model — and both vendor SDKs read an absent base URL as "use my own default
  host", so the declared credential would have been transmitted to the SDK
  vendor's endpoint rather than the operator's provider. That config is now an
  `invalid_config` rejection, and the provider's reported fallback takes the
  first model that actually has a base URL instead of whichever model is first.
- A model id the named catalog does not publish is rejected rather than
  resolved with whatever economics sit next to it, so a typo cannot silently
  become a priced model. An account-scoped id (an OpenRouter `@preset/...`,
  which no static catalog can know) requires an explicit `"catalog": false`
  marker, keeping the hand-written exception deliberate. An `api` override that
  contradicts the catalog is refused instead of producing an unroutable model,
  and catalog entries on request APIs the resolver cannot construct are never
  admitted. Operator-declared `compat` remains inert, unvalidated data; only the
  catalog's own compat — from the pinned dependency, not config text — is
  forwarded.

## [0.5.1] - 2026-09-14

### Fixed

- A stage that enters a final-response reserve no longer strips the tool schema
  in silence. The provider request that follows now carries the same instruction
  the tool rejection does — stop using tools and return the final response, with
  the reserve that tripped and its numbers — so a model that suddenly has no
  tools is told why. Without it, models answered the missing schema by emitting
  their own tool-call syntax as prose, and the role returned that garbage as its
  final answer. Observed on two unrelated model families across three runs and on
  two different reserves (`model_turns`, `input`).

## [0.5.0] - 2026-09-14

### Fixed

- `ad-coder update` no longer reports a global GitHub install as changed without
  verifying it. It now reads the installed revision before and after `bun add`,
  reports the real `previousRevision`, and derives `changed` from the comparison
  instead of hardcoding both. A stale pin in the global lockfile makes
  `bun add --global --force` reinstall the previous revision and still exit zero;
  that outcome now fails with the typed `install_mismatch` code naming the
  lockfile to repair, and `install_unverifiable` when no installed revision can
  be read at all.
- `UpdateError` now carries `retryable` and a next action, and `ad-coder update`
  projects both — as a structured record under `--json` and as recovery text on
  stderr otherwise — instead of emitting a bare message.

- Every `ad-coder update` failure now projects a recovery action, not only the
  two new verification codes: `not_checkout`, `dirty_checkout`, `detached_head`,
  `missing_upstream`, `invalid_revision`, and `command_failed` each name the next
  step, and a runner that cannot spawn is translated into a typed
  `command_failed` that keeps its causal error for programmatic callers.
- A usage error under `ad-coder update --json` or `ad-coder console --json` now
  emits the structured `usage` record instead of prose followed by the whole
  root help text, which corrupted stderr for a caller parsing it as JSON.

### Added

- Exported `readInstalledRevision` and the `UpdateErrorOptions` type from the
  library entry point, and an injectable `readInstalledRevision` hook on
  `UpdateOptions` so an install can be verified without a real Bun installation.
- Exported `projectCliError` and `renderCliError` from the CLI module so the
  machine and human failure shapes are reachable and testable without spawning
  a process.
- Widened two existing public types compatibly: `UpdateOptions.onStep` gained
  the `"verify"` step, and `UpdateErrorCode` gained `install_mismatch` and
  `install_unverifiable`. A consumer that annotates either narrowly by hand
  needs its annotation widened; runtime behavior for existing callers is
  unchanged.

## [0.4.0] - 2026-09-14

### Added

- `/help` console command listing every console command with its usage,
  description, and an example, and naming `--workflows pipeline` for the
  commands the session did not enable.
- Exported the console command registry (`CONSOLE_COMMANDS`,
  `consoleCommandUsage`, `consoleCommandNames`, `findConsoleCommand`) and the
  typed `ConsoleControlFailure` projection from the library entry point.
- `/help` now explains each command argument individually in both the formatted
  and JSON projections, rather than only naming it in the usage line.

### Changed

- Console command dispatch, argument validation, failure guidance, and help now
  render from one command registry instead of a hand-maintained usage string.
  `/exit` is dispatched through its registry entry rather than a literal name.
- Every console failure, including interruption, session limits, empty provider
  turns, turn failures, oversized input, unreadable input, and a failed session
  close, now reports the same typed projection with a recovery action and
  retryability instead of a bare code. Oversized input, unreadable input, and a
  failed close previously had no machine-mode record at all.
- Console failures now report a stable `code` with the failed command, concise
  text naming the failure, a `retryable` flag, and one recovery action in both
  the formatted and `console_error` JSON projections.

### Fixed

- Replaced the identical, unhelpful guidance every failed console command
  printed, which listed neither `/help` nor `/exit` and never explained why the
  command failed.
- Sanitized terminal control sequences out of the machine-mode `console_error`
  record; `JSON.stringify` leaves C1 controls intact, so untrusted command text
  could reach a terminal reading JSON output.
- Preserved the originating manager error as `cause` on `ConsoleControlError`
  for programmatic callers while still projecting only safe fields.

## [0.3.4] - 2026-09-14

### Fixed

- Reject empty OpenRouter API-key input and report login success only after the
  private credential store confirms that the key was retained.

## [0.3.3] - 2026-09-14

### Fixed

- Added the exact selected-provider authentication command to interactive
  console recovery after an empty failed provider turn.

## [0.3.2] - 2026-09-14

### Changed

- Made `openrouter-presets` the required default inventory profile for ad-coder
  dogfood and development unless the operator explicitly selects another.

## [0.3.1] - 2026-09-14

### Fixed

- Restored visible TTY input, newline echo, and destructive Backspace handling
  in the raw interactive console.

## [0.3.0] - 2026-09-14

### Fixed

- Fixed `ad-coder update` for global Bun GitHub installs by resolving and
  installing the exact `main` revision instead of trusting a stale Git lock.

- Reconciled role tool allow-lists with disabled plugin groups, preserved typed
  pre-provider tool-configuration failures, and made project reconnaissance
  parameters and failures unambiguous and actionable while retaining Planner's
  documented focused-read fallback.

### Added

- Added a single auto-loaded user runtime inventory at
  `~/.config/ad-coder/inventories.json`; first use seeds an editable OpenAI
  profile while preserving explicit per-run provider and model overrides.

- Added persistent OpenRouter API-key login, status, and logout through the
  private credential store, with hidden terminal input and environment fallback.
- Added `ad-coder update` for clean linked Git checkouts, with fail-closed branch
  and upstream validation, fast-forward-only pull, frozen install, and link refresh.

- Added explicitly selected, role-scoped Skills v1 with bounded secure
  built-in/project resolution, content digests, actionable typed failures,
  four orchestration skills, and console/library selection.

- Added responsive console-local controls plus configurable console page sizing and Escape-sequence timeout handling.

- Added `Escape`/`/interrupt` turn-only console interruption and local commands
  to list, inspect, read, and cancel detached pipeline runs without invoking the
  orchestrator model.

- Added detached background pipeline execution with owner-scoped polling,
  bounded cursor events, terminal results, cancellation, lease-based recovery,
  and JSON CLI access while the foreground conversation remains available.
- Added bounded, content-free owner-scoped background subscriptions with
  reconnect polling recovery and console lifecycle/stage/terminal stderr NDJSON
  notices that leave model turns and JSON result stdout untouched.

- Taught Orchestrator to accept complete terminal pipeline evidence and avoid
  duplicate post-pipeline reads and test runs.

- Kept incremental Coder and Reviewer retries focused when a change adds
  untracked files; their bounded paths remain available for explicit role reads.

- Added explicit model-inventory Researcher brief composition, trusted replacement-source configuration, and digest-only durable stage metadata.
- Added versioned portable user profiles with append-only economics history and
  always-JSON `profile show|export|import-preview|import-apply` CLI access.
- Added append-only server-reported `credit_balance` observations and atomic
  `profile record` input, so a future credit refill and balance delta can be
  measured without exporting account identity or raw provider responses.
- Added bounded `.ad-coder/calibration.json` snapshots, `profile snapshot`, and
  automatic project-calibrated routing for matching named inventories.
- Added typed, configurable closeout reserves for duration, model turns, and
  tool turns so bounded roles retain capacity to return their final result.
- Added an input-token closeout reserve and increased the default model-turn
  reserve from two to four after dogfood showed context-heavy turns and retried
  tool batches exhausting the prior closeout allowance. Final reserved requests
  now expose no tools, preventing another rejected tool loop; input closeout uses
  the preceding request to anticipate context growth.

- Added a headless named model-inventory layer and CLI selection that atomically
  pairs a provider/model registry with its role-by-complexity routing profile.

- Added native Orchestrator `resume_pipeline` support and safe aggregate stage
  usage/run identity in automatic pipeline results.
- Added `drive --resume-run` for stage-limit pauses, with actionable checkpoint
  output, unknown-run failure, task-binding protection, and rejection when the
  exhausted host budget was not raised or disabled.
- Added explicit `drive --resume-run <id> --retry-research` recovery for rejected
  Researcher output while preserving the accepted Planner result.
- Added configurable incremental pipeline retry handoffs, deterministic full-context
  fallback reasons, and durable per-stage handoff-strategy observability.
- Added `search_project`, a configurable ranked and byte-bounded task
  reconnaissance projection for all native pipeline roles.
- Added `read_project`, a configurable multi-file line-slice projection with
  one aggregate byte ceiling for every native pipeline role.
- Added a zero-disabled per-stage limit controller for duration, model turns,
  tool turns, input tokens, and provider-reported cost.
- Wired finite stage-budget defaults through the runner, durable coordinator,
  effective configuration, and CLI, with explicit resume of the incomplete stage.
- Added a bounded headless semantic tool-activity lifecycle stream, optional
  subscriptions, compact console grouping, and schema-v1 NDJSON progress on
  stderr with visible backpressure and subscriber drops.
- Added safe per-stage provider/model, thinking, duration, reasoning-token, cost,
  and context-strategy metrics to pipeline results and durable reports.
- Added per-stage UTF-8 byte measurements for the effective system prompt,
  stage handoff prompt, tool definitions, and their request-assembly total.

### Changed

- Standalone roles now checkpoint their run and can resume the same durable
  session and ledger with `role --resume-run` after a stage-limit pause or crash.
- CLI runs from inside `targetDir` now disable environment credentials so Bun's
  startup dotenv loading cannot import provider keys from the target project.
- Context-budget refusals now report their effective ceiling when a runtime model
  window is smaller than the role budget.
- Standalone `role` runs now persist their numeric usage ledger, print a safe
  usage envelope, stream semantic tool activity, and retain selected plugin tools.
- Pipeline `drive` runs now stream the same bounded semantic tool activity for
  every role stage.
- Planner now stops after one sufficient bounded evidence pass for tasks with
  explicit files and acceptance criteria, and ends immediately after submission.
- Coder now skips broad exploration after a concrete Planner handoff, edits
  existing files in place, and bounds repeated verification runs.
- Planner now uses only bounded structural, search, and batched-read project
  tools, removing redundant raw shell/read paths from its reconnaissance loop.
- Bounded normal Planner reconnaissance by batching independent reads and
  converting unresolved evidence into a research gate before Coder dispatch.
- Planner now specifies verification commands without executing suites, builds,
  linters, or formatters during normal reconnaissance.
- Security, Researcher, Coder, and Reviewer now use scoped batched search/read
  projections before any individual-file fallback.

### Security

- Hardened `read_project` against path replacement and post-stat file growth by
  using descriptor-relative no-follow traversal and a bounded descriptor read.
- Hardened activity projection against argument, identifier, terminal-control,
  custom-tool-name, and oversized-record disclosure; default web transport now
  pins validated public addresses and revalidates redirects.

### Fixed

- Reviewer verdict instructions now include the exact contract IDs required for
  each planned surface, so valid documentation-only reviews can self-correct.
- Preserved typed stage-limit failures across the model harness boundary and
  made `drive` report actionable stage pauses instead of pending decisions.
- Made `submit_follow_up` advertise discriminated variants and prevented invalid
  optional follow-up metadata from discarding a completed primary role result.

## [0.2.1] - 2026-09-12

### Changed

- Replaced the accreted architecture dump with a readable system map and added
  an enforced human-first documentation contract, configurable readability gate,
  and cold-reader planning/review procedure.
- Tightened the Orchestrator prompt, made its tool policy explicitly default-open
  over all registered tools, and added documentation audit triggers.
- Added plugin-shaped DuckDuckGo search and navigable page reading, content-image
  discovery, and capability-based image inspection with configurable vision-model
  routing for text-only roles.
- Added Git-ignore-aware `explore_project` reconnaissance for every code-reading
  role, isolated `decompose_task`, and Auditor/project-health contracts for
  evidence-based, test-pinned decomposition.
- Made the shipped pipeline an opt-in conversational workflow module selected by
  `--workflows pipeline`; disabled workflows register no tools, while standalone
  `drive` remains an explicit pipeline entry point.
- Exposed gate, exploration, web, media, and model-modality defaults as typed
  configuration instead of hidden behavioral constants.
- Added configurable stderr progress heartbeats and provider-request timeouts for
  long-running model-backed CLI operations.
- Added enforceable product-change, error-behavior, compatibility/release, and
  decomposition methods and made every delivery role apply their boundaries.
- Extended CI through a packed-artifact installation smoke.
- Added pipeline-independent `run_role` delegation so the Orchestrator can call
  every shipped specialist directly while workflow modules remain disabled.
- Defined the next-step headless tool-observability contract and recorded its
  compact human and structured machine renderers in the backlog.

## [0.2.0] - 2026-09-12

The working core of the harness. Built on `@earendil-works/pi-agent-core` and
`@earendil-works/pi-ai` 0.85.1, Bun + TypeScript, provable end to end with no
network (pi-ai's fauxProvider) and demonstrated live on DeepSeek.

### Added

- **Public release discipline** — package version `0.2.0`, enforced SemVer and
  dated-changelog consistency, artifact version verification, public-clone
  installation guidance, and an explicit no-recursive-orchestration guard for
  every built-in role.

- **Durable Orchestrator control-plane foundation** — queued daemon-free starts,
  atomic request-key admission, reconstruction, safe status/list/tool views,
  cooperative cancellation, explicit auto/manual decisions, provider/session-limit
  pauses, scoped child decomposition, reports, breakpoints and reviewed-tree-bound
  publishing. The machine `operations` CLI exposes trusted control actions.
  Pipeline results now distinguish `approved` from `decomposition_required`
  while retaining the compatible `approved` boolean.

- **Project operations Increment 6** — configurable headless repository
  publishing with JSON preflight/start/finish operations, isolated explicit-path
  commits, local/CI/manual gates, exact-head approval, GitHub and local squash
  flows, dirty-work preservation, and base-movement recovery.

- **Project operations Increment 5** — migration-free LDO layout detection,
  non-destructive digest/provenance imports with explicit execution trust,
  durable inspection/resume, and detect/preview/import/inspect/resume JSON CLI
  actions. Enabled importer limits reject unsafe or oversized source artifacts
  before persistence; zero keeps each numeric limit disabled.

- **Project operations Increment 4** — a durable non-model RunCoordinator,
  structured per-turn FollowUps, operator decisions, accepted-contract re-review,
  idempotent closeout, and resume parity across all workflow drivers.

- **Project operations Increment 3** — strict, provenance-preserving FollowUps;
  proposal-only documentation routing; and one configured BacklogStore authority
  with file or opt-in GitHub issue persistence, lifecycle/lease claims, a
  read-only capability probe, and one-time migration advice. GitHub payloads use
  stdin and persist only a structural metadata projection.

- **Trusted target role prompts and contract-aware roles** — pipeline and
  conversational orchestration now activate `.ad-coder/prompts/<role>.md`
  overrides automatically and byte-verbatim. Planner, Coder, and Reviewer roles
  discover, carry, obey, and independently enforce applicable target-project
  contracts without requiring ad-coder's documentation filenames.

- **Session generation limits** — headless conversations and orchestrators accept
  zero-disabled turn and USD thresholds enforced across all Models generation
  paths, including nested workflow roles and built-in compaction. Console flags
  expose the same controller and typed exhaustion stops safely without a fake
  completion record.

- **Minimal human console** — `ad-coder console --target-dir <dir>` keeps one
  `startOrchestrator` session across turns, supports formatted and JSONL output,
  injected streams, `/exit`/EOF cleanup, terminal-control sanitization, and a
  configurable 65,536-byte default input-line limit. Host tools remain
  unrestricted by explicit MVP decision.

- **Activated context compaction** — `auto` now builds a one-shot, no-tool
  summarizer from the resolved cheap-tier model and is propagated through role,
  pipeline, CLI, conversation, and orchestrator paths. `disabled-then-halt`
  rejects a full over-budget branch before provider execution; `cache-aware`
  fails loudly pending implementation. Summaries retain untrusted-history
  provenance, cross-provider disclosure requires explicit opt-in, and repeated
  summarizer failures are circuit-broken.

- **Role** — a validated preset over the harness options (`defineRole(role,
  model)`): a verbatim system prompt, a per-role tool allow-list
  (`activeToolNames`), a `cacheRetention` policy, and a `ContextBudget`. Pi's own
  compaction is disabled so the context strategy stays in ad-coder.
- **Prompts as files** — `resolvePrompt(name, opts?)` resolves a SYSTEM prompt
  by bare name to a verbatim UTF-8 string, so a role can reference `"coder"`
  instead of embedding an inline `fs.readFileSync`. A project prompt at
  `<projectDir>/.ad-coder/prompts/<name>.md` overrides the built-in shipped at
  `prompts/<name>.md`; the file is returned unchanged (no trim, no normalize, no
  templating — it is the cacheable verbatim cache prefix). The name is validated
  against `/^[A-Za-z0-9_-]+$/` BEFORE any path is built (no dots, slashes or
  `..`), and failures are a typed `PromptError` (`invalid_name`/`not_found`)
  carrying only the name and the absolute paths tried — never file contents.
  Task/user-prompt templating is a follow-on.
- **Default-open tool allow-list** — `activeToolNames` is now OPTIONAL: an absent
  field means "every registered tool" (the harness default), a present `[]` is
  still a deny-all, and a present non-empty array is the exact set. Existing
  roles set the field explicitly, so only the previously-invalid absent case
  changes meaning.
- **Ledger** — attributes provider token usage and cost to role / step / run as
  JSONL. `usage` is per-response (not cumulative); cost comes from
  `Usage.cost` and is never recomputed. Records carry identifiers and numbers
  only — never prompts, responses, or headers.
- **Ledger tool-call observability** — each record now carries an optional
  `toolCalls` map (tool name → count) of the tools the model REQUESTED in that
  response, omitted when it requested none. Per-response granularity, names and
  counts only (never arguments or output); execution outcome (`isError`) is a
  documented follow-on via the `after_tool` hook.
- **Context management** — `ContextBudget` on every role validated against a
  caller-supplied `Model` (local / custom endpoints safe); a `ContextCompactor`
  (`transform_context` hook) with ad-coder's own summarization prompt; and an
  `assertTurnFitsBudget` pre-flight.
- **Capability matrix** — `deriveCapabilities(model)` (cost mode, cache
  controllability, context window, unit costs, out/in ratio), plus
  `cacheEfficiency` and `breakEvenReads` metrics.
- **Quality gates** — a data-declared `QualityGate` + a `GateRunner` with an
  injected command executor; format / lint / typecheck / in-process size gates.
- **Runner** — `runRole(params)` drives one turn through pi-agent-core in a
  **required, separate `targetDir`** (harness dir ≠ target dir; credentials only
  from the harness environment, never the target's). Custom tools are injectable
  via `tools?` (`defineTool` / `Tool`).
- **Conversation** — `startConversation(config)` (`src/conversation/`): the
  multi-turn substrate the conversational orchestrator will sit on. It builds ONE
  harness over ONE session, acquires the lane and attaches the compactor ONCE,
  and returns a `ConversationSession` whose `step()` re-drives that same
  `lane.prompt` seam turn after turn — history is retained on the durable Session
  branch tip, never replayed. Each turn gets a fresh per-turn `Ledger` sharing
  the one sink and attaches/unsubscribes its ledger + `tool_end` listeners inside
  a `finally` (so N turns emit exactly N ledger rows, never duplicated), narrows
  the settled record to `{status, assistantText, toolCalls, droppedRecords}`, and
  never closes the shared sink until `close()`. `runRole` stays the single-turn
  primitive; this reuses its seams (`runner.ts`/`pipeline.ts` untouched). The
  compactor is the payoff for long chats.
- **Orchestration** — `runPipeline(config)`: an optional planner → an optional
  Security phase → a coder ⇄ reviewer loop to `maxRounds`. The reviewer submits a
  structured verdict and the planner a structured complexity + security surface
  via tool calls (`submit_verdict`, `submit_plan`); an elevated security surface
  runs a threat-modeling Security phase whose mitigations thread into the coder
  and every reviewer turn. Per-phase cost is visible in the ledger.
- **Stepped workflow engine** — `createWorkflowSession(config)` exposes the
  plan → [security] → code ⇄ review graph as an explicit, inspectable
  `WorkflowState`: `step(state)` runs the ONE pending role turn and returns the
  post-turn state plus the `AvailableTransition[]` on offer WITHOUT committing
  one, and the pure `applyTransition(state, chosen)` yields the next state. A
  driver picks each transition — `advance`, `rework` (re-run the coder without a
  review in between), or `stop`. `runPipeline` is now the autonomous auto-driver
  over this engine (always take the default transition), byte-for-byte its prior
  behavior. Transition policy is a setting, not a constant: `WorkflowDefaults`
  (`onChangesRequested`, `autoAdvance`, plus `maxRounds`/`defaultComplexity`)
  each defaults to today's behavior. This is the substrate a human-stepped UI or
  the conversational orchestrator drives.
- **Provider registry** — `src/registry/`: plain-data provider + model config,
  a strict fail-loud `parseRegistryConfig` validator (https-only absolute base
  URLs, no embedded userinfo), and `resolveRegistry` turning declared data plus
  the harness environment into a pi `Models` collection with a stable-name
  lookup. Credentials resolve through an injectable env accessor by declared var
  NAME; a missing one throws `RegistryError('missing_credential', <NAME>)`. Five
  presets ship: `deepseekPreset`, `openrouterPreset`, `openaiCompatiblePreset`,
  `anthropicCompatiblePreset`, and the OAuth-delegated `openaiCodexPreset`.
- **Profiles** — `src/profiles/`: the composer layer above the registry that
  resolves a `(role, complexity)` cell — or a per-spawn `SpawnOverride` — to a
  registry model NAME and then to a live pi `Model<Api>`, plus an advisory
  `{ maxOutput, cacheRetention }`. A strict fail-loud `parseProfile` validator
  (five `ProfileRole`s including a forward-looking `recorder`, seen-Set duplicate
  detection on the `role:complexity` key), `resolveProfile` (which rethrows a
  registry `unknown_model` as `ProfileError('unknown_model')` so the layer
  presents one typed surface), and a provider-agnostic `buildDefaultProfile`
  builder. The advisory hints have no sink yet and nothing wires this into
  `runPipeline` — both are a deliberate follow-on.
- **Complexity-aware routing** — `runPipeline` now CONSUMES the profile/registry
  layers through an optional `PipelineConfig.routing`
  (`{ profile, registry, defaultComplexity?, overrides? }`): per-role model
  selection is driven by the planner-rated complexity — the planner (and any
  pre-complexity role) routes on `defaultComplexity` (default `'medium'`), and
  every later role on the planner's submitted tier, else that default; a per-role
  override wins over the `(role, complexity)` cell. Routing is optional and
  additive — absent, model selection is byte-for-byte the prior behavior (each
  `RoleSpec.model` over `config.models`).
- **Built-in role prompts** — `prompts/{planner,coder,reviewer,security}.md`.
- **Env-driven config resolution** — `resolvePipelineConfig(options)` builds a
  runnable `PipelineConfig` from the environment: it selects a provider by
  env-var PRESENCE (precedence `DEEPSEEK_API_KEY` → `OPENROUTER_API_KEY` →
  OpenAI-Codex OAuth, overridable with `provider`), builds the matching shipped
  preset's registry through the injected `env` accessor (a keyless env-var
  provider throws `RegistryError('missing_credential', <VAR-NAME>)` naming only
  the variable), routes strong/mid/cheap model NAMES through the default
  profile, and derives the context budget as a PERCENT of the smallest chosen
  model's window (never a hardcoded value) so one budget validates for every
  role. The selected provider and tier model names are echoed to stderr (names
  only, never a key) before the turn runs.
- **`ad-coder role <name> "<task>" --target-dir <dir>` subcommand** — runs a
  single built-in role (`planner`/`coder`/`reviewer`/`security`) standalone
  against a target directory, resolving the provider and models from the
  environment. Prints the role's final assistant text and the per-run cost;
  `--provider`, `--strong-model`/`--mid-model`/`--cheap-model`, `--max-rounds`
  and `--default-complexity` are validated at the argument boundary (bad input
  exits 2 with the usage string). The role runs with real read/write/edit/bash
  tool access rooted at the target directory — the target directory is NOT a
  sandbox (same posture as `run`).
- **`ad-coder drive "<task>" --target-dir <dir> [--auto]` subcommand** — drives
  the stepped workflow engine one phase at a time: it prints each turn's output
  and per-step cost and, at every step, reads which offered transition to take
  (`advance`/`rework`/`stop`). `--auto` swaps the human read for the auto-driver
  so the path reproduces `runPipeline` for scripting/CI. The drive loop lives in
  a library module (`driveWorkflow`, exported) driven through injected
  input/output/error streams, so it needs no TTY; a chosen transition is
  validated against the ones the step actually offered and rejected with a typed
  `DriveError('transition_not_offered')` otherwise. The same change adds a
  silent-no-op signal to both `role` and `drive`: a turn with empty assistant
  text and zero cost now writes a clear stderr warning (the provider may need
  authentication, e.g. `codex login`) instead of two blank-looking lines.
- **Packaging** — MIT license, CI (typecheck + tests on Bun), and one-command
  install/update from GitHub.

What's planned next lives in [`docs/ROADMAP.md`](docs/ROADMAP.md), not here — a
changelog records what changed, not what's still to do.
