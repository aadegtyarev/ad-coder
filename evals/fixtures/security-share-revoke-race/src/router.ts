import { getShare } from "./store";

export interface Request {
  headers: Record<string, string>;
  params: Record<string, string>;
}

/** Every share token is this shape before any lookup runs. Opaque, never a path. */
const TOKEN_PATTERN = /^[a-z0-9]{16,64}$/;

export function requireToken(request: Request): string {
  const token = request.params.token ?? "";
  if (!TOKEN_PATTERN.test(token)) throw new Error("invalid token");
  return token;
}

/**
 * Existing route. Reads the canonical store directly -- correct today, and not
 * part of this plan.
 */
export const routes = {
  "GET /shares/:token": (request: Request) => {
    const token = requireToken(request);
    const record = getShare(token);
    if (!record || record.revokedAt) throw new Error("not found");
    return { ownerId: record.ownerId, filePath: record.filePath };
  },
};
