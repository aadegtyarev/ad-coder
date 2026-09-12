import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface BuildInfo {
  version: string;
  revision: string | null;
  linkedDevelopment: boolean;
}

/** Resolve truthful package provenance without requiring Git metadata. */
export function resolveBuildInfo(packageRoot = path.resolve(import.meta.dir, "..")): BuildInfo {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")) as {
    version?: unknown;
  };
  if (
    typeof manifest.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version)
  )
    throw new Error("package version is not valid semver");
  let revision: string | null = null;
  try {
    revision =
      execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: packageRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null;
  } catch {
    // Packed artifacts correctly report unknown when source metadata is absent.
  }
  return {
    version: manifest.version,
    revision,
    linkedDevelopment: fs.existsSync(path.join(packageRoot, ".git")),
  };
}
