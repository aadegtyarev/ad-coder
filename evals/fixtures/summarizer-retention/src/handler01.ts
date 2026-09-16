import type { Request, Response } from "./types";

/**
 * Handler 1 of the reporting API. One of twelve near-identical modules; the
 * bulk is deliberate -- this fixture exists to overflow a small context budget,
 * so the role reading them must compact before it can answer.
 */
export function handle01(request: Request): Response {
  const rows = request.rows ?? [];
  const total = rows.reduce((sum, row) => sum + row.amount, 0);
  const average = rows.length === 0 ? 0 : total / rows.length;
  return {
    status: 200,
    body: { handler: "handle01", count: rows.length, total, average },
  };
}

/**
 * FIELD NOTES for handler 01. Retained from the migration because the
 * dashboards read these names and nothing in the code enforces them.
 *
 * - `field_01_01`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_01_02`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_01_03`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_01_04`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_01_05`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_01_06`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_01_07`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_01_08`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_01_09`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_01_10`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_01_11`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_01_12`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 */
export const FIELDS_01 = [
  "field_01_01",
  "field_01_02",
  "field_01_03",
  "field_01_04",
  "field_01_05",
  "field_01_06",
  "field_01_07",
  "field_01_08",
  "field_01_09",
  "field_01_10",
  "field_01_11",
  "field_01_12",
] as const;
