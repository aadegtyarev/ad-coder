# Checkpoint

## 2026-09-16 (later) — What the bench could not see, and what the field already knew

The bench measured answers. It could not see what a model did *besides*
answering, could not tell a wrong answer from an unlucky phrasing, and was
justified by its author's taste rather than by anything citable. All three are
now addressed, and the corpus covers every role for the first time.

**Three things a model could do freely while scoring 1.00.** Scope: a task now
declares the paths its work may touch, and the runner compares a snapshot of the
target before and after. A model that fixed the named function and also pulled in
a logging framework, reformatted a neighbour and left a scratch file behind was
previously indistinguishable from one that did the work. Prohibitions: a task may
forbid a tool, checked against the names every ledger row already carries -- one
mechanism for every role and mode. And claims: an auditor could cite a contract
file that does not exist, a reviewer a line past the end of a 17-line file, a
security answer a step of a three-step plan. Each is now the heaviest check in
its task.

**The mirror nobody had written.** Every artifact task shipped a `.gamed.json` --
the cheat that must fail -- and none shipped its opposite: a different, equally
valid answer that must pass. So the corpus had verified six times that a cheat
would be caught and never once that an honest answer in other words would be
accepted. Two of eight tasks rejected one on the day the samples were added; both
were matching the author's vocabulary rather than the finding.

**Tasks that argued against their own scorers.** `planner-contract-carry-v1` was
failed identically by six models across four families and two vendors, the
dearest scoring lowest -- the inverted signature this project's own health check
calls broken rather than hard. `coder-retention-v1` shipped a fixture whose
comment called the rule its scorer required a drift from the contract, and four
models across three vendors deleted the rule and cited that comment. Both were
task defects. The second cost `gpt-5.6-sol` 0.78 twice where it now scores 1.00
twice at the same effort -- one sentence of fixture prose apart.

**The summarizer, and why its cell was empty.** It is not dispatchable as a role
at all; it runs only inside compaction. So the task measures what compaction is
for: a constraint stated once, twelve bulky files that must be read first, and a
budget small enough to evict the early messages. Two attempts failed before it
worked -- one fit in the budget and never compacted, one hit the ceiling and was
refused -- and neither was diagnosable, because ad-coder announced a compaction
FAILURE and said nothing on success. It now reports itself in numbers, the runner
counts it, and a task can demand it. That gap was invisible in production too.

**Theory, instead of taste.** `docs/benchmark-scoring-research.md` records what
the field has settled, with sources. Worst-run scoring is `pass^k` and has a
citation. Five repeats is the convergent choice of three independent
maintainers; three was a budget guess. A task every model fails identically is a
published defect signal, not a hunch -- this project reached that conclusion
twice by hand before learning it had a name. And Terminal-Bench spends three
expert hours per task and still fixed 28 of 89 in a point release: task defects
are the normal condition of a benchmark, found by running it.

**Coverage.** All nine roles are measured, `summarizer` included. The listing
reports what a task measures rather than what it dispatches -- it had shown the
summarizer uncovered and the auditor covered twice, which is the table used to
decide what to build next. What remains empty is by tier: `trivial` and `complex`
are measured only for the orchestrator and the coder.

**Evidence.** 56 runs from this rebuild -- eleven models, four vendors, ten tasks
-- are in `docs/calibration-evidence.jsonl` with provider, effort, harness
outcome, cost and duration. The row that justifies the file: `minimax-m3` scored
0.25, 0.94 and 0.41 on one task. Any single number would have been a lie about
that cell. Live results worth carrying forward: `glm-5.2` and `kimi-k3` reach
1.00 on coder/medium where `deepseek-v4-pro` reaches 0.88 in eleven minutes, and
varying the summarizer while holding the role fixed changed nothing -- what
breaks under compaction is the role reading the summary, not the model writing
it.

**Open, with issues filed rather than fixed:** #143 handoff fidelity, #164
reference-relative bands, #165 tests that cannot fail, #168 structured output
(every `unreadable_answer` on record was produced without the flag, and the docs
say so), #171 a role declaring absent what is in front of it.


