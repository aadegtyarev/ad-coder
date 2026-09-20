// Regression for issue #483. `removeAbandonedLock` opens the lock by name and
// only then stats the handle it holds. A lock whose owner releases it
// (`unlink`) inside that window leaves us holding a descriptor to an inode
// with no links left: the measured stat is a regular file, owned by us, with
// `nlink` 0. Before the fix the guard read that as "a foreign file sits at the
// lock's name" and refused with AuthError `unsafe credential lock`, so an
// ordinary release became a denial of authentication.
//
// The interleaving is reproduced here by releasing the lock inside the very
// open that observes it -- the descriptor exists first, the unlink happens
// second, the caller's stat happens third, exactly as in the field. The two
// neighbouring refusals (a lock name carrying a second hard link, and a
// non-regular file at the lock name) are asserted to still refuse, so the
// change narrows the guard to the released case instead of loosening it.
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthError, FileCredentialStore } from "ad-coder";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function storePath(): { root: string; file: string; lock: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-lock-"));
  roots.push(root);
  const file = path.join(root, "private", "credentials.json");
  fs.mkdirSync(path.dirname(file), { mode: 0o700 });
  return { root, file, lock: `${file}.lock` };
}

const oauth = {
  type: "oauth" as const,
  access: "sentinel-access",
  refresh: "sentinel-refresh",
  expires: Date.now() + 60_000,
};

/** Seeds the lock of a holder that is provably gone: a pid that cannot exist
 * and an mtime of the epoch, so only the code under test decides what happens. */
function seedAbandonedLock(lock: string): void {
  fs.writeFileSync(lock, JSON.stringify({ pid: 2_147_483_647, createdAt: 0 }), { mode: 0o600 });
  const old = new Date(0);
  fs.utimesSync(lock, old, old);
}

/** Runs `body` with `fs.promises.open` intercepting the lock's read-only open:
 * the lock is unlinked right after that descriptor exists and before the
 * caller's `stat`, which is the release window from #483. Returns the inode
 * state of the held descriptor as of that moment. */
async function withLockReleasedMidOpen(
  lock: string,
  body: () => Promise<void>,
): Promise<{ nlink: number; isFile: boolean; uidMatches: boolean }[]> {
  const realOpen = fs.promises.open;
  const observed: { nlink: number; isFile: boolean; uidMatches: boolean }[] = [];
  const lockReadFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const lockName = path.basename(lock);
  fs.promises.open = (async (target: fs.PathLike, flags?: string | number, mode?: number) => {
    const handle = await realOpen(target, flags as never, mode);
    if (flags === lockReadFlags && path.basename(String(target)) === lockName) {
      // The owner's release, at the one instant that makes the held inode linkless.
      fs.unlinkSync(lock);
      const held = fs.fstatSync(handle.fd);
      observed.push({
        nlink: held.nlink,
        isFile: held.isFile(),
        uidMatches: held.uid === process.getuid?.(),
      });
    }
    return handle;
  }) as typeof fs.promises.open;
  try {
    await body();
  } finally {
    fs.promises.open = realOpen;
  }
  return observed;
}

test("a lock released between our open and our stat is recovery, not an unsafe lock", async () => {
  const { file, lock } = storePath();
  seedAbandonedLock(lock);
  const store = new FileCredentialStore({ path: file, staleLockMs: 0 });
  const observed = await withLockReleasedMidOpen(lock, async () => {
    await store.modify("openai-codex", async () => oauth);
  });
  // The interleaving really happened, and the link count is the only thing
  // that moved: the held inode is still a regular file, still ours, linkless.
  expect(observed).toEqual([{ nlink: 0, isFile: true, uidMatches: true }]);
  // A released lock is gone, so the caller retries and acquires a fresh one.
  expect(await store.read("openai-codex")).toEqual(oauth);
  expect(fs.existsSync(lock)).toBe(false);
});

test("a lock name carrying a second hard link still refuses as unsafe", async () => {
  const { root, file, lock } = storePath();
  const shared = path.join(root, "shared-lock");
  seedAbandonedLock(shared);
  fs.linkSync(shared, lock);
  const store = new FileCredentialStore({ path: file, staleLockMs: 0 });
  await expect(store.modify("openai-codex", async () => oauth)).rejects.toThrow(
    /unsafe credential lock/,
  );
  // The refusal is the link count, and both names are still there to prove it.
  expect(fs.statSync(lock).nlink).toBe(2);
  expect(fs.existsSync(shared)).toBe(true);
});

test("a non-regular file at the lock name still refuses as unsafe", async () => {
  const { file, lock } = storePath();
  fs.mkdirSync(lock, { mode: 0o700 });
  const store = new FileCredentialStore({ path: file, staleLockMs: 0 });
  let thrown: unknown;
  try {
    await store.modify("openai-codex", async () => oauth);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(AuthError);
  expect(String(thrown)).toContain("unsafe credential lock");
  // And nothing was published through a refused lock path.
  expect(fs.existsSync(file)).toBe(false);
});
