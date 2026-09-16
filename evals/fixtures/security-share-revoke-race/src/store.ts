export interface ShareRecord {
  token: string;
  ownerId: string;
  filePath: string;
  revokedAt?: number;
}

const shares = new Map<string, ShareRecord>();

/** Existing surface: called by the (unshown) create route. Not part of this plan. */
export function createShare(token: string, ownerId: string, filePath: string): void {
  shares.set(token, { token, ownerId, filePath });
}

/** The single canonical source of truth for a token's revoked status. */
export function getShare(token: string): ShareRecord | undefined {
  return shares.get(token);
}

/** Marks a share revoked in the canonical store. Nothing else reacts to this yet. */
export function revokeShare(token: string, ownerId: string): void {
  const record = shares.get(token);
  if (!record) throw new Error("not found");
  if (record.ownerId !== ownerId) throw new Error("not the owner");
  record.revokedAt = Date.now();
}
