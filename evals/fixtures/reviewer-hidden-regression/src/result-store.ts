import * as path from "node:path";

const SAFE_ID = /^[a-z0-9_-]+$/;

export function resultPath(baseDir: string, encodedId: string): string {
  if (!SAFE_ID.test(encodedId)) throw new Error("invalid result id");
  return path.join(baseDir, encodedId, "result.json");
}

export function saveResult(
  writePrimary: () => void,
  writeMetadata: () => void,
): { saved: boolean } {
  writeMetadata();
  writePrimary();
  return { saved: true };
}
