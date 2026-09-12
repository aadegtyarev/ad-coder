#!/usr/bin/env node
import { resolve } from 'node:path'
import { createClaudeCliAdapter } from '../adapters/claude-cli.mjs'
import { createCodexCliAdapter } from '../adapters/codex-cli.mjs'
import { createPipeline } from '../core/pipeline.mjs'
import { buildCodexPrompt, buildPrompt } from '../core/prompts.mjs'
import { createIsolatedWorktree } from '../core/isolation.mjs'
import { checkpointRun, createRunCheckpoint, finishRunCheckpoint, loadApprovedPlan, loadRunCheckpoint, saveApprovedPlan } from '../core/plan-store.mjs'
import { summarizeTokenUsage } from '../core/token-usage.mjs'

// Sol owns planning and elevated/complex implementation; CLI flags win.
const CODEX_DEFAULT_MODELS = {
  planner: 'gpt-5.6-sol',
  coder: plan => plan?.complexity === 'complex' || plan?.security_surface === 'elevated' ? 'gpt-5.6-sol' : 'gpt-5.6-terra',
  security: 'gpt-5.6-sol',
  reviewer: 'gpt-5.6-terra',
  researcher: 'gpt-5.6-terra',
  recorder: 'gpt-5.6-luna',
}

function usage() {
  console.error('Usage: node scripts/ldo-run.mjs --runtime codex|claude [--model MODEL] [--planner-model MODEL] [--researcher-model MODEL] [--coder-model MODEL] [--reviewer-model MODEL] [--security-model MODEL] [--recorder-model MODEL] [--research] [--plan-only] [--review-plan auto|always|never] [--continue-plan ID|latest] [--resume-run ID|latest] [--isolate] [--no-record] [--security auto|true|false] [--task "task"]... "task"')
  process.exit(2)
}

