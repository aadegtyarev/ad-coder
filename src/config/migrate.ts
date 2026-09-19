import type { CredentialStore } from "@earendil-works/pi-ai";
import { resolveModelInventory } from "../inventory/resolve";
import type {
  ModelInventoryConfig,
  ResolvedModelInventory,
  ResolvedModelInventoryConfig,
  ResolvedModelInventoryProfile,
  ResolveModelInventoryOptions,
} from "../inventory/types";
import { parseModelInventoryConfig } from "../inventory/validate";
import type { Complexity } from "../orchestration/types";
import { resolveProfile } from "../profiles/resolve";
import type { Profile, ProfileEntry } from "../profiles/types";
import { resolveRegistry } from "../registry/resolve";
import type {
  CredentialSource,
  ResolvedModelConfig,
  ResolvedProviderConfig,
  ResolvedRegistry,
} from "../registry/types";
import { toRegistryAndProfile } from "./to-registry";
import type {
  ModelConfig as ConfigModelConfig,
  ModelLadder,
  ModelsConfig,
  ProviderConfig,
} from "./types";

/**
 * The pure `inventories.json` -> `models.yaml` transform behind `config migrate`.
 *
 * Everything here is DATA IN, DATA OUT: no filesystem, no CLI, no real
 * environment, no credential store. Both sides of the parity check resolve
 * through the same resolver the seam uses, with an injected env accessor that
 * returns a fixed placeholder for exactly the env-var NAMES the inventory
 * itself declares (never `process.env`) and a no-op credential store, so
 * env-var providers resolve without any real credential existing in this
 * process. A credential VALUE therefore cannot leak: none is ever read.
 *
 * The transform never throws on data content. Every anomaly -- an unresolvable
 * profile, an oauth credential models.yaml cannot spell, a provider declared
 * two ways, a field with no YAML expression, a parity mismatch -- lands in the
 * report; the CALLER decides success (all-or-nothing belongs to the CLI).
 */

