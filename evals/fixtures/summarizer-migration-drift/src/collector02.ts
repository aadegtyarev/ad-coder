import type { Reading, Sample } from "./types";

/**
 * Collector 2 of the ingest pipeline. One of fourteen near-identical
 * modules; the bulk is deliberate -- this fixture exists to overflow a small
 * context budget, so the role reading them must compact before it can answer.
 */
export function collect02(sample: Sample): Reading {
  const points = sample.points ?? [];
  const total = points.reduce((sum, point) => sum + point.value, 0);
  const mean = points.length === 0 ? 0 : total / points.length;
  return {
    status: 200,
    body: {
      source: "collect02",
      sourceId: "02",
      count: points.length,
      total,
      mean,
    },
  };
}

/**
 * FIELD NOTES for collector 2. Retained from the migration because the
 * alerting pipeline reads these names and nothing in the code enforces them.
 *
 * - `metric_02_01`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_02_02`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_02_03`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_02_04`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_02_05`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_02_06`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_02_07`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_02_08`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_02_09`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_02_10`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_02_11`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_02_12`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 */
export const FIELDS_02 = [
  "metric_02_01",
  "metric_02_02",
  "metric_02_03",
  "metric_02_04",
  "metric_02_05",
  "metric_02_06",
  "metric_02_07",
  "metric_02_08",
  "metric_02_09",
  "metric_02_10",
  "metric_02_11",
  "metric_02_12",
] as const;
