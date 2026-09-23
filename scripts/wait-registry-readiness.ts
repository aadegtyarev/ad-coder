/**
 * Wait for the npm registry to make a just-published package usable.
 *
 * `npm publish` is intentionally executed exactly once by the release workflow.
 * The registry can acknowledge that write before either an exact-version lookup
 * or the channel's `latest` dist-tag is visible to installers. Retrying publish
 * would turn a propagation delay into an immutable duplicate-version failure, so
 * this script polls only reads and names a bounded timeout explicitly.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface RegistryCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type RegistryCommandRunner = (argv: string[]) => Promise<RegistryCommandResult>;

export interface RegistryTarballResponse {
  ok: boolean;
  status: number;
  bytes: Uint8Array;
}

/** Kept injectable so the release gate can prove CDN failure handling offline. */
export type RegistryTarballFetcher = (url: string) => Promise<RegistryTarballResponse>;

export interface RegistryReadinessOptions {
  packageName: string;
  version: string;
  maxAttempts: number;
  delayMs: number;
  run: RegistryCommandRunner;
  fetchTarball?: RegistryTarballFetcher;
  sleep?: (delayMs: number) => Promise<void>;
  onPending?: (attempt: number, observation: string) => void;
}

export interface RegistryReadiness {
  attempts: number;
}

export class RegistryPropagationPendingError extends Error {
  readonly code = "propagation_pending";

  constructor(
    readonly packageName: string,
    readonly version: string,
    readonly attempts: number,
    readonly lastObservation: string,
  ) {
    super(
      `npm registry propagation is still pending for ${packageName}@${version} after ${attempts} attempts; ` +
        `the package was published once and will not be republished. Last observation: ${lastObservation}. ` +
        "Wait for the registry to converge, then verify with npm view before rerunning any downstream install.",
    );
    this.name = "RegistryPropagationPendingError";
  }
}

export function readJsonString(result: RegistryCommandResult): string | null {
  if (result.exitCode !== 0) return null;
  // npm normally prints one JSON value, but a runner can prepend or append its
  // own npm warnings to stdout. Treat whole non-empty lines as candidates: a
  // JSON value must still be complete on its line, and exactly one value must
  // be present. Searching for a quoted substring would turn damaged output or
  // a warning's quoted configuration name into a successful readiness check.
  const values: unknown[] = [];
  for (const line of result.stdout.split(/\r?\n/u)) {
    const candidate = line.trim();
    if (candidate === "") continue;
    try {
      values.push(JSON.parse(candidate));
    } catch {
      // This line is transport noise, not a complete JSON value.
    }
  }
  if (values.length !== 1) return null;
  return typeof values[0] === "string" ? values[0] : null;
}

function readJsonObject(result: RegistryCommandResult): Record<string, unknown> | null {
  if (result.exitCode !== 0) return null;
  const values: unknown[] = [];
  for (const line of result.stdout.split(/\r?\n/u)) {
    const candidate = line.trim();
    if (candidate === "") continue;
    try {
      values.push(JSON.parse(candidate));
    } catch {
      // See readJsonString: only a complete, standalone JSON value is trusted.
    }
  }
  const [value] = values;
  return values.length === 1 && value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function tarballMetadata(
  result: RegistryCommandResult,
): { kind: "ready"; url: string; integrity: string } | { kind: "pending"; observation: string } {
  const value = readJsonObject(result);
  if (!value || typeof value.tarball !== "string" || typeof value.integrity !== "string")
    return { kind: "pending", observation: "tarball metadata was missing or invalid" };
  if (!value.integrity.startsWith("sha512-"))
    return { kind: "pending", observation: "tarball metadata had invalid integrity" };
  let parsed: URL;
  try {
    parsed = new URL(value.tarball);
  } catch {
    return { kind: "pending", observation: "tarball metadata had an invalid URL" };
  }
  // This workflow uses the public npm registry explicitly. Do not let a malformed
  // registry response turn the privileged release runner into an arbitrary fetcher.
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "registry.npmjs.org" ||
    parsed.username !== "" ||
    parsed.password !== ""
  )
    return { kind: "pending", observation: "tarball metadata named a non-npm HTTPS URL" };
  return { kind: "ready", url: parsed.toString(), integrity: value.integrity };
}

async function defaultTarballFetcher(url: string): Promise<RegistryTarballResponse> {
  const response = await fetch(url, { redirect: "error" });
  return {
    ok: response.ok,
    status: response.status,
    bytes: new Uint8Array(await response.arrayBuffer()),
  };
}

