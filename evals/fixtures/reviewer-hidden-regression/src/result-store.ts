import * as path from "node:path";

const SAFE_ID = /^[a-z0-9_%.-]+$/;

export function resultPath(baseDir: string, encodedId: string): string {
  if (!SAFE_ID.test(encodedId)) throw new Error("invalid result id");
  return path.join(baseDir, decodeURIComponent(encodedId), "result.json");
}

export function saveResult(
  writePrimary: () => void,
  writeMetadata: () => void,
): { saved: boolean } {
  writePrimary();
  try {
    writeMetadata();
  } catch {
    return { saved: false };
  }
  return { saved: true };
}
