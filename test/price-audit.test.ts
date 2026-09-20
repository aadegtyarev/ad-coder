import { describe, expect, test } from "bun:test";
import {
  auditDeclaredPrices,
  type ChargeRecord,
  DEFAULT_TOLERANCE,
  type DeclaredRoute,
  type LiveCatalogue,
  type LivePrice,
  livePerMillion,
  normalizeScopeKey,
  PER_MILLION,
} from "../src/registry/price-audit";

/**
 * Fixture-driven, NO network, NO user file: the charge record is a plain
 * object literal, the public list is a plain object. Every test pins one of
 * the ticket's acceptance points.
 */

const route = (
  provider: string,
  modelId: string,
  prices: { input: number; output: number; cacheRead?: number },
): DeclaredRoute => ({ route: `${provider}:${modelId}`, provider, modelId, prices });

const charges = (provider: string, model: string, ratio: number, count: number): ChargeRecord => ({
  [normalizeScopeKey(provider, model)]: { provider, model, ratio, count },
});

const live = (prompt: number, completion: number, inputCacheRead?: number): LivePrice => ({
  prompt: (prompt / PER_MILLION).toString(),
  completion: (completion / PER_MILLION).toString(),
  ...(inputCacheRead !== undefined
    ? { input_cache_read: (inputCacheRead / PER_MILLION).toString() }
    : {}),
});

