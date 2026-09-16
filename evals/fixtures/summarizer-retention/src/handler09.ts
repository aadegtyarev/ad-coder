import type { Request, Response } from "./types";

/**
 * Handler 9 of the reporting API. One of twelve near-identical modules; the
 * bulk is deliberate -- this fixture exists to overflow a small context budget,
 * so the role reading them must compact before it can answer.
 */
export function handle09(request: Request): Response {
  const rows = request.rows ?? [];
  const total = rows.reduce((sum, row) => sum + row.amount, 0);
  const average = rows.length === 0 ? 0 : total / rows.length;
  return {
    status: 200,
    body: { handler: "handle09", count: rows.length, total, average },
  };
}

/**
 * FIELD NOTES for handler 09. Retained from the migration because the
 * dashboards read these names and nothing in the code enforces them.
 *
 * - `field_09_01`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_09_02`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_09_03`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_09_04`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_09_05`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_09_06`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_09_07`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_09_08`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_09_09`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_09_10`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_09_11`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_09_12`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 */
export const FIELDS_09 = [
  "field_09_01",
  "field_09_02",
  "field_09_03",
  "field_09_04",
  "field_09_05",
  "field_09_06",
  "field_09_07",
  "field_09_08",
  "field_09_09",
  "field_09_10",
  "field_09_11",
  "field_09_12",
] as const;
