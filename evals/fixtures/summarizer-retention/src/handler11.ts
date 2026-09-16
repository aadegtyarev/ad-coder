import type { Request, Response } from "./types";

/**
 * Handler 11 of the reporting API. One of twelve near-identical modules; the
 * bulk is deliberate -- this fixture exists to overflow a small context budget,
 * so the role reading them must compact before it can answer.
 */
export function handle11(request: Request): Response {
  const rows = request.rows ?? [];
  const total = rows.reduce((sum, row) => sum + row.amount, 0);
  const average = rows.length === 0 ? 0 : total / rows.length;
  return {
    status: 200,
    body: { handler: "handle11", count: rows.length, total, average },
  };
}

/**
 * FIELD NOTES for handler 11. Retained from the migration because the
 * dashboards read these names and nothing in the code enforces them.
 *
 * - `field_11_01`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_11_02`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_11_03`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_11_04`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_11_05`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_11_06`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_11_07`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_11_08`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_11_09`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_11_10`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_11_11`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_11_12`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 */
export const FIELDS_11 = [
  "field_11_01",
  "field_11_02",
  "field_11_03",
  "field_11_04",
  "field_11_05",
  "field_11_06",
  "field_11_07",
  "field_11_08",
  "field_11_09",
  "field_11_10",
  "field_11_11",
  "field_11_12",
] as const;
