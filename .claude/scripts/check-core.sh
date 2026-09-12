#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs'
import { createPipeline } from './core/pipeline.mjs'
import { buildCodexPrompt, buildPrompt, compiledRoleInstructions, roleInstructions } from './core/prompts.mjs'
import { summarizeTokenUsage } from './core/token-usage.mjs'

const runner = readFileSync('./scripts/ldo-run.mjs', 'utf8')
function assertStrictObjects(schema, path = '$') {
  if (!schema || typeof schema !== 'object') return
  if (schema.type === 'object' && schema.properties) {
    const missing = Object.keys(schema.properties).filter(key => !schema.required?.includes(key))
    if (missing.length) throw new Error(`${path} omits strict required properties: ${missing.join(', ')}`)
  }
  for (const [key, value] of Object.entries(schema)) assertStrictObjects(value, `${path}.${key}`)
}
for (const role of ['researcher', 'planner', 'security', 'coder', 'reviewer', 'recorder']) assertStrictObjects(JSON.parse(readFileSync(`./schemas/${role}.json`, 'utf8')), role)
console.log('✓ every portable output schema satisfies Codex strict required-property rules')
const claudeAdapter = readFileSync('./adapters/claude-cli.mjs', 'utf8')
if (claudeAdapter.includes('--permission-prompts') || !claudeAdapter.includes("permissionMode = 'auto'") || claudeAdapter.includes("writable ? 'acceptEdits'")) throw new Error('Claude adapter uses removed or non-automating permission modes')
console.log('✓ portable Claude adapter uses current auto permission mode for non-interactive edits and verification')
const expectedModels = {
  planner: 'gpt-5.6-sol', coder: 'gpt-5.6-sol', security: 'gpt-5.6-sol',
  reviewer: 'gpt-5.6-terra', researcher: 'gpt-5.6-terra', recorder: 'gpt-5.6-luna',
}
for (const [role, model] of Object.entries(expectedModels)) {
  if (!runner.includes(model) || !runner.includes('options[`${role}Model`] || options.model')) {
    throw new Error(`Codex default or override precedence missing for ${role}`)
  }
}
console.log('✓ Codex model defaults use one Sol Planner, dynamic Coder routing, Terra review, and Luna recording')

let sourceBytes = 0; let compiledBytes = 0
for (const role of ['researcher', 'planner', 'security', 'coder', 'reviewer', 'recorder']) {
  const source = roleInstructions(role)
  const compiled = compiledRoleInstructions(role)
  sourceBytes += Buffer.byteLength(source); compiledBytes += Buffer.byteLength(compiled)
  if (compiled.startsWith('---') || compiled.includes('## OUTPUT SCHEMA') || compiled.includes('```json')) throw new Error(`compiled ${role} prompt retained metadata or duplicate schema`)
}
if (compiledBytes >= sourceBytes * 0.92) throw new Error(`role prompt compaction saved too little: ${sourceBytes} -> ${compiledBytes}`)
if (!compiledRoleInstructions('reviewer').includes('Evidence is mandatory') || !compiledRoleInstructions('recorder').includes('## BACKLOG DESTINATION')) throw new Error('prompt compaction removed a required behavioral invariant')
console.log(`✓ shared role prompts drop duplicate schemas and metadata (${sourceBytes} → ${compiledBytes} bytes) while retaining behavioral rules`)
const fullReviewer = compiledRoleInstructions('reviewer')
const trivialReviewer = compiledRoleInstructions('reviewer', { profile: 'trivial' })
if (trivialReviewer.length >= fullReviewer.length * 0.75 || !trivialReviewer.includes('Evidence is mandatory') || trivialReviewer.includes('When the suite outlives one tool call') || trivialReviewer.includes('Migration numbering gate')) throw new Error('trivial Reviewer profile is not safely compacted')
const claudeTrivial = buildPrompt({ role: 'reviewer', task: 'task', context: { plan: { complexity: 'trivial' } } })
const codexTrivial = buildCodexPrompt({ role: 'reviewer', task: 'task', context: { plan: { complexity: 'trivial', steps: [] } } })
if (!claudeTrivial.includes('When the suite outlives one tool call') || codexTrivial.includes('When the suite outlives one tool call')) throw new Error('trivial Reviewer profile leaked into Claude or failed to activate for Codex')
console.log(`✓ only Codex trivial Reviewer uses the compact profile (${fullReviewer.length} → ${trivialReviewer.length} chars)`)

