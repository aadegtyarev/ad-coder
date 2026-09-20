/**
 * `bun run scripts/check-prices.ts` — the command half of the price audit.
 *
 * The command only MAKES A WRONG ROW VISIBLE; fixing it is the operator's act.
 *
 * THE ANCHOR HIERARCHY (see src/registry/price-audit.ts):
 * - PRIMARY: the provider's own charge answer, read from the project's
 *   cost-anomaly state (`.ad-coder/cost-anomaly.json`) via the module that owns
 *   it (`src/economics/cost-anomaly.ts`). Billing ABOVE the declared row is
 *   UNDER-DECLARED: a FINDING. Billing BELOW it is OVER-DECLARED: a NOTE, never
 *   a block.
 * - HINT: the public OpenRouter list (`--offline` skips it). A disagreement is
 *   printed as `hint` -- a reason to measure -- because the list can name the
 *   CHEAPEST backend's price while this account is billed for a dearer one. It
 *   is never a verdict and never grounds to edit, so it never sets exit 1.
 * - The offline self-consistency judgement still runs and still sets exit 1.
 *
 * EXITS: 0 clean (notes and hints included), 1 a finding (under-declared,
 * self-inconsistency, or a hostile row), 2 an explicitly requested charge
 * record (`--charges`) could not be read. An absent or unreadable DEFAULT
 * charge record is stated as "no charge observations available", never a
 * silent pass, and does not by itself change the exit.
 *
 * SOURCES:
 * - declared rows: `--inventory <path>`, DEFAULT defaultModelsPath() -- the
 *   operator's models.yaml layer (per-1M, `input`/`output` required,
 *   `cacheRead`/`cacheWrite` optional). NEVER read or written implicitly
 *   beyond the flag's own target.
 * - charge record: `--charges <path>`, DEFAULT `.ad-coder/cost-anomaly.json`
 *   resolved against the target directory (cwd unless overridden for tests).
 * - public list: GET https://openrouter.ai/api/v1/models (no key), a HINT.
 *
 * Both the charge record and the fetch are INJECTED (see `run`), so tests
 * exercise every judgement with no network and no user file at all.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { defaultModelsPath, loadModelsConfig } from "../src/config/store";
import {
  COST_ANOMALY_STATE_PATH,
  type CostAnomalyStateSnapshot,
  FileCostAnomalyStore,
} from "../src/economics/cost-anomaly";
import {
  auditDeclaredPrices,
  type ChargeObservation,
  type ChargeRecord,
  DEFAULT_TOLERANCE,
  type DeclaredRoute,
  type LiveCatalogue,
  type LivePrice,
  normalizeScopeKey,
} from "../src/registry/price-audit";

/** The live endpoint. Exported so tests can pin it without network. */
export const LIVE_MODELS_URL = "https://openrouter.ai/api/v1/models";

/** Bounded live fetch: the source answering "not today" is an explicit outcome. */
export const LIVE_TIMEOUT_MS = 10_000;

export interface CommandDeps {
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: (input: string, init?: { signal?: AbortSignal }) => Promise<Response>;
  write?: (text: string) => void;
  /** The directory a default `--charges` path resolves against; cwd in real use. */
  targetDir?: string;
}

/** Normalize a live `/models` payload into the auditor's catalogue. */
export function normalizeLiveCatalogue(payload: unknown): LiveCatalogue {
  const data =
    typeof payload === "object" &&
    payload !== null &&
    "data" in (payload as Record<string, unknown>)
      ? (payload as Record<string, unknown>).data
      : undefined;
  const catalogue: Record<string, LivePrice> = {};
  if (!Array.isArray(data)) return catalogue;
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const model = entry as Record<string, unknown>;
    if (typeof model.id !== "string" || model.id.length === 0) continue;
    const pricing = model.pricing;
    if (typeof pricing !== "object" || pricing === null) continue;
    const prices = pricing as Record<string, unknown>;
    catalogue[model.id] = {
      ...(typeof prices.prompt === "string" ? { prompt: prices.prompt } : {}),
      ...(typeof prices.completion === "string" ? { completion: prices.completion } : {}),
      ...(typeof prices.input_cache_read === "string"
        ? { input_cache_read: prices.input_cache_read }
        : {}),
    };
  }
  return catalogue;
}

type LiveOutcome =
  | { kind: "ok"; catalogue: LiveCatalogue }
  | { kind: "unavailable"; reason: string };