describe("auditDeclaredPrices: the charge record is the verdict", () => {
  test("(i) a route the provider bills 3.353x is UNDER-DECLARED: a finding naming route, direction, declared row and ratio", () => {
    const result = auditDeclaredPrices(
      [
        route("openrouter", "deepseek/deepseek-v4-pro", {
          input: 0.422298,
          output: 0.844596,
          cacheRead: 0.0351915,
        }),
      ],
      { charges: charges("openrouter", "deepseek/deepseek-v4-pro", 3.353, 3) },
    );
    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0]!;
    expect(finding.kind).toBe("under-declared");
    expect(finding.direction).toBe("under-declared");
    expect(finding.routes).toContain("openrouter:deepseek/deepseek-v4-pro");
    expect(finding.model).toBe("deepseek/deepseek-v4-pro");
    expect(finding.ratio).toBeCloseTo(3.353, 3);
    expect(finding.count).toBe(3);
    expect(finding.declaredValues).toEqual([0.422298, 0.844596, 0.0351915]);
    expect(finding.message).toContain("openrouter:deepseek/deepseek-v4-pro");
    expect(finding.message).toContain("UNDER-DECLARED");
    expect(finding.message).toContain("3.353");
    expect(finding.message).toContain("0.422298");
    expect(finding.message).toContain("3 charge observations");
  });

  test("(ii) a 1.650x scope is a finding and reports its observation count", () => {
    const result = auditDeclaredPrices(
      [route("openrouter", "z-ai/glm-5.3-flash", { input: 0.09, output: 0.3, cacheRead: 0.018 })],
      { charges: charges("openrouter", "z-ai/glm-5.3-flash", 1.65, 2) },
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.kind).toBe("under-declared");
    expect(result.findings[0]!.ratio).toBeCloseTo(1.65, 3);
    expect(result.findings[0]!.count).toBe(2);
    expect(result.findings[0]!.message).toContain("2 charge observations");
  });

  test("(iii) a 1.0000 scope is clean and reported as compared", () => {
    const result = auditDeclaredPrices(
      [route("openrouter", "minimax/minimax-m3", { input: 0.3, output: 1.2, cacheRead: 0.06 })],
      { charges: charges("openrouter", "minimax/minimax-m3", 1.0, 4) },
    );
    expect(result.findings).toHaveLength(0);
    expect(result.compared).toEqual([
      { route: "openrouter:minimax/minimax-m3", model: "minimax/minimax-m3", ratio: 1.0, count: 4 },
    ]);
  });

  test("(iv) a 0.81x scope is OVER-DECLARED: a NOTE, never a finding", () => {
    const result = auditDeclaredPrices(
      [route("openrouter", "minimax/minimax-m3", { input: 0.3, output: 1.2, cacheRead: 0.06 })],
      { charges: charges("openrouter", "minimax/minimax-m3", 0.81, 5) },
    );
    expect(result.findings).toHaveLength(0);
    expect(result.compared).toHaveLength(0);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]!.kind).toBe("over-declared");
    expect(result.notes[0]!.direction).toBe("over-declared");
    expect(result.notes[0]!.ratio).toBeCloseTo(0.81, 3);
    expect(result.notes[0]!.message).toContain("OVER-DECLARED");
    expect(result.notes[0]!.message).toContain("0.81");
  });

  test("(v) a public-list disagreement is a HINT, never a finding", () => {
    const catalogue: LiveCatalogue = { "deepseek/deepseek-v4-pro": live(0.42, 0.84, 0.035) };
    const result = auditDeclaredPrices(
      [
        route("openrouter", "deepseek/deepseek-v4-pro", {
          input: 0.672,
          output: 1.344,
          cacheRead: 0.056,
        }),
      ],
      { live: catalogue },
    );
    expect(result.findings).toHaveLength(0);
    expect(result.hints).toHaveLength(3);
    for (const hint of result.hints) {
      expect(hint.kind).toBe("hint");
      expect(hint.factor).toBeCloseTo(1.6, 3);
      expect(hint.message).toContain("a reason to measure");
      expect(hint.message).toContain("not a verdict and not grounds to edit");
    }
  });

  test("(vi) every unmatched scope and every route without an observation is named", () => {
    const result = auditDeclaredPrices(
      [route("openrouter", "minimax/minimax-m3", { input: 0.3, output: 1.2, cacheRead: 0.06 })],
      { charges: charges("openrouter", "ghost/model", 2.0, 1) },
    );
    const kinds = result.notes.map((note) => note.kind);
    expect(kinds).toContain("route-without-observation");
    expect(kinds).toContain("unmatched-scope");
    expect(result.notes.find((n) => n.kind === "route-without-observation")?.message).toContain(
      "minimax/minimax-m3",
    );
    expect(result.notes.find((n) => n.kind === "unmatched-scope")?.message).toContain(
      "ghost/model",
    );
  });

  test("(vii) offline self-consistency still catches a model declared differently under two routes", () => {
    const result = auditDeclaredPrices([
      {
        route: "openrouter:cheap/deepseek/deepseek-v4-pro",
        provider: "openrouter",
        modelId: "openrouter/deepseek-v4-pro",
        prices: { input: 0.42, output: 0.84, cacheRead: 0.035 },
      },
      {
        route: "custom:mirrored",
        provider: "custom",
        modelId: "openrouter/deepseek-v4-pro",
        prices: { input: 1.4164, output: 2.8332, cacheRead: 0.1178 },
      },
    ]);
    const findings = result.findings.filter((f) => f.kind === "self-inconsistency");
    expect(findings).toHaveLength(3); // one per unit
    for (const finding of findings) {
      // The grouping is reported verbatim, so a wrong pairing is visible.
      expect(finding.model).toBe("deepseek-v4-pro");
      expect(finding.routes).toEqual([
        "openrouter:cheap/deepseek/deepseek-v4-pro",
        "custom:mirrored",
      ]);
      expect(finding.declaredValues).toBeDefined();
    }
    expect(result.liveHalfSkipped).toBe(true);
    expect(result.chargeHalfSkipped).toBe(true);
  });

  test("(vii) the unit conversion is pinned: live '0.0000003' per token == declared 0.30 per 1M", () => {
    expect(livePerMillion("0.0000003")).toBeCloseTo(0.3, 10);
    expect(livePerMillion("0.000000844596")).toBeCloseTo(0.844596, 10);
    expect(PER_MILLION).toBe(1_000_000);
    const catalogue: LiveCatalogue = { "z-ai/glm-5.3-flash": { prompt: "0.0000003" } };
    const result = auditDeclaredPrices(
      [route("openrouter", "z-ai/glm-5.3-flash", { input: 0.3, output: 1 })],
      { live: catalogue, tolerance: DEFAULT_TOLERANCE },
    );
    expect(result.findings).toHaveLength(0);
    expect(result.hints).toHaveLength(0); // an agreeing list is not a disagreement
  });
});