const handoff = {
  plan: { summary: 'plan', complexity: 'medium', security_surface: 'elevated', steps: [{ what: 'change', files: ['src/a.js'], acceptance: 'test', user_facing: true }], risks: [], codebase_context: { stack: 'node', conventions: 'small modules', relevant_files: [{ path: 'src/a.js', role: 'primary', note: 'target' }], test_command: 'npm test', run_command: 'npm run dev' } },
  security: { status: 'findings', summary: 'secure', findings: [], threat_model_notes: null },
  coder: { summary: 'FIRST-CODER-REPORT-MUST-NOT-REACH-FIX', files_changed: ['src/a.js'], tests: { result: 'passed', command: 'npm test' }, docs_updated: [], deviations: [] },
  review: { status: 'changes_requested', summary: 'fix this', issues: [{ file: 'src/a.js', severity: 'major', what: 'missing case', suggestion: 'cover it' }], verification: { verdict: 'failed', criteria: [], blockers: [] }, attacks: [] },
}
const claudeFix = buildPrompt({ role: 'coder', task: 'task', context: handoff })
const codexFix = buildCodexPrompt({ role: 'coder', task: 'task', context: handoff })
if (!claudeFix.includes('FIRST-CODER-REPORT-MUST-NOT-REACH-FIX') || codexFix.includes('FIRST-CODER-REPORT-MUST-NOT-REACH-FIX') || !codexFix.includes('missing case') || !codexFix.includes('src/a.js')) {
  throw new Error('Codex handoff did not retain plan/review while dropping the previous Coder report')
}
console.log('✓ Codex fix handoff retains actionable plan and review data but drops the previous Coder report; Claude prompt is unchanged')

const narrowContext = {
  plan: { summary: 'FULL-PLAN-SUMMARY-SENTINEL', complexity: 'complex', security_surface: 'none', risks: ['PLAN-RISK-SENTINEL'], steps: [{ what: 'IMPLEMENTATION-DETAIL-SENTINEL', files: ['src/a.js'], acceptance: 'returns the expected value' }], codebase_context: { stack: 'node', relevant_files: [] } },
  coder: { summary: 'CODER-NARRATIVE-SENTINEL', files_changed: ['src/a.js'], tests: { command: 'npm test', result: 'passed' }, docs_updated: [], deviations: [] },
  review: { status: 'changes_requested', summary: 'final verdict', issues: [{ file: 'src/a.js', severity: 'major', what: 'UNRESOLVED-SENTINEL', suggestion: 'fix it' }], verification: { verdict: 'failed', criteria: [{ criterion: 'x', status: 'failed', evidence: 'VERIFICATION-EVIDENCE-SENTINEL', note: '' }], blockers: [] }, attacks: [] },
}
const reviewerPrompt = buildCodexPrompt({ role: 'reviewer', task: 'task', context: narrowContext })
if (!reviewerPrompt.includes('returns the expected value') || !reviewerPrompt.includes('src/a.js') || reviewerPrompt.includes('FULL-PLAN-SUMMARY-SENTINEL') || reviewerPrompt.includes('PLAN-RISK-SENTINEL') || reviewerPrompt.includes('IMPLEMENTATION-DETAIL-SENTINEL')) throw new Error('Reviewer received more than acceptance criteria and changed-file evidence')
const recorderPrompt = buildCodexPrompt({ role: 'recorder', task: 'task', context: narrowContext })
if (!recorderPrompt.includes('final verdict') || !recorderPrompt.includes('UNRESOLVED-SENTINEL') || recorderPrompt.includes('VERIFICATION-EVIDENCE-SENTINEL') || recorderPrompt.includes('IMPLEMENTATION-DETAIL-SENTINEL') || recorderPrompt.includes('CODER-NARRATIVE-SENTINEL')) throw new Error('Recorder handoff was not reduced to verdict, unresolved work, and compact run metadata')
console.log('✓ Reviewer and Recorder receive narrow role-specific Codex handoffs')

