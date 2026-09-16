import type { Reading, Sample } from "./types";

/**
 * Collector 5 of the ingest pipeline. One of fourteen near-identical
 * modules; the bulk is deliberate -- this fixture exists to overflow a small
 * context budget, so the role reading them must compact before it can answer.
 */
export function collect05(sample: Sample): Reading {
  const points = sample.points ?? [];
  const total = points.reduce((sum, point) => sum + point.value, 0);
  const mean = points.length === 0 ? 0 : total / points.length;
  return {
    status: 200,
    body: {
      source: "collect05",
      sourceId: "05",
      count: points.length,
      total,
      mean,
    },
  };
}

/**
 * FIELD NOTES for collector 5. Retained from the migration because the
 * alerting pipeline reads these names and nothing in the code enforces them.
 *
 * - `metric_05_01`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_05_02`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_05_03`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_05_04`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_05_05`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_05_06`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_05_07`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_05_08`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_05_09`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_05_10`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_05_11`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_05_12`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 */
export const FIELDS_05 = [
  "metric_05_01",
  "metric_05_02",
  "metric_05_03",
  "metric_05_04",
  "metric_05_05",
  "metric_05_06",
  "metric_05_07",
  "metric_05_08",
  "metric_05_09",
  "metric_05_10",
  "metric_05_11",
  "metric_05_12",
] as const;
