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

One exception, for this provider specifically: opencode-go rejects every request
that arrives without an `x-opencode-session` header, and neither the catalog nor
pi-ai's own opencode provider supplies one. Add
`"headers": {"x-opencode-session": "{{session}}"}` to the provider until
[#120](https://github.com/aadegtyarev/ad-coder/issues/120) makes it carry its own
required header; without it the account answers HTTP 400 `MissingSessionID`.

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
levels the model supports, each mapped to the spelling that model expects, with
unsupported levels marked explicitly. ad-coder forwards that map, so a level the
model *does* support is sent under the model's own name rather than pi's.

**An unsupported level is not repaired for you.** The map tells you a level is
unsupported; it does not make asking for it safe. What actually happens depends
on the request format the model speaks, and all three outcomes are bad in
different ways:

- `deepseek` and `openrouter` formats forward the unsupported level *verbatim*
  (the adapter's `?? requested` fallback treats the explicit "unsupported" mark
  the same as "not listed"), so the provider sees a value it never published.
- `zai` and `ant-ling` formats drop the effort field entirely while still
  enabling thinking, so the request silently runs at the model's default.
- `anthropic-messages` falls back to its own fixed level table, ignoring the
  model's map.

So the map is a **calibration input**, not a safety net: pick levels from it
rather than around it.

A level is in one of **three** states, and the difference matters when you read
a map: *mapped* (the catalog publishes the spelling to send), *marked
unsupported* (present with a `null`), or simply *absent* (the catalog says
nothing). Only the first is a level the provider has published support for.
Absent and `null` behave identically at dispatch — both are forwarded verbatim
on the `deepseek` and `openrouter` formats — so neither is a level to route at.

This is worth checking whenever you calibrate a profile. The mapped set is
narrower than it looks, and it differs between the same model on two providers:

| model | provider | mapped | marked unsupported |
| --- | --- | --- | --- |
| `glm-5.3-flash` | `opencode-go` | `low`, `high`, `max` | `off`, `minimal`, `medium`, `xhigh` |
| `glm-5.3` | `opencode-go` | `low`, `high`, `max` | `off`, `minimal`, `medium`, `xhigh` |
| `deepseek-v4-flash` | `opencode-go` | `low`, `high`, `max` | `minimal`, `medium` |
| `deepseek-v4-pro` | `opencode-go` | `high`, `max` | `minimal`, `low`, `medium` |
| `z-ai/glm-5.3-flash` | `openrouter` | `low`, `high`, `max` | `off`, `minimal`, `medium`, `xhigh` |
| `z-ai/glm-5.2` | `openrouter` | `off`, `high`, `xhigh` | `minimal`, `low`, `medium`, `max` |
| `deepseek/deepseek-v4-flash` | `openrouter` | `off`, `high`, `xhigh` | `minimal`, `low`, `medium`, `max` |
| `deepseek/deepseek-v4-pro` | `openrouter` | `off`, `high`, `xhigh` | `minimal`, `low`, `medium`, `max` |

Read the DeepSeek rows against each other: `low` is mapped on `opencode-go` and
explicitly marked unsupported on OpenRouter, and `max` flips the same way. The
same model name, the same vendor, two different answers — a hand-written model
list cannot show you that, and a profile that routes both cells at `low` is
misconfigured on exactly one of them.

Two models carry no map at all (`minimax-m3` on either provider,
`kimi-k2.7-code`); every level reaches them verbatim. `minimax/minimax-m2.5`
carries a map with a single entry — `off`, marked unsupported — and is silent on
everything else.

## What a catalog does not do

- **It does not replace calibration.** Prices and ceilings are facts; which
  model suits which role is measurement. See
  published benchmark evidence (see AGENTS.md, "Model routing").
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
- [Cost economics](cost-economics.md) — how prices become budget decisions
