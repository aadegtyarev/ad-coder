import type { Request, Response } from "./types";

/**
 * Handler 12 of the reporting API. One of twelve near-identical modules; the
 * bulk is deliberate -- this fixture exists to overflow a small context budget,
 * so the role reading them must compact before it can answer.
 */
export function handle12(request: Request): Response {
  const rows = request.rows ?? [];
  const total = rows.reduce((sum, row) => sum + row.amount, 0);
  const average = rows.length === 0 ? 0 : total / rows.length;
  return {
    status: 200,
    body: { handler: "handle12", count: rows.length, total, average },
  };
}

/**
 * FIELD NOTES for handler 12. Retained from the migration because the
 * dashboards read these names and nothing in the code enforces them.
 *
 * - `field_12_01`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_12_02`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_12_03`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_12_04`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_12_05`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_12_06`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_12_07`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_12_08`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_12_09`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_12_10`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_12_11`: numeric, nullable, defaulted to zero on absence. Written by
 *   the import path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 * - `field_12_12`: numeric, nullable, defaulted to zero on absence. Written by
 *   the export path, read by the rollup. Renaming it silently blanks
 *   the panel that charts it, because the dashboard keys on the string.
 */
export const FIELDS_12 = [
  "field_12_01",
  "field_12_02",
  "field_12_03",
  "field_12_04",
  "field_12_05",
  "field_12_06",
  "field_12_07",
  "field_12_08",
  "field_12_09",
  "field_12_10",
  "field_12_11",
  "field_12_12",
] as const;
