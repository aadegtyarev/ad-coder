import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { BacklogFollowUp, GitHubCommandRequest } from "../src";
import {
  aggregateFollowUps,
  createBacklogStore,
  FileBacklogStore,
  GitHubBacklogStore,
  ProjectOperationsError,
  ProjectStore,
  probeGitHubBacklogCapability,
  routeDocumentationFollowUp,
  suggestBacklogMigrationOnce,
  validateFollowUp,
} from "../src";

function root(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-operations-"));
}
function candidate(overrides: Partial<BacklogFollowUp> = {}): BacklogFollowUp {
  return {
    kind: "backlog",
    title: "Repair claim handling",
    evidence: [{ summary: "Claim race observed", path: "src/work.ts", line: 4 }],
    provenance: [{ producer: "reviewer", runId: "run-1", branch: "feature/ops" }],
    priority: "high",
    ...overrides,
  };
}
const holder = { owner: "alice", runId: "run-1", branch: "feature/ops" };

test("FollowUp validates all variants, rejects unsafe content, and honors zero-disabled limits", () => {
  const base = {
    title: "Keep policy explicit",
    evidence: [{ summary: "Observed mismatch", path: "src/a.ts" }],
    provenance: [{ producer: "coder", runId: "r1" }],
  };
  expect(validateFollowUp({ ...base, kind: "contract", contract: "security" }).kind).toBe(
    "contract",
  );
  expect(validateFollowUp({ ...base, kind: "note" }).kind).toBe("note");
  expect(
    validateFollowUp({ ...base, kind: "design-doc-drift", document: "docs/ARCHITECTURE.md" }).kind,
  ).toBe("design-doc-drift");
  expect(validateFollowUp({ ...base, kind: "backlog", priority: "low" }).kind).toBe("backlog");
  expect(() => validateFollowUp({ ...base, kind: "note", extra: true })).toThrow(
    ProjectOperationsError,
  );
  expect(() =>
    validateFollowUp({
      ...base,
      kind: "note",
      evidence: [{ summary: "token=ghp_abcdefghijklmnopqrstuvwxyz" }],
    }),
  ).toThrow(ProjectOperationsError);
  expect(() => validateFollowUp({ ...base, kind: "note" }, { evidenceLimit: 1 })).toThrow(
    ProjectOperationsError,
  );
  expect(validateFollowUp({ ...base, kind: "note" }, { evidenceLimit: 0 }).kind).toBe("note");
});

test("aggregation deduplicates semantic candidates and deterministically merges provenance", () => {
  const first = candidate();
  const second = candidate({ provenance: [{ producer: "security", runId: "run-2" }] });
  const result = aggregateFollowUps([second, first, candidate({ title: "Another item" })]);
  expect(result).toHaveLength(2);
  expect(result[1]?.provenance.map((entry) => entry.producer)).toEqual(["reviewer", "security"]);
  expect(() =>
    aggregateFollowUps([first, candidate({ title: "Another item" })], { aggregationLimit: 1 }),
  ).toThrow(ProjectOperationsError);
});

test("documentation routing returns fixed proposals and rejects escape and symlink destinations", () => {
  const target = root();
  fs.mkdirSync(path.join(target, "docs"));
  fs.writeFileSync(path.join(target, "docs", "NOTES.md"), "# Notes\n");
  const { priority: _priority, ...base } = candidate();
  const note = { ...base, kind: "note" as const };
  const proposal = routeDocumentationFollowUp(target, note);
  expect(proposal.destination).toBe(path.join(target, "docs", "NOTES.md"));
  expect(proposal.content).toContain("provenance: reviewer run=run-1 branch=feature/ops");
  expect(fs.readFileSync(proposal.destination, "utf8")).toBe("# Notes\n");
  expect(() =>
    routeDocumentationFollowUp(target, {
      ...note,
      kind: "design-doc-drift",
      document: "../outside.md",
    }),
  ).toThrow(ProjectOperationsError);
  fs.symlinkSync(os.tmpdir(), path.join(target, "linked"));
  expect(() =>
    routeDocumentationFollowUp(target, {
      ...note,
      kind: "design-doc-drift",
      document: "linked/a.md",
    }),
  ).toThrow(ProjectOperationsError);
});