## 2026-09-16 — Calibration bench rebuilt, and the profile role it depended on

The `recorder` profile role is retired. It was reserved for a role that never
arrived -- nothing dispatched it, no prompt defined it, `ROLE_NAMES` never listed
it -- but the cell was load-bearing: it chose the compaction summarizer's model.
It is now `summarizer`, a routing role like any other, with `--summarizer-model`
overriding it the way every `--<role>-model` flag overrides its own. Before, that
flag resolved beside the shared path, so the startup banner printed the profile
cell while the run used the flag.

The calibration bench was then rebuilt, in two halves.

**It stopped reporting things that were not true.** A measurement now names the
provider that served the model -- the same model name behind two providers can be
a different quantization and a different set of supported thinking levels -- and
the runner passes the task's declared complexity, which it never did, so every
task had run at `medium` and a trivial task's result credited whichever model the
medium cell named. Measurements carry a `harnessOutcome` beside `quality`, since
a zero from a bad answer and a zero from a refused tool are different facts.
Scorers that could not read an answer threw, which the runner reported as a
failed run, so the measurement left the sample -- and the runs it lost were the
bad ones. Negative checks were satisfied by emptiness, so garbage output earned
points for restraint. `--repeat N` reports worst, mean and best rather than one
sample, because the same model on one task produced 0.43, 0.79, an unreadable
answer and 1.00 in a sitting, and a series now survives a run that aborts.

**It stopped measuring shape instead of substance.** The contract-carry scorer
matched a keyword bag, so invented boilerplate scored full marks; it now verifies
carried rule text against the fixture's real contract file. The refactoring check
counted a declaration and two call sites, which a wrapper beside untouched
duplication satisfies; it now proves both entry points read through one parser.
The reviewer task gained an evidence requirement and a cap on blocking findings,
since a review listing every suspicion is as unusable as one listing none. Each
task may now ship a `.gamed.json` -- the specific evasion its scorer claims to
stop, required to score at most two thirds -- which caught a precision check
written an hour earlier whose weight let six findings instead of two cost an
evasion fourteen percent.

Tasks now declare `purpose`. Nine are `calibration`; five are `smoke`, kept
because they prove the harness still dispatches and scores, and never quoted as
evidence about a model. `calibration:health` names a task whose quality spread
across models has collapsed, or whose quality falls as price rises -- both
defects found this session were caught by a person reading a printout, and both
were visible in the numbers.

Two capabilities are measured that were not. `orchestrator-decompose-v1` puts six
requirements to the orchestrator, one already satisfied by the code, one phrased
as two and indivisible, two phrased as one and separable, and one real ordering
dependency. `planner-absent-artifact-v1` asks for a plan against documents that do
not exist inside a fixture that is otherwise real; it ships as `smoke` because
every model scores 1.00, which says the role prompt's instruction is being
followed rather than that models differ.

