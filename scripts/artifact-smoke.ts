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

try {
  await run(["bun", "pm", "pack", "--ignore-scripts", "--destination", scratch], root);
  const archiveName = fs.readdirSync(scratch).find((name) => name.endsWith(".tgz"));
  if (archiveName === undefined) throw new Error("package manager did not produce an artifact");
  const archive = path.join(scratch, archiveName);
  const digest = createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("artifact integrity digest was not produced");
  await run(["tar", "-xzf", archive], scratch);
  const artifact = path.join(scratch, "package");
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
