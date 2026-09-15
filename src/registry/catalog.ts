import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ApiKind } from "./types";

/**
 * The pi-ai built-in model catalog, read as plain data.
 *
 * WHY THIS EXISTS. Model economics are facts about a provider, not decisions an
 * operator makes: a hand-written price list in a config file is correct only
 * until the provider changes it, and a stale price silently corrupts every
 * routing and budget decision computed from it. pi-ai ships a generated catalog
 * that moves with the pinned dependency, so reading it is strictly more
 * truthful than restating it. This module is the ONLY place that catalog is
 * read, so the blast radius of the dependency's shape is one file.
 *
 * COST. The whole import is paid once at module load: measured at 19ms marginal
 * over the pi-ai import the registry already performs, and a lookup is a map
 * read. That is why the catalog is a static import rather than a lazy one --
 * being synchronously available is what lets `parseRegistryConfig` stay a pure
 * synchronous validator that fails loud on an unknown catalog name.
 */

/**
 * Catalog apis this registry can actually construct a provider for.
 *
 * A deliberate subset of the catalog's nine api kinds: the resolver builds only
 * `openai-completions` and `anthropic-messages` through `createProvider`, and
 * `openai-codex-responses` is reachable only through the delegated OAuth
 * factory. A catalog model on any other api (bedrock, vertex, mistral, the
 * responses family) is admitted by NOTHING here rather than being registered
 * and failing later at dispatch -- an unroutable model in the registry is a
 * name the routing profile can select and then die on.
 */
const RESOLVABLE_APIS: ReadonlySet<string> = new Set<ApiKind>([
  "openai-completions",
  "anthropic-messages",
]);

/** One catalog entry, narrowed to the fields the registry consumes. */
export interface CatalogModel {
  readonly modelId: string;
  readonly api: ApiKind;
  readonly baseUrl: string;
  readonly reasoning: boolean;
  readonly input: ("text" | "image")[];
  readonly cost: Model<Api>["cost"];
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
  /**
   * Request-shaping overrides pi-ai generated for this model.
   *
   * Forwarded, unlike an operator-declared `compat`. The two are NOT the same
   * trust level: a declared `compat` is unvalidated config text and stays inert
   * data (see `parseRegistryConfig`), while this value comes from the pinned
   * dependency itself -- the same bytes pi-ai's own provider factories use. It
   * is also load-bearing: `thinkingLevelMap` is consulted only inside a
   * `compat.thinkingFormat` branch, so dropping compat would silently turn the
   * thinking-level mapping into a no-op.
   */
  readonly compat?: unknown;
}

/** provider name -> modelId -> entry. Built once, on first read. */
let index: Map<string, Map<string, CatalogModel>> | undefined;

function build(): Map<string, Map<string, CatalogModel>> {
  if (index !== undefined) return index;
  const built = new Map<string, Map<string, CatalogModel>>();
  for (const provider of getBuiltinProviders()) {
    const models = new Map<string, CatalogModel>();
    for (const model of getBuiltinModels(provider)) {
      if (!RESOLVABLE_APIS.has(model.api)) continue;
      models.set(model.id, {
        modelId: model.id,
        api: model.api as ApiKind,
        baseUrl: model.baseUrl,
        reasoning: model.reasoning,
        input: [...model.input],
        cost: model.cost,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        ...(model.thinkingLevelMap !== undefined && { thinkingLevelMap: model.thinkingLevelMap }),
        ...(model.compat !== undefined && { compat: model.compat }),
      });
    }
    built.set(provider, models);
  }
  index = built;
  return built;
}

/**
 * Every catalog name that admits at least one resolvable model, sorted.
 *
 * Reported verbatim in the error raised for an unknown catalog: a typo in a
 * provider name is otherwise indistinguishable from "that provider is not
 * shipped", and the operator cannot discover the correct spelling from a config
 * file.
 */
export function catalogNames(): string[] {
  return [...build()]
    .filter(([, models]) => models.size > 0)
    .map(([name]) => name)
    .sort();
}

/** The resolvable models of one catalog, or undefined when the name is unknown. */
export function catalogModels(name: string): ReadonlyMap<string, CatalogModel> | undefined {
  const models = build().get(name);
  return models === undefined || models.size === 0 ? undefined : models;
}
