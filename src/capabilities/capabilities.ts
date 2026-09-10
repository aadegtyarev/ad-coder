import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type { Role } from "../role";

/**
 * How a model bills, which decides what there is to optimize.
 *
 * `per-token` optimizes money; `prepaid` (a plan whose catalog cost is all
 * zero, so the ledger reads $0 against a real quota spend) optimizes quota and
 * latency; `local` (LM Studio, vLLM) optimizes the small context window and
 * latency. See docs/cost-economics.md:70-85.
 */
export type CostMode = "per-token" | "prepaid" | "local";

export interface ModelCapabilities {
  costMode: CostMode;
  cacheControllable: boolean;
  contextWindow: number;
  cacheReadUnitCost: number;
  cacheWriteUnitCost: number;
  outInRatio: number;
}

export type ReconcileCode = "inert-cache-retention";

export interface ReconcileWarning {
  code: ReconcileCode;
  role: string;
  modelId: string;
  message: string;
}

/**
 * The four private/loopback host forms `deriveCapabilities` recognizes without
 * a range test. Range-based forms (10.x, 192.168.x, 172.16-31.x, *.local) are
 * matched separately in `isLocalHost`.
 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

const LOCAL_PROVIDER = /lmstudio|vllm|local/i;

/**
 * Derive the capability descriptor from a pi-ai Model.
 *
 * `cacheControllable` is `api === "anthropic-messages" || compat.cacheControlFormat
 * === "anthropic"`, NOT the format alone. The format-only rule is a false
 * negative on native Anthropic: `claude-fable-5` is `api: "anthropic-messages"`
 * with NO `compat.cacheControlFormat`, yet honors `cacheRetention` through
 * `getCacheControl` (pi-ai anthropic-messages.js:29). The format path
 * (openai-completions.js:808) only covers openai-completions models emulating
 * Anthropic cache_control markers. The `"cacheControlFormat" in model.compat`
 * guard is type-necessary, not defensive: on `Model<Api>` `compat` is the union
 * of all four compat types and `cacheControlFormat` lives only on
 * `OpenAICompletionsCompat` (pi-ai types.d.ts:516) — a bare
 * `model.compat?.cacheControlFormat` does not type-check under strict.
 */
export function deriveCapabilities(model: Model<Api>): ModelCapabilities {
  const fmt =
    model.compat && "cacheControlFormat" in model.compat
      ? model.compat.cacheControlFormat
      : undefined;
  const cacheControllable = model.api === "anthropic-messages" || fmt === "anthropic";

  const cost = model.cost;
  const anyCost =
    cost.input !== 0 || cost.output !== 0 || cost.cacheRead !== 0 || cost.cacheWrite !== 0;

  // Only the local-vs-prepaid split is a best-effort baseUrl/provider heuristic
  // and is meant to be overridable; per-token is reliable because it reads price,
  // not host (docs/pi-capabilities.md:343-356).
  const costMode: CostMode = anyCost
    ? "per-token"
    : isLocalHost(model.baseUrl) || LOCAL_PROVIDER.test(model.provider)
      ? "local"
      : "prepaid";

  return {
    costMode,
    cacheControllable,
    contextWindow: model.contextWindow,
    cacheReadUnitCost: cost.cacheRead,
    cacheWriteUnitCost: cost.cacheWrite,
    outInRatio: cost.input === 0 ? 0 : cost.output / cost.input,
  };
}

/**
 * `cacheRead / (cacheRead + input)` for one role and turn: what fraction of read
 * tokens came from cache. A drop from 0.9 to 0.2 means something broke the
 * prefix. Both-zero (no reads at all) yields 0 rather than dividing by zero
 * (docs/cost-economics.md:97-106).
 */
export function cacheEfficiency(usage: Usage): number {
  if (usage.cacheRead === 0 && usage.input === 0) return 0;
  return usage.cacheRead / (usage.cacheRead + usage.input);
}

/**
 * How many times a cached prefix must be re-read before the cache write pays for
 * itself, computed from unit prices rather than guessed. fable-5:
 * `12.5 / (10 - 1) = 1.4`, so a prefix must be reused at least twice.
 *
 * Sentinels are ordered and must stay so: `"always"` (not numeric 0) when
 * `cacheWrite === 0`, because a free write always pays and no positive threshold
 * exists; then `"degenerate"` when `input <= cacheRead`, because the denominator
 * is non-positive and the ratio is meaningless. Only past both is the numeric
 * threshold returned. Collapsing either sentinel to a bare number would report
 * a false break-even.
 */
export function breakEvenReads(model: Model<Api>): number | "always" | "degenerate" {
  const cw = model.cost.cacheWrite;
  const inp = model.cost.input;
  const cr = model.cost.cacheRead;
  if (cw === 0) return "always";
  if (inp <= cr) return "degenerate";
  return cw / (inp - cr);
}

/**
 * Warn when a role asks for a `cacheRetention` its model cannot honor, so the
 * setting fails loud instead of being silently ignored. The message is phrased
 * about the model's inability in general, NOT tied to the `cacheControlFormat`
 * field: native Anthropic honors `cacheRetention` without that field, so a
 * field-specific message would be wrong there. Never throws — a reconciliation
 * check must not itself break a run.
 */
export function reconcileRoleWithModel(role: Role, model: Model<Api>): ReconcileWarning[] {
  const { cacheControllable } = deriveCapabilities(model);
  if (role.cacheRetention !== "none" && !cacheControllable) {
    return [
      {
        code: "inert-cache-retention",
        role: role.name,
        modelId: model.id,
        message: `model cannot honor cacheRetention "${role.cacheRetention}"; the setting is inert on this model`,
      },
    ];
  }
  return [];
}

/**
 * Best-effort loopback/private-range detection over a baseUrl. A URL that will
 * not parse is treated as non-local (falls through to prepaid) rather than
 * throwing, because baseUrl on a hand-built or custom model may be malformed.
 */
function isLocalHost(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return false;
  }
  // `URL.hostname` returns IPv6 hosts in bracketed form (`[::1]`), the only
  // syntactically valid way to express one in a URL, so strip the brackets
  // before the loopback lookup — otherwise a local IPv6 endpoint like
  // `http://[::1]:11434/v1` (Ollama/LM Studio bind here) misclassifies as prepaid.
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (LOOPBACK_HOSTS.has(host)) return true;
  if (host.endsWith(".local")) return true;
  if (host.startsWith("10.")) return true;
  if (host.startsWith("192.168.")) return true;

  const parts = host.split(".");
  if (parts.length === 4 && parts[0] === "172") {
    const second = parts[1];
    if (second !== undefined) {
      const n = Number(second);
      if (Number.isInteger(n) && n >= 16 && n <= 31) return true;
    }
  }
  return false;
}
