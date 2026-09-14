# Provider catalogs

How to point a provider at a shipped model catalog instead of writing model
prices by hand, and when writing them by hand is still the right answer.

## Why

Model economics are facts about a provider, not decisions you make. A price
list written into a config file is correct only until the provider changes it,
and a stale price is worse than a missing one: ad-coder computes routing and
budget decisions from it, so wrong numbers do not fail — they quietly produce
wrong answers.

pi-ai ships a generated catalog of 31 usable providers, from 2 models
(`cerebras`) to 366 (`openrouter`). It moves with the pinned dependency, so a
`bun update` refreshes prices instead of your editor. Each entry carries the
model id, request API, base URL, per-token costs, context window, token ceiling,
accepted input modalities, and — where the provider publishes one — the mapping
of thinking levels the model actually supports.

## Using a catalog

Name it on the provider. Every model then comes from it:

```json
{
  "id": "opencode-go",
  "api": "openai-completions",
  "catalog": "opencode-go",
  "credential": { "kind": "env-var", "envVar": "OPENCODE_API_KEY" },
  "models": [
    { "modelId": "glm-5.3-flash", "name": "flash" },
    { "modelId": "minimax-m3", "name": "m3" }
  ]
}
```

That is the whole declaration. No `cost`, no `maxTokens`, no per-model
`baseUrl`, no `api` override — and `name` is optional too, defaulting to the
model id.

Note what the catalog settled here that a hand-written list would have had to
get right: `minimax-m3` speaks `anthropic-messages` while `glm-5.3-flash`
speaks `openai-completions`, and they sit behind different path prefixes of the
same account. Both facts come from the catalog.

Omit `models` entirely to admit every model the catalog publishes, each under
its own id:

```json
{
  "id": "deepseek",
  "api": "openai-completions",
  "catalog": "deepseek",
  "credential": { "kind": "env-var", "envVar": "DEEPSEEK_API_KEY" }
}
```

A routing profile then addresses them by catalog id (`deepseek-chat`, …). This
is convenient for a small catalog and unwieldy for `openrouter`; listing the
handful you route to is usually clearer.

### Available catalogs

`ant-ling`, `anthropic`, `baseten`, `cerebras`, `cloudflare-ai-gateway`,
`cloudflare-workers-ai`, `deepseek`, `fireworks`, `github-copilot`, `groq`,
`huggingface`, `kimi-coding`, `minimax`, `minimax-cn`, `moonshotai`,
`moonshotai-cn`, `nvidia`, `opencode`, `opencode-go`, `openrouter`,
`qwen-token-plan`, `qwen-token-plan-cn`, `qwen-token-plan-individual`,
`together`, `vercel-ai-gateway`, `xiaomi`, `xiaomi-token-plan-ams`,
`xiaomi-token-plan-cn`, `xiaomi-token-plan-sgp`, `zai`, `zai-coding-cn`.

A misspelled name is rejected with the full list, so you never have to guess
the spelling from a config file.

The catalog name is independent of the provider `id`: point a provider called
`work-openrouter` at `"catalog": "openrouter"` if you keep two accounts apart.

## Overriding a catalog value

Anything you declare wins. The catalog is the best available default, not an
authority over you:

```json
{ "modelId": "glm-5.3-flash", "name": "flash", "maxTokens": 4096 }
```

Useful for a negotiated price, an account-specific ceiling, or a deliberately
smaller `contextWindow` to cap context spend. Declared `headers` apply to
catalog-backed models exactly as they do to hand-declared ones, provider-level
and per-model both.

One override is refused: an `api` that contradicts the catalog. The catalog
knows which request API the model speaks, and a mismatch is silently
unroutable, so it is reported as a config error instead.

## When the catalog cannot know

Some ids exist only inside your account. An OpenRouter `@preset/...` routes
through provider preferences you saved on their site, so no static catalog can
publish it or its price. Mark those models `"catalog": false` and supply
`cost` and `maxTokens` yourself — they live beside catalog-backed siblings:

```json
{
  "id": "openrouter",
  "api": "openai-completions",
  "baseUrl": "https://openrouter.ai/api/v1",
  "catalog": "openrouter",
  "credential": { "kind": "env-var", "envVar": "OPENROUTER_API_KEY" },
  "models": [
    { "modelId": "minimax/minimax-m3", "name": "m3" },
    {
      "modelId": "@preset/minimaxm2-5",
      "name": "preset-m25",
      "catalog": false,
      "maxTokens": 8192,
      "cost": { "input": 0.27, "output": 1.08, "cacheRead": 0.054, "cacheWrite": 0 }
    }
  ]
}
```

The marker is required rather than inferred. Without it, a typo in a model id
would be indistinguishable from a deliberate account-scoped id, and ad-coder
would resolve the typo with whatever numbers happened to sit next to it. With
it, the hand-written exception stays deliberate and the typo stays an error.

A provider with a catalog needs `baseUrl` only when it admits such a model:
catalog entries carry their own.

## Thinking levels

Where a provider publishes it, a catalog entry carries the set of thinking
levels the model supports, with unsupported levels marked explicitly. ad-coder
forwards it, so a routing profile asking for a level the model rejects gets the
model's documented fallback instead of an opaque provider error.

This is worth checking when you calibrate a profile. For example, on
`opencode-go` both `glm-5.3-flash` and `deepseek-v4-flash` support `low`,
`high` and `max` but **not** `medium` — a profile routing them at `medium` is
misconfigured in a way a hand-written model list cannot show you.

## What a catalog does not do

- **It does not replace calibration.** Prices and ceilings are facts; which
  model suits which role is measurement. See
  [model calibration](model-calibration.md).
- **It does not admit every model it publishes.** Entries on request APIs
  ad-coder cannot construct (`bedrock-converse-stream`, `google-vertex`, the
  responses family, …) are omitted rather than registered and left to fail at
  dispatch.
- **It is not live.** The catalog is generated data pinned with pi-ai. A price
  changed upstream today arrives with the next dependency update, so confirmed
  observations still belong in your calibration evidence.

## Related

- [Configuration](../README.md#configuration) — declaring registries, headers,
  and inventories
- [Model calibration](model-calibration.md) — measuring role fit
- [Cost economics](cost-economics.md) — how prices become budget decisions
