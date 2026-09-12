import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  BacklogFollowUp,
  FollowUp,
  GitHubCommandRequest,
  Verdict,
  WorkflowSession,
  WorkflowState,
} from "../src";
import {
  aggregateFollowUps,
  appendDocumentationProposal,
  createBacklogStore,
  FileBacklogStore,
  GitHubBacklogStore,
  ProjectOperationsError,
  ProjectStore,
  probeGitHubBacklogCapability,
  RunCoordinator,
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
  const base: Pick<FollowUp, "title" | "evidence" | "provenance"> = {
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

function coordinatorState(): WorkflowState {
  return {
    phase: "code",
    round: 1,
    planSummary: "",
    contractRequirements: [],
    changeSummary: "",
    securityNotes: "",
    preComplexity: "medium",
    effective: "medium",
    verdicts: [],
    runIds: [],
    done: false,
    approved: false,
  };
}

function coordinatorSession(store: ProjectStore, followUps: FollowUp[]): WorkflowSession {
  return {
    projectStore: store,
    initialState: coordinatorState,
    async step(state) {
      return {
        state: { ...state, runIds: [...state.runIds, "code-run"] },
        result: { phase: "code", runId: "code-run", text: "done", followUps },
        transitions: [{ kind: "stop", isDefault: true, toPhase: "done", toRound: state.round }],
      };
    },
    async reviewCurrent(state) {
      const verdict: Verdict = {
        status: "approved",
        issues: [],
        summary: "accepted rule holds",
      };
      return {
        state: {
          ...state,
          verdicts: [...state.verdicts, verdict],
          runIds: [...state.runIds, "contract-review"],
        },
        result: {
          phase: "review",
          runId: "contract-review",
          text: "approved",
          verdict,
          followUps: [],
        },
        transitions: [{ kind: "stop", isDefault: true, toPhase: "done", toRound: state.round }],
      };
    },
  };
}

test("RunCoordinator checkpoints aggregation and makes automatic closeout effects idempotent", async () => {
  const target = root();
  fs.mkdirSync(path.join(target, "docs"));
  fs.writeFileSync(path.join(target, "docs", "NOTES.md"), "# Notes\n");
  const store = new ProjectStore(target);
  const first = candidate({ provenance: [{ producer: "coder", runId: "round-1" }] });
  const second = candidate({ provenance: [{ producer: "reviewer", runId: "round-1" }] });
  const coordinator = new RunCoordinator(coordinatorSession(store, [first, second]), store, {
    runId: "coordinator-test",
    decisionLimit: 0,
    checkpointByteLimit: 0,
  });
  const result = await coordinator.run();
  expect(result.status).toBe("complete");
  expect(result.checkpoint.followUps).toHaveLength(1);
  expect(result.checkpoint.followUps[0]?.provenance).toHaveLength(2);
  expect(new FileBacklogStore(store).list()).toHaveLength(1);

  const resumed = new RunCoordinator(coordinatorSession(store, []), new ProjectStore(target), {
    runId: "coordinator-test",
  });
  expect((await resumed.run()).checkpoint).toEqual(result.checkpoint);
  expect(new FileBacklogStore(store).list()).toHaveLength(1);
});

test("contract decisions persist, require operator authority, and re-review the current change", async () => {
  const target = root();
  fs.mkdirSync(path.join(target, "docs", "contracts"), { recursive: true });
  const store = new ProjectStore(target);
  const followUp: FollowUp = {
    kind: "contract",
    contract: "quality",
    title: "Make the gate explicit",
    evidence: [{ summary: "Rule was implicit", path: "docs/ROADMAP.md", line: 1 }],
    provenance: [{ producer: "reviewer", runId: "review-1" }],
  };
  const coordinator = new RunCoordinator(coordinatorSession(store, [followUp]), store, {
    runId: "contract-test",
  });
  const blocked = await coordinator.run();
  expect(blocked.status).toBe("awaiting_decision");
  const decision = blocked.checkpoint.decisions[0];
  expect(decision?.status).toBe("pending");
  await expect(
    coordinator.resolveDecision(decision?.id ?? "missing", {
      source: "model" as "operator",
      action: "accept",
      contractText: "Every change passes the project gate.",
    }),
  ).rejects.toMatchObject({ code: "unauthorized_resolution" });
  await coordinator.resolveDecision(decision?.id ?? "missing", {
    source: "operator",
    action: "accept",
    contractText: "Every change passes the project gate.",
  });
  const completed = await coordinator.run();
  expect(completed.result?.approved).toBe(true);
  expect(completed.result?.contractRequirements).toContain("Every change passes the project gate.");
  expect(fs.readFileSync(path.join(target, "docs", "contracts", "quality.md"), "utf8")).toContain(
    "- Every change passes the project gate.",
  );
  expect(completed.checkpoint.contractReviews[0]?.status).toBe("approved");
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

test("documentation append rejects a destination swap and recovers an interrupted lock", () => {
  const target = root();
  fs.mkdirSync(path.join(target, "docs"));
  const notes = path.join(target, "docs", "NOTES.md");
  fs.writeFileSync(notes, "# Notes\n");
  const { priority: _priority, ...base } = candidate();
  const proposal = routeDocumentationFollowUp(target, { ...base, kind: "note" });

  fs.unlinkSync(notes);
  fs.symlinkSync(path.join(target, "outside.md"), notes);
  expect(() => appendDocumentationProposal(proposal, "swapped")).toThrow(ProjectOperationsError);
  expect(fs.existsSync(path.join(target, "outside.md"))).toBe(false);

  fs.unlinkSync(notes);
  fs.writeFileSync(notes, "# Notes\n");
  fs.writeFileSync(`${notes}.ad-coder-lock`, `${JSON.stringify({ pid: 2_147_483_647 })}\n`);
  expect(appendDocumentationProposal(proposal, "resumed")).toBe(true);
  expect(appendDocumentationProposal(proposal, "resumed")).toBe(false);
  expect(fs.readFileSync(notes, "utf8").match(/ad-coder:resumed/g)).toHaveLength(1);
});

test("coordinator resumes pending steps without rerunning models and rejects stale writers", async () => {
  const target = root();
  const store = new ProjectStore(target);
  let turns = 0;
  const session = coordinatorSession(store, []);
  const counted: WorkflowSession = {
    ...session,
    async step(state) {
      turns++;
      return session.step(state);
    },
  };
  const first = new RunCoordinator(counted, store, { runId: "resume-boundary" });
  const stale = new RunCoordinator(counted, new ProjectStore(target), {
    runId: "resume-boundary",
  });
  const pending = await first.prepareStep();
  expect(turns).toBe(1);
  const resumed = new RunCoordinator(counted, new ProjectStore(target), {
    runId: "resume-boundary",
  });
  expect((await resumed.prepareStep())?.result.runId).toBe(pending?.result.runId);
  expect(turns).toBe(1);
  expect(() => resumed.commitTransition(pending?.transitions[0] as never)).not.toThrow();
  expect((await resumed.run()).status).toBe("complete");
  await expect(stale.prepareStep()).rejects.toMatchObject({ code: "checkpoint_conflict" });
});

test("coordinator limits are zero-disabled and positive values fail loudly", async () => {
  const unlimitedTarget = root();
  const unlimitedStore = new ProjectStore(unlimitedTarget);
  const contracts: FollowUp[] = ["quality", "security"].map((contract, index) => ({
    kind: "contract",
    contract,
    title: `Contract ${index}`,
    evidence: [{ summary: "Rule needs operator input" }],
    provenance: [{ producer: "reviewer", runId: `review-${index}` }],
  }));
  const unlimited = new RunCoordinator(
    coordinatorSession(unlimitedStore, contracts),
    unlimitedStore,
    {
      runId: "unlimited",
      decisionLimit: 0,
      checkpointByteLimit: 0,
    },
  );
  expect((await unlimited.run()).checkpoint.decisions).toHaveLength(2);

  const limitedTarget = root();
  const limitedStore = new ProjectStore(limitedTarget);
  const limited = new RunCoordinator(coordinatorSession(limitedStore, contracts), limitedStore, {
    runId: "limited",
    decisionLimit: 1,
  });
  await expect(limited.run()).rejects.toMatchObject({ code: "resource_limit" });

  const bytesTarget = root();
  const bytesStore = new ProjectStore(bytesTarget);
  const bytes = new RunCoordinator(coordinatorSession(bytesStore, []), bytesStore, {
    runId: "byte-limited",
    checkpointByteLimit: 1,
  });
  await expect(bytes.run()).rejects.toMatchObject({ code: "resource_limit" });
});

test("rejected and deferred decisions remain auditable and do not mutate documents", async () => {
  const target = root();
  fs.mkdirSync(path.join(target, "docs", "contracts"), { recursive: true });
  const store = new ProjectStore(target);
  const followUps: FollowUp[] = ["quality", "security"].map((contract, index) => ({
    kind: "contract",
    contract,
    title: `Decision ${index}`,
    evidence: [{ summary: "Operator choice required" }],
    provenance: [{ producer: "reviewer", runId: `review-${index}` }],
  }));
  const coordinator = new RunCoordinator(coordinatorSession(store, followUps), store, {
    runId: "decision-outcomes",
  });
  const blocked = await coordinator.run();
  const [rejected, deferred] = blocked.checkpoint.decisions;
  await coordinator.resolveDecision(rejected?.id ?? "missing", {
    source: "operator",
    action: "reject",
  });
  await coordinator.resolveDecision(deferred?.id ?? "missing", {
    source: "operator",
    action: "defer",
  });
  const completed = await coordinator.run();
  expect(completed.checkpoint.decisions.map((decision) => decision.status).sort()).toEqual([
    "deferred",
    "rejected",
  ]);
  expect(fs.readdirSync(path.join(target, "docs", "contracts"))).toEqual([]);
});

test("a failed contract re-review cannot close approved", async () => {
  const target = root();
  fs.mkdirSync(path.join(target, "docs", "contracts"), { recursive: true });
  const store = new ProjectStore(target);
  const followUp: FollowUp = {
    kind: "contract",
    contract: "quality",
    title: "Require a correction",
    evidence: [{ summary: "Current implementation conflicts" }],
    provenance: [{ producer: "reviewer", runId: "review-failed" }],
  };
  const base = coordinatorSession(store, [followUp]);
  const session: WorkflowSession = {
    ...base,
    async reviewCurrent(state) {
      const verdict: Verdict = {
        status: "changes_requested",
        issues: [{ severity: "major", what: "Rule is not satisfied" }],
        summary: "correction required",
      };
      return {
        state: { ...state, verdicts: [...state.verdicts, verdict] },
        result: { phase: "review", runId: "failed-review", text: "failed", verdict },
        transitions: [],
      };
    },
  };
  const coordinator = new RunCoordinator(session, store, { runId: "failed-contract-review" });
  const blocked = await coordinator.run();
  await expect(
    coordinator.resolveDecision(blocked.checkpoint.decisions[0]?.id ?? "missing", {
      source: "operator",
      action: "accept",
      contractText: "Every change satisfies the accepted rule.",
    }),
  ).rejects.toMatchObject({ code: "unresolved_review" });
  expect(coordinator.checkpoint.closeout).toBeUndefined();
  expect(coordinator.checkpoint.contractReviews[0]?.status).toBe("changes_requested");
});

test("note and explicit design drift effects append once across reconstruction", async () => {
  const target = root();
  fs.mkdirSync(path.join(target, "docs"));
  const notes = path.join(target, "docs", "NOTES.md");
  const architecture = path.join(target, "docs", "ARCHITECTURE.md");
  fs.writeFileSync(notes, "# Notes\n");
  fs.writeFileSync(architecture, "# Architecture\n");
  const store = new ProjectStore(target);
  const base = {
    title: "Record deterministic evidence",
    evidence: [{ summary: "Observed behavior", path: "src/a.ts", line: 1 }],
    provenance: [{ producer: "reviewer", runId: "review-docs" }],
  };
  const followUps: FollowUp[] = [
    { ...base, kind: "note" },
    { ...base, kind: "design-doc-drift", document: "docs/ARCHITECTURE.md" },
  ];
  const coordinator = new RunCoordinator(coordinatorSession(store, followUps), store, {
    runId: "documentation-effects",
  });
  const completed = await coordinator.run();
  expect(completed.status).toBe("complete");
  const before = [fs.readFileSync(notes, "utf8"), fs.readFileSync(architecture, "utf8")];

  const resumed = new RunCoordinator(
    coordinatorSession(store, followUps),
    new ProjectStore(target),
    {
      runId: "documentation-effects",
    },
  );
  expect((await resumed.run()).checkpoint.closeout).toEqual(completed.checkpoint.closeout);
  expect([fs.readFileSync(notes, "utf8"), fs.readFileSync(architecture, "utf8")]).toEqual(before);
  expect(before[0]?.match(/<!-- ad-coder:/g)).toHaveLength(1);
  expect(before[1]?.match(/<!-- ad-coder:/g)).toHaveLength(1);
});

test("ambiguous product-document decisions survive reconstruction without mutation", async () => {
  const target = root();
  fs.mkdirSync(path.join(target, "docs"));
  const store = new ProjectStore(target);
  const followUp: FollowUp = {
    kind: "design-doc-drift",
    document: "docs/MISSING.md",
    title: "Choose a product document",
    evidence: [{ summary: "No explicit existing destination" }],
    provenance: [{ producer: "planner", runId: "plan-product" }],
  };
  const coordinator = new RunCoordinator(coordinatorSession(store, [followUp]), store, {
    runId: "product-decision",
  });
  const blocked = await coordinator.run();
  expect(blocked.status).toBe("awaiting_decision");
  expect(blocked.checkpoint.decisions[0]).toMatchObject({ kind: "product", status: "pending" });
  expect(fs.existsSync(path.join(target, "docs", "MISSING.md"))).toBe(false);

  const resumed = new RunCoordinator(coordinatorSession(store, []), new ProjectStore(target), {
    runId: "product-decision",
  });
  const stillBlocked = await resumed.run();
  expect(stillBlocked.checkpoint.decisions).toEqual(blocked.checkpoint.decisions);
  expect(fs.existsSync(path.join(target, "docs", "MISSING.md"))).toBe(false);
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