const args = process.argv.slice(2)
const options = { planOnly: false, isolate: false, research: false, record: true, security: 'auto', reviewPlan: 'auto' }
const taskParts = []
const tasks = []
const valueFlags = new Set(['--runtime', '--model', '--planner-model', '--researcher-model', '--coder-model', '--reviewer-model', '--security-model', '--recorder-model', '--security', '--task', '--continue-plan', '--resume-run', '--review-plan'])
for (let index = 0; index < args.length; index++) {
  const arg = args[index]
  if (arg === '--no-record') {
    options.record = false
  } else if (arg === '--plan-only' || arg === '--isolate' || arg === '--research') {
    options[arg === '--plan-only' ? 'planOnly' : arg === '--isolate' ? 'isolate' : 'research'] = true
  } else if (valueFlags.has(arg)) {
    const value = args[++index]
    if (!value) usage()
    if (arg === '--task') tasks.push(value)
    else options[arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value
  } else {
    taskParts.push(arg)
  }
}
const runtime = options.runtime
const positionalTask = taskParts.join(' ').trim()
if (positionalTask) tasks.push(positionalTask)
if (!runtime || (!tasks.length && !options.continuePlan && !options.resumeRun) || !['codex', 'claude'].includes(runtime)) usage()
if (!['auto', 'true', 'false'].includes(options.security) || !['auto', 'always', 'never'].includes(options.reviewPlan)) usage()
if ((options.continuePlan || options.resumeRun) && (runtime !== 'codex' || tasks.length || options.planOnly || options.isolate)) usage()
if (options.continuePlan && options.resumeRun) usage()

const root = resolve(new URL('..', import.meta.url).pathname)
const schemas = Object.fromEntries(['researcher', 'planner', 'security', 'coder', 'reviewer', 'recorder'].map(role => [role, resolve(root, 'schemas', `${role}.json`)]))
const adapter = runtime === 'codex' ? createCodexCliAdapter() : createClaudeCliAdapter()
let activeRun = null
let usageEntries = []
const roleModels = Object.fromEntries(['planner', 'researcher', 'coder', 'reviewer', 'security', 'recorder'].map(role => {
  const override = options[`${role}Model`] || options.model
  if (override || runtime !== 'codex') return [role, override]
  return [role, CODEX_DEFAULT_MODELS[role]]
}))

const pipeline = createPipeline({
  adapter,
  // Claude retains its existing prompt exactly. Codex gets role-specific,
  // bounded handoffs because every phase is a fresh CLI context.
  prompt: runtime === 'codex' ? buildCodexPrompt : buildPrompt,
  schemas,
  models: roleModels,
  async onEvent(event) {
    console.error(`[${event.role}] ${event.type}`)
    if (event.type === 'agent_finished') {
      const entry = { stage: event.checkpoint || event.role, model: event.model || null, usage: event.result.usage || null }
      usageEntries.push(entry)
      if (activeRun && event.checkpoint) await checkpointRun({ state: activeRun, checkpoint: event.checkpoint, value: event.result.value, usage: entry.usage, model: entry.model })
    }
  },
  scopedTests: runtime === 'codex',
})

const originalCwd = process.cwd()
const multi = tasks.length > 1
const security = options.security === 'auto' ? 'auto' : options.security === 'true'

async function runTask(task, isolation, approved = null, completed = {}, planOnly = options.planOnly) {
  const result = await pipeline({
    task,
    cwd: isolation?.path || originalCwd,
    planOnly,
    research: options.research,
    record: options.record,
    isolation,
    security,
    approvedPlan: approved?.plan || null,
    approvedSecurity: approved?.security || null,
    completed,
  })
  const tokenUsage = summarizeTokenUsage(usageEntries)
  const enriched = { ...result, tokenUsage }
  const planArtifact = runtime === 'codex' && planOnly && result.mode !== 'resolution-required'
    ? await saveApprovedPlan({ cwd: isolation?.path || originalCwd, task, plan: result.plan.value, security: result.security?.value, usage: usageEntries })
    : null
  if (activeRun && !planOnly) await finishRunCheckpoint({ state: activeRun, result: enriched })
  return { ...enriched, isolation, planArtifact, runCheckpoint: activeRun?.path || null }
}

async function main() {
  if (options.resumeRun) {
    activeRun = await loadRunCheckpoint({ cwd: originalCwd, reference: options.resumeRun })
    usageEntries = [...(activeRun.usage || [])]
    console.error(`[resume] continuing ${activeRun.id} from ${Object.keys(activeRun.completed).join(', ') || 'the first incomplete phase'}`)
    return runTask(activeRun.task, null, activeRun, activeRun.completed)
  }
  if (options.continuePlan) {
    const approved = await loadApprovedPlan({ cwd: originalCwd, reference: options.continuePlan })
    usageEntries = [...(approved.usage || [])]
    console.error(`[plan] continuing ${approved.id} validated against ${approved.baseHead}`)
    activeRun = await createRunCheckpoint({ cwd: originalCwd, approved })
    return runTask(approved.task, null, approved)
  }
  // Worktree creation is serial on purpose: each `git worktree add` is fast,
  // while creating `.worktrees/` and its .gitignore rule concurrently is a
  // filesystem race. Agent phases below still execute in parallel.
  const isolations = []
  if (multi || options.isolate) {
    for (const task of tasks) {
      const isolation = await createIsolatedWorktree({ cwd: originalCwd, task })
      console.error(`[isolate] verified ${isolation.path} (${isolation.branch})`)
      isolations.push(isolation)
    }
  }

  const runFresh = async (task, isolation) => {
    if (runtime !== 'codex' || tasks.length > 1) return runTask(task, isolation)
    const planned = await runTask(task, isolation, null, {}, true)
    if (planned.mode === 'resolution-required') return planned
    const pause = options.planOnly || options.reviewPlan === 'always' || (options.reviewPlan === 'auto' && (planned.plan.value.complexity === 'complex' || planned.plan.value.security_surface === 'elevated'))
    if (pause) return { ...planned, mode: 'plan-review', plan_review_recommended: options.planOnly ? 'requested' : planned.plan.value.security_surface === 'elevated' ? 'elevated security surface' : 'complex plan' }
    const approved = await loadApprovedPlan({ cwd: isolation?.path || originalCwd, reference: planned.planArtifact.id })
    activeRun = await createRunCheckpoint({ cwd: isolation?.path || originalCwd, approved })
    return { ...(await runTask(task, isolation, approved)), planArtifact: planned.planArtifact }
  }
  const results = await Promise.all(tasks.map((task, index) => runFresh(task, isolations[index] || null)))
  if (!multi) return results[0]
  const approved = results.filter(result => result.approved).length
  const planned = results.filter(result => result.mode === 'plan-only').length
  return { mode: options.planOnly ? 'multi-plan-only' : 'multi', summary: { total: results.length, approved, planned }, features: results }
}

main().then(result => {
  console.log(JSON.stringify(result, null, 2))
  process.exitCode = result.mode === 'plan-only' || result.mode === 'plan-review' || result.mode === 'multi-plan-only' || result.approved ? 0 : 1
}).catch(error => {
  console.error(`LDO failed: ${error.message}`)
  process.exitCode = 1
})