async function tarballObservation(
  result: RegistryCommandResult,
  fetchTarball: RegistryTarballFetcher,
): Promise<string> {
  const metadata = tarballMetadata(result);
  if (metadata.kind === "pending") return metadata.observation;
  try {
    const downloaded = await fetchTarball(metadata.url);
    if (!downloaded.ok) return `tarball fetch returned HTTP ${downloaded.status}`;
    const integrity = `sha512-${createHash("sha512").update(downloaded.bytes).digest("base64")}`;
    return integrity === metadata.integrity
      ? "tarball integrity matched"
      : "tarball integrity mismatched";
  } catch (error) {
    return `tarball fetch failed (${error instanceof Error ? error.message : String(error)})`;
  }
}

function observation(result: RegistryCommandResult, expected: string): string {
  const found = readJsonString(result);
  if (found !== null) return found === expected ? "matched" : `returned ${JSON.stringify(found)}`;
  const npmCode = /(?:^|\n)npm (?:error|ERR!) code ([A-Z][A-Z0-9]+)/u.exec(result.stderr)?.[1];
  return result.exitCode === 0
    ? "returned invalid JSON"
    : `lookup failed (${npmCode ?? `exit ${result.exitCode}`})`;
}

/**
 * Poll both facts an updater relies on: the immutable exact version and the
 * mutable `latest` tag. Injected process and clock make the retry boundary
 * deterministic in tests and avoid a shell in the workflow.
 */
export async function waitForRegistryReadiness(
  options: RegistryReadinessOptions,
): Promise<RegistryReadiness> {
  if (!Number.isSafeInteger(options.maxAttempts) || options.maxAttempts < 1)
    throw new Error("maxAttempts must be a positive integer");
  if (!Number.isSafeInteger(options.delayMs) || options.delayMs < 0)
    throw new Error("delayMs must be a non-negative integer");
  const sleep =
    options.sleep ?? ((delayMs) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const fetchTarball = options.fetchTarball ?? defaultTarballFetcher;
  let lastObservation = "no lookup was made";
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    const exact = await options.run([
      "npm",
      "view",
      `${options.packageName}@${options.version}`,
      "version",
      "--json",
      "--prefer-online",
    ]);
    const latest = await options.run([
      "npm",
      "view",
      options.packageName,
      "dist-tags.latest",
      "--json",
      "--prefer-online",
    ]);
    const exactValue = readJsonString(exact);
    const latestValue = readJsonString(latest);
    if (exactValue === options.version && latestValue === options.version) {
      const dist = await options.run([
        "npm",
        "view",
        `${options.packageName}@${options.version}`,
        "dist",
        "--json",
        "--prefer-online",
      ]);
      const downloaded = await tarballObservation(dist, fetchTarball);
      if (downloaded === "tarball integrity matched") return { attempts: attempt };
      lastObservation = `exact matched; latest matched; ${downloaded}`;
    } else {
      lastObservation = `exact ${observation(exact, options.version)}; latest ${observation(latest, options.version)}`;
    }
    options.onPending?.(attempt, lastObservation);
    if (attempt < options.maxAttempts) await sleep(options.delayMs);
  }
  throw new RegistryPropagationPendingError(
    options.packageName,
    options.version,
    options.maxAttempts,
    lastObservation,
  );
}

function positiveInteger(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/u.test(value) || Number(value) < 1 || !Number.isSafeInteger(Number(value)))
    throw new Error(`${name} must be a positive integer`);
  return Number(value);
}

function nonNegativeInteger(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error(`${name} must be a non-negative integer`);
  return Number(value);
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
    throw new Error(
      "package.json must contain string name and version before registry readiness can be checked",
    );
  const result = await waitForRegistryReadiness({
    packageName: manifest.name,
    version: manifest.version,
    maxAttempts: positiveInteger(
      "REGISTRY_READY_ATTEMPTS",
      process.env.REGISTRY_READY_ATTEMPTS,
      180,
    ),
    delayMs: nonNegativeInteger(
      "REGISTRY_READY_DELAY_MS",
      process.env.REGISTRY_READY_DELAY_MS,
      10_000,
    ),
    run: npmRunner,
    onPending: (attempt, status) => {
      // A delayed publish can take many minutes. Keep its two independent
      // registry observations visible while the job is running, without
      // flooding Actions logs on every ten-second poll.
      if (attempt === 1 || attempt % 6 === 0)
        process.stdout.write(`npm registry pending (attempt ${attempt}): ${status}\n`);
    },
  });
  process.stdout.write(
    `npm registry ready: ${manifest.name}@${manifest.version} resolves exactly and is latest (${result.attempts} attempt${result.attempts === 1 ? "" : "s"})\n`,
  );
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