test("file backlog enforces lifecycle, holder identity, lease recovery, persistence and CAS", () => {
  const target = root();
  let clock = 100;
  const project = new ProjectStore(target);
  const backlog = new FileBacklogStore(project, { claimLeaseMs: 10 }, () => clock);
  expect(backlog.create(candidate(), "work-1").value.status).toBe("queued");
  expect(backlog.claim("work-1", holder).value.status).toBe("claimed");
  expect(() => backlog.claim("work-1", { ...holder, owner: "bob" })).toThrow(
    ProjectOperationsError,
  );
  expect(() => backlog.transition("work-1", "done", holder)).toThrow(ProjectOperationsError);
  expect(backlog.transition("work-1", "in_progress", holder).value.status).toBe("in_progress");
  expect(backlog.transition("work-1", "review", holder).value.status).toBe("review");
  expect(backlog.transition("work-1", "done", holder).value.claim).toBeUndefined();
  backlog.create(candidate({ title: "Blocked item" }), "work-blocked");
  backlog.claim("work-blocked", holder);
  expect(backlog.transition("work-blocked", "blocked", holder).value.status).toBe("blocked");
  expect(backlog.transition("work-blocked", "queued", holder).value.status).toBe("queued");
  backlog.create(candidate({ title: "Lease item" }), "work-2");
  backlog.claim("work-2", holder);
  clock = 111;
  expect(() => backlog.renew("work-2", holder)).toThrow(ProjectOperationsError);
  expect(() => backlog.transition("work-2", "in_progress", holder)).toThrow(ProjectOperationsError);
  expect(backlog.claim("work-2", { ...holder, owner: "bob" }).value.claim?.owner).toBe("bob");
  expect(new FileBacklogStore(new ProjectStore(target)).list()).toHaveLength(3);
});

test("backlog persistence never stores arbitrary candidate prose", () => {
  const target = root();
  const sentinel = "novel-credential-format-Z9y8x7w6";
  const backlog = new FileBacklogStore(new ProjectStore(target));
  const created = backlog.create(
    candidate({ title: sentinel, evidence: [{ summary: sentinel, path: "src/work.ts" }] }),
    "safe-projection",
  );
  expect(JSON.stringify(created)).not.toContain(sentinel);
  expect(JSON.stringify(backlog.get("safe-projection"))).not.toContain(sentinel);
});

test("GitHub probe is read-only, selection is explicit, and migration suggestion is once-only", () => {
  const calls: GitHubCommandRequest[] = [];
  const executor = {
    execute(request: GitHubCommandRequest) {
      calls.push(request);
      const stdout = request.argv.includes("label")
        ? '[{"name":"ad-coder:queued"}]'
        : request.argv.includes("issue")
          ? "[]"
          : "{}";
      return { exitCode: 0, stdout };
    },
  };
  const capability = probeGitHubBacklogCapability(executor, "owner/repo");
  expect(capability.available).toBe(true);
  expect(
    calls.every(
      (call) => !call.argv.some((arg) => ["create", "edit", "close", "--method"].includes(arg)),
    ),
  ).toBe(true);
  const target = root();
  const store = new ProjectStore(target);
  expect(createBacklogStore(store)).toBeInstanceOf(FileBacklogStore);
  const githubConfigured = new ProjectStore(root(), {
    projectOperations: {
      backlogBackend: "github",
      github: { repository: "owner/repo" },
    },
  });
  expect(createBacklogStore(githubConfigured, undefined, executor)).toBeInstanceOf(
    GitHubBacklogStore,
  );
  expect(calls).toHaveLength(4);
  expect(suggestBacklogMigrationOnce(store, 2, capability)).toEqual({
    from: "files",
    to: "github",
    itemCount: 2,
  });
  expect(suggestBacklogMigrationOnce(new ProjectStore(target), 2, capability)).toBeUndefined();
});

