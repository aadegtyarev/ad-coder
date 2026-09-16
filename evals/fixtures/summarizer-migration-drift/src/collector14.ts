import type { Reading, Sample } from "./types";

/**
 * Collector 14 of the ingest pipeline. One of fourteen near-identical
 * modules; the bulk is deliberate -- this fixture exists to overflow a small
 * context budget, so the role reading them must compact before it can answer.
 */
export function collect14(sample: Sample): Reading {
  const points = sample.points ?? [];
  const total = points.reduce((sum, point) => sum + point.value, 0);
  const mean = points.length === 0 ? 0 : total / points.length;
  return {
    status: 200,
    body: {
      source: "collect14",
      sourceId: "14",
      count: points.length,
      total,
      mean,
    },
  };
}

/**
 * FIELD NOTES for collector 14. Retained from the migration because the
 * alerting pipeline reads these names and nothing in the code enforces them.
 *
 * - `metric_14_01`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_14_02`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_14_03`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_14_04`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_14_05`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_14_06`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_14_07`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_14_08`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_14_09`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_14_10`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_14_11`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_14_12`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 */
export const FIELDS_14 = [
  "metric_14_01",
  "metric_14_02",
  "metric_14_03",
  "metric_14_04",
  "metric_14_05",
  "metric_14_06",
  "metric_14_07",
  "metric_14_08",
  "metric_14_09",
  "metric_14_10",
  "metric_14_11",
  "metric_14_12",
] as const;
