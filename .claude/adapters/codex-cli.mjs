import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

/** Execution adapter for the installed `codex exec` CLI. */
export function createCodexCliAdapter({ binary = 'codex', sandbox = 'read-only' } = {}) {
  return {
    async run({ prompt, cwd, model, schema, writable = false, search = false }) {
      const args = [
        '--ask-for-approval', 'never', '--sandbox', writable ? 'workspace-write' : sandbox,
        'exec', '--ephemeral', '--skip-git-repo-check',
        '--output-schema', schema, '--json', '-C', cwd, prompt,
      ]
      if (search) args.splice(0, 0, '--search')
      if (model) args.splice(0, 0, '--model', model)

      return new Promise((resolve, reject) => {
        const child = spawn(binary, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', chunk => { stdout += chunk })
        child.stderr.on('data', chunk => { stderr += chunk })
        child.on('error', reject)
        child.on('close', code => {
          if (code !== 0) {
            const diagnostic = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n').slice(-8000)
            return reject(new Error(`codex exec exited ${code}: ${diagnostic || 'no diagnostic output'}`))
          }
          const messages = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
          const final = [...messages].reverse().find(event => event.type === 'item.completed' && event.item?.type === 'agent_message')
          if (!final?.item?.text) return reject(new Error('Codex returned no final agent message'))
          resolve({ value: JSON.parse(final.item.text), raw: final.item.text, usage: messages.find(event => event.type === 'turn.completed')?.usage || null })
        })
      })
    },
  }
}

export function readSchema(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}
