import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type PublishOptions, publishOrReuse } from "../scripts/publish-registry-package";
import type { RegistryCommandResult } from "../scripts/wait-registry-readiness";

const filename = "ad-coder-dev-0.181.24-dev.123.tgz";
const ok = (stdout: string): RegistryCommandResult => ({ exitCode: 0, stdout, stderr: "" });
const absent = (): RegistryCommandResult => ({
  exitCode: 1,
  stdout: "",
  stderr: "npm error code E404\n",
});
const metadata = { name: "ad-coder-dev", version: "0.181.24-dev.123" };
const packed = ok("");

function archiveBytes(
  manifest: unknown,
  marker = "one packed package, published unchanged",
): Buffer {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-test-pack-"));
  try {
    fs.mkdirSync(path.join(root, "package"));
    fs.writeFileSync(path.join(root, "package", "package.json"), `${JSON.stringify(manifest)}\n`);
    fs.writeFileSync(path.join(root, "package", "README.md"), marker);
    const archive = path.join(root, "fixture.tgz");
    execFileSync("tar", ["-czf", archive, "-C", root, "package"]);
    return fs.readFileSync(archive);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const packageBytes = archiveBytes(metadata);
const integrity = `sha512-${createHash("sha512").update(packageBytes).digest("base64")}`;

function options(
  replies: RegistryCommandResult[],
  calls: string[][],
  contents: Buffer = packageBytes,
  artifacts: string[] = [filename],
): PublishOptions {
  return {
    packageName: "ad-coder-dev",
    version: "0.181.24-dev.123",
    tag: "latest",
    run: async (argv) => {
      calls.push(argv);
      if (argv[1] === "pack" && replies[0]?.exitCode === 0) {
        const destination = argv[4];
        if (!destination) throw new Error("pack destination missing");
        for (const artifact of artifacts)
          fs.writeFileSync(path.join(destination, artifact), contents);
      }
      if (argv[1] === "publish") {
        const tarball = argv[2];
        if (!tarball) throw new Error("publish tarball missing");
        expect(fs.readFileSync(tarball).toString("hex")).toBe(contents.toString("hex"));
      }
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
  const destination = calls[0]?.[4];
  if (!destination) throw new Error("pack destination missing");
  expect(calls).toEqual([
    ["npm", "pack", "--silent", "--pack-destination", destination],
    ["npm", "view", "ad-coder-dev@0.181.24-dev.123", "dist.integrity", "--json", "--prefer-online"],
    ["npm", "publish", path.join(destination, filename), "--tag", "latest"],
  ]);
  expect(fs.existsSync(destination)).toBe(false);
});

test("empty, malformed, and misleading npm pack output cannot redirect or block publication", async () => {
  for (const output of [
    "",
    "not json",
    JSON.stringify([{ ...metadata, filename: "../escape.tgz", integrity: "sha512-false" }]),
    JSON.stringify([{ ...metadata, name: "other-package", version: "other-version" }]),
  ]) {
    const calls: string[][] = [];
    expect(await publishOrReuse(options([ok(output), absent(), ok("published")], calls))).toBe(
      "published",
    );
    expect(calls[2]?.[2]).toBe(path.join(calls[0]?.[4] ?? "", filename));
  }
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

test("registry integrity is checked against tarball bytes, regardless of pack output", async () => {
  const calls: string[][] = [];
  const misleading = ok(JSON.stringify([{ ...metadata, integrity: "sha512-not-the-tarball" }]));
  expect(await publishOrReuse(options([misleading, ok(JSON.stringify(integrity))], calls))).toBe(
    "reused",
  );
  expect(calls).toHaveLength(2);

  const changedCalls: string[][] = [];
  await expect(
    publishOrReuse(
      options(
        [packed, ok(JSON.stringify(integrity))],
        changedCalls,
        archiveBytes(metadata, "different bytes"),
      ),
    ),
  ).rejects.toThrow("different tarball integrity");
  expect(changedCalls).toHaveLength(2);
});

test("wrong or unreadable archive manifest cannot trigger publication", async () => {
  for (const contents of [
    archiveBytes({ ...metadata, name: "other-package" }),
    archiveBytes({ ...metadata, version: "other-version" }),
    archiveBytes({ name: metadata.name }),
    Buffer.from("not a tarball"),
  ]) {
    const calls: string[][] = [];
    await expect(publishOrReuse(options([packed], calls, contents))).rejects.toThrow();
    expect(calls).toHaveLength(1);
  }
});

test("a missing, ambiguous, or unsafe packed archive cannot trigger publication", async () => {
  for (const artifacts of [
    [],
    [filename, "second.tgz"],
    [filename, "unexpected.txt"],
    [".hidden.tgz"],
  ]) {
    const calls: string[][] = [];
    await expect(publishOrReuse(options([packed], calls, packageBytes, artifacts))).rejects.toThrow(
      "exactly one safe tarball",
    );
    expect(calls).toHaveLength(1);
  }
});

test("a symlinked tarball cannot trigger publication", async () => {
  const calls: string[][] = [];
  const testOptions = options([packed], calls);
  const originalRun = testOptions.run;
  testOptions.run = async (argv) => {
    const result = await originalRun(argv);
    if (argv[1] === "pack") {
      const destination = argv[4];
      if (!destination) throw new Error("pack destination missing");
      const tarball = path.join(destination, filename);
      fs.unlinkSync(tarball);
      fs.symlinkSync("outside.tgz", tarball);
    }
    return result;
  };
  await expect(publishOrReuse(testOptions)).rejects.toThrow("exactly one safe tarball");
  expect(calls).toHaveLength(1);
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

  const mismatchedCalls: string[][] = [];
  await expect(
    publishOrReuse(
      options([packed, absent(), failed, ok('"sha512-other-package"')], mismatchedCalls),
    ),
  ).rejects.toThrow("different tarball integrity");
  expect(mismatchedCalls).toHaveLength(4);
});
