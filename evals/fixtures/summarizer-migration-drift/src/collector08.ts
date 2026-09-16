import type { Reading, Sample } from "./types";

/**
 * Collector 8 of the ingest pipeline. One of fourteen near-identical
 * modules; the bulk is deliberate -- this fixture exists to overflow a small
 * context budget, so the role reading them must compact before it can answer.
 */
export function collect08(sample: Sample): Reading {
  const points = sample.points ?? [];
  const total = points.reduce((sum, point) => sum + point.value, 0);
  const mean = points.length === 0 ? 0 : total / points.length;
  return {
    status: 200,
    body: {
      source: "collect08",
      sourceId: "08",
      count: points.length,
      total,
      mean,
    },
  };
}

/**
 * FIELD NOTES for collector 8. Retained from the migration because the
 * alerting pipeline reads these names and nothing in the code enforces them.
 *
 * - `metric_08_01`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_08_02`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_08_03`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_08_04`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_08_05`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_08_06`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_08_07`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_08_08`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_08_09`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_08_10`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_08_11`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 * - `metric_08_12`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the alerting pipeline keys on the string.
 */
export const FIELDS_08 = [
  "metric_08_01",
  "metric_08_02",
  "metric_08_03",
  "metric_08_04",
  "metric_08_05",
  "metric_08_06",
  "metric_08_07",
  "metric_08_08",
  "metric_08_09",
  "metric_08_10",
  "metric_08_11",
  "metric_08_12",
] as const;