const usage = summarizeTokenUsage([
  { stage: 'planner', model: 'terra', usage: { input_tokens: 100, cache_creation_input_tokens: 10, cache_read_input_tokens: 60, output_tokens: 20 } },
  { stage: 'coder', model: 'sol', usage: { input_tokens: 200, cache_creation_input_tokens: 20, cache_read_input_tokens: 150, output_tokens: 40 } },
])
if (usage.status !== 'measured' || usage.input_tokens !== 300 || usage.cache_creation_input_tokens !== 30 || usage.cached_input_tokens !== 210 || usage.output_tokens !== 60 || usage.total_tokens !== 600 || usage.stages[1].model !== 'sol') throw new Error('per-stage token usage was not aggregated accurately')
const unavailableUsage = summarizeTokenUsage([{ stage: 'reviewer', model: 'terra', usage: null }])
if (unavailableUsage.status !== 'unavailable' || unavailableUsage.input_tokens !== null) throw new Error('missing CLI usage must not be reported as zero')
console.log('✓ Codex token usage reports real per-stage counters and never turns missing data into zero')

const covered = { surface_analysis: { project_type: 'test', surfaces: [{ id: 'logic', name: 'Logic', change: 'test change', contracts: [], principles: ['correctness'], coverage: 'covered', evidence: ['test fixture'], resolution: 'follow fixture' }] } }
const calls = []
const adapter = {
  async run(options) {
    calls.push(options)
    if (options.role === 'planner') return { value: { ...covered, summary: 'plan' }, raw: '{}' }
    if (options.role === 'coder') return { value: { summary: 'code' }, raw: '{}' }
    return { value: { status: calls.filter(c => c.role === 'reviewer').length === 1 ? 'changes_requested' : 'approved' }, raw: '{}' }
  },
}
const pipeline = createPipeline({
  adapter,
  schemas: { planner: 'plan', coder: 'code', reviewer: 'review' },
  prompt: ({ role }) => role,
  retries: 0,
})
const result = await pipeline({ task: 'test', cwd: process.cwd() })
const roles = calls.map(c => c.role).join(',')
const writable = calls.filter(c => c.role === 'coder').every(c => c.writable === true)
if (!result.approved || roles !== 'planner,coder,reviewer,coder,reviewer' || !writable) {
  throw new Error(`unexpected pipeline: approved=${result.approved} roles=${roles} writable=${writable}`)
}
console.log('✓ shared pipeline performs plan → code → review → fix → review')

const planOnlyCalls = []
const planOnly = createPipeline({
  adapter: { async run(options) { planOnlyCalls.push(options.role); return { value: { ...covered, summary: 'plan' }, raw: '{}' } } },
  schemas: { planner: 'plan', coder: 'code', reviewer: 'review' },
  prompt: ({ role }) => role,
  retries: 0,
})
const planned = await planOnly({ task: 'test', cwd: process.cwd(), planOnly: true })
if (planned.mode !== 'plan-only' || planOnlyCalls.join(',') !== 'planner') {
  throw new Error(`unexpected plan-only pipeline: mode=${planned.mode} roles=${planOnlyCalls.join(',')}`)
}
console.log('✓ plan-only stops after the planner')

