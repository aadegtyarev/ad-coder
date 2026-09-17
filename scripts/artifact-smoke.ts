import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const expectedVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
  .version as string;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-artifact-smoke-"));
const isolatedBun = path.join(scratch, "bun-home");
const readOnlyCache = path.join(os.homedir(), ".bun", "install", "cache");
const environment = {
  ...process.env,
  BUN_INSTALL: isolatedBun,
  npm_config_ignore_scripts: "true",
  GITHUB_TOKEN: "",
  NPM_TOKEN: "",
  NODE_AUTH_TOKEN: "",
};

const MAX_AUDITED_FILES = 2_000;
const MAX_AUDITED_FILE_BYTES = 1_000_000;
// `bin` holds the node launcher the published `bin` field points at: it is what
// `npm i -g` puts on PATH, so it must ship (issue #268). Everything here is an
// explicit declaration -- an entry is added when the package deliberately gains
// a root, never to quiet the gate.
const PACKED_ROOTS = new Set(["bin", "src", "prompts", "examples"]);
const PACKED_FILES = new Set(["package.json", "README.md", "CHANGELOG.md", "LICENSE"]);
const TRACKED_ROOTS = new Set([
  ".ad-coder", // bounded anonymous project calibration; intentionally excluded from package files
  ".claude", // reviewed developer-only LDO harness; intentionally excluded from package files
  ".github",
  "docs",
  "evals", // development-only calibration corpus; intentionally excluded from package files
  "examples",
  "prompts",
  "scripts",
  "src",
  "test",
]);
const TRACKED_FILES = new Set([
  ".gitignore",
  "AGENTS.md",
  "CHANGELOG.md",
  "CLAUDE.md",
  "LICENSE",
  "README.md",
  "biome.json",
  "bun.lock",
  "package.json",
  "tsconfig.json",
  // Every-PR delivery/review stamping opt-in switch; deliberately committed at the
  // repo root and deliberately excluded from package files (not in "files").
  "ad-coder.stamps.json",
]);
const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ["github-token", /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/],
  ["openai-key", /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/],
];
const TRACKED_FIXTURE_ALLOWLIST = new Map([
  // Exercises production FollowUp secret rejection; this invalid credential is never packed.
  ["test/project-operations.test.ts", new Set(["github-token"])],
]);

async function run(command: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(command, { cwd, env: environment, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`${command[0]} ${command[1] ?? ""} failed: ${stderr.trim()}`);
  return stdout;
}

function walkFiles(directory: string): string[] {
  return fs
    .readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

function auditFiles(
  files: string[],
  base: string,
  label: string,
  allowlist: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): void {
  if (files.length > MAX_AUDITED_FILES) throw new Error(`${label} file inventory exceeds limit`);
  for (const file of files) {
    const relative = path.relative(base, file);
    const stat = fs.statSync(file);
    if (stat.size > MAX_AUDITED_FILE_BYTES) {
      throw new Error(`${label} file exceeds audit byte limit: ${relative}`);
    }
    const content = fs.readFileSync(file, "utf8");
    for (const [kind, pattern] of SECRET_PATTERNS) {
      if (pattern.test(content) && !allowlist.get(relative)?.has(kind))
        throw new Error(`${label} ${kind} candidate: ${relative}`);
    }
  }
}

try {
  const tracked = (await run(["git", "ls-files", "-z"], root))
    .split("\0")
    .filter(Boolean)
    .map((name) => path.join(root, name));
  for (const file of tracked) {
    const relative = path.relative(root, file);
    const rootName = relative.split(path.sep)[0] as string;
    if (!TRACKED_FILES.has(relative) && !TRACKED_ROOTS.has(rootName)) {
      throw new Error(`unexpected tracked file: ${relative}`);
    }
  }
  auditFiles(tracked, root, "tracked", TRACKED_FIXTURE_ALLOWLIST);
  await run(["bun", "pm", "pack", "--ignore-scripts", "--destination", scratch], root);
  const archiveName = fs.readdirSync(scratch).find((name) => name.endsWith(".tgz"));
  if (archiveName === undefined) throw new Error("package manager did not produce an artifact");
  const archive = path.join(scratch, archiveName);
  const digest = createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("artifact integrity digest was not produced");
  await run(["tar", "-xzf", archive], scratch);
  const artifact = path.join(scratch, "package");
  const packed = walkFiles(artifact);
  for (const file of packed) {
    const relative = path.relative(artifact, file);
    const rootName = relative.split(path.sep)[0] as string;
    if (!PACKED_FILES.has(relative) && !PACKED_ROOTS.has(rootName)) {
      throw new Error(`unexpected packed file: ${relative}`);
    }
  }
  for (const required of ["package.json", "README.md", "LICENSE"]) {
    if (!fs.existsSync(path.join(artifact, required)))
      throw new Error(`packed file missing: ${required}`);
  }
  auditFiles(packed, artifact, "packed");
  fs.copyFileSync(path.join(root, "bun.lock"), path.join(artifact, "bun.lock"));
  await run(
    ["bun", "install", "--frozen-lockfile", "--ignore-scripts", "--cache-dir", readOnlyCache],
    artifact,
  );
  await run(["bun", "link"], artifact);
  const consumer = path.join(scratch, "consumer");
  fs.mkdirSync(consumer);
  fs.writeFileSync(
    path.join(consumer, "package.json"),
    '{"name":"artifact-smoke-consumer","private":true}',
  );
  await run(["bun", "link", "ad-coder"], consumer);
  const binary = path.join(consumer, "node_modules", ".bin", "ad-coder");
  const about = JSON.parse(await run([binary, "about", "--json"], consumer)) as {
    version?: string;
  };
  if (about.version !== expectedVersion)
    throw new Error("artifact about returned the wrong semver");
  const help = await run([binary, "--help"], consumer);
  if (!help.includes("ad-coder")) throw new Error("artifact help did not execute");
  process.stdout.write(`artifact smoke passed sha256=${digest}\n`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
