/**
 * A PURE price audit comparator: it decides nothing about config resolution
 * and performs no I/O. It takes declared per-1M price rows, the provider's own
 * charge record (the PRIMARY anchor), and an optional public catalogue (a HINT
 * only), and reports named results -- findings, notes, hints, and clean rows --
 * so nothing is silently dropped. See scripts/check-prices.ts for the wiring.
 *
 * THE ANCHOR HIERARCHY IS THE POINT:
 * - The provider's own charge answer, per (provider, model) scope, is the
 *   VERDICT. The observable is charged/expected: billing ABOVE the declared
 *   row moves the ratio up, which means the row is UNDER-DECLARED and must be
 *   a finding. Billing BELOW it means the row is OVER-DECLARED: a visible
 *   note, never a block, because a discount never hides an overcharge.
 * - The public OpenRouter list is a HINT only. It can name the CHEAPEST
 *   backend's price while the account is billed for a dearer one, so a
 *   disagreement is a reason to measure -- never a verdict and never grounds
 *   to edit.
 * - The offline self-consistency judgement (the same model declared
 *   differently under two routes) is independent of any anchor and stays a
 *   finding.
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
 * finding can point at the exact place an operator fixes; `provider` and
 * `modelId` are matched against the charge record; prices are per 1M tokens
 * (the units of both config layers).
 */