const approvedPlanCalls = []
const approvedPlanPipeline = createPipeline({
  adapter: {
    async run(options) {
      approvedPlanCalls.push(options.role)
      if (options.role === 'coder') return { value: { summary: 'implemented' }, raw: '{}' }
      return { value: { status: 'approved', summary: 'reviewed' }, raw: '{}' }
    },
  },
  schemas: { planner: 'plan', security: 'security', coder: 'code', reviewer: 'review' },
  prompt: ({ role }) => role,
  retries: 0,
})
const resumed = await approvedPlanPipeline({
  task: 'approved task', cwd: process.cwd(),
  approvedPlan: { ...covered, complexity: 'medium', security_surface: 'elevated', summary: 'approved plan' },
  approvedSecurity: { status: 'clean', findings: [], summary: 'approved security' },
})
if (approvedPlanCalls.join(',') !== 'coder,reviewer' || !resumed.approved || resumed.plan.resumed !== true || resumed.security.resumed !== true) {
  throw new Error(`approved plan was not reused: ${approvedPlanCalls.join(',')}`)
}
console.log('✓ an approved saved plan reuses its Security result and continues at Code without another Planner call')

const resumeCalls = []
const resumePipeline = createPipeline({
  adapter: { async run(options) { resumeCalls.push(options.role); return { value: { status: 'approved', summary: 'reviewed' }, raw: '{}' } } },
  schemas: { planner: 'plan', coder: 'code', reviewer: 'review' },
  prompt: ({ role }) => role, retries: 0,
})
const afterCoder = await resumePipeline({
  task: 'resume review', cwd: process.cwd(),
  approvedPlan: { ...covered, complexity: 'medium', security_surface: 'none', summary: 'approved plan' },
  completed: { coder: { summary: 'already implemented' } },
})
if (resumeCalls.join(',') !== 'reviewer' || !afterCoder.coder.resumed || !afterCoder.approved) throw new Error(`Coder checkpoint did not resume at Reviewer: ${resumeCalls.join(',')}`)
console.log('✓ a run checkpoint after Coder resumes directly at Reviewer')

const securityCalls = []
const securityPipeline = createPipeline({
  adapter: {
    async run(options) {
      securityCalls.push(options)
      if (options.role === 'planner') return { value: { ...covered, summary: 'plan', security_surface: 'elevated' }, raw: '{}' }
      return { value: { status: 'clean', summary: 'threat model', findings: [], threat_model_notes: null }, raw: '{}' }
    },
  },
  schemas: { planner: 'plan', security: 'security', coder: 'code', reviewer: 'review' },
  prompt: ({ role }) => role,
  retries: 0,
})
const securedPlan = await securityPipeline({ task: 'test', cwd: process.cwd(), planOnly: true })
if (securityCalls.map(c => c.role).join(',') !== 'planner,security' || securedPlan.security?.value.status !== 'clean') {
  throw new Error(`security phase did not follow elevated plan: ${securityCalls.map(c => c.role).join(',')}`)
}
console.log('✓ elevated plans run Security before plan-only returns')

const researchCalls = []
const researchPipeline = createPipeline({
  adapter: {
    async run(options) {
      researchCalls.push(options)
      if (options.role === 'researcher') return { value: { summary: 'research' }, raw: '{}' }
      return { value: { ...covered, summary: 'plan', security_surface: 'none' }, raw: '{}' }
    },
  },
  schemas: { researcher: 'research', planner: 'plan', coder: 'code', reviewer: 'review' },
  prompt: ({ role }) => role,
  retries: 0,
})
const researchedPlan = await researchPipeline({ task: 'test', cwd: process.cwd(), research: true, planOnly: true })
if (researchCalls.map(c => c.role).join(',') !== 'researcher,planner' || researchCalls[0].search !== true || researchedPlan.research?.value.summary !== 'research') {
  throw new Error(`research phase was not carried into planning: ${researchCalls.map(c => c.role).join(',')}`)
}
console.log('✓ opt-in research runs before planning and is carried forward')

