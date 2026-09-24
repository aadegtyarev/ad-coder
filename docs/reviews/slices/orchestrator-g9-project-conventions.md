# Slice audit: orchestrator guarantee `orchestrator.md:39` (g9-project-conventions)
Audit base: ff07c9988923aeb4fa0b66106f3574103eb4b4cd, date 2026-09-24.
Rule text: "- The orchestrator reads the target project's working conventions before acting.
  Durable decisions belong in repository documents and state, not conversation."

## Verdict
violating (first clause unimplemented on the conversational orchestrator surface this
slice examined): nothing in the orchestrator's own prompt (`prompts/orchestrator.md`) or
composition directs it to read the target project's working conventions before acting —
`AGENTS.md` appears verbatim in exactly one source path (the LDO import, which
`AGENTS.md:216-217` explicitly directs this program not to use) and the only mechanism
that would cause such a read, the `delivery-discipline` skill, is catalogue OPT-IN whose
manifest description triggers on merge/rebase/stamp/CI delivery events, not on task
start. The second clause ("durable decisions ... not conversation") is covered as prompt
text only, unenforced. Surfaces examined: `prompts/orchestrator.md`,
`prompts/skills/delivery-discipline/`, the skill resolver/loader role kit
(`src/skills/resolver.ts`, `src/skills/load-tool.ts`, `src/skills/role-kit.ts`), the
orchestrator assembly (`src/orchestration/orchestrator.ts` prompt/kit wiring), the CLAUDE
surface docs (`AGENTS.md`, `CLAUDE.md`), and `src/project-operations/ldo-import.ts`. NOT
examined: the pipeline Planner/Coder brief path (prompts/planner.md, prompts/coder.md)
beyond a grep, delegated `run_role` dispatch plumbing, and any CLI `orchestrator`
command end-to-end.

## Checks executed
| Command | Result |
| --- | --- |
| `git rev-parse HEAD` | `ff07c9988923aeb4fa0b66106f3574103eb4b4cd` (matches audit base) |
| `bun test test/skills.test.ts` | 27 pass, 0 fail, 247 expect() calls, exit 0 (695ms) — exercises real behaviour incl. `a role receives the catalogue, and loads instructions only when it asks` (test/skills.test.ts:387) and `delivery discipline is shared by all delivery roles ...` (line 151), which asserts skill.instructions contains "read \`AGENTS.md\`" |
| grep sweeps (`AGENTS\.md\|CLAUDE\.md` over `src/`, `prompts/`, `docs/`) | `src/` hits: 1 — `src/project-operations/ldo-import.ts:204` only; `prompts/` hits: `prompts/skills/delivery-discipline/instructions.md:9` only; `prompts/orchestrator.md`: 0 hits |
| `grep -n "durable project memory\|Do not use chat" prompts/orchestrator.md` | line 196 `Do not use chat as durable project memory. Enforceable rules belong in` — the only clause-2 implementation found; no test contains that phrase |

## Evidence read
- `docs/contracts/orchestrator.md:39-40` — the audited bullet, quoted verbatim above.
- `prompts/orchestrator.md:1-60, 145-175, 186-197` — read in full: routing/inspection
  rules ("Read the relevant source before claiming how it behaves", line 151) but NO
  instruction to read the target project's conventions file before acting; the
  "Keep state and documentation healthy" section (lines ~193-199, "Do not use chat as
  durable project memory") implements clause 2 at prompt level only, with no
  mechanical check (verify.md / review have no rule citing it for the orchestrator).
- `prompts/skills/delivery-discipline/instructions.md:9` — "The first project-work step
  is to read `AGENTS.md`, `docs/contracts/quality.md`, and
  `docs/contracts/product-change.md` ... Do not edit, rebase, version, or dispatch
  until that read is complete." This is exactly the clause-1 behaviour — but it lives
  inside a skill whose coverage the role only gets on demand.
- `prompts/skills/delivery-discipline/skill.json:2-5` — the skill is not `always`; its
  description triggers on "merge PR", "conflict", "rebase", "stamp", "version",
  "release", "force push", "CI red": no trigger for "starting work in a project".
- `src/skills/load-tool.ts:9-58` — skills ship as a catalogue (justified by
  docs/contracts/skills.md's ban on pasting full instructions into every prompt);
  `src/skills/role-kit.ts:113-129` — catalogue mode, with `unconditionalSkills`
  (`src/skills/resolver.ts:423-437`) requiring `skill.always === true`, a flag NO
  shipped skill sets (grep of prompts/skills/*/*.json for "unconditional"/"always":
  no manifest carries `always: true` for this path).
- `src/orchestration/orchestrator.ts:1721-1737` — the orchestrator role kit gets
  `selectedSkills: config.selectedSkills` (default undefined = catalogue mode) and
  `projectDir: config.targetDir`; project skills can override built-ins but nothing
  forces a conventions-reading skill into the orchestrator's prompt.
- `src/project-operations/ldo-import.ts:204` — the sole `src/` read of `AGENTS.md`,
  detected as an existing LDO documentation-layout file, not consulted "before acting".
- `AGENTS.md:221-228` — the host repo's own convention writing durable decisions to
  `docs/ROADMAP.md`/issues/research notes; `CLAUDE.md:7` points at the canonical
  documents. These are host-repo text, not code the orchestrator runs on a target.

## Gaps and unverified
- The clause-1 rule exists in the contract but has no enforcing artefact I could find:
  no prompt line telling the orchestrator to read the target's conventions file, no
  mechanism that reads it programmatically at session start, and no test asserting the
  orchestrator reads target conventions before its first mutation. The obvious
  fix would be either an `always` skill for the orchestrator ("read the target project's
  orientation/convention documents before acting") or target-aware prompt injection —
  PROPOSAL, PENDING OPERATOR DECISION, not in scope to build here.
- Clause 2 is prompt-advice only; whether the Reviewer contract or reviewer prompts
  could enforce "durable decisions to repository documents" mechanically was NOT
  examined (unverified).
- I did not verify the delegated worker paths (planner/coder/reviewer prompts after a
  single grep — no `AGENTS`/`convention` hits — but not read in full).
- I did not run a live conversation against a fixture target directory to observe that
  the model fails to read conventions in practice; the verdict rests on prompt/tool
  composition, which is the deterministic part of the surface.
- The pipeline `decompose_task`/Planner intake path could be a second place the rule
  could hold; not examined.
