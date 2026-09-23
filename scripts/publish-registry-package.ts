/** Publish once, or resume a release whose identical package is already on npm. */
import * as fs from "node:fs";
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

function expectedIntegrity(result: RegistryCommandResult): string {
  if (result.exitCode !== 0) throw new Error(`npm pack failed (${npmErrorCode(result)})`);
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error("npm pack returned invalid JSON");
  }
  if (!Array.isArray(value) || value.length !== 1 || typeof value[0]?.integrity !== "string")
    throw new Error("npm pack did not return one package integrity");
  return value[0].integrity;
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
  const packed = await options.run(["npm", "pack", "--dry-run", "--json", "--silent"]);
  const expected = expectedIntegrity(packed);
  const before = await lookupIntegrity(options);
  if (before.kind === "present") {
    requireMatch(before.integrity, expected, options);
    return "reused";
  }

  const publish = await options.run([
    "npm",
    "publish",
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
