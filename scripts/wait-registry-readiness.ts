/**
 * Wait for the npm registry to make a just-published package usable.
 *
 * `npm publish` is intentionally executed exactly once by the release workflow.
 * The registry can acknowledge that write before either an exact-version lookup
 * or the channel's `latest` dist-tag is visible to installers. Retrying publish
 * would turn a propagation delay into an immutable duplicate-version failure, so
 * this script polls only reads and names a bounded timeout explicitly.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface RegistryCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type RegistryCommandRunner = (argv: string[]) => Promise<RegistryCommandResult>;

export interface RegistryReadinessOptions {
  packageName: string;
  version: string;
  maxAttempts: number;
  delayMs: number;
  run: RegistryCommandRunner;
  sleep?: (delayMs: number) => Promise<void>;
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

function readJsonString(result: RegistryCommandResult): string | null {
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

function observation(result: RegistryCommandResult, expected: string): string {
  const found = readJsonString(result);
  if (found !== null) return found === expected ? "matched" : `returned ${JSON.stringify(found)}`;
  const detail = result.stderr.trim() || result.stdout.trim();
  return result.exitCode === 0
    ? "returned invalid JSON"
    : `lookup failed (${detail || `exit ${result.exitCode}`})`;
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
  let lastObservation = "no lookup was made";
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    const exact = await options.run([
      "npm",
      "view",
      `${options.packageName}@${options.version}`,
      "version",
      "--json",
    ]);
    const latest = await options.run([
      "npm",
      "view",
      options.packageName,
      "dist-tags.latest",
      "--json",
    ]);
    const exactValue = readJsonString(exact);
    const latestValue = readJsonString(latest);
    if (exactValue === options.version && latestValue === options.version)
      return { attempts: attempt };
    lastObservation = `exact ${observation(exact, options.version)}; latest ${observation(latest, options.version)}`;
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
      30,
    ),
    delayMs: nonNegativeInteger(
      "REGISTRY_READY_DELAY_MS",
      process.env.REGISTRY_READY_DELAY_MS,
      10_000,
    ),
    run: npmRunner,
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
