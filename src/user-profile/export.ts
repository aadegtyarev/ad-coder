import { encodeUserProfile } from "./schema";

/**
 * Produce the portable schema, not the private store file. The schema contains
 * only routing calibration and confirmed economic history, never credentials or account data.
 */
export function exportUserProfile(value: unknown): string {
  return encodeUserProfile(value);
}