/** The effective routing identity of one resolved (profile, role, tier) cell. */
export interface CellFacts {
  providerId: string;
  modelId: string;
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/** One (profile, role, tier) parity comparison, both sides resolved. */
export interface ParityRow {
  profile: string;
  role: string;
  tier: Complexity;
  equal: boolean;
  /** Effective facts from the inventory side, when its cell resolved. */
  inventory?: CellFacts;
  /** Effective facts from the projected models.yaml side, when its cell resolved. */
  projected?: CellFacts;
  /** Set when a side failed to resolve; the cell could not be proven equal. */
  note?: string;
}

/** One provider id declared two ways across profiles. First declaration wins; caller decides. */
export interface ProviderConflict {
  providerId: string;
  field: string;
  profiles: [string, string];
  values: [unknown, unknown];
}

/** One field with no models.yaml expression. Values are names/numbers only. */
export interface DroppedItem {
  profile: string;
  provider?: string;
  model?: string;
  cell?: string;
  field: string;
  value?: unknown;
}

/** One thing the target format cannot express. Never dropped silently. */
export interface NotExpressibleItem {
  profile: string;
  provider?: string;
  reason: string;
}

/** Per-profile migration status. */
export interface MigrateProfileReport {
  name: string;
  status: "migrated" | "not-expressible";
  isDefault: boolean;
  roles?: string[];
  cellCount?: number;
  reasons?: string[];
}

/** The whole migration report: serializable, names only, no credential values. */
export interface MigrateReport {
  profiles: MigrateProfileReport[];
  /** Provider ids emitted after the cross-profile union. */
  providers: string[];
  providerConflicts: ProviderConflict[];
  dropped: DroppedItem[];
  notExpressible: NotExpressibleItem[];
  parity: ParityRow[];
  /** The `defaultProfile` written to models.yaml, when the inventory default migrated. */
  defaultProfile?: string;
  /** Whole-inventory failures that prevented per-profile work at all. */
  errors: string[];
}

export interface MigrateResult {
  models: ModelsConfig;
  report: MigrateReport;
}

/** Compare effective cell facts field by field; the parity check's only verdict. */
export function cellFactsEqual(a: CellFacts, b: CellFacts): boolean {
  return (
    a.providerId === b.providerId &&
    a.modelId === b.modelId &&
    a.contextWindow === b.contextWindow &&
    a.maxTokens === b.maxTokens &&
    a.cost.input === b.cost.input &&
    a.cost.output === b.cost.output &&
    a.cost.cacheRead === b.cost.cacheRead &&
    a.cost.cacheWrite === b.cost.cacheWrite
  );
}

/** Project a resolved pi model onto the compared facts. Names and numbers only. */
function factsOf(model: {
  provider: string;
  id: string;
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}): CellFacts {
  return {
    providerId: model.provider,
    modelId: model.id,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    cost: { ...model.cost },
  };
}

/** A fixed placeholder so declared env-var credentials resolve; never a real secret, never emitted. */
const STUB_CREDENTIAL = "stub-credential";

/** Satisfies CredentialStore without reading, listing, writing or deleting anything. */
const NOOP_CREDENTIAL_STORE: CredentialStore = {
  read: async () => undefined,
  list: async () => [],
  modify: async () => undefined,
  delete: async () => {},
};

/**
 * Resolution options for BOTH sides of the parity check.
 *
 * The env accessor returns the placeholder for exactly the env-var NAMES the
 * inventory declares and undefined for everything else: resolveRegistry's
 * credential preflight therefore passes for env-var providers without this
 * process ever touching the real environment or a real credential store. (A
 * literal `() => undefined` would fail every env-var profile at the preflight
 * and make parity unprovable, which is why the placeholder exists.)
 */
function stubResolveOptions(inventory: ModelInventoryConfig): ResolveModelInventoryOptions {
  const declared = new Set<string>();
  for (const profile of inventory.profiles) {
    for (const provider of profile.registry.providers) {
      if (provider.credential.kind === "env-var") declared.add(provider.credential.envVar);
    }
  }
  return {
    env: (name) => (declared.has(name) ? STUB_CREDENTIAL : undefined),
    credentials: NOOP_CREDENTIAL_STORE,
  };
}

function sameCredential(a: CredentialSource, b: CredentialSource): boolean {
  return (
    a.kind === b.kind && (a.kind !== "env-var" || b.kind !== "env-var" || a.envVar === b.envVar)
  );
}

/** Order-insensitive header-map equality; headers are validated non-auth config text. */
function sameHeaders(
  a: Record<string, string> | undefined,
  b: Record<string, string> | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface MigratedProfile {
  name: string;
  entries: ProfileEntry[];
  profile: Profile;
  oldResolved: ResolvedRegistry;
  routes: Record<string, ModelLadder>;
  roles: string[];
}

/**
 * Migrate every inventory profile into a `ModelsConfig`, verifying per-cell
 * parity by resolving BOTH sides through the production resolver with the stub
 * options. See the module comment for the no-throw, no-secret contract.
 */
export function migrateInventoriesToModels(inventory: ModelInventoryConfig): MigrateResult {
  const report: MigrateReport = {
    profiles: [],
    providers: [],
    providerConflicts: [],
    dropped: [],
    notExpressible: [],
    parity: [],
    errors: [],
  };
  const models: ModelsConfig = { providers: {}, profiles: {} };

  let validated: ResolvedModelInventoryConfig | undefined;
  try {
    validated = parseModelInventoryConfig(inventory);
  } catch (err) {
    // The inventory as a whole is unusable: no profile can be trusted, so the
    // report carries the reason and an empty projection. Data problem, not a crash.
    report.errors.push(errorText(err));
    return { models, report };
  }

  const stub = stubResolveOptions(inventory);
  const union = new Map<string, ResolvedProviderConfig>();
  const unionSource = new Map<string, string>();
  const migrated: MigratedProfile[] = [];

  for (const declared of validated.profiles) {
    const outcome = migrateProfile(declared, inventory, stub, union, unionSource, report);
    if (outcome !== undefined) migrated.push(outcome);
  }

  models.providers = Object.fromEntries(
    [...union.entries()].map(([id, provider]) => [id, toYamlProvider(provider)]),
  );
  report.providers = [...union.keys()];
  for (const profile of migrated) {
    models.profiles[profile.name] = { name: profile.name, routes: profile.routes };
  }
  const defaultName = validated.default;
  if (defaultName !== undefined && migrated.some((profile) => profile.name === defaultName)) {
    // An inventory default whose profile failed is NOT written: a defaultProfile
    // naming a missing profile would break projection downstream.
    models.defaultProfile = defaultName;
    report.defaultProfile = defaultName;
  }

  runParity(migrated, models, stub, report);
  return { models, report };
}

const TIERS = ["trivial", "medium", "complex"] as const;

/**
 * Migrate one profile: resolve it first (requirement 1), refuse oauth
 * providers, rebuild rows from effective values, report every field with no
 * YAML expression, then merge its providers into the cross-profile union.
 * Returns undefined when the profile is not expressible here.
 */
function migrateProfile(
  declared: ResolvedModelInventoryProfile,
  inventory: ModelInventoryConfig,
  stub: ResolveModelInventoryOptions,
  union: Map<string, ResolvedProviderConfig>,
  unionSource: Map<string, string>,
  report: MigrateReport,
): MigratedProfile | undefined {
  const name = declared.name;
  const isDefault = inventory.default === name;
  const reasons: string[] = [];

  for (const provider of declared.registry.providers) {
    if (provider.credential.kind !== "oauth") continue;
    const reason = `provider "${provider.id}" uses an oauth credential; models.yaml can only express an env-var credential NAME`;
    report.notExpressible.push({ profile: name, provider: provider.id, reason });
    reasons.push(reason);
  }
  if (reasons.length > 0) {
    report.profiles.push({ name, status: "not-expressible", isDefault, reasons });
    return undefined;
  }

  let oldResolved: ResolvedModelInventory;
  try {
    // Resolve exactly this profile so one broken profile cannot sink the rest.
    oldResolved = resolveModelInventory({ profiles: [declared], default: name }, name, stub);
  } catch (err) {
    const reason = `profile fails resolution under the migration stub environment: ${errorText(err)}`;
    report.notExpressible.push({ profile: name, reason });
    report.profiles.push({ name, status: "not-expressible", isDefault, reasons: [reason] });
    return undefined;
  }

  const nameIndex = new Map<string, { providerId: string; modelId: string }>();
  for (const provider of declared.registry.providers) {
    for (const model of provider.models) {
      nameIndex.set(model.name, { providerId: provider.id, modelId: model.modelId });
    }
  }

  const byRole = new Map<string, ProfileEntry[]>();
  for (const cell of declared.profile.entries) {
    const cells = byRole.get(cell.role);
    if (cells === undefined) byRole.set(cell.role, [cell]);
    else cells.push(cell);
  }

  const routes: Record<string, ModelLadder> = {};
  const roles: string[] = [];
  let unresolvedCell = false;
  for (const [role, cells] of byRole) {
    const tierRung = new Map<string, string>();
    for (const tier of TIERS) {
      const cell = cells.find((candidate) => candidate.complexity === tier);
      if (cell === undefined) continue;
      const hit = nameIndex.get(cell.model);
      if (hit === undefined) {
        const reason = `cell ${role}@${tier} routes to "${cell.model}", which this profile's registry does not declare`;
        report.notExpressible.push({ profile: name, reason });
        reasons.push(reason);
        unresolvedCell = true;
        continue;
      }
      tierRung.set(tier, `${hit.providerId}:${hit.modelId}`);
    }
    if (unresolvedCell) break;
    // Bare row = the trivial tier's rung (or, when trivial is undeclared, the
    // first declared tier's); every declared tier that differs gets an override.
    // An override WITHOUT a bare row is invisible to the projection, so the
    // bare row is always emitted.
    const bare = TIERS.map((tier) => tierRung.get(tier)).find((rung) => rung !== undefined);
    if (bare === undefined) continue;
    routes[role] = [bare];
    roles.push(role);
    for (const tier of ["medium", "complex"] as const) {
      const rung = tierRung.get(tier);
      if (rung !== undefined && rung !== bare) routes[`${role}@${tier}`] = [rung];
    }
    for (const cell of cells) {
      const at = `${cell.role}@${cell.complexity}`;
      if (cell.maxOutput !== undefined)
        report.dropped.push({ profile: name, cell: at, field: "maxOutput", value: cell.maxOutput });
      if (cell.cacheRetention !== undefined)
        report.dropped.push({
          profile: name,
          cell: at,
          field: "cacheRetention",
          value: cell.cacheRetention,
        });
      if (cell.thinkingLevel !== undefined)
        report.dropped.push({
          profile: name,
          cell: at,
          field: "thinkingLevel",
          value: cell.thinkingLevel,
        });
    }
  }
  if (unresolvedCell) {
    report.profiles.push({ name, status: "not-expressible", isDefault, reasons });
    return undefined;
  }

  reportDroppedFields(declared, name, report);
  mergeIntoUnion(declared.registry.providers, name, union, unionSource, report);
  report.profiles.push({
    name,
    status: "migrated",
    isDefault,
    roles,
    cellCount: declared.profile.entries.length,
  });
  return {
    name,
    entries: declared.profile.entries,
    profile: declared.profile,
    oldResolved: oldResolved.registry,
    routes,
    roles,
  };
}

/**
 * Report operator-authored fields with no models.yaml expression. The
 * validated declarations retain every authored field, so this reads the same
 * effective data the emission does. Values are routing-hint names/numbers;
 * `compat` and per-model `headers` carry unrestricted content and are named
 * without their values.
 */
function reportDroppedFields(
  declared: ResolvedModelInventoryProfile,
  name: string,
  report: MigrateReport,
): void {
  const push = (item: Omit<DroppedItem, "profile">): void => {
    report.dropped.push({ profile: name, ...item });
  };
  for (const provider of declared.registry.providers) {
    if (provider.displayName !== undefined)
      push({ provider: provider.id, field: "displayName", value: provider.displayName });
    if (provider.catalog !== undefined)
      push({ provider: provider.id, field: "catalog", value: provider.catalog });
    for (const model of provider.models) {
      const at = { provider: provider.id, model: model.name };
      if (model.reasoning) push({ ...at, field: "reasoning", value: true });
      if (model.api !== undefined) push({ ...at, field: "api", value: model.api });
      if (model.input !== undefined) push({ ...at, field: "input", value: model.input });
      if (model.catalog === false) push({ ...at, field: "catalog", value: false });
      if (model.compat !== undefined) push({ ...at, field: "compat" });
      if (model.headers !== undefined) push({ ...at, field: "headers" });
    }
  }
}

/**
 * Union providers by id across all profiles. Identical effective declarations
 * merge (models append); any differing effective api/baseUrl/credential/
 * headers, or the same model name with differing effective modelId/window/
 * maxTokens/cost, is a reported conflict and the FIRST declaration stands.
 */
function mergeIntoUnion(
  providers: ResolvedProviderConfig[],
  source: string,
  union: Map<string, ResolvedProviderConfig>,
  unionSource: Map<string, string>,
  report: MigrateReport,
): void {
  for (const next of providers) {
    const prev = union.get(next.id);
    if (prev === undefined) {
      // Copy: later profiles append merged models to the union's own list.
      union.set(next.id, { ...next, models: [...next.models] });
      unionSource.set(next.id, source);
      continue;
    }
    const first = unionSource.get(next.id) ?? source;
    const clash = (field: string, a: unknown, b: unknown): void => {
      report.providerConflicts.push({
        providerId: next.id,
        field,
        profiles: [first, source],
        values: [a, b],
      });
    };
    if (prev.api !== next.api) clash("api", prev.api, next.api);
    if (prev.baseUrl !== next.baseUrl) clash("baseUrl", prev.baseUrl, next.baseUrl);
    if (!sameCredential(prev.credential, next.credential))
      clash("credential", prev.credential, next.credential);
    if (!sameHeaders(prev.headers, next.headers)) clash("headers", prev.headers, next.headers);
    mergeModels(prev, next, first, source, report);
  }
}

function mergeModels(
  prev: ResolvedProviderConfig,
  next: ResolvedProviderConfig,
  first: string,
  source: string,
  report: MigrateReport,
): void {
  const byName = new Map(prev.models.map((model) => [model.name, model]));
  for (const model of next.models) {
    const existing = byName.get(model.name);
    if (existing === undefined) {
      // A NEW name can still collide on the emitted row key (the modelId):
      // rows are keyed by modelId, so two names sharing one key cannot both exist.
      const owner = prev.models.find((candidate) => candidate.modelId === model.modelId);
      if (owner !== undefined) {
        report.providerConflicts.push({
          providerId: prev.id,
          field: `modelId:${model.modelId}`,
          profiles: [first, source],
          values: [owner.name, model.name],
        });
        continue;
      }
      prev.models.push(model);
      byName.set(model.name, model);
      continue;
    }
    if (!sameModelFacts(existing, model)) {
      report.providerConflicts.push({
        providerId: prev.id,
        field: `model:${model.name}`,
        profiles: [first, source],
        values: [modelFacts(existing), modelFacts(model)],
      });
    }
  }
}

function modelFacts(model: ResolvedModelConfig): Record<string, unknown> {
  return {
    modelId: model.modelId,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    cost: { ...model.cost },
  };
}

function sameModelFacts(a: ResolvedModelConfig, b: ResolvedModelConfig): boolean {
  return (
    a.modelId === b.modelId &&
    a.contextWindow === b.contextWindow &&
    a.maxTokens === b.maxTokens &&
    a.cost.input === b.cost.input &&
    a.cost.output === b.cost.output &&
    a.cost.cacheRead === b.cost.cacheRead &&
    a.cost.cacheWrite === b.cost.cacheWrite
  );
}

/** One effective provider as a models.yaml provider row. OAuth never reaches here. */
function toYamlProvider(provider: ResolvedProviderConfig): ProviderConfig {
  const credential =
    provider.credential.kind === "env-var" ? provider.credential.envVar : undefined;
  if (credential === undefined) {
    // Unreachable through migrateProfile (oauth profiles are excluded first);
    // a disabled row keeps the projection safe if that invariant ever changes.
    return { enabled: false, api: provider.api, models: {} };
  }
  return {
    enabled: true,
    api: provider.api,
    baseUrl: provider.baseUrl,
    credential,
    ...(provider.headers !== undefined && { headers: provider.headers }),
    models: Object.fromEntries(provider.models.map((model) => [model.modelId, toYamlModel(model)])),
  };
}

/**
 * One effective model as a models.yaml row, keyed by the provider-native
 * modelId. input/output always; cacheRead/cacheWrite only when nonzero
 * (absent settles at zero in the projection); window and maxTokens always.
 */
function toYamlModel(model: ResolvedModelConfig): ConfigModelConfig {
  return {
    input: model.cost.input,
    output: model.cost.output,
    ...(model.cost.cacheRead > 0 && { cacheRead: model.cost.cacheRead }),
    ...(model.cost.cacheWrite > 0 && { cacheWrite: model.cost.cacheWrite }),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(model.baseUrl !== undefined && { baseUrl: model.baseUrl }),
  };
}

/**
 * Requirement 7: project the built ModelsConfig back through the seam's
 * projection (toRegistryAndProfile), resolve both sides through the SAME
 * resolver and stub options, and compare per declared (profile, role, tier)
 * cell: effective (providerId, modelId, contextWindow, maxTokens, cost).
 * A cell that cannot be resolved is reported unequal with a note, never thrown.
 */
function runParity(
  migrated: MigratedProfile[],
  models: ModelsConfig,
  stub: ResolveModelInventoryOptions,
  report: MigrateReport,
): void {
  for (const profile of migrated) {
    let projected: ReturnType<typeof toRegistryAndProfile> | undefined;
    let newResolved: ResolvedRegistry | undefined;
    try {
      projected = toRegistryAndProfile(models, profile.name);
      newResolved = resolveRegistry(projected.registry, stub);
    } catch (err) {
      for (const cell of profile.entries) {
        report.parity.push({
          profile: profile.name,
          role: cell.role,
          tier: cell.complexity,
          equal: false,
          note: `projected side failed to resolve: ${errorText(err)}`,
        });
      }
      continue;
    }
    for (const cell of profile.entries) {
      const row: ParityRow = {
        profile: profile.name,
        role: cell.role,
        tier: cell.complexity,
        equal: false,
      };
      try {
        row.inventory = factsOf(
          resolveProfile(profile.profile, profile.oldResolved, cell.role, cell.complexity).model,
        );
      } catch (err) {
        row.note = `inventory side failed to resolve: ${errorText(err)}`;
        report.parity.push(row);
        continue;
      }
      try {
        row.projected = factsOf(
          resolveProfile(projected.profile, newResolved, cell.role, cell.complexity).model,
        );
      } catch (err) {
        row.note = `projected cell failed to resolve: ${errorText(err)}`;
        report.parity.push(row);
        continue;
      }
      row.equal = cellFactsEqual(row.inventory, row.projected);
      report.parity.push(row);
    }
  }
}