const governanceCalls = []
let planningPass = 0
const governancePipeline = createPipeline({
  adapter: { async run(options) {
    governanceCalls.push(options.role)
    if (options.role === 'researcher') return { value: { summary: 'evidence' }, raw: '{}' }
    if (options.role === 'planner') {
      planningPass++
      const coverage = planningPass === 1 ? 'research_required' : 'resolved'
      return { value: { ...covered, surface_analysis: { project_type: 'cli', surfaces: [{ ...covered.surface_analysis.surfaces[0], coverage }] }, summary: 'plan', security_surface: 'none' }, raw: '{}' }
    }
    return { value: { status: 'approved' }, raw: '{}' }
  } },
  schemas: { researcher: 'research', planner: 'plan', coder: 'code', reviewer: 'review' },
  prompt: ({ role }) => role, retries: 0,
})
const governed = await governancePipeline({ task: 'governed', cwd: process.cwd(), planOnly: true })
if (governanceCalls.join(',') !== 'planner,researcher,planner' || governed.mode !== 'plan-only') throw new Error(`required research did not re-plan before coding: ${governanceCalls.join(',')}`)

const blockedCalls = []
const blockedPipeline = createPipeline({
  adapter: { async run(options) { blockedCalls.push(options.role); return { value: { ...covered, surface_analysis: { project_type: 'cli', surfaces: [{ ...covered.surface_analysis.surfaces[0], coverage: 'contract_candidate' }] }, summary: 'blocked' }, raw: '{}' } } },
  schemas: { planner: 'plan', coder: 'code', reviewer: 'review' }, prompt: ({ role }) => role, retries: 0,
})
const blocked = await blockedPipeline({ task: 'blocked', cwd: process.cwd() })
if (blocked.mode !== 'resolution-required' || blockedCalls.join(',') !== 'planner') throw new Error('contract candidate reached Code')
console.log('✓ surface governance automatically researches uncertain coverage and blocks unresolved contract candidates before Code')

const recordCalls = []
const recordPipeline = createPipeline({
  adapter: {
    async run(options) {
      recordCalls.push(options)
      const values = {
        planner: { ...covered, complexity: 'medium', summary: 'plan', security_surface: 'none' },
        coder: { summary: 'code' },
        reviewer: { status: 'approved', summary: 'review' },
        recorder: { worktree_root: process.cwd(), files_written: ['docs/reviews/test.md'], backlog: { destination: 'none', file: null, count: 0 }, notes: '' },
      }
      return { value: values[options.role], raw: '{}' }
    },
  },
  schemas: { planner: 'plan', coder: 'code', reviewer: 'review', recorder: 'record' },
  prompt: ({ role }) => role,
  retries: 0,
})
const recorded = await recordPipeline({ task: 'test', cwd: process.cwd() })
if (recordCalls.map(c => c.role).join(',') !== 'planner,coder,reviewer,recorder' || recordCalls.at(-1).writable !== true || recorded.record?.value.files_written.length !== 1) {
  throw new Error(`record phase did not persist after an approved medium plan: ${recordCalls.map(c => c.role).join(',')}`)
}
console.log('✓ medium approved runs persist a recorder report')

const scopedContexts = []
const scopedPipeline = createPipeline({
  adapter: {
    async run(options) {
      if (options.role === 'planner') return { value: { ...covered, complexity: 'medium', security_surface: 'none', summary: 'plan', steps: [{ files: ['src/a.js'] }], codebase_context: { relevant_files: [{ path: 'test/a.test.js', role: 'test' }], test_command: 'npm test', test_command_scoped: 'npm test -- {paths}' } }, raw: '{}' }
      if (options.role === 'coder') return { value: { summary: 'code' }, raw: '{}' }
      return { value: { status: 'approved' }, raw: '{}' }
    },
  },
  schemas: { planner: 'plan', coder: 'code', reviewer: 'review' },
  prompt: ({ role, context }) => { scopedContexts.push({ role, context }); return role },
  scopedTests: true, retries: 0,
})
await scopedPipeline({ task: 'scoped', cwd: process.cwd() })
const scopedRoles = scopedContexts.filter(item => ['coder', 'reviewer'].includes(item.role))
if (scopedRoles.length !== 2 || scopedRoles.some(item => item.context.scopedTests.command !== 'npm test -- test/a.test.js')) throw new Error('safe scoped test was not handed to Coder and Reviewer')
console.log('✓ Codex scoped tests expand only validated repository-relative paths')

