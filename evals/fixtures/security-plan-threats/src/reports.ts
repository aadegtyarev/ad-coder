import * as fs from "node:fs";
import * as path from "node:path";

export interface Request {
  query: Record<string, string>;
  headers: Record<string, string>;
}

const REPORT_DIR = "/var/lib/reports";

/** Existing, already-reviewed surface: the id is validated before it is joined. */
export function readReport(id: string): string {
  if (!/^[a-z0-9-]{1,64}$/.test(id)) throw new Error("invalid report id");
  return fs.readFileSync(path.join(REPORT_DIR, `${id}.json`), "utf8");
}

/** Existing surface. Every caller is behind `requireSession` in `src/router.ts`. */
export function listReports(owner: string): string[] {
  return fs
    .readdirSync(REPORT_DIR)
    .filter((name) => name.startsWith(`${owner}-`))
    .map((name) => name.replace(/\.json$/, ""));
}
