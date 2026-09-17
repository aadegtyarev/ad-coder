#!/usr/bin/env node
/**
 * Launcher, not the CLI. The real entry point is `src/cli.ts`, and ad-coder runs
 * on Bun: prompts and skills are read from files beside the package, and every
 * command the project defines is a `bun run`.
 *
 * `bin` cannot point at the TypeScript directly, because `npm i -g` puts this on
 * a PATH where `node` executes it -- and node meets `.ts` with a syntax error in
 * a file the user did not write. That is the worst possible first contact with a
 * tool. So `bin` points here: node can always run this file, and it either hands
 * over to Bun or explains what to install.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = join(dirname(dirname(fileURLToPath(import.meta.url))), "src", "cli.ts");

/** Bun on PATH, then the default install location its own installer uses. */
function findBun() {
  const onPath = spawnSync("bun", ["--version"], { stdio: "ignore" });
  if (onPath.status === 0) return "bun";
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (home !== undefined) {
    const installed = join(home, ".bun", "bin", "bun");
    if (existsSync(installed)) return installed;
  }
  return undefined;
}

const bun = findBun();
if (bun === undefined) {
  process.stderr.write(
    "ad-coder runs on Bun, which was not found on PATH or in ~/.bun/bin.\n" +
      "Install it with:  curl -fsSL https://bun.sh/install | bash\n" +
      "Then run ad-coder again -- no reinstall of this package is needed.\n",
  );
  process.exit(127);
}

// Inherit stdio and forward the exit code: this process must be transparent, so
// an interactive console, a piped JSON result and a non-zero exit all behave as
// though Bun had been invoked directly.
const run = spawnSync(bun, ["run", cli, ...process.argv.slice(2)], { stdio: "inherit" });
if (run.error !== undefined) {
  process.stderr.write(`ad-coder: could not start Bun (${run.error.message})\n`);
  process.exit(127);
}
// A signal-killed child reports null status; report the conventional 128+n.
process.exit(run.status ?? (run.signal !== null ? 128 : 1));
