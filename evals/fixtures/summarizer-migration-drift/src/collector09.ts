import type { Reading, Sample } from "./types";

/**
 * Collector 9 of the ingest pipeline. One of fourteen near-identical
 * modules; the bulk is deliberate -- this fixture exists to overflow a small
 * context budget, so the role reading them must compact before it can answer.
 */
export function collect09(sample: Sample): Reading {
  const points = sample.points ?? [];
  const total = points.reduce((sum, point) => sum + point.value, 0);
  const mean = points.length === 0 ? 0 : total / points.length;
  return {
    status: 200,
    body: {
      source: "collect07",
      sourceId: "09",
      count: points.length,
      total,
      mean,
    },
  };
}

/**
 * FIELD NOTES for collector 9. Retained from the migration because the
 * alerting pipeline reads these names and nothing in the code enforces them.
 *
 * - `metric_09_01`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_09_02`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_09_03`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_09_04`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_09_05`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_09_06`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_09_07`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_09_08`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_09_09`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_09_10`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_09_11`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_09_12`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 */
export const FIELDS_09 = [
  "metric_09_01",
  "metric_09_02",
  "metric_09_03",
  "metric_09_04",
  "metric_09_05",
  "metric_09_06",
  "metric_09_07",
  "metric_09_08",
  "metric_09_09",
  "metric_09_10",
  "metric_09_11",
  "metric_09_12",
] as const;
