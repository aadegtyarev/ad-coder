import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { summarizeTokenUsage } from './token-usage.mjs'

const PLAN_ID = /^[a-z0-9][a-z0-9-]{0,95}$/

function slug(value) {
  const result = String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
  return result || 'plan'
}

function git(args, cwd) {
  return new Promise((resolveResult, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolveResult(stdout.trim()) : reject(new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`)))
  })
}

function isPlan(value) {
  const surfaces = value?.surface_analysis?.surfaces
  const ids = Array.isArray(surfaces) ? surfaces.map(surface => surface?.id) : []
  return !!value && typeof value === 'object' && typeof value.summary === 'string' && Array.isArray(value.steps) && value.codebase_context && typeof value.codebase_context === 'object' && Array.isArray(value.codebase_context.relevant_files) && typeof value.surface_analysis?.project_type === 'string' && Array.isArray(surfaces) && surfaces.length > 0 && surfaces.length <= 20 && new Set(ids).size === ids.length && surfaces.every(surface => /^[a-z0-9][a-z0-9-]{0,63}$/.test(surface?.id || '') && ['covered', 'not_applicable', 'resolved'].includes(surface?.coverage) && Array.isArray(surface?.evidence) && surface.evidence.some(item => String(item || '').trim()))
}

function isSecurity(value) {
  return value === null || value === undefined || (!!value && typeof value === 'object' && typeof value.status === 'string' && Array.isArray(value.findings))
}

async function rootOf(cwd) { return git(['rev-parse', '--show-toplevel'], cwd) }
async function planDirectory(cwd) { return join(await rootOf(cwd), '.codex', 'ldo', 'plans') }
async function runDirectory(cwd) { return join(await rootOf(cwd), '.codex', 'ldo', 'runs') }

export async function saveApprovedPlan({ cwd, task, plan, security, usage = [] }) {
  if (!isPlan(plan) || !isSecurity(security)) throw new Error('refusing to save malformed plan artifact')
  const root = await rootOf(cwd)
  const baseHead = await git(['rev-parse', 'HEAD'], root)
  const directory = await planDirectory(root)
  await mkdir(directory, { recursive: true })
  const id = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 17)}-${slug(task)}-${randomBytes(3).toString('hex')}`
  const path = join(directory, `${id}.json`)
  const artifact = { version: 1, id, root, baseHead, createdAt: new Date().toISOString(), task, plan, security: security || null, usage }
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
  return { id, path, baseHead, createdAt: artifact.createdAt }
}

export async function loadApprovedPlan({ cwd, reference = 'latest' }) {
  const root = await rootOf(cwd)
  const directory = await planDirectory(root)
  let filename
  if (reference === 'latest') {
    const files = (await readdir(directory)).filter(file => file.endsWith('.json')).sort()
    filename = files.at(-1)
    if (!filename) throw new Error('no saved LDO plan artifact exists; run --plan-only first')
  } else {
    if (!PLAN_ID.test(reference)) throw new Error('invalid saved plan id')
    filename = `${reference}.json`
  }
  const path = join(directory, filename)
  if (basename(path) !== filename) throw new Error('unsafe saved plan path')
  let artifact
  try { artifact = JSON.parse(await readFile(path, 'utf8')) } catch (error) { throw new Error(`could not read saved plan artifact: ${error.message}`) }
  const head = await git(['rev-parse', 'HEAD'], root)
  if (!artifact || artifact.version !== 1 || artifact.root !== root || artifact.baseHead !== head || typeof artifact.task !== 'string' || !isPlan(artifact.plan) || !isSecurity(artifact.security)) {
    throw new Error('saved plan is stale or malformed; run --plan-only again before implementation')
  }
  return { ...artifact, path }
}

export async function createRunCheckpoint({ cwd, approved }) {
  const directory = await runDirectory(cwd)
  await mkdir(directory, { recursive: true })
  const id = approved.id
  const path = join(directory, `${id}.json`)
  const state = { version: 1, id, root: approved.root, baseHead: approved.baseHead, task: approved.task, plan: approved.plan, security: approved.security, status: 'running', startedAt: new Date().toISOString(), usage: approved.usage || [], completed: {} }
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  return { ...state, path }
}

export async function checkpointRun({ state, checkpoint, value, usage = null, model = null }) {
  if (!state || !PLAN_ID.test(state.id) || typeof checkpoint !== 'string') throw new Error('invalid run checkpoint')
  state.completed[checkpoint] = value
  state.usage ||= []
  state.usage.push({ stage: checkpoint, model, usage })
  state.tokenUsage = summarizeTokenUsage(state.usage)
  await writeFile(state.path, `${JSON.stringify({ ...state, path: undefined }, null, 2)}\n`, 'utf8')
}

export async function finishRunCheckpoint({ state, result }) {
  if (!state || !PLAN_ID.test(state.id) || !result) throw new Error('invalid terminal run checkpoint')
  state.status = 'completed'
  state.completedAt = new Date().toISOString()
  state.approved = result.approved === true
  state.backlog = result.record?.value?.backlog || { destination: 'none', file: null, count: 0 }
  state.tokenUsage = result.tokenUsage || null
  await writeFile(state.path, `${JSON.stringify({ ...state, path: undefined }, null, 2)}\n`, 'utf8')
}

export async function loadRunCheckpoint({ cwd, reference = 'latest' }) {
  const root = await rootOf(cwd)
  const directory = await runDirectory(root)
  let filename
  if (reference === 'latest') {
    const files = (await readdir(directory)).filter(file => file.endsWith('.json')).sort()
    for (const candidate of files.reverse()) {
      try {
        const value = JSON.parse(await readFile(join(directory, candidate), 'utf8'))
        if (value?.status !== 'completed') { filename = candidate; break }
      } catch {}
    }
    if (!filename) throw new Error('no interrupted LDO run exists; continue an approved plan first')
  } else {
    if (!PLAN_ID.test(reference)) throw new Error('invalid saved run id')
    filename = `${reference}.json`
  }
  const path = join(directory, filename)
  let state
  try { state = JSON.parse(await readFile(path, 'utf8')) } catch (error) { throw new Error(`could not read saved run checkpoint: ${error.message}`) }
  const head = await git(['rev-parse', 'HEAD'], root)
  if (!state || state.version !== 1 || state.root !== root || state.baseHead !== head || typeof state.task !== 'string' || !isPlan(state.plan) || !isSecurity(state.security) || !state.completed || typeof state.completed !== 'object') {
    throw new Error('saved run is stale or malformed; create a fresh plan before resuming')
  }
  return { ...state, path }
}
