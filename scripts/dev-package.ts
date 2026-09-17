/**
 * Rewrite `package.json` in place for a `-dev` publish (issue #268).
 *
 * The dev channel is a second package, `ad-coder-dev`, rather than a dist-tag on
 * the first: a dist-tag would still install as `ad-coder`, overwriting the stable
 * command, and the operator wants both usable side by side. A second name gives
 * each its own binary and lets someone track early features without giving up a
 * working tool.
 *
 * It is generated from the same tree rather than kept as a second manifest:
 * two committed manifests drift, and the difference here is three fields.
 *
 * Run by the release workflow on a `-dev` tag, immediately before `npm publish`.
 * Never committed -- the workflow's checkout is discarded after the run.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const DEV_NAME = "ad-coder-dev";

/** `v0.53.0-dev.1` -> `0.53.0-dev.1`; the tag is the single source of the version. */
export function devVersionFromTag(tag: string): string {
  const version = tag.startsWith("v") ? tag.slice(1) : tag;
  // A prerelease identifier is what distinguishes the channel, so require it
  // rather than silently publishing a stable-looking version to the dev package.
  if (!/^\d+\.\d+\.\d+-dev\.\d+$/.test(version))
    throw new Error(`a dev tag must look like v1.2.3-dev.4, got "${tag}"`);
  return version;
}

export interface DevManifest {
  name: string;
  version: string;
  /** One entry; the dev build renames the key, so the type must not pin it. */
  bin: Record<string, string>;
  description?: string;
}

/**
 * The three fields that differ, and nothing else: same files, same dependencies,
 * same engines. A dev install must behave identically apart from its name, or it
 * stops being a preview of what ships.
 */
export function devManifest<T extends DevManifest>(manifest: T, version: string): T {
  const binPath = Object.values(manifest.bin)[0];
  if (binPath === undefined) throw new Error("package.json has no bin entry to rename");
  return {
    ...manifest,
    name: DEV_NAME,
    version,
    bin: { [DEV_NAME]: binPath },
    description:
      `${manifest.description ?? ""} (development channel: published from a -dev tag, ahead of the stable ad-coder package)`.trim(),
  };
}

if (import.meta.main) {
  const tag = process.argv[2];
  if (tag === undefined) throw new Error("usage: dev-package.ts <tag>");
  const manifestPath = path.join(process.cwd(), "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as DevManifest;
  const rewritten = devManifest(manifest, devVersionFromTag(tag));
  fs.writeFileSync(manifestPath, `${JSON.stringify(rewritten, null, 2)}\n`);
  process.stdout.write(`${rewritten.name}@${rewritten.version}\n`);
}
