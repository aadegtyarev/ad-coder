/**
 * A PURE price audit comparator: it decides nothing about config resolution
 * and performs no I/O. It takes declared per-1M price rows and an (optional)
 * live catalogue of per-token price strings, and reports three kinds of named
 * result -- agreements, divergences beyond a tolerance, and incomparable rows
 * (never silently dropped). See scripts/check-prices.ts for the command wiring.
 *
 * The hostile row contract: a value that is missing, not a number, NaN, or
 * negative becomes a NAMED validation-error finding, never a thrown error and
 * never a silent pass -- a broken row that looked like a pass is the worst
 * outcome a price check can produce.
 */

/** A live price keyed by the model id, with PER-TOKEN decimal STRING prices. */
export interface LivePrice {
  prompt?: string;
  completion?: string;
  /** Cache-read pricing, per token, string (OpenRouter: `input_cache_read`). */
  input_cache_read?: string;
}

/** A live catalogue: model id (e.g. `z-ai/glm-5.3-flash`) -> its prices. */
export type LiveCatalogue = Readonly<Record<string, LivePrice>>;

/**
 * One declared route as the auditor consumes it. `route` names the row so a
 * finding can point at the exact place an operator fixes; `modelId` is the
 * provider-native id matched against the catalogue; prices are per 1M tokens
 * (the units of both config layers).
 */
export interface DeclaredRoute {
  route: string;
  modelId: string;
  prices: {
    input: number;
    output: number;
    cacheRead?: number;
  };
}

/** The units compared, in report order. */
export const AUDIT_UNITS = ["input", "output", "cacheRead"] as const;
export type AuditUnit = "input" | "output" | "cacheRead";

/** Normalization factor between a per-token live price and a per-1M declared one. */
export const PER_MILLION = 1_000_000;

/**
 * Default relative tolerance. Named so the command's help and this module can
 * state the same number without one reading the other's argv.
 */
export const DEFAULT_TOLERANCE = 0.05;

/**
 * The explicit normalization adapter: a live per-token decimal STRING becomes
 * a per-1M number. Deliberately the ONLY place the ×1_000_000 lives, so the
 * unit conversion is pinned in one name (test (v) pins it numerically).
 *
 * Returns `undefined` for anything that is not a finite, non-negative number
 * after parsing -- the caller turns that into a named hostile-row finding.
 */
export function livePerMillion(tokenPrice: unknown): number | undefined {
  if (typeof tokenPrice === "number") {
    return Number.isFinite(tokenPrice) && tokenPrice >= 0 ? tokenPrice * PER_MILLION : undefined;
  }
  if (typeof tokenPrice !== "string") return undefined;
  const parsed = Number(tokenPrice);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed * PER_MILLION : undefined;
}

export const LIVE_UNIT_BY_AUDIT_UNIT: Record<AuditUnit, keyof LivePrice> = {
  input: "prompt",
  output: "completion",
  cacheRead: "input_cache_read",
};

export interface PriceFinding {
  kind: "divergence" | "self-inconsistency" | "invalid-row";
  /** Route or routes the finding names. Grouped findings list all of them. */
  routes: string[];
  /** The grouping token: the model id whose prices disagree. */
  model: string;
  unit: AuditUnit;
  /** Declared value(s) named verbatim. */
  declared?: number;
  declaredValues?: readonly number[];
  /** The live catalogue value (per 1M) for a divergence, undefined otherwise. */
  reference?: number;
  /**
   * declared / reference. Divergence-only: the factor is the number an
   * operator greps for, so the ticket's exact numeric acceptance can match it.
   */
  factor?: number;
  /** Human-readable, named-identifier-only message. Never a crash. */
  message: string;
}

/** An agreeing row: reported as compared, not suppressed. */
export interface ComparedRow {
  route: string;
  model: string;
  unit: AuditUnit;
  declared: number;
  reference: number;
}