export interface DeclaredRoute {
  route: string;
  provider: string;
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
 * unit conversion is pinned in one name (the unit-conversion test pins it
 * numerically).
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

/** The direction a declared row is wrong, when judged against the charge record. */
export type Direction = "under-declared" | "over-declared";

/**
 * One scope's charge answer as the comparator consumes it. The ratio is
 * charged/expected for the scope: billing ABOVE the declared price moves it
 * up. `count` is how many settled charge observations back the latest ratio.
 */
export interface ChargeObservation {
  provider: string;
  model: string;
  ratio: number;
  count: number;
}

/**
 * Charge observations keyed by normalized scope (`<provider>/<model>` with
 * `/` and `:` separators normalized). See {@link normalizeScopeKey}.
 */
export type ChargeRecord = Readonly<Record<string, ChargeObservation>>;

export interface PriceFinding {
  kind: "under-declared" | "self-inconsistency" | "invalid-row";
  /** Route or routes the finding names. Grouped findings list all of them. */
  routes: string[];
  /** The grouping token: the model id whose prices disagree. */
  model: string;
  unit?: AuditUnit;
  direction?: Direction;
  /** charged/expected, for an under-declared finding. */
  ratio?: number;
  /** Observation count, for an under-declared finding. */
  count?: number;
  /** Declared row value(s) named verbatim. */
  declaredValues?: readonly number[];
  /** Human-readable, named-identifier-only message. Never a crash. */
  message: string;
}

/** A non-blocking charge/scope note: over-declared rows and unmatched names. */
export interface AuditNote {
  kind: "over-declared" | "unmatched-scope" | "route-without-observation";
  routes: string[];
  model: string;
  direction?: Direction;
  ratio?: number;
  count?: number;
  declaredValues?: readonly number[];
  message: string;
}

/** A public-list disagreement. A HINT, never a finding and never grounds to edit. */
export interface PriceHint {
  kind: "hint";
  route: string;
  model: string;
  unit: AuditUnit;
  declared: number;
  reference: number;
  factor: number;
  message: string;
}

/** A row the charge record judged clean: reported as compared, not suppressed. */
export interface ChargeComparedRow {
  route: string;
  model: string;
  ratio: number;
  count: number;
}

export interface AuditResult {
  findings: PriceFinding[];
  notes: AuditNote[];
  hints: PriceHint[];
  compared: ChargeComparedRow[];
  /** Explicit: the public-list hint half was skipped (offline or none supplied). */
  liveHalfSkipped: boolean;
  /** Explicit: the charge-record half was skipped (no observations supplied). */
  chargeHalfSkipped: boolean;
}

export interface AuditOptions {
  /** Charge observations keyed by normalized scope; omit to skip the charge half. */
  charges?: ChargeRecord;
  /** Public-list hint catalogue; omit to skip the hint half. */
  live?: LiveCatalogue;
  /** Relative tolerance (default {@link DEFAULT_TOLERANCE}). Named, not magic. */
  tolerance?: number;
}

/**
 * Normalize a scope identity to one comparison key. `/` and `:` are the same
 * separator for this purpose, so a route declared as `openrouter:deepseek/...`
 * matches a charge scope recorded as `openrouter/deepseek/...`.
 */
export function normalizeScopeKey(provider: string, model: string): string {
  return `${provider.replace(/[:/]/g, "/")}/${model.replace(/[:/]/g, "/")}`;
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

/** The declared row's values, named so a finding reads the row it fixes. */
function describeDeclared(route: DeclaredRoute): string {
  const parts = [`input ${route.prices.input}`, `output ${route.prices.output}`];
  if (route.prices.cacheRead !== undefined) parts.push(`cacheRead ${route.prices.cacheRead}`);
  return parts.join(", ");
}

/** Hostile-row validation: ALWAYS runs, independent of any anchor. */
function auditDeclaredValidity(declared: readonly DeclaredRoute[], findings: PriceFinding[]): void {
  for (const route of declared) {
    for (const unit of AUDIT_UNITS) {
      const value = route.prices[unit];
      if (value === undefined) continue; // optional unit, declared absent
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        findings.push({
          kind: "invalid-row",
          routes: [route.route],
          model: route.modelId,
          unit,
          message: `${route.route}: \`cost.${unit}\` is not a usable declared price (must be a finite non-negative number, got ${String(value)})`,
        });
      }
    }
  }
}

/**
 * The DIRECTIONAL charge judgement: the two directions do not cost the same.
 * Above 1 + tolerance the provider charges MORE than the row says (the row is
 * under-declared) -- a finding. Below 1 - tolerance the row prints more than
 * reality (over-declared) -- a visible note, never a block.
 */
function judgeCharge(
  route: DeclaredRoute,
  observation: ChargeObservation,
  tolerance: number,
  result: Pick<AuditResult, "findings" | "notes" | "compared">,
): void {
  const { ratio, count } = observation;
  const declaredValues = [
    route.prices.input,
    route.prices.output,
    ...(route.prices.cacheRead !== undefined ? [route.prices.cacheRead] : []),
  ];
  const observed = `${count} charge observation${count === 1 ? "" : "s"}`;
  if (ratio > 1 + tolerance) {
    result.findings.push({
      kind: "under-declared",
      routes: [route.route],
      model: route.modelId,
      direction: "under-declared",
      ratio,
      count,
      declaredValues,
      message:
        `${route.route} is UNDER-DECLARED: the provider billed ×${ratio.toFixed(4)} the declared ` +
        `row (${describeDeclared(route)} per 1M) across ${observed}`,
    });
    return;
  }
  if (ratio < 1 - tolerance) {
    result.notes.push({
      kind: "over-declared",
      routes: [route.route],
      model: route.modelId,
      direction: "over-declared",
      ratio,
      count,
      declaredValues,
      message:
        `${route.route} is OVER-DECLARED: the provider billed ×${ratio.toFixed(4)} the declared ` +
        `row (${describeDeclared(route)} per 1M) across ${observed}`,
    });
    return;
  }
  result.compared.push({ route: route.route, model: route.modelId, ratio, count });
}

/** The public-list HINT: a disagreement is a reason to measure, never a verdict. */
function auditHint(
  route: DeclaredRoute,
  live: LiveCatalogue,
  tolerance: number,
  hints: PriceHint[],
): void {
  const found = findLive(live, route.modelId);
  if (found === undefined) return; // no list entry: nothing to hint on
  const [liveId, livePrice] = found;
  for (const unit of AUDIT_UNITS) {
    const declaredValue = route.prices[unit];
    if (typeof declaredValue !== "number" || !Number.isFinite(declaredValue) || declaredValue < 0)
      continue; // the validity pass names a hostile row; the hint does not repeat it
    const reference = livePerMillion(livePrice[LIVE_UNIT_BY_AUDIT_UNIT[unit]]);
    if (reference === undefined || reference === 0) continue;
    const factor = declaredValue / reference;
    if (Math.abs(factor - 1) > tolerance) {
      hints.push({
        kind: "hint",
        route: route.route,
        model: route.modelId,
        unit,
        declared: declaredValue,
        reference,
        factor,
        message:
          `${route.route} ${unit}: the row declares ${declaredValue} per 1M but the public list ` +
          `publishes ${reference.toFixed(6)} per 1M ("${liveId}") = ×${factor.toFixed(4)} -- the ` +
          "row and the list disagree, a reason to measure; not a verdict and not grounds to edit " +
          "(the list can be the cheapest backend's price while the account is billed for a dearer one)",
      });
    }
  }
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
        // finding from the validity pass (or the declared absence was optional);
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
    notes: [],
    hints: [],
    compared: [],
    liveHalfSkipped: options.live === undefined,
    chargeHalfSkipped: options.charges === undefined,
  };

  auditDeclaredValidity(declared, result.findings);

  if (!result.chargeHalfSkipped) {
    const charges = options.charges as ChargeRecord; // narrowed by the flag above
    const matchedScopeKeys = new Set<string>();
    for (const route of declared) {
      const key = normalizeScopeKey(route.provider, route.modelId);
      const observation = charges[key];
      if (observation === undefined) {
        result.notes.push({
          kind: "route-without-observation",
          routes: [route.route],
          model: route.modelId,
          message: `${route.route} has no charge observation (no ${route.provider}/${route.modelId} scope in the charge record)`,
        });
        continue;
      }
      matchedScopeKeys.add(key);
      judgeCharge(route, observation, tolerance, result);
    }
    for (const [key, observation] of Object.entries(charges)) {
      if (matchedScopeKeys.has(key)) continue;
      result.notes.push({
        kind: "unmatched-scope",
        routes: [],
        model: observation.model,
        message: `charge observation scope ${observation.provider}/${observation.model} matches no declared route`,
      });
    }
  }

  if (!result.liveHalfSkipped) {
    const live = options.live as LiveCatalogue; // narrowed by the flag above
    for (const route of declared) auditHint(route, live, tolerance, result.hints);
  }

  auditSelfConsistency(declared, tolerance, result.findings);
  return result;
}
