import { access, appendFile, mkdir, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'

function run(command, args, cwd) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolveRun(stdout.trim())
      else reject(new Error(`${command} ${args.join(' ')} failed (${code}): ${stderr.trim() || stdout.trim()}`))
    })
  })
}

function slugify(task) {
  const slug = String(task).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48)
  return slug || 'task'
}

function isSafeChild(root, candidate) {
  const path = relative(root, candidate)
  return Boolean(path) && path !== '..' && !path.startsWith(`..${sep}`) && !path.startsWith(sep)
}

async function exists(path) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function ignoreWorktrees(root) {
  const ignored = join(root, '.gitignore')
  let contents = ''
  try { contents = await readFile(ignored, 'utf8') } catch {}
  if (contents.split(/\r?\n/).includes('.worktrees/')) return false
  await appendFile(ignored, `${contents && !contents.endsWith('\n') ? '\n' : ''}.worktrees/\n`)
  return true
}

/** Create, then independently verify, an LDO worktree from the current HEAD. */
export async function createIsolatedWorktree({ cwd, task, attempts = 5 }) {
  const root = await run('git', ['rev-parse', '--show-toplevel'], cwd)
  const baseHead = await run('git', ['rev-parse', 'HEAD'], root)
  const stem = slugify(task)
  const worktreesRoot = resolve(root, '.worktrees')
  if (!isSafeChild(root, worktreesRoot)) throw new Error('refusing worktree path outside repository')
  await mkdir(worktreesRoot, { recursive: true })

  let lastError
  for (let number = 1; number <= attempts; number++) {
    const suffix = number === 1 ? '' : `-${number}`
    const label = `${stem}${suffix}`
    const path = resolve(worktreesRoot, label)
    const branch = `ldo/${label}`
    if (!isSafeChild(worktreesRoot, path) || basename(path) !== label) throw new Error('refusing unsafe worktree label')
    if (await exists(path)) continue

    try {
      await run('git', ['worktree', 'add', '-b', branch, path], root)
    } catch (error) {
      lastError = error
      continue
    }

    try {
      const [verifiedRoot, verifiedHead, verifiedBranch] = await Promise.all([
        run('git', ['rev-parse', '--show-toplevel'], path),
        run('git', ['rev-parse', 'HEAD'], path),
        run('git', ['symbolic-ref', '--short', 'HEAD'], path),
      ])
      if (verifiedRoot !== path || verifiedHead !== baseHead || verifiedBranch !== branch) {
        throw new Error(`worktree verification failed: root=${verifiedRoot} head=${verifiedHead} branch=${verifiedBranch}`)
      }
    } catch (error) {
      throw new Error(`worktree was created but could not be verified; refusing to create another: ${error.message}`)
    }

    // Do not edit the caller's tree until the linked worktree has been proven.
    // A failed `git worktree add` must not leave an unrelated .gitignore diff.
    const ignored = await ignoreWorktrees(root)
    return { path, branch, root, baseHead, ignored }
  }
  throw new Error(`could not create a verified isolated worktree after ${attempts} attempts: ${lastError?.message || 'all candidate paths already exist'}`)
}
