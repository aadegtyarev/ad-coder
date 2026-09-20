import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolvePipelineConfig } from "../src/cli/resolve-config";

/** An absolute-path caveat guard: every test confines reads to a temp dir. */
function scratch(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ad-coder-retire-${label}-`));
}

const silent = (): void => {};

function fakeEnv(vars: Record<string, string>): (name: string) => string | undefined {
  return (name: string) => vars[name];
}

// ---------------------------------------------------------------------------
// (b) the stored routing source ABSENT + DEEPSEEK_API_KEY -> env-preset route

test("(b) an absent models.yaml with DEEPSEEK_API_KEY resolves the env-preset route and writes nothing", () => {
  const dir = scratch("env");
  try {
    const config = resolvePipelineConfig({
      task: "x",
      targetDir: dir,
      modelsConfigPath: path.join(dir, "models.yaml"), // absent
      env: fakeEnv({ DEEPSEEK_API_KEY: "k" }),
      warn: silent,
    });
    expect(config.delegatedRoute?.source).toBe('provider "deepseek"');
    // NO file is created anywhere in the scratch dir: no seeding on first use.
    expect(fs.readdirSync(dir)).toEqual([]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (c) the stored routing source ABSENT, no env keys -> codex fallback path entered

test("(c) an absent models.yaml with no env keys takes the codex fallback and writes nothing", () => {
  const dir = scratch("codex");
  try {
    const config = resolvePipelineConfig({
      task: "x",
      targetDir: dir,
      modelsConfigPath: path.join(dir, "models.yaml"), // absent
      env: fakeEnv({}),
      warn: silent,
    });
    expect(config.delegatedRoute?.source).toBe('provider "openai-codex"');
    // The assertion is file absence, not oauth behaviour: resolution must not
    // materialize a stored routing source on first use.
    expect(fs.readdirSync(dir)).toEqual([]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