test("GitHub backlog keeps candidate text out of argv and rejects a competing shared-store claim", () => {
  const target = root();
  const project = new ProjectStore(target);
  const requests: GitHubCommandRequest[] = [];
  let issue!: { number: number; title: string; body: string; labels: Array<{ name: string }> };
  let competitor: GitHubBacklogStore | undefined;
  let conflict: unknown;
  let raceOnPatch = false;
  const active = new Set<string>();
  const coordinator = {
    runExclusive<T>(repository: string, itemId: string, action: () => T): T {
      const key = `${repository}:${itemId}`;
      if (active.has(key)) throw new ProjectOperationsError("claim_conflict", itemId);
      active.add(key);
      try {
        return action();
      } finally {
        active.delete(key);
      }
    },
  };
  const executor = {
    execute(request: GitHubCommandRequest) {
      requests.push(request);
      const endpoint = request.argv.find((arg) => arg.startsWith("repos/")) ?? "";
      if (request.argv.includes("POST")) {
        const input = JSON.parse(request.stdin ?? "") as {
          title: string;
          body: string;
          labels: string[];
        };
        issue = {
          number: 1,
          title: input.title,
          body: input.body,
          labels: input.labels.map((name) => ({ name })),
        };
      } else if (request.argv.includes("PATCH")) {
        if (raceOnPatch && competitor !== undefined) {
          raceOnPatch = false;
          try {
            competitor.claim("1", { ...holder, owner: "bob" });
          } catch (error) {
            conflict = error;
          }
        }
        const input = JSON.parse(request.stdin ?? "") as { body: string; labels: string[] };
        issue.body = input.body;
        issue.labels = input.labels.map((name) => ({ name }));
      } else if (endpoint.includes("issues?")) {
        return { exitCode: 0, stdout: JSON.stringify(issue === undefined ? [] : [issue]) };
      }
      return { exitCode: 0, stdout: JSON.stringify(issue) };
    },
  };
  const config = {
    backlogBackend: "github" as const,
    claimLeaseMs: 100,
    github: { repository: "owner/repo" },
  };
  let clock = 10;
  const backlog = new GitHubBacklogStore(project, executor, config, () => clock, coordinator);
  competitor = new GitHubBacklogStore(
    new ProjectStore(target),
    executor,
    config,
    () => clock,
    coordinator,
  );
  const sentinel = "novel-credential-format-Z9y8x7w6";
  expect(
    backlog.create(candidate({ title: sentinel, evidence: [{ summary: sentinel }] })).value
      .candidate.title,
  ).toBe("Redacted backlog candidate");
  raceOnPatch = true;
  expect(backlog.claim("1", holder).value.status).toBe("claimed");
  expect(conflict).toBeInstanceOf(ProjectOperationsError);
  expect(backlog.transition("1", "in_progress", holder).value.status).toBe("in_progress");
  expect(backlog.transition("1", "blocked", holder).value.status).toBe("blocked");
  expect(backlog.transition("1", "queued", holder).value.status).toBe("queued");
  expect(backlog.claim("1", holder).value.status).toBe("claimed");
  expect(backlog.transition("1", "in_progress", holder).value.status).toBe("in_progress");
  expect(backlog.transition("1", "review", holder).value.status).toBe("review");
  expect(backlog.transition("1", "done", holder).value.status).toBe("done");
  clock = 111;
  expect(() => backlog.renew("1", holder)).toThrow(ProjectOperationsError);
  expect(() => backlog.transition("1", "in_progress", holder)).toThrow(ProjectOperationsError);
  expect(requests.every((request) => !request.argv.includes(sentinel))).toBe(true);
  expect(
    requests
      .filter((request) => request.stdin !== undefined)
      .every((request) => !request.stdin?.includes(sentinel)),
  ).toBe(true);
});

test("GitHub mutations fail loudly without a shared coordination domain", () => {
  const target = root();
  const issue = {
    number: 1,
    title: "managed",
    body: JSON.stringify({
      schema: 1,
      revision: 1,
      candidate: candidate(),
      createdAt: 1,
      updatedAt: 1,
    }),
    labels: [{ name: "ad-coder:queued" }],
  };
  const executor = { execute: () => ({ exitCode: 0, stdout: JSON.stringify(issue) }) };
  const backlog = new GitHubBacklogStore(new ProjectStore(target), executor, {
    backlogBackend: "github",
    github: { repository: "owner/repo" },
  });
  expect(() => backlog.claim("1", holder)).toThrow(ProjectOperationsError);
});
