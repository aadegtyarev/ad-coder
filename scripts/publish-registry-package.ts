/** Publish once, or resume a release whose identical package is already on npm. */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  type RegistryCommandResult,
  type RegistryCommandRunner,
  readJsonString,
} from "./wait-registry-readiness";

export interface PublishOptions {
  packageName: string;
  version: string;
  tag?: string;
  run: RegistryCommandRunner;
}

export type PublishOutcome = "published" | "reused";

function npmErrorCode(result: RegistryCommandResult): string {
  return (
    /(?:^|\n)npm (?:error|ERR!) code ([A-Z][A-Z0-9]+)/u.exec(result.stderr)?.[1] ??
    `exit ${result.exitCode}`
  );
}

function packedTarball(
  result: RegistryCommandResult,
  destination: string,
  options: PublishOptions,
): string {
  if (result.exitCode !== 0) throw new Error(`npm pack failed (${npmErrorCode(result)})`);
  // npm versions disagree about what --json emits (including no record at all).
  // Only the fresh destination and the archive's own manifest are authorities.
  const entries = fs.readdirSync(destination, { withFileTypes: true });
  if (
    entries.length !== 1 ||
    !entries[0]?.isFile() ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/u.test(entries[0].name)
  )
    throw new Error("npm pack did not create exactly one safe tarball");
  const tarball = path.join(destination, entries[0].name);
  let manifest: unknown;
  try {
    const source = execFileSync("tar", ["-xOzf", tarball, "package/package.json"], {
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    manifest = JSON.parse(source);
  } catch {
    throw new Error("npm pack created an archive without a readable package manifest");
  }
  if (
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    !Object.hasOwn(manifest, "name") ||
    !Object.hasOwn(manifest, "version") ||
    (manifest as { name: unknown }).name !== options.packageName ||
    (manifest as { version: unknown }).version !== options.version
  )
    throw new Error("npm pack created an archive with a different package name or version");
  return tarball;
}

type Lookup = { kind: "missing" } | { kind: "present"; integrity: string };

async function lookupIntegrity(options: PublishOptions): Promise<Lookup> {
  const result = await options.run([
    "npm",
    "view",
    `${options.packageName}@${options.version}`,
    "dist.integrity",
    "--json",
    "--prefer-online",
  ]);
  if (result.exitCode !== 0) {
    if (npmErrorCode(result) === "E404") return { kind: "missing" };
    throw new Error(`npm registry integrity lookup failed (${npmErrorCode(result)})`);
  }
  const integrity = readJsonString(result);
  if (!integrity?.startsWith("sha512-"))
    throw new Error("npm registry returned an invalid package integrity");
  return { kind: "present", integrity };
}

function requireMatch(actual: string, expected: string, options: PublishOptions): void {
  if (actual !== expected)
    throw new Error(
      `${options.packageName}@${options.version} already exists with different tarball integrity; release cannot reuse it`,
    );
}

/** Never mark another tarball of the same immutable version as this release. */
export async function publishOrReuse(options: PublishOptions): Promise<PublishOutcome> {
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-release-pack-"));
  try {
    const packed = await options.run([
      "npm",
      "pack",
      "--silent",
      "--pack-destination",
      destination,
    ]);
    const tarball = packedTarball(packed, destination, options);
    // Compute SRI from the validated archive bytes. A later directory publish
    // could repack a different tarball.
    const expected = `sha512-${createHash("sha512").update(fs.readFileSync(tarball)).digest("base64")}`;
    const before = await lookupIntegrity(options);
    if (before.kind === "present") {
      requireMatch(before.integrity, expected, options);
      return "reused";
    }

    const publish = await options.run([
      "npm",
      "publish",
      tarball,
      ...(options.tag ? ["--tag", options.tag] : []),
    ]);
    if (publish.exitCode === 0) return "published";

    // Another attempt may have published this exact tarball while its metadata
    // was still returning 404. Recover only after a positive integrity match.
    const after = await lookupIntegrity(options);
    if (after.kind === "present") {
      requireMatch(after.integrity, expected, options);
      return "reused";
    }
    throw new Error(
      `npm publish failed (${npmErrorCode(publish)}); exact version remains unavailable`,
    );
  } finally {
    fs.rmSync(destination, { recursive: true, force: true });
  }
}

async function npmRunner(argv: string[]): Promise<RegistryCommandResult> {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function main(): Promise<void> {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
  ) as {
    name?: unknown;
    version?: unknown;
  };
  if (typeof manifest.name !== "string" || typeof manifest.version !== "string")
    throw new Error("package.json must contain string name and version before npm publish");
  const tag = process.argv[2] === "--tag" ? process.argv[3] : undefined;
  if (process.argv.length > 2 && (!tag || process.argv.length !== 4))
    throw new Error("usage: publish-registry-package.ts [--tag <dist-tag>]");
  const result = await publishOrReuse({
    packageName: manifest.name,
    version: manifest.version,
    ...(tag ? { tag } : {}),
    run: npmRunner,
  });
  process.stdout.write(`npm package ${result}: ${manifest.name}@${manifest.version}\n`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
