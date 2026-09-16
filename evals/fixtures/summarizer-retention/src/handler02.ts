import type { Request, Response } from "./types";

/**
 * Handler 2 of the reporting API. One of twelve near-identical modules; the
 * bulk is deliberate -- this fixture exists to overflow a small context budget,
 * so the role reading them must compact before it can answer.
 */
export function handle02(request: Request): Response {
  const rows = request.rows ?? [];
  const total = rows.reduce((sum, row) => sum + row.amount, 0);
  const average = rows.length === 0 ? 0 : total / rows.length;
  return {
    status: 200,
    body: { handler: "handle02", count: rows.length, total, average },
  };
}

/**
 * FIELD NOTES for handler 02. Retained from the migration because the
 * dashboards read these names and nothing in the code enforces them.
 *
 * - `field_02_01`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_02_02`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_02_03`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_02_04`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_02_05`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_02_06`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_02_07`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_02_08`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_02_09`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_02_10`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_02_11`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_02_12`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 */
export const FIELDS_02 = [
  "field_02_01",
  "field_02_02",
  "field_02_03",
  "field_02_04",
  "field_02_05",
  "field_02_06",
  "field_02_07",
  "field_02_08",
  "field_02_09",
  "field_02_10",
  "field_02_11",
  "field_02_12",
] as const;
