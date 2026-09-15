import type { Request } from "./reports";
import { listReports, readReport } from "./reports";

export interface Session {
  owner: string;
}

/** The single authorization door. Every report route is registered behind it. */
export function requireSession(request: Request): Session {
  const owner = request.headers["x-session-owner"];
  if (!owner) throw new Error("unauthenticated");
  return { owner };
}

export const routes = {
  "GET /reports": (request: Request) => listReports(requireSession(request).owner),
  "GET /reports/:id": (request: Request) => {
    requireSession(request);
    return readReport(request.query.id ?? "");
  },
};