`refactor-config-v1` was found never to have run a coder: it declared `role:
coder` and mode `manual-workflow`, so the orchestrator did the work itself and
`model` came back `null`. Repaired and re-measured, it saturates, so it is
`smoke` -- which leaves the corpus with no coverage of `coder` at `medium`, the
busiest routing cell (#159).

Live results on OpenCode Go, 0.45 USD across roughly 80 runs: `glm-5.3-flash`
took the trivial tier 9/9; `deepseek-v4.1-flash` matched `deepseek-v4-flash` on
quality at two to three times the speed; `minimax-m3` solved decomposition 3/3 in
three different shapes. The `security-plan-threats-v1` plateau at 0.83-0.89 was
diagnosed per check and is honest difficulty -- every model finds the real threats
and only `avoids-auth-false-positive` wobbles.

Recorded separately: `docs/opencode-go-economics.md`, where a model's monthly
allowance was read as a multiplier on the subscription rather than a ceiling, and
as multiplying across models. The first half of that stands; the second does not,
and the document was corrected on 2026-09-18 against the account's own usage
dashboard -- the cap is one shared week, measured per model. Allowances still do
not track token price, which is what the two identically priced GLM models show.

Verification: `typecheck`, `check`, `check:release` (0.20.1), `check:docs`,
`smoke:artifact`, and `bun test` (703 passing, 3,818 assertions) all pass on
`main`. Corpus smoke reports 14 tasks, 9 calibration, 5 smoke, 0 unscored. Issues
opened for what was found and not fixed: #132, #134, #137, #138, #141, #142,
#143, #144, #146, #151, #159.

## 2026-09-12 — Documentation and onboarding reconciliation

Reconciled README, ARCHITECTURE, ROADMAP, and BACKLOG with the registry-declared
CLI and current MVP. The installation and first-run path now covers Bun/private
GitHub installation, Codex browser or device-code OAuth, auth status, standalone
roles, automatic `drive --auto`, the interactive `console`, daemon-free durable
`control`, configuration, and diagnostics. Documentation now records the seven
CLI fronts (`auth`, `control`, `operations`, `run`, `role`, `drive`, `console`),
the delivered stepped engine and breakpoint control, and the actual provider
precedence DeepSeek → OpenRouter → Codex OAuth. It also states the intentional
no-sandbox boundary and credential location clearly. Root `.gitignore` was not
edited.

Verification: registry help for root/control/operations passed. The focused auth,
CLI, role, drive, console, and configuration suite passed with 63 tests and 416
assertions (`npm exec --offline -- bun test test/auth.test.ts
test/cli-config.test.ts test/cli.test.ts test/cli-role.test.ts
test/cli-drive.test.ts test/cli-console.test.ts`; exit 0). The full-suite result
was 331 passing tests and 1,699 assertions (`npm exec --offline -- bun test`; exit
0). `npm exec --offline -- bun run typecheck`, `npm exec --offline -- bun run
check`, and `git diff --check` were also run after this documentation change;
their successful results are recorded with the closeout.

## 2026-09-12 — Persistent OpenAI Codex OAuth readiness

Codex OAuth credentials persist in a private user-local file through an injectable
CredentialStore with validated data, cross-process locking, owner-only modes, fsync,
and atomic publication. Headless status/login/logout expose no token values. The
registry-derived CLI supports browser and device-code login and rejects project-local
credential paths. Missing or failed refreshed authentication stops before generation.
Standalone roles expose only their registered tools, and CLI shutdown closes Codex
WebSocket resources instead of waiting for the provider idle timeout.

Live subscription dogfood passed: auth status reported OAuth; standalone Planner
returned meaningful text and exited cleanly; the Orchestrator called `show_cost` and
answered; a temporary-project automatic pipeline produced meaningful Planner and
Coder output, verified its file byte-for-byte, and received an approved Reviewer
verdict in one round. Pipeline cost was $0.17039500 ($0.048626 plan, $0.068133 code,
$0.053636 review); two additional short role checks cost $0.047035 and $0.008435.
The implementation pipeline consumed 10,487,990 tokens, including 9,829,120 cached.

The local gate passes 302 tests with 1,536 assertions plus TypeScript, Biome, and
`git diff --check`; the auth stress suite additionally passed 20 repeated runs. The
default review ceiling is now `maxRounds: 2`: one initial implementation and one fix
cycle. A second blocking verdict is the signal for Orchestrator-led decomposition.
Codex OAuth defaults mirror the LDO tiers: Astra for Orchestrator, Sol for
Planner/Security and complex Coder work, Terra for Reviewer and medium Coder work,
and Luna for Summarizer and trivial Coder work. Every selected model has a 272k
window, so the global Summarizer-window invariant holds.

## 2026-09-12 — Self-hosting model and context configuration

Every active model is independently selectable, including Orchestrator and
Summarizer. Model context windows default to 200000 when omitted and explicit
registry values may narrow or expand them. Context budgets derive independently
from each selected model using configurable percentages. Automatic compaction
remains the default. Configuration fails before provider dispatch unless the
Summarizer window covers the largest reachable pipeline, override, or Orchestrator
window; chunked summarization is intentionally deferred under this invariant.
Registry/profile files are explicitly selected JSON data and are never executed.

Verification: focused model/config/orchestration/CLI/export coverage passed 99 tests
with 675 assertions. The full suite passed 287 tests with 1,467 assertions;
TypeScript, Biome, and `git diff --check` pass. Persistent Codex OAuth and live
self-hosting dogfood are next.

## 2026-09-12 — Project operations Increment 6

Repository publishing now has a headless core and registry-derived JSON
preflight/start/finish operations. Remote HEAD then configured main/master
candidates select an exact base OID. Publishing creates a feature branch,
constructs commits from explicit paths in an isolated index, runs the selected
local/CI/combined/manual gate, pushes an explicit refspec, creates a structured
PR through stdin, and squash-merges only the checked head. Multi-developer mode
requires server-enforced approval by another developer on that exact commit.

Local repositories use a controlled single-parent squash update without
checking out base. Protected-base operations, initially dirty paths without
individual authorization, moving bases, empty/pending CI, and changed PR heads
fail closed. User files remain untouched, HEAD stays on the feature branch, and
results include recovery guidance. All policy choices are configurable; local
tests are default and numeric limits default to `0` disabled. Trusted project
prompt overrides and the no-sandbox/no-permission-cage stance are unchanged.

Verification: focused publishing/CLI/export coverage passed 48 tests with 561 assertions; the full suite passed 278 tests with 1,426 assertions across 23 files, including a linked-worktree publishing lifecycle. `bun run
typecheck`, `bun run check`, and `git diff --check` passed using the cached Bun
executable through `npm exec --offline -- bun`.

## 2026-09-12 — Project operations Increment 5

Existing LDO projects are adopted without migration. Headless and JSON CLI
operations detect and preview the existing layout without writes; imports retain
exact source bytes as immutable digest revisions with a versioned manifest,
observed/claimed provenance, and optional explicit digest trust. Source LDO
artifacts and project documentation are never overwritten. Unsafe filesystem
objects, traversal, malformed/unsupported version-1 data, and enabled numeric
limits fail before persistence; all numeric limits default to `0` disabled.
Artifact enumeration and reads stay anchored to a verified open LDO directory
descriptor, so an ancestor-path replacement cannot redirect an accepted read.

Inspection reports source status and the first incomplete phase. Trusted,
unchanged interrupted work is narrowly translated into native WorkflowState and
continued by RunCoordinator under a stable digest checkpoint; terminal work does
not rerun effects. A completed import is terminal only when its final supported
review is approved and the run's approved state agrees. Imported text requires explicit trust bound to its exact digest before resume. Trusted prompt
overrides and the no-sandbox/no-permission-cage MVP stance are unchanged.

Verification: 269 Bun tests (1,357 assertions), including focused CLI, ProjectStore,
package-export, malformed-envelope, import and resume coverage; TypeScript, Biome, and
`git diff --check` pass. Repository publishing policy is the next separate task.

## 2026-09-12 — Project operations Increment 4

The non-model RunCoordinator now owns workflow progress and closeout for direct
pipelines, custom driving, and conversational orchestration. Each role turn gets
a fresh structured FollowUp capture when its tool policy permits it; provenance
is engine-authored and all rounds aggregate deterministically. Versioned
ProjectStore checkpoints retain workflow/pending-step progress, completed stable
effects, unresolved decisions, contract re-reviews, and terminal closeout, with
CAS rejection for stale writers and resume from the first incomplete phase.

Notes and authorized design-document drift use fixed metadata-only blocks and
stable markers; file backlog retries use deterministic IDs. Contract and
ambiguous product choices persist for an operator-only decision. Accepted exact
one-line contract rules are appended once and re-review the unchanged current
implementation before closeout. Numeric coordinator limits default to `0`, which
disables them. Trusted target-local prompt overrides remain automatic,
byte-verbatim, and unrestricted; no sandbox or permission cage was introduced.

Verification: 260 Bun tests (1,285 assertions), TypeScript, Biome, and
`git diff --check` pass. Next:
non-destructive LDO import/operator commands. Repository publishing policy and
distributed GitHub claim coordination remain deferred.
## 2026-09-12 — Codex role reasoning defaults

Model profiles now carry an optional validated `thinkingLevel` through profile
resolution, complexity routing, Role, and pi-agent-core harness options. OpenAI
Codex OAuth defaults route Coder at every complexity to `gpt-5.6-sol` with
`medium` reasoning and the conversational Orchestrator to `gpt-5.6-sol` with
`low` reasoning. Explicit profiles, spawn overrides, model choices, and the CLI
Orchestrator reasoning option retain precedence; other providers keep their
existing defaults.

Verification: 309 Bun tests with 1,577 assertions, TypeScript, Biome, and
`git diff --check` passed.

## 2026-09-12 — Daemon-free control plane

The operator's updated mandate is recorded in ROADMAP and the operation-modes
contract. Pipeline exhaustion now returns a typed `decomposition_required`
outcome. The headless ProjectStore-backed core now provides atomic request-keyed
queued admission, restart-safe status/list/resume/cancel, scoped auto/manual
decisions, provider/session/project limit pauses, sequential decomposition,
breakpoints, reports and reviewed publish-tree binding. Machine CLI and safe model
tools call that same core; only the trusted host/CLI surface can resolve a manual
decision. Publisher checks the exact staged tree before ref mutation.

Verification in this workspace: the focused control-plane/project-operations run
passes 52 tests with 265 assertions; the full suite passes 316 tests with 1,613
assertions. TypeScript, Biome and `git diff --check` pass. Bun is reproduced from
the existing offline npm cache because no direct `bun` executable is on PATH.

## 2026-09-12 — Incremental pipeline-context decision

The next optimization after the current Orchestrator control-plane increment is
recorded in ROADMAP and BACKLOG. Planner reconnaissance, Coder fix turns, and
repeated review will use scoped handoffs by default, with visible automatic
fallback to full context on scope drift or insufficient evidence. Per-stage
context and diff telemetry will make the token and cache effect measurable.

## 2026-09-12 — Orchestrator control plane verified

The daemon-free control plane now has durable queued runs, safe status/list/report projections,
auto/manual decisions, scoped child decomposition, CAS execution leases, cooperative cancellation,
provider/session/project pauses, exact publish-tree binding, and cursor-based durable events for
completion, attention, limits, failures, and publication. Auto decisions require existing project
documentation as evidence; unsupported choices defer instead of fabricating operator approval.
All numeric resource limits default to `0` unlimited, while decomposition depth remains the explicit
semantic exception with default `1` and `0` unlimited.

Verification: 318 Bun tests with 1,624 assertions, TypeScript, Biome, and the focused concurrency,
validation, decomposition, event-cursor, and stale-publication tests pass.

## 2026-09-12 — Stage observability and provider-limit recovery

Pipeline stages now retain safe token/cache/output totals, bounded normalized
dedicated-read observations, streamed cumulative Git diff byte counts, and the
resolved context strategy through workflow checkpoints, `PipelineResult`,
`RunReport`, safe control reports, and CLI JSON. Structured rate/quota exhaustion
durably pauses with a safe retry delay and clears the execution lease; the CLI
binds the coordinator to the durable control run ID, so explicit or scheduled
resume continues the same checkpoint. Timed retry is disabled at `0`; positive
configuration enables bounded exponential retry through a shared live-host
admission coordinator, with validated hints, jitter, a 24-hour delay cap, and a
durable configurable attempt ceiling (`0` means unlimited). Git diff probes disable repository
fsmonitor hooks through a sanitized environment override, while reported read paths omit
terminal controls and Unicode-format controls. Subscription status, provider fallback, context
shrinking, and incremental context handoffs remain out of scope.

The direct `bun` executable was absent from PATH, so the pre-edit focused baseline
could not start. The documented offline-cache invocation then reproduced Bun:
the planner-scoped verification passes 87 tests with 563 assertions, the expanded
eight-file verification passes 164 tests with 1,098 assertions, and the full suite
passes 330 tests with 1,696 assertions. TypeScript, Biome, and `git diff --check` pass.
The second Reviewer returned further findings after one fix cycle; per operator policy the next
model fix cycle was stopped and the Orchestrator completed the final audit locally. The full local
gate is green and authorizes publication.