/** Fetch the live half with a bounded timeout; failures are reported, never thrown. */
export async function fetchLiveCatalogue(deps: CommandDeps = {}): Promise<LiveOutcome> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(LIVE_MODELS_URL, {
      signal: AbortSignal.timeout(LIVE_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      kind: "unavailable",
      reason: `the source did not answer (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  if (!response.ok) {
    return { kind: "unavailable", reason: `the source did not answer (HTTP ${response.status})` };
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    return {
      kind: "unavailable",
      reason: `the source answered, but not with parsable JSON (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  return { kind: "ok", catalogue: normalizeLiveCatalogue(payload) };
}

/** Declared routes from a (validated) models.yaml layer, per 1M, enabled providers only. */
export function declaredRoutes(config: ReturnType<typeof loadModelsConfig>): DeclaredRoute[] {
  const routes: DeclaredRoute[] = [];
  for (const [providerId, provider] of Object.entries(config.providers)) {
    if (!provider.enabled) continue;
    for (const [modelId, model] of Object.entries(provider.models)) {
      routes.push({
        route: `${providerId}:${modelId}`,
        provider: providerId,
        modelId,
        prices: {
          input: model.input,
          output: model.output,
          ...(model.cacheRead !== undefined ? { cacheRead: model.cacheRead } : {}),
        },
      });
    }
  }
  return routes;
}

/**
 * The same version-2 guards `FileCostAnomalyStore.load()` applies, for an
 * explicit `--charges` path the store cannot reach: the store's path is fixed
 * to `COST_ANOMALY_STATE_PATH`, so a custom file is read here WITHOUT inventing
 * a second format. The default path goes through the store itself.
 */
function parseSnapshotAt(filePath: string): CostAnomalyStateSnapshot | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as CostAnomalyStateSnapshot;
    if (parsed?.version !== 2) return undefined;
    if (typeof parsed.scopes !== "object" || parsed.scopes === null) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

type ChargeLoadOutcome =
  | { kind: "ok"; record: ChargeRecord }
  | { kind: "absent"; path: string }
  | { kind: "unreadable"; path: string; reason: string };

/**
 * Read the charge record. The default path is read by the module that owns it
 * (`FileCostAnomalyStore`); an explicit `--charges` path applies the same v2
 * guards. Absent and unreadable are DISTINGUISHED so the caller can state one
 * explicitly and reserve exit 2 for an explicitly requested anchor.
 */
export function loadChargeRecord(
  targetDir: string,
  chargesArg: string | undefined,
): ChargeLoadOutcome {
  const filePath =
    chargesArg === undefined
      ? path.resolve(targetDir, COST_ANOMALY_STATE_PATH)
      : path.resolve(targetDir, chargesArg);
  if (!fs.existsSync(filePath)) return { kind: "absent", path: filePath };

  const snapshot =
    chargesArg === undefined
      ? new FileCostAnomalyStore(targetDir).load()
      : parseSnapshotAt(filePath);
  if (snapshot === undefined)
    return { kind: "unreadable", path: filePath, reason: "not a readable version-2 charge record" };
  return { kind: "ok", record: buildChargeRecord(snapshot) };
}

/**
 * Fold a snapshot's scopes into the comparator's `ChargeRecord`. The latest
 * observation is the most recent ratio across `observed` (settled, most recent
 * last) and `pending` (over-threshold readings that arrived after it); the
 * count is the total number of those readings.
 */
export function buildChargeRecord(snapshot: CostAnomalyStateSnapshot): ChargeRecord {
  const record: Record<string, ChargeObservation> = {};
  for (const [key, state] of Object.entries(snapshot.scopes)) {
    if (typeof state !== "object" || state === null) continue;
    const provider =
      typeof state.provider === "string" && state.provider.length > 0
        ? state.provider
        : (key.split("/")[0] ?? "");
    const model =
      typeof state.model === "string" && state.model.length > 0
        ? state.model
        : key.slice(key.indexOf("/") + 1);
    const ratios = [
      ...(Array.isArray(state.observed) ? state.observed : []),
      ...(Array.isArray(state.pending) ? state.pending : []),
    ].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    if (ratios.length === 0) continue;
    record[normalizeScopeKey(provider, model)] = {
      provider,
      model,
      ratio: ratios[ratios.length - 1] as number,
      count: ratios.length,
    };
  }
  return record;
}

type ParsedArgs =
  | { kind: "ok"; inventory?: string; charges?: string; tolerance: number; offline: boolean }
  | { kind: "bad"; error: string };

/** Parse the command's flags; unknown or malformed flags are a usage refusal. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  let inventory: string | undefined;
  let charges: string | undefined;
  let tolerance = DEFAULT_TOLERANCE;
  let offline = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--offline") {
      offline = true;
      continue;
    }
    const value = argv[index + 1];
    if (flag === "--inventory" && typeof value === "string") {
      inventory = value;
      index += 1;
      continue;
    }
    if (flag === "--charges" && typeof value === "string") {
      charges = value;
      index += 1;
      continue;
    }
    if (flag === "--tolerance" && typeof value === "string") {
      const parsed = Number(value);
      if (!(Number.isFinite(parsed) && parsed >= 0 && parsed < 1)) {
        return { kind: "bad", error: `--tolerance must be a ratio in [0, 1), got "${value}"` };
      }
      tolerance = parsed;
      index += 1;
      continue;
    }
    return {
      kind: "bad",
      error:
        "usage: scripts/check-prices.ts [--inventory <path>] [--charges <path>] [--tolerance <ratio>] [--offline]",
    };
  }
  const parsed: {
    kind: "ok";
    inventory?: string;
    charges?: string;
    tolerance: number;
    offline: boolean;
  } = { kind: "ok", tolerance, offline };
  if (inventory !== undefined) parsed.inventory = inventory;
  if (charges !== undefined) parsed.charges = charges;
  return parsed;
}

/** Run the command; returns the exit code. No process.exit inside a test. */
export async function run(argv: readonly string[], deps: CommandDeps = {}): Promise<number> {
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  const targetDir = deps.targetDir ?? process.cwd();
  const args = parseArgs(argv);
  if (args.kind === "bad") {
    write(`${args.error}\n`);
    return 1;
  }

  let config: ReturnType<typeof loadModelsConfig>;
  try {
    config = loadModelsConfig(args.inventory ?? defaultModelsPath());
  } catch (error) {
    write(
      `inventory could not be used: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }

  const routes = declaredRoutes(config);

  // An EXPLICITLY requested anchor that cannot be read is the one case exit 2
  // is reserved for; an absent/unreadable DEFAULT record is stated below and
  // never by itself changes the exit.
  const chargesOutcome = loadChargeRecord(targetDir, args.charges);
  if (chargesOutcome.kind !== "ok" && args.charges !== undefined) {
    write(
      `an anchor was requested and could not be read: ${chargesOutcome.path} ` +
        `(${chargesOutcome.kind === "absent" ? "does not exist" : chargesOutcome.reason})\n`,
    );
    return 2;
  }

  const liveOutcome: LiveOutcome | { kind: "skipped" } = args.offline
    ? { kind: "skipped" }
    : await fetchLiveCatalogue(deps);

  const audit = auditDeclaredPrices(routes, {
    ...(chargesOutcome.kind === "ok" ? { charges: chargesOutcome.record } : {}),
    ...(liveOutcome.kind === "ok" ? { live: liveOutcome.catalogue } : {}),
    tolerance: args.tolerance,
  });

  for (const row of audit.compared) {
    write(
      `ok        ${row.route}: billed ×${row.ratio.toFixed(4)} the declared row, ` +
        `${row.count} charge observation${row.count === 1 ? "" : "s"}\n`,
    );
  }
  for (const note of audit.notes) {
    write(`NOTE      ${note.message}\n`);
  }
  for (const hint of audit.hints) {
    write(`hint      ${hint.message}\n`);
  }
  for (const finding of audit.findings) {
    write(`FINDING   ${finding.message}\n`);
  }
  if (chargesOutcome.kind !== "ok") {
    write(
      chargesOutcome.kind === "absent"
        ? `no charge observations available (no charge record at ${chargesOutcome.path})\n`
        : `no charge observations available (charge record unreadable at ${chargesOutcome.path}: ${chargesOutcome.reason})\n`,
    );
  }
  if (liveOutcome.kind === "unavailable") {
    write(`public list unavailable: ${liveOutcome.reason}\n`);
  }
  if (liveOutcome.kind === "skipped") {
    write(
      "offline: the public-list hint half was skipped by request (--offline); the charge and self-consistency judgements still ran\n",
    );
  }
  return audit.findings.length > 0 ? 1 : 0;
}

// Entry guard: importing this module (e.g. from a test) must not run anything.
if (import.meta.main) process.exitCode = await run(process.argv.slice(2));