/** A row that could not be judged, named so "unknown" is never inferred as "ok". */
export interface NotComparableRow {
  route: string;
  model: string;
  unit: AuditUnit;
  reason: string;
}

export interface AuditResult {
  findings: PriceFinding[];
  compared: ComparedRow[];
  notComparable: NotComparableRow[];
  /** Explicit: the live half was skipped (offline or no catalogue supplied). */
  liveHalfSkipped: boolean;
}

export interface AuditOptions {
  /** Live per-token catalogue; omit or set `liveHalfSkipped` to skip (a) entirely. */
  live?: LiveCatalogue;
  liveHalfSkipped?: boolean;
  /** Relative tolerance (default {@link DEFAULT_TOLERANCE}). Named, not magic. */
  tolerance?: number;
}

/**
 * Look a declared model up in the live catalogue: exact id match, then a
 * LAST-PATH-SEGMENT match (`z-ai/glm-5.3-flash` matches `glm-5.3-flash`), the
 * same grouping rule the self-consistency judgement reports verbatim.
 */
function findLive(catalogue: LiveCatalogue, modelId: string): [string, LivePrice] | undefined {
  const exact = catalogue[modelId];
  if (exact !== undefined) return [modelId, exact];
  const last = modelId.split("/").at(-1) ?? modelId;
  const entry = Object.entries(catalogue).find(([id]) => {
    const tail = id.split("/").at(-1) ?? id;
    return tail === last && id !== modelId;
  });
  return entry === undefined ? undefined : [entry[0], entry[1]];
}

/** One unit's divergence check: returns a finding or a compared row. */
function compareUnit(
  route: DeclaredRoute,
  live: LiveCatalogue,
  tolerance: number,
  result: Pick<AuditResult, "findings" | "compared" | "notComparable">,
): void {
  const found = findLive(live, route.modelId);
  if (found === undefined) {
    result.notComparable.push({
      route: route.route,
      model: route.modelId,
      unit: "input",
      reason: `no live catalogue entry matches "${route.modelId}"`,
    });
    return;
  }
  const [liveId, livePrice] = found;
  for (const unit of AUDIT_UNITS) {
    const declaredValue = route.prices[unit];
    if (declaredValue === undefined) continue; // optional unit, declared absent
    if (typeof declaredValue !== "number" || !Number.isFinite(declaredValue) || declaredValue < 0) {
      result.findings.push({
        kind: "invalid-row",
        routes: [route.route],
        model: route.modelId,
        unit,
        message: `${route.route}: \`cost.${unit}\` is not a usable declared price (must be a finite non-negative number, got ${String(declaredValue)})`,
      });
      continue;
    }
    if (livePrice[LIVE_UNIT_BY_AUDIT_UNIT[unit]] === undefined) {
      result.notComparable.push({
        route: route.route,
        model: route.modelId,
        unit,
        reason: `live entry "${liveId}" publishes no ${LIVE_UNIT_BY_AUDIT_UNIT[unit] ?? unit} reference`,
      });
      continue;
    }
    const reference = livePerMillion(livePrice[LIVE_UNIT_BY_AUDIT_UNIT[unit]]);
    if (reference === undefined) {
      result.findings.push({
        kind: "invalid-row",
        routes: [route.route],
        model: route.modelId,
        unit,
        message: `${route.route}: live ${String(LIVE_UNIT_BY_AUDIT_UNIT[unit])} price for "${liveId}" is not a usable number (missing, non-numeric, NaN or negative)`,
      });
      continue;
    }
    if (reference === 0) {
      result.notComparable.push({
        route: route.route,
        model: route.modelId,
        unit,
        reason: `live ${String(LIVE_UNIT_BY_AUDIT_UNIT[unit])} price for "${liveId}" is zero, so no relative factor exists`,
      });
      continue;
    }
    const factor = declaredValue / reference;
    if (Math.abs(factor - 1) > tolerance) {
      result.findings.push({
        kind: "divergence",
        routes: [route.route],
        model: route.modelId,
        unit,
        declared: declaredValue,
        reference,
        factor,
        message: `${route.route} ${unit}: declared ${declaredValue} per 1M vs live ${reference} per 1M ("${liveId}") = ×${factor.toFixed(4)}, beyond tolerance ${tolerance}`,
      });
      continue;
    }
    result.compared.push({
      route: route.route,
      model: route.modelId,
      unit,
      declared: declaredValue,
      reference,
    });
  }
  // cacheWrite has no live reference unit at all: named not-comparable, never dropped.
  result.notComparable.push({
    route: route.route,
    model: route.modelId,
    unit: "input",
    reason: "declared `cacheWrite` has no live reference unit and is not comparable",
  });
}

