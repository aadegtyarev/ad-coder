import { describe, expect, test } from "bun:test";
import {
  auditDeclaredPrices,
  DEFAULT_TOLERANCE,
  type LiveCatalogue,
  type LivePrice,
  livePerMillion,
  PER_MILLION,
} from "../src/registry/price-audit";

/**
 * Fixture-driven, NO network, NO user file: the live "catalogue" is a plain
 * object literal, the offline cases simply omit it. Every test pins one of the
 * ticket's acceptance points.
 */

const live = (prompt: number, completion: number, inputCacheRead?: number): LivePrice => ({
  prompt: (prompt / PER_MILLION).toString(),
  completion: (completion / PER_MILLION).toString(),
  ...(inputCacheRead !== undefined
    ? { input_cache_read: (inputCacheRead / PER_MILLION).toString() }
    : {}),
});

describe("auditDeclaredPrices", () => {
  test("(i) a route 3.35x its live row yields a finding naming that route and factor", () => {
    // Live values verified against the real endpoint: deepseek-v4-pro
    // 0.4223/0.8446/0.0352 per 1M.
    const catalogue: LiveCatalogue = { "deepseek/deepseek-v4-pro": live(0.4223, 0.8446, 0.0352) };
    const result = auditDeclaredPrices(
      [
        {
          route: "openrouter:prod/deepseek/deepseek-v4-pro",
          modelId: "deepseek/deepseek-v4-pro",
          prices: { input: 0.4223 * 3.35, output: 0.8446 * 3.35, cacheRead: 0.0352 * 3.35 },
        },
      ],
      { live: catalogue },
    );
    expect(result.findings).toHaveLength(3);
    for (const finding of result.findings) {
      expect(finding.kind).toBe("divergence");
      expect(finding.routes).toContain("openrouter:prod/deepseek/deepseek-v4-pro");
      expect(finding.factor).toBeCloseTo(3.35, 3);
      expect(finding.model).toBe("deepseek/deepseek-v4-pro");
    }
    expect(result.compared).toHaveLength(0);
  });

  test("(ii) offline self-consistency catches deepseek-v4-pro declared differently under two routes, live half absent", () => {
    const result = auditDeclaredPrices([
      {
        route: "openrouter:cheap/deepseek/deepseek-v4-pro",
        modelId: "openrouter/deepseek-v4-pro",
        prices: { input: 0.42, output: 0.84, cacheRead: 0.035 },
      },
      {
        route: "custom:mirrored",
        modelId: "openrouter/deepseek-v4-pro",
        // ~3.372x the first route: 0.42 -> 1.4164
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
    expect(result.liveHalfSkipped).toBe(true); // live half absent entirely
  });

  test("(iii) agreeing rows (minimax-m3 vs the same live values) yield no findings", () => {
    const catalogue: LiveCatalogue = { "minimax/minimax-m3": live(0.3, 1.2, 0.06) };
    const result = auditDeclaredPrices(
      [
        {
          route: "openrouter:minimax/minimax-m3",
          modelId: "minimax/minimax-m3",
          prices: { input: 0.3, output: 1.2, cacheRead: 0.06 },
        },
      ],
      { live: catalogue },
    );
    expect(result.findings).toHaveLength(0);
    expect(result.compared.map((c) => c.unit)).toEqual(["input", "output", "cacheRead"]);
    // cacheWrite has no live reference: named, never silently dropped.
    expect(result.notComparable).toHaveLength(1);
    expect(result.notComparable[0]).toMatchObject({
      route: "openrouter:minimax/minimax-m3",
      unit: "input",
      reason: "declared `cacheWrite` has no live reference unit and is not comparable",
    });
  });

  test("(iv) the unit conversion is pinned: live '0.0000003' per token == declared 0.30 per 1M", () => {
    expect(livePerMillion("0.0000003")).toBeCloseTo(0.3, 10);
    expect(livePerMillion("0.000000844596")).toBeCloseTo(0.844596, 10);
    expect(PER_MILLION).toBe(1_000_000);
    const catalogue: LiveCatalogue = { "z-ai/glm-5.3-flash": { prompt: "0.0000003" } };
    const result = auditDeclaredPrices(
      [{ route: "r", modelId: "z-ai/glm-5.3-flash", prices: { input: 0.3, output: 1 } }],
      { live: catalogue, tolerance: DEFAULT_TOLERANCE },
    );
    expect(result.findings).toHaveLength(0);
    expect(result.compared).toContainEqual({
      route: "r",
      model: "z-ai/glm-5.3-flash",
      unit: "input",
      declared: 0.3,
      reference: 0.3,
    });
  });
});

/* --- Command-level tests: scripts/check-prices.ts, fully injected, NO network --- */

import { run as runScript } from "../scripts/check-prices";

test("(iv) a source that does not answer reports source-unavailable and exits 2", async () => {
  const lines: string[] = [];
  const inventory = new URL("./fixtures/check-prices-injected.yaml", import.meta.url).pathname;
  const code = await runScript(["--inventory", inventory], {
    fetchImpl: async () => {
      throw new Error("upstream refused");
    },
    write: (text: string) => lines.push(text),
  });
  expect(code).toBe(2);
  expect(lines.join("")).toMatch(/source unavailable: the source did not answer/);
});
