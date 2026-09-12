import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

/** Execution adapter for Claude Code's non-interactive CLI mode. */
export function createClaudeCliAdapter({ binary = 'claude', permissionMode = 'auto' } = {}) {
  return {
    async run({ prompt, cwd, model, schema }) {
      const jsonSchema = typeof schema === 'string' ? JSON.parse(readFileSync(schema, 'utf8')) : schema
      const args = [
        '--print', '--output-format', 'json',
        '--json-schema', JSON.stringify(jsonSchema),
        '--permission-mode', permissionMode,
      ]
      if (model) args.push('--model', model)
      args.push(prompt)

      return new Promise((resolve, reject) => {
        const child = spawn(binary, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', chunk => { stdout += chunk })
        child.stderr.on('data', chunk => { stderr += chunk })
        child.on('error', reject)
        child.on('close', code => {
          if (code !== 0) return reject(new Error(`claude exited ${code}: ${stderr.trim()}`))
          try {
            const response = JSON.parse(stdout)
            const raw = response.result
            if (typeof raw !== 'string') throw new Error('Claude returned no final result')
            resolve({ value: JSON.parse(raw), raw, usage: response.usage || null })
          } catch (error) {
            reject(error)
          }
        })
      })
    },
  }
}
