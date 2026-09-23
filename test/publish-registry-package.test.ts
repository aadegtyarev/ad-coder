import { expect, test } from "bun:test";
import { type PublishOptions, publishOrReuse } from "../scripts/publish-registry-package";
import type { RegistryCommandResult } from "../scripts/wait-registry-readiness";

const integrity = "sha512-local-package";
const ok = (stdout: string): RegistryCommandResult => ({ exitCode: 0, stdout, stderr: "" });
const absent = (): RegistryCommandResult => ({
  exitCode: 1,
  stdout: "",
  stderr: "npm error code E404\n",
});
const packed = ok(JSON.stringify([{ integrity }]));

function options(replies: RegistryCommandResult[], calls: string[][]): PublishOptions {
  return {
    packageName: "ad-coder-dev",
    version: "0.181.24-dev.123",
    tag: "latest",
    run: async (argv) => {
      calls.push(argv);
      const reply = replies.shift();
      if (!reply) throw new Error("unexpected command");
      return reply;
    },
  };
}

test("an unpublished version is published once with its configured dist-tag", async () => {
  const calls: string[][] = [];
  expect(await publishOrReuse(options([packed, absent(), ok("published")], calls))).toBe(
    "published",
  );
  expect(calls).toEqual([
    ["npm", "pack", "--dry-run", "--json", "--silent"],
    ["npm", "view", "ad-coder-dev@0.181.24-dev.123", "dist.integrity", "--json", "--prefer-online"],
    ["npm", "publish", "--tag", "latest"],
  ]);
});

test("a rerun reuses only the identical published tarball", async () => {
  const calls: string[][] = [];
  expect(await publishOrReuse(options([packed, ok(JSON.stringify(integrity))], calls))).toBe(
    "reused",
  );
  expect(calls).toHaveLength(2);
  const mismatchCalls: string[][] = [];
  await expect(
    publishOrReuse(options([packed, ok('"sha512-other-package"')], mismatchCalls)),
  ).rejects.toThrow("different tarball integrity");
  expect(mismatchCalls).toHaveLength(2);
});

test("an unavailable registry or malformed response cannot trigger publish", async () => {
  for (const registryReply of [
    { exitCode: 1, stdout: "", stderr: "npm error code ETIMEDOUT" },
    ok('"sha512-broken'),
  ]) {
    const calls: string[][] = [];
    await expect(publishOrReuse(options([packed, registryReply], calls))).rejects.toThrow();
    expect(calls).toHaveLength(2);
  }
});

test("a publish race can be recovered only by a matching registry integrity", async () => {
  const calls: string[][] = [];
  const failed = { exitCode: 1, stdout: "", stderr: "npm error code E403" };
  expect(
    await publishOrReuse(options([packed, absent(), failed, ok(JSON.stringify(integrity))], calls)),
  ).toBe("reused");
  expect(calls).toHaveLength(4);

  const missingCalls: string[][] = [];
  await expect(
    publishOrReuse(options([packed, absent(), failed, absent()], missingCalls)),
  ).rejects.toThrow("npm publish failed (E403)");
  expect(missingCalls).toHaveLength(4);
});