const noTestContexts = []
const noTestPipeline = createPipeline({
  adapter: { async run(options) {
    if (options.role === 'planner') return { value: { ...covered, complexity: 'trivial', security_surface: 'none', steps: [{ files: ['package.json', 'src/a.js'] }], codebase_context: { relevant_files: [{ path: 'package.json', role: 'config' }], test_command: 'node --test', test_command_scoped: 'node --test {paths}' } }, raw: '{}' }
    if (options.role === 'coder') return { value: {}, raw: '{}' }
    return { value: { status: 'approved' }, raw: '{}' }
  } },
  schemas: { planner: 'plan', coder: 'code', reviewer: 'review' },
  prompt: ({ context }) => { noTestContexts.push(context); return 'prompt' },
  scopedTests: true, retries: 0,
})
await noTestPipeline({ task: 'no test path', cwd: process.cwd() })
if (noTestContexts.some(context => context?.scopedTests)) throw new Error('scoped test fallback accepted a config or source file as a test target')
console.log('✓ scoped tests fall back to the full suite instead of passing non-test files')
NODE

LDO_ISOLATION_WORK="$(mktemp -d)"
trap 'rm -rf "$LDO_ISOLATION_WORK"' EXIT
git -C "$LDO_ISOLATION_WORK" init -q
git -C "$LDO_ISOLATION_WORK" config user.email ldo-test@example.invalid
git -C "$LDO_ISOLATION_WORK" config user.name 'LDO core test'
git -C "$LDO_ISOLATION_WORK" commit --allow-empty -qm 'initial'

LDO_ISOLATION_WORK="$LDO_ISOLATION_WORK" node --input-type=module <<'NODE'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createIsolatedWorktree } from './core/isolation.mjs'
import { checkpointRun, createRunCheckpoint, finishRunCheckpoint, loadApprovedPlan, loadRunCheckpoint, saveApprovedPlan } from './core/plan-store.mjs'

const root = process.env.LDO_ISOLATION_WORK
const isolated = await createIsolatedWorktree({ cwd: root, task: 'A safe isolated test' })
const ignored = await readFile(join(root, '.gitignore'), 'utf8')
if (!isolated.path.startsWith(`${root}/.worktrees/`) || isolated.branch !== 'ldo/a-safe-isolated-test' || !ignored.includes('.worktrees/')) {
  throw new Error(`unexpected isolation result: ${JSON.stringify(isolated)}`)
}
console.log('✓ deterministic isolation creates and verifies a fresh worktree')

const plan = { complexity: 'medium', security_surface: 'none', summary: 'saved plan', surface_analysis: { project_type: 'test', surfaces: [{ id: 'logic', coverage: 'resolved', evidence: ['approved fixture'] }] }, steps: [], risks: [], codebase_context: { stack: 'node', conventions: '', relevant_files: [], test_command: 'npm test', test_command_scoped: null, run_command: '' } }
const saved = await saveApprovedPlan({ cwd: root, task: 'checkpoint test', plan, security: null })
const approved = await loadApprovedPlan({ cwd: root, reference: saved.id })
const run = await createRunCheckpoint({ cwd: root, approved })
await checkpointRun({ state: run, checkpoint: 'coder', value: { summary: 'done' } })
const resumed = await loadRunCheckpoint({ cwd: root, reference: 'latest' })
if (resumed.completed.coder.summary !== 'done' || resumed.status !== 'running' || resumed.tokenUsage.status !== 'unavailable') throw new Error('run checkpoint did not preserve completed phase and incremental token totals')
await finishRunCheckpoint({ state: resumed, result: { approved: true, record: { value: { backlog: { destination: 'file', file: 'docs/BACKLOG.md', count: 1 } } } } })
const completed = JSON.parse(await readFile(resumed.path, 'utf8'))
if (completed.status !== 'completed' || completed.backlog.count !== 1) throw new Error('terminal checkpoint did not preserve backlog outcome')
console.log('✓ plan artifacts and terminal run checkpoints preserve resume and backlog state')
NODE
