/**
 * `bun run scripts/check-prices.ts` — the command half of the price audit.
 *
 * The command only MAKES A WRONG ROW VISIBLE; fixing it is the operator's act.
 * It names exits: 0 clean, 1 divergence or invalid row found, 2 the live
 * source did not answer. `--offline` states explicitly that the live half was
 * skipped by request, and the offline self-consistency judgement still runs.
 *
 * SOURCES:
 * - declared rows: `--inventory <path>`, DEFAULT defaultModelsPath() -- the
 *   operator's models.yaml layer (per-1M, `input`/`output` required,
 *   `cacheRead`/`cacheWrite` optional). NEVER read or written implicitly
 *   beyond the flag's own target: no test needs, and no default write touches,
 *   the operator's own file.
 * - live reference: GET https://openrouter.ai/api/v1/models (no key), whose
 *   `data[].pricing.prompt/completion/input_cache_read` are PER-TOKEN decimal
 *   STRINGS, normalized through the explicit ×1_000_000 adapter in
 *   src/registry/price-audit.ts.
 *
 * The fetch is INJECTED (see `run`), so tests exercise every judgement with no
 * network at all.
 */
import { defaultModelsPath, loadModelsConfig } from "../src/config/store";
import {
  auditDeclaredPrices,
  DEFAULT_TOLERANCE,
  type DeclaredRoute,
  type LiveCatalogue,
  type LivePrice,
} from "../src/registry/price-audit";

/** The live endpoint. Exported so tests can pin it without network. */
export const LIVE_MODELS_URL = "https://openrouter.ai/api/v1/models";

/** Bounded live fetch: the source answering "not today" is an explicit outcome. */
export const LIVE_TIMEOUT_MS = 10_000;

export interface CommandDeps {
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: (input: string, init?: { signal?: AbortSignal }) => Promise<Response>;
  write?: (text: string) => void;
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

type ParsedArgs =
  | { kind: "ok"; inventory?: string; tolerance: number; offline: boolean }
  | { kind: "bad"; error: string };

/** Parse the command's flags; unknown or malformed flags are a usage refusal. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  let inventory: string | undefined;
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
        "usage: scripts/check-prices.ts [--inventory <path>] [--tolerance <ratio>] [--offline]",
    };
  }
  const parsed: { kind: "ok"; inventory?: string; tolerance: number; offline: boolean } = {
    kind: "ok",
    tolerance,
    offline,
  };
  if (inventory !== undefined) parsed.inventory = inventory;
  return parsed;
}

/** Run the command; returns the exit code. No process.exit inside a test. */
export async function run(argv: readonly string[], deps: CommandDeps = {}): Promise<number> {
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
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

  const liveOutcome: LiveOutcome | { kind: "skipped" } = args.offline
    ? { kind: "skipped" }
    : await fetchLiveCatalogue(deps);

  const audit = auditDeclaredPrices(declaredRoutes(config), {
    ...(args.offline ? { liveHalfSkipped: true } : {}),
    ...(liveOutcome.kind === "ok" ? { live: liveOutcome.catalogue } : {}),
    tolerance: args.tolerance,
  });

  for (const row of audit.compared) {
    write(
      `ok        ${row.route} ${row.unit}: declared ${row.declared} == live ${row.reference.toFixed(6)} per 1M\n`,
    );
  }
  for (const row of audit.notComparable) {
    write(`skipped   ${row.route} ${row.unit}: ${row.reason}\n`);
  }
  for (const finding of audit.findings) {
    write(`FINDING   ${finding.message}\n`);
  }
  if (liveOutcome.kind === "unavailable") {
    write(`source unavailable: ${liveOutcome.reason}\n`);
    return 2;
  }
  if (liveOutcome.kind === "skipped") {
    write(
      "offline: the live half was skipped by request (--offline); only the offline self-consistency judgement ran\n",
    );
  }
  return audit.findings.length > 0 ? 1 : 0;
}

// Entry guard: importing this module (e.g. from a test) must not run anything.
if (import.meta.main) process.exitCode = await run(process.argv.slice(2));