/**
 * Offline self-consistency: the same model declared under two or more routes
 * must agree within tolerance. Grouped by the model id's LAST path segment,
 * and the grouping is reported VERBATIM, so a wrong pairing (two different
 * models that share a tail segment) is visible in the finding itself.
 */
function auditSelfConsistency(
  declared: readonly DeclaredRoute[],
  tolerance: number,
  findings: PriceFinding[],
): void {
  const bySegment = new Map<string, DeclaredRoute[]>();
  for (const route of declared) {
    // Model ids are operator-declared strings, potentially empty; the segment
    // is still deterministic, so the grouping is always a defined key.
    const segment = route.modelId.split("/").at(-1) ?? String(route.modelId);
    const group = bySegment.get(segment);
    if (group === undefined) bySegment.set(segment, [route]);
    else group.push(route);
  }
  for (const [segment, routes] of bySegment) {
    if (routes.length < 2) continue;
    for (const unit of AUDIT_UNITS) {
      const values = routes
        .map((route) => ({ route, value: route.prices[unit] }))
        .filter(
          (entry): entry is { route: DeclaredRoute; value: number } =>
            entry.value !== undefined &&
            typeof entry.value === "number" &&
            Number.isFinite(entry.value) &&
            entry.value >= 0,
        );
      if (values.length < 2) {
        // Any hostile or missing value among grouped routes is already a named
        // finding from the live pass (or the declared absence was optional);
        // here a group with fewer than two usable values cannot judge a
        // divergence, so it is named rather than passed silently.
        if (values.length === 0 && routes.length >= 2) {
          findings.push({
            kind: "self-inconsistency",
            routes: routes.map((r) => r.route),
            model: segment,
            unit,
            message: `${segment} under routes ${routes.map((r) => `"${r.route}"`).join(", ")}: ${unit} has no two usable declared values to compare`,
          });
        }
        continue;
      }
      const min = Math.min(...values.map((v) => v.value));
      const max = Math.max(...values.map((v) => v.value));
      if (min > 0 && (max - min) / min <= tolerance) continue;
      findings.push({
        kind: "self-inconsistency",
        routes: values.map((v) => v.route.route),
        model: segment,
        unit,
        declaredValues: values.map((v) => v.value),
        message: `${segment} declared inconsistently under routes ${values.map((v) => `"${v.route.route}" (${v.value})`).join(", ")}: unit ${unit} spans ${((max - min) / (min || 1)).toFixed(4)} of the minimum, beyond tolerance ${tolerance}`,
      });
    }
  }
}

/** Run the whole audit. Pure: no I/O, no global state, deterministic. */
export function auditDeclaredPrices(
  declared: readonly DeclaredRoute[],
  options: AuditOptions = {},
): AuditResult {
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const result: AuditResult = {
    findings: [],
    compared: [],
    notComparable: [],
    liveHalfSkipped: options.liveHalfSkipped === true || options.live === undefined,
  };
  if (!result.liveHalfSkipped) {
    const live = options.live as LiveCatalogue; // narrowed by the flag above
    for (const route of declared) compareUnit(route, live, tolerance, result);
  }
  auditSelfConsistency(declared, tolerance, result.findings);
  return result;
}
