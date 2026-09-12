/**
 * The shared LDO phase pipeline. Runtime-specific concerns belong in the
 * adapter passed to createAgentRunner; policy and phase ordering live here.
 */
import { createAgentRunner } from './agent-runner.mjs'

function contextOf(values) {
  const entries = Object.entries(values).filter(([, value]) => value !== undefined && value !== null)
  return entries.length ? Object.fromEntries(entries) : undefined
}

function scopedTestOf(plan) {
  const template = plan?.codebase_context?.test_command_scoped
  if (typeof template !== 'string' || template.length > 500 || template.split('{paths}').length !== 2) return null
  const shellFree = template.replace('{paths}', '')
  if (/[|&;<>`$(){}?\n\r]/.test(shellFree)) return null
  const broad = String(plan?.codebase_context?.test_command || '').trim().split(/\s+/)[0]
  const command = shellFree.trim().split(/\s+/)[0]
  const allowed = new Set(['npm', 'npx', 'yarn', 'pnpm', 'pytest', 'python', 'python3', 'go', 'cargo', 'mvn', 'gradle', 'dotnet', 'rspec', 'bundle', 'phpunit', 'jest', 'vitest', 'ctest', 'make', 'tox', 'deno', 'bun', 'node'])
  if (!allowed.has(command) && command !== broad) return null
  const candidates = (plan.codebase_context.relevant_files || []).filter(file => /test|spec/i.test(`${file.role} ${file.path}`)).map(file => file.path)
  const fallback = (plan.steps || []).flatMap(step => step.files || []).filter(path => /(^|[/_.-])(test|tests|spec|specs)([/_.-]|$)/i.test(path))
  const paths = [...new Set(candidates.length ? candidates : fallback)].filter(path => typeof path === 'string' && path.length <= 300 && !path.startsWith('-') && !path.startsWith('/') && !path.split('/').includes('..') && /^[A-Za-z0-9_./-]+$/.test(path)).slice(0, 20)
  if (!paths.length) return null
  return { command: template.replace('{paths}', paths.join(' ')), paths }
}

const RESOLVED_COVERAGE = new Set(['covered', 'not_applicable', 'resolved'])

export function unresolvedPlanCoverage(plan) {
  const analysis = plan?.surface_analysis
  if (!analysis || typeof analysis.project_type !== 'string' || !Array.isArray(analysis.surfaces) || !analysis.surfaces.length || analysis.surfaces.length > 20) {
    return [{ id: 'surface-analysis', coverage: 'missing', name: 'Surface analysis' }]
  }
  const seen = new Set()
  return analysis.surfaces.filter(surface => {
    if (!surface || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(surface.id || '') || seen.has(surface.id)) return true
    seen.add(surface.id)
    if (!RESOLVED_COVERAGE.has(surface.coverage)) return true
    return !Array.isArray(surface.evidence) || !surface.evidence.some(item => String(item || '').trim())
  })
}

function researchQuestion(task, plan, gaps) {
  return [
    'Research the engineering requirements needed to resolve these affected product surfaces before implementation.',
    `Task: ${task}`,
    `Project type: ${plan?.surface_analysis?.project_type || 'unknown'}`,
    `Unresolved surfaces: ${JSON.stringify(gaps)}`,
    'Return evidence-backed findings mapped to the stable surface IDs. Prefer authoritative standards and established project evidence.',
  ].join('\n')
}

export function createPipeline({ adapter, prompt, schemas, models = {}, retries = 1, onEvent, scopedTests = false }) {
  if (typeof prompt !== 'function') throw new TypeError('prompt({ role, task, context }) is required')
  if (!schemas?.planner || !schemas?.coder || !schemas?.reviewer) throw new TypeError('planner, coder and reviewer schemas are required')

  const runAgent = createAgentRunner(adapter, { retries, onEvent })
  const modelFor = (role, plan = null) => typeof models[role] === 'function' ? models[role](plan) : models[role]

  return async function run({ task, cwd, planOnly = false, security = 'auto', research = false, record = true, isolation = null, approvedPlan = null, approvedSecurity = null, completed = {} }) {
    const execution = isolation ? { isolation } : {}
    let researchReport = !approvedPlan && research && schemas.researcher
      ? await runAgent({
        role: 'researcher', cwd, model: modelFor('researcher'), schema: schemas.researcher, search: true,
        prompt: prompt({ role: 'researcher', task, context: contextOf(execution) }),
      })
      : null

    let plan = approvedPlan ? { value: approvedPlan, raw: JSON.stringify(approvedPlan), role: 'planner', attempt: 0, resumed: true } : await runAgent({
      checkpoint: 'planner',
      role: 'planner', cwd, model: modelFor('planner'), schema: schemas.planner,
      prompt: prompt({ role: 'planner', task, context: contextOf({ ...execution, research: researchReport?.value }) }),
    })
    let coverageGaps = unresolvedPlanCoverage(plan.value)
    if (!approvedPlan && coverageGaps.some(gap => gap.coverage === 'research_required') && schemas.researcher) {
      researchReport = await runAgent({
        role: 'researcher', cwd, model: modelFor('researcher'), schema: schemas.researcher, search: true,
        prompt: prompt({ role: 'researcher', task: researchQuestion(task, plan.value, coverageGaps), context: contextOf({ ...execution, plan: plan.value }) }),
      })
      plan = await runAgent({
        checkpoint: 'planner', role: 'planner', cwd, model: modelFor('planner'), schema: schemas.planner,
        prompt: prompt({ role: 'planner', task, context: contextOf({ ...execution, previousPlan: plan.value, research: researchReport.value }) }),
      })
      coverageGaps = unresolvedPlanCoverage(plan.value)
    }
    const unresolvedConflicts = Array.isArray(plan.value?.conflicts) ? plan.value.conflicts.filter(item => item && !String(item).trim().startsWith('NONE —')) : []
    if (coverageGaps.length || unresolvedConflicts.length) {
      return { task, mode: 'resolution-required', research: researchReport, plan, security: null, unresolvedCoverage: coverageGaps, unresolvedConflicts, approved: false }
    }
    const shouldRunSecurity = schemas.security && (security === true || (security === 'auto' && plan.value.security_surface === 'elevated'))
    const securityReport = approvedSecurity ? { value: approvedSecurity, raw: JSON.stringify(approvedSecurity), role: 'security', attempt: 0, resumed: true } : shouldRunSecurity
      ? await runAgent({
        checkpoint: 'security',
        role: 'security', cwd, model: modelFor('security', plan.value), schema: schemas.security,
        prompt: prompt({ role: 'security', task, context: contextOf({ ...execution, plan: plan.value }) }),
      })
      : null

    if (planOnly) return { task, mode: 'plan-only', research: researchReport, plan, security: securityReport }

    const scopedTest = scopedTests ? scopedTestOf(plan.value) : null

    let coder = completed.coder ? { value: completed.coder, raw: JSON.stringify(completed.coder), role: 'coder', attempt: 0, resumed: true } : await runAgent({
      checkpoint: 'coder',
      role: 'coder', cwd, model: modelFor('coder', plan.value), schema: schemas.coder,
      writable: true, prompt: prompt({ role: 'coder', task, context: contextOf({ ...execution, scopedTests: scopedTest, plan: plan.value, security: securityReport?.value }) }),
    })

    let review = completed.reviewer1 ? { value: completed.reviewer1, raw: JSON.stringify(completed.reviewer1), role: 'reviewer', attempt: 0, resumed: true } : await runAgent({
      checkpoint: 'reviewer1',
      role: 'reviewer', cwd, model: modelFor('reviewer', plan.value), schema: schemas.reviewer,
      prompt: prompt({ role: 'reviewer', task, context: contextOf({ ...execution, scopedTests: scopedTest, plan: plan.value, security: securityReport?.value, coder: coder.value }) }),
    })

    if (review.value.status === 'changes_requested') {
      coder = completed.coderFix1 ? { value: completed.coderFix1, raw: JSON.stringify(completed.coderFix1), role: 'coder', attempt: 0, resumed: true } : await runAgent({
        checkpoint: 'coderFix1',
        role: 'coder', cwd, model: modelFor('coder', plan.value), schema: schemas.coder,
        writable: true, prompt: prompt({ role: 'coder', task, context: contextOf({ ...execution, scopedTests: scopedTest, plan: plan.value, security: securityReport?.value, coder: coder.value, review: review.value }) }),
      })
      review = completed.reviewer2 ? { value: completed.reviewer2, raw: JSON.stringify(completed.reviewer2), role: 'reviewer', attempt: 0, resumed: true } : await runAgent({
        checkpoint: 'reviewer2',
        role: 'reviewer', cwd, model: modelFor('reviewer', plan.value), schema: schemas.reviewer,
        prompt: prompt({ role: 'reviewer', task, context: contextOf({ ...execution, scopedTests: scopedTest, plan: plan.value, security: securityReport?.value, coder: coder.value, previousReview: review.value }) }),
      })
    }

    const approved = review.value.status === 'approved'
    const shouldRecord = record && schemas.recorder && (plan.value.complexity !== 'trivial' || !approved)
    const recordReport = completed.recorder ? { value: completed.recorder, raw: JSON.stringify(completed.recorder), role: 'recorder', attempt: 0, resumed: true } : shouldRecord
      ? await runAgent({
        checkpoint: 'recorder',
        role: 'recorder', cwd, model: modelFor('recorder', plan.value), schema: schemas.recorder, writable: true,
        prompt: prompt({ role: 'recorder', task, context: contextOf({ ...execution, plan: plan.value, security: securityReport?.value, coder: coder.value, review: review.value }) }),
      })
      : null

    return { task, research: researchReport, plan, security: securityReport, coder, review, record: recordReport, approved }
  }
}
