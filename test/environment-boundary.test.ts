import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createCredentialEnvironment } from "../src/auth/environment-boundary";

test("credential environment snapshots operator values and blocks cwd transitions into target", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-boundary-"));
  const target = path.join(root, "target");
  const outside = path.join(root, "operator-shell");
  const nested = path.join(target, "nested");
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(outside);
  let cwd = outside;
  const source: Record<string, string | undefined> = { PROVIDER_KEY: "operator-value" };
  const env = createCredentialEnvironment(target, { cwd: () => cwd, env: source });

  expect(env("PROVIDER_KEY")).toBe("operator-value");
  source.PROVIDER_KEY = "target-mutation";
  expect(env("PROVIDER_KEY")).toBe("operator-value");
  cwd = target;
  expect(env("PROVIDER_KEY")).toBeUndefined();
  cwd = nested;
  expect(env("PROVIDER_KEY")).toBeUndefined();
  fs.rmSync(root, { recursive: true, force: true });
});

test("credential environment started inside target captures no values or secrets", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-boundary-"));
  const target = path.join(root, "target");
  const outside = path.join(root, "operator-shell");
  fs.mkdirSync(target);
  fs.mkdirSync(outside);
  let cwd = target;
  const warnings: string[] = [];
  const env = createCredentialEnvironment(target, {
    cwd: () => cwd,
    env: { PROVIDER_KEY: "target-owned-secret" },
    warn: (message) => warnings.push(message),
  });

  cwd = outside;
  expect(env("PROVIDER_KEY")).toBeUndefined();
  expect(warnings.join("")).not.toContain("target-owned-secret");
  fs.rmSync(root, { recursive: true, force: true });
});

test("credential containment handles filesystem aliases and a root target", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-boundary-"));
  const target = path.join(root, "target");
  const alias = path.join(root, "alias");
  fs.mkdirSync(target);
  fs.symlinkSync(target, alias, "dir");
  expect(
    createCredentialEnvironment(target, { cwd: () => alias, env: { KEY: "secret" } })("KEY"),
  ).toBeUndefined();
  expect(
    createCredentialEnvironment(path.parse(root).root, { cwd: () => root, env: { KEY: "secret" } })(
      "KEY",
    ),
  ).toBeUndefined();
  fs.rmSync(root, { recursive: true, force: true });
});
