/**
 * Runtime-neutral agent invocation helpers.
 *
 * Adapters implement `run`. This module owns the policy that is useful for
 * both Claude Code and Codex: bounded retries, normalized failures, and a
 * stable result shape for the orchestrator.
 */

export function createAgentRunner(adapter, { retries = 1, onEvent = () => {} } = {}) {
  if (!adapter || typeof adapter.run !== 'function') {
    throw new TypeError('An execution adapter with run(options) is required')
  }

  return async function runAgent(options) {
    let lastError
    for (let attempt = 0; attempt <= retries; attempt++) {
      await onEvent({ type: 'agent_started', role: options.role, checkpoint: options.checkpoint, model: options.model, attempt: attempt + 1 })
      try {
        const result = await adapter.run(options)
        if (!result || typeof result !== 'object') throw new Error('Adapter returned no result')
        try {
          await onEvent({ type: 'agent_finished', role: options.role, checkpoint: options.checkpoint, model: options.model, attempt: attempt + 1, result })
        } catch (error) {
          throw new Error(`agent finished but its checkpoint could not be saved: ${error.message}`)
        }
        return { ...result, role: options.role, attempt: attempt + 1 }
      } catch (error) {
        lastError = error
        await onEvent({ type: 'agent_failed', role: options.role, checkpoint: options.checkpoint, model: options.model, attempt: attempt + 1, error })
        if (error.message.startsWith('agent finished but its checkpoint could not be saved:')) break
        if (attempt < retries) continue
      }
    }
    throw lastError
  }
}

export function normalizeAgentResult(value, { raw = '', usage = null } = {}) {
  return { value, raw, usage }
}
