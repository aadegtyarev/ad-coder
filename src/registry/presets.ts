import type { ModelConfig, ProviderConfig } from "./types";

/**
 * The FIVE shipped provider presets (this is the whole set -- there is
 * deliberately NO separate native-openai or native-anthropic preset). Native
 * OpenAI and native Anthropic are reached through the two CUSTOM presets by
 * pointing `baseUrl` at `api.openai.com` / `api.anthropic.com`; native Anthropic
 * this way gives full cacheRetention control (the project's cache-control
 * thesis). Each builder merges a caller-supplied model list with a small
 * built-in default so a preset is usable with zero model config while remaining
 * fully overridable. Every returned `ProviderConfig` is accepted by
 * `parseRegistryConfig`.
 */

function mergeModels(defaults: ModelConfig[], override?: ModelConfig[]): ModelConfig[] {
  return override && override.length > 0 ? override : defaults;
}

/** DeepSeek: OpenAI-completions API, key from `DEEPSEEK_API_KEY`. */
export function deepseekPreset(models?: ModelConfig[]): ProviderConfig {
  return {
    id: "deepseek",
    displayName: "DeepSeek",
    api: "openai-completions",
    baseUrl: "https://api.deepseek.com",
    credential: { kind: "env-var", envVar: "DEEPSEEK_API_KEY" },
    models: mergeModels(
      [
        {
          name: "deepseek-chat",
          modelId: "deepseek-chat",
          contextWindow: 64000,
          maxTokens: 8192,
          cost: { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0.27 },
        },
      ],
      models,
    ),
  };
}

/**
 * OpenRouter: dual-api aggregator. The provider api defaults to
 * `openai-completions`; a model that fronts an Anthropic endpoint carries its
 * own `api: 'anthropic-messages'` override, and the resolver builds the mixed-API
 * provider form. Key from `OPENROUTER_API_KEY`.
 */
export function openrouterPreset(models?: ModelConfig[]): ProviderConfig {
  return {
    id: "openrouter",
    displayName: "OpenRouter",
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    credential: { kind: "env-var", envVar: "OPENROUTER_API_KEY" },
    models: mergeModels(
      [
        {
          name: "openrouter-auto",
          modelId: "openrouter/auto",
          contextWindow: 128000,
          maxTokens: 8192,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
      models,
    ),
  };
}

/**
 * A custom OpenAI-compatible endpoint (LM Studio, vLLM, self-hosted, OR native
 * OpenAI via `https://api.openai.com/v1`). The caller supplies `id`, `baseUrl`,
 * the credential env-var name, and the models -- there is no default endpoint.
 */
export function openaiCompatiblePreset(input: {
  id: string;
  displayName?: string;
  baseUrl: string;
  envVar: string;
  models: ModelConfig[];
}): ProviderConfig {
  return {
    id: input.id,
    ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
    api: "openai-completions",
    baseUrl: input.baseUrl,
    credential: { kind: "env-var", envVar: input.envVar },
    models: input.models,
  };
}

/**
 * A custom Anthropic-compatible endpoint (incl. native Anthropic via
 * `https://api.anthropic.com`, which yields full cacheRetention control). The
 * caller supplies `id`, `baseUrl`, the credential env-var name, and the models.
 */
export function anthropicCompatiblePreset(input: {
  id: string;
  displayName?: string;
  baseUrl: string;
  envVar: string;
  models: ModelConfig[];
}): ProviderConfig {
  return {
    id: input.id,
    ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
    api: "anthropic-messages",
    baseUrl: input.baseUrl,
    credential: { kind: "env-var", envVar: input.envVar },
    models: input.models,
  };
}

/**
 * OpenAI Codex: OAuth-ONLY (no env-var key). The credential is `{ kind: 'oauth' }`
 * and the resolver DELEGATES to the shipped `openaiCodexProvider()` factory --
 * no token handling here. The `baseUrl` is carried only so the config validates
 * uniformly; the resolver IGNORES it and uses the factory's fixed endpoint.
 * `modelId`s must exist in the codex factory's own catalog for lookup to resolve.
 */
export function openaiCodexPreset(models?: ModelConfig[]): ProviderConfig {
  return {
    id: "openai-codex",
    displayName: "OpenAI Codex",
    api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api",
    credential: { kind: "oauth" },
    models: mergeModels(
      [
        {
          name: "codex-gpt-5.5",
          modelId: "gpt-5.5",
          contextWindow: 272000,
          maxTokens: 128000,
          reasoning: true,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
      models,
    ),
  };
}
