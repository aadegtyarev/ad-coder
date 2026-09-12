/**
 * Claude Code adapter boundary.
 *
 * The Claude workflow runtime injects `agent()` and related functions into
 * workflow scripts, so this adapter is intentionally dependency-injected.
 * It prevents Claude globals from leaking into the platform-neutral core.
 */
export function createClaudeCodeAdapter(agent) {
  if (typeof agent !== 'function') throw new TypeError('Claude agent function is required')
  return {
    async run({ prompt, model, schema, writable: _writable, cwd: _cwd, role: _role, search: _search, ...metadata }) {
      const value = await agent(prompt, { model, schema, ...metadata })
      return { value, raw: JSON.stringify(value), usage: null }
    },
  }
}
