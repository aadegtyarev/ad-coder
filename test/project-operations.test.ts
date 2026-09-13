import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type {
  BacklogFollowUp,
  FollowUp,
  GitHubCommandRequest,
  PublishingCommandRequest,
  Verdict,
  WorkflowSession,
  WorkflowState,
} from "../src";
import {
  aggregateFollowUps,
  appendDocumentationProposal,
  buildPublishingPrBody,
  createBacklogStore,
  DEFAULT_REPOSITORY_PUBLISHING_CONFIG,
  detectLdoProject,
  FileBacklogStore,
  finishRepositoryPublishing,
  GitHubBacklogStore,
  importLdoArtifacts,
  inspectImportedLdoWork,
  ProjectOperationsError,
  ProjectStore,
  preflightRepositoryPublishing,
  previewLdoImport,
  probeGitHubBacklogCapability,
  RunCoordinator,
  resolveRepositoryPublishingConfig,
  resumeImportedLdoWork,
  routeDocumentationFollowUp,
  StageLimitError,
  startRepositoryPublishing,
  suggestBacklogMigrationOnce,
  validateFollowUp,
} from "../src";
import { SUBMIT_VERDICT_TOOL_NAME } from "../src/orchestration/verdict";
import { defineRole } from "../src/role";

function ldoPlan(id: string): Record<string, unknown> {
  return {
    version: 1,
    id,
    root: "/historical/project",
    baseHead: "abc123",
    createdAt: "2026-09-12T00:00:00.000Z",
    task: "Implement safe import",
    plan: {
      complexity: "medium",
      security_surface: "low",
      summary: "A saved plan",
      steps: [{ what: "code", files: ["src/a.ts"], acceptance: "passes", user_facing: true }],
      risks: [],
      codebase_context: {
        stack: "TypeScript",
        conventions: "strict",
        relevant_files: [],
        test_command: "bun test",
        test_command_scoped: null,
        run_command: "bun test",
      },
    },
    security: null,
    usage: [],
  };
}

function ldoCoder(summary = "coded"): Record<string, unknown> {
  return {
    summary,
    files_changed: ["src/a.ts"],
    tests: { result: "passed", command: "bun test" },
    docs_updated: [],
    deviations: [],
  };
}

function ldoReview(status: "approved" | "changes_requested"): Record<string, unknown> {
  return {
    status,
    summary: status,
    issues:
      status === "approved"
        ? []
        : [{ file: "src/a.ts", severity: "major", what: "fix it", suggestion: "correct it" }],
    verification: { verdict: "verified", criteria: [], blockers: [] },
    attacks: [],
  };
}

function ldoRun(
  id: string,
  completed: Record<string, unknown>,
  status: "running" | "completed" = "running",
): Record<string, unknown> {
  const plan = ldoPlan(id);
  return {
    version: 1,
    id,
    root: plan.root,
    baseHead: plan.baseHead,
    task: plan.task,
    plan: plan.plan,
    security: null,
    status,
    startedAt: "2026-09-12T00:00:00.000Z",
    usage: [],
    completed,
    tokenUsage: {
      status: "unavailable",
      input_tokens: null,
      cache_creation_input_tokens: null,
      cached_input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      stages: [],
    },
    ...(status === "completed"
      ? {
          completedAt: "2026-09-12T00:01:00.000Z",
          approved: true,
          backlog: { destination: "none", file: null, count: 0 },
        }
      : {}),
  };
}

test("LDO detection and preview are non-mutating; import is durable and idempotent", () => {
  const target = root();
  fs.mkdirSync(path.join(target, ".codex", "ldo", "plans"), { recursive: true });
  fs.mkdirSync(path.join(target, "docs", "contracts"), { recursive: true });
  fs.writeFileSync(path.join(target, "docs", "NOTES.md"), "notes\n");
  const source = path.join(target, ".codex", "ldo", "plans", "saved-plan.json");
  fs.writeFileSync(source, `${JSON.stringify(ldoPlan("saved-plan"), null, 2)}\n`);
  const original = fs.readFileSync(source);

  const detection = detectLdoProject(target);
  expect(detection.detected).toBe(true);
  expect(detection.documentation.notes).toBe("docs/NOTES.md");
  expect(previewLdoImport(target).items[0]?.status).toBe("importable");
  expect(fs.existsSync(path.join(target, ".ad-coder"))).toBe(false);

  const store = new ProjectStore(target);
  const first = importLdoArtifacts(store, {
    trustDigests: [previewLdoImport(store).items[0]!.sha256!],
  });
  expect(first.imported).toHaveLength(1);
  const identity = first.imported[0]!.identity;
  const persistedRecord = store.readVersionedJson<{ sourceBytesBase64: string }>(
    path.join(store.layout.root, first.imported[0]!.recordPath),
  ).value;
  expect(Buffer.from(persistedRecord.sourceBytesBase64, "base64")).toEqual(original);
  expect(inspectImportedLdoWork(store, identity).trustedForResume).toBe(true);
  const beforeManifest = fs.readFileSync(path.join(store.layout.runs, "ldo-import-manifest.json"));
  expect(importLdoArtifacts(new ProjectStore(target)).skipped).toHaveLength(1);
  expect(fs.readFileSync(path.join(store.layout.runs, "ldo-import-manifest.json"))).toEqual(
    beforeManifest,
  );
  expect(fs.readFileSync(source)).toEqual(original);
});

test("LDO detection honors configured existing locations and rejects unsafe layout candidates", () => {
  const target = root();
  fs.mkdirSync(path.join(target, "existing", "plans"), { recursive: true });
  fs.mkdirSync(path.join(target, "project-docs"), { recursive: true });
  fs.writeFileSync(path.join(target, "project-docs", "operator.md"), "notes\n");
  const detected = detectLdoProject(target, {
    ldo: { root: "existing", plans: "existing/plans", runs: "existing/runs" },
    documentation: { root: "project-docs", notes: "project-docs/operator.md" },
  });
  expect(detected).toMatchObject({ plans: "existing/plans", runs: null });
  expect(detected.documentation).toMatchObject({
    root: "project-docs",
    notes: "project-docs/operator.md",
    backlog: null,
  });
  expect(() => detectLdoProject(target, { ldo: { root: "../outside" } })).toThrow(
    ProjectOperationsError,
  );
  fs.symlinkSync(os.tmpdir(), path.join(target, "linked-docs"));
  expect(() => detectLdoProject(target, { documentation: { root: "linked-docs" } })).toThrow(
    ProjectOperationsError,
  );
});

test("LDO preview reports malformed records and import rejects before persistence", () => {
  const target = root();
  fs.mkdirSync(path.join(target, ".codex", "ldo", "plans"), { recursive: true });
  fs.writeFileSync(path.join(target, ".codex", "ldo", "plans", "bad.json"), "{secret payload");
  const preview = previewLdoImport(target);
  expect(preview.items[0]?.status).toBe("rejected");
  const store = new ProjectStore(target);
  expect(() => importLdoArtifacts(store)).toThrow(ProjectOperationsError);
  expect(fs.existsSync(path.join(store.layout.runs, "ldo-import-manifest.json"))).toBe(false);
});

test("LDO import rejects malformed required envelope fields before persistence", () => {
  const mutations: Array<[string, (artifact: Record<string, unknown>) => void]> = [
    ["missing plan createdAt", (artifact) => delete artifact.createdAt],
    [
      "malformed plan usage",
      (artifact) =>
        (artifact.usage = [{ stage: "planner", model: null, usage: { input_tokens: "secret" } }]),
    ],
    ["missing run startedAt", (artifact) => delete artifact.startedAt],
    ["malformed run tokenUsage", (artifact) => (artifact.tokenUsage = { arbitrary: true })],
    [
      "malformed terminal backlog",
      (artifact) => (artifact.backlog = { destination: "none", count: -1 }),
    ],
  ];

  for (const [name, mutate] of mutations) {
    const target = root();
    const kind =
      name.startsWith("missing plan") || name.startsWith("malformed plan") ? "plans" : "runs";
    const directory = path.join(target, ".codex", "ldo", kind);
    fs.mkdirSync(directory, { recursive: true });
    const artifact =
      kind === "plans"
        ? ldoPlan("malformed")
        : ldoRun("malformed", { coder: ldoCoder(), reviewer1: ldoReview("approved") }, "completed");
    mutate(artifact);
    fs.writeFileSync(path.join(directory, "malformed.json"), JSON.stringify(artifact));

    expect(previewLdoImport(target).items[0]).toMatchObject({ status: "rejected" });
    const store = new ProjectStore(target);
    expect(() => importLdoArtifacts(store)).toThrow(ProjectOperationsError);
    expect(fs.existsSync(path.join(store.layout.runs, "ldo-import-manifest.json"))).toBe(false);
  }
});

test("LDO run imports preserve provenance across reconstruction and resume at code", async () => {
  const target = root();
  const runs = path.join(target, ".codex", "ldo", "runs");
  fs.mkdirSync(runs, { recursive: true });
  const source = path.join(runs, "needs-fix.json");
  fs.writeFileSync(
    source,
    `${JSON.stringify(
      ldoRun("needs-fix", { coder: ldoCoder(), reviewer1: ldoReview("changes_requested") }),
    )}\n`,
  );
  const store = new ProjectStore(target);
  const digest = previewLdoImport(store).items[0]!.sha256!;
  importLdoArtifacts(store, { trustDigests: [digest] });

  const reconstructed = new ProjectStore(target);
  expect(inspectImportedLdoWork(reconstructed, "run:needs-fix")).toMatchObject({
    sourceStatus: "unchanged",
    completedStages: ["coder", "reviewer1"],
    firstIncompletePhase: "code",
    trustedForResume: true,
  });

  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "faux-1", contextWindow: 200_000 }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel() as Model<Api>;
  const role = (name: string, tools: string[]) => ({
    role: defineRole(
      {
        name,
        provider: "faux",
        modelId: model.id,
        systemPrompt: name,
        activeToolNames: tools,
        cacheRetention: "none" as const,
        contextBudget: { maxTokens: 100_000, reserveTokens: 10_000, keepRecentTokens: 20_000 },
      },
      model,
    ),
    model,
  });
  faux.setResponses([
    fauxAssistantMessage("corrected"),
    fauxAssistantMessage(
      fauxToolCall(SUBMIT_VERDICT_TOOL_NAME, {
        status: "approved",
        issues: [],
        summary: "approved",
      }),
    ),
    fauxAssistantMessage("review complete"),
  ]);
  const result = await resumeImportedLdoWork(reconstructed, "run:needs-fix", {
    targetDir: target,
    models,
    task: "Implement safe import",
    maxRounds: 3,
    roles: {
      coder: role("coder", ["bash", "read", "write", "edit"]),
      reviewer: role("reviewer", [SUBMIT_VERDICT_TOOL_NAME]),
    },
  });
  expect(result.status).toBe("complete");
  expect(faux.state.callCount).toBe(3);
  const resumedAgain = await resumeImportedLdoWork(new ProjectStore(target), "run:needs-fix", {
    targetDir: target,
    models,
    task: "Implement safe import",
    maxRounds: 3,
    roles: {
      coder: role("coder", ["bash", "read", "write", "edit"]),
      reviewer: role("reviewer", [SUBMIT_VERDICT_TOOL_NAME]),
    },
  });
  expect(resumedAgain.status).toBe("complete");
  expect(faux.state.callCount).toBe(3);
});

test("LDO completed runs require a final approved review aligned with approved state", () => {
  const target = root();
  const runs = path.join(target, ".codex", "ldo", "runs");
  fs.mkdirSync(runs, { recursive: true });
  fs.writeFileSync(
    path.join(runs, "approved.json"),
    JSON.stringify(
      ldoRun("approved", { coder: ldoCoder(), reviewer1: ldoReview("approved") }, "completed"),
    ),
  );
  expect(previewLdoImport(target).items[0]).toMatchObject({
    resumable: false,
    status: "importable",
  });

  const stale = ldoRun(
    "stale",
    { coder: ldoCoder(), reviewer1: ldoReview("changes_requested") },
    "completed",
  );
  fs.writeFileSync(path.join(runs, "stale.json"), JSON.stringify(stale));
  expect(previewLdoImport(target).items.find((item) => item.id === "stale")).toMatchObject({
    status: "rejected",
    error: { code: "stale_import" },
  });
  expect(() => importLdoArtifacts(new ProjectStore(target))).toThrow(ProjectOperationsError);
});

test("LDO inspection maps plan-only and coder-complete work to native phases", () => {
  const target = root();
  const plans = path.join(target, ".codex", "ldo", "plans");
  const runs = path.join(target, ".codex", "ldo", "runs");
  fs.mkdirSync(plans, { recursive: true });
  fs.mkdirSync(runs, { recursive: true });
  fs.writeFileSync(path.join(plans, "plan-only.json"), JSON.stringify(ldoPlan("plan-only")));
  fs.writeFileSync(
    path.join(runs, "coded.json"),
    JSON.stringify(ldoRun("coded", { coder: ldoCoder() })),
  );
  const store = new ProjectStore(target);
  importLdoArtifacts(store);
  expect(inspectImportedLdoWork(store, "plan:plan-only").firstIncompletePhase).toBe("code");
  expect(inspectImportedLdoWork(store, "run:coded").firstIncompletePhase).toBe("review");
});

test("LDO importer rejects symlinks, hard links, and every enabled numeric limit", () => {
  const target = root();
  const plans = path.join(target, ".codex", "ldo", "plans");
  fs.mkdirSync(plans, { recursive: true });
  const source = path.join(plans, "limited.json");
  fs.writeFileSync(source, JSON.stringify(ldoPlan("limited")));
  fs.writeFileSync(path.join(plans, "second.json"), JSON.stringify(ldoPlan("second")));

  for (const ldo of [
    { artifactCountLimit: 0, perFileByteLimit: 1, aggregateByteLimit: 0 },
    { artifactCountLimit: 0, perFileByteLimit: 0, aggregateByteLimit: 1 },
    { artifactCountLimit: 1, perFileByteLimit: 0, aggregateByteLimit: 0 },
  ]) {
    const store = new ProjectStore(target, { projectOperations: { ldo } });
    expect(() => importLdoArtifacts(store)).toThrow(ProjectOperationsError);
    expect(fs.existsSync(path.join(store.layout.runs, "ldo-import-manifest.json"))).toBe(false);
  }
  expect(() => previewLdoImport(target, { ldo: { artifactCountLimit: -1 } })).toThrow(
    ProjectOperationsError,
  );

  fs.linkSync(source, path.join(plans, "linked.json"));
  expect(previewLdoImport(target).items.find((item) => item.id === "linked")).toMatchObject({
    status: "rejected",
    error: { code: "unsafe_import" },
  });
  fs.unlinkSync(path.join(plans, "linked.json"));
  fs.symlinkSync(source, path.join(plans, "symlink.json"));
  expect(previewLdoImport(target).items.find((item) => item.id === "symlink")).toMatchObject({
    status: "rejected",
    error: { code: "unsafe_import" },
  });
});

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

test("RunCoordinator durably pauses a limited stage and resumes only that stage", async () => {
  const store = new ProjectStore(root());
  const base = coordinatorSession(store, []);
  let attempts = 0;
  const session: WorkflowSession = {
    ...base,
    async step(state) {
      attempts += 1;
      if (attempts === 1) throw new StageLimitError("duration", 10, 10);
      return base.step(state);
    },
  };
  const coordinator = new RunCoordinator(session, store, { runId: "stage-limit-pause" });
  const paused = await coordinator.run();
  expect(paused.status).toBe("paused");
  expect(paused.checkpoint.pause).toEqual({
    phase: "code",
    code: "stage_limit",
    action: "increase or disable the duration stage limit, then resume explicitly",
  });
  expect(attempts).toBe(1);
  coordinator.resumeStage({ source: "operator", action: "retry" });
  expect((await coordinator.run()).status).toBe("complete");
  expect(attempts).toBe(2);
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

function repositoryExecutor() {
  const requests: PublishingCommandRequest[] = [];
  return {
    requests,
    execute(request: PublishingCommandRequest) {
      requests.push(request);
      const result = Bun.spawnSync(request.argv, {
        cwd: request.cwd,
        env: { ...process.env, ...request.env },
        ...(request.stdin !== undefined && { stdin: Buffer.from(request.stdin) }),
      });
      return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
      };
    },
  };
}

function localRepository(): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-publish-"));
  const run = (args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: target });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  };
  run(["init", "-b", "main"]);
  run(["config", "user.name", "Publisher Test"]);
  run(["config", "user.email", "publisher@example.invalid"]);
  fs.writeFileSync(path.join(target, "kept.txt"), "base\n");
  run(["add", "--", "kept.txt"]);
  run(["commit", "-m", "base"]);
  return target;
}

test("publishing config defaults are efficient and validation is strict", () => {
  expect(DEFAULT_REPOSITORY_PUBLISHING_CONFIG.gate).toBe("local");
  expect(DEFAULT_REPOSITORY_PUBLISHING_CONFIG.outputByteLimit).toBe(0);
  expect(resolveRepositoryPublishingConfig().baseCandidates).toEqual(["main", "master"]);
  expect(() => resolveRepositoryPublishingConfig({ gate: "unknown" as never })).toThrow(
    ProjectOperationsError,
  );
  expect(() => resolveRepositoryPublishingConfig({ outputByteLimit: -1 })).toThrow(
    ProjectOperationsError,
  );
});

test("publishing preflight is read-only, reports dirt and local mode, then locally squash-merges", () => {
  const target = localRepository();
  fs.writeFileSync(path.join(target, "user.txt"), "do not publish\n");
  const executor = repositoryExecutor();
  const config = {
    mode: "local" as const,
    gate: "local" as const,
    localTestCommand: ["git", "status", "--porcelain"],
  };
  const preflight = preflightRepositoryPublishing(executor, target, config);
  expect(preflight).toMatchObject({
    phase: "preflight",
    gate: "local",
    mode: "local",
    base: "main",
    currentBranch: "main",
  });
  expect(preflight.dirty.untracked).toContain("user.txt");
  expect(
    executor.requests.every(
      (request) =>
        !["switch", "add", "commit", "push", "update-ref"].includes(request.argv[1] ?? ""),
    ),
  ).toBe(true);
  const started = startRepositoryPublishing(
    executor,
    target,
    { preflight, featureBranch: "feature/publish" },
    config,
  );
  fs.writeFileSync(path.join(target, "feature.txt"), "published\n");
  const result = finishRepositoryPublishing(
    executor,
    target,
    {
      started,
      paths: ["feature.txt"],
      commitMessage: "publish feature",
      title: "Publish feature",
      description: {
        problem: "Missing policy",
        audience: "Operators",
        userImpact: "Safe publishing",
        verification: "Tests pass",
        reviewerVerdict: "approved",
      },
    },
    config,
  );
  expect(result).toMatchObject({ phase: "finished", gate: "local", mode: "local" });
  expect(fs.readFileSync(path.join(target, "user.txt"), "utf8")).toBe("do not publish\n");
  expect(
    Bun.spawnSync(["git", "branch", "--show-current"], { cwd: target }).stdout.toString().trim(),
  ).toBe("feature/publish");
  expect(
    Bun.spawnSync(["git", "rev-list", "--count", `${preflight.baseOid}..main`], { cwd: target })
      .stdout.toString()
      .trim(),
  ).toBe("1");
  const add = executor.requests.find((request) => request.argv[1] === "add");
  expect(add?.argv).toEqual(["git", "add", "--", "feature.txt"]);
  expect(add?.env?.GIT_INDEX_FILE).toBeString();
});

test("publishing commits from a linked Git worktree whose .git is a file", () => {
  const primary = localRepository();
  const linked = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-linked-publish-"));
  fs.rmdirSync(linked);
  expect(
    Bun.spawnSync(["git", "worktree", "add", "-b", "linked-start", linked, "main"], {
      cwd: primary,
    }).exitCode,
  ).toBe(0);
  expect(fs.lstatSync(path.join(linked, ".git")).isFile()).toBe(true);

  const executor = repositoryExecutor();
  const config = {
    mode: "local" as const,
    gate: "local" as const,
    localTestCommand: ["git", "status", "--porcelain"],
  };
  const preflight = preflightRepositoryPublishing(executor, linked, config);
  const started = startRepositoryPublishing(
    executor,
    linked,
    { preflight, featureBranch: "feature/from-linked" },
    config,
  );
  fs.writeFileSync(path.join(linked, "linked.txt"), "published from worktree\n");
  expect(
    finishRepositoryPublishing(
      executor,
      linked,
      {
        started,
        paths: ["linked.txt"],
        commitMessage: "publish linked worktree",
        title: "Publish linked worktree",
        description: {
          problem: "Linked worktree support",
          audience: "Operators",
          userImpact: "Publishing works",
          verification: "Regression test",
          reviewerVerdict: "approved",
        },
      },
      config,
    ).phase,
  ).toBe("finished");
  expect(Bun.spawnSync(["git", "show", "main:linked.txt"], { cwd: linked }).stdout.toString()).toBe(
    "published from worktree\n",
  );
});

test("publishing refuses to start from a branch divergent from the selected base", () => {
  const target = localRepository();
  const executor = repositoryExecutor();
  expect(Bun.spawnSync(["git", "switch", "-c", "topic/divergent"], { cwd: target }).exitCode).toBe(
    0,
  );
  fs.writeFileSync(path.join(target, "divergent.txt"), "divergent\n");
  for (const args of [
    ["add", "--", "divergent.txt"],
    ["commit", "-m", "divergent"],
  ])
    expect(Bun.spawnSync(["git", ...args], { cwd: target }).exitCode).toBe(0);
  const config = { mode: "local" as const };
  const preflight = preflightRepositoryPublishing(executor, target, config);

  expect(() =>
    startRepositoryPublishing(
      executor,
      target,
      { preflight, featureBranch: "feature/from-divergent" },
      config,
    ),
  ).toThrow(ProjectOperationsError);
  expect(
    Bun.spawnSync(["git", "branch", "--show-current"], { cwd: target }).stdout.toString().trim(),
  ).toBe("topic/divergent");
  expect(
    Bun.spawnSync(["git", "show-ref", "--verify", "refs/heads/feature/from-divergent"], {
      cwd: target,
    }).exitCode,
  ).not.toBe(0);
});

test("publishing refuses protected heads, dirty paths, moved bases, and unavailable approval", () => {
  const target = localRepository();
  const executor = repositoryExecutor();
  const config = { mode: "local" as const, gate: "manual" as const };
  const preflight = preflightRepositoryPublishing(executor, target, config);
  expect(() =>
    startRepositoryPublishing(executor, target, { preflight, featureBranch: "main" }, config),
  ).toThrow(ProjectOperationsError);
  fs.writeFileSync(path.join(target, "dirty.txt"), "user\n");
  const dirty = preflightRepositoryPublishing(executor, target, config);
  const started = startRepositoryPublishing(
    executor,
    target,
    { preflight: dirty, featureBranch: "feature/guard" },
    config,
  );
  expect(() =>
    finishRepositoryPublishing(
      executor,
      target,
      {
        started,
        paths: ["dirty.txt"],
        commitMessage: "x",
        title: "x",
        description: {
          problem: "x",
          audience: "x",
          userImpact: "x",
          verification: "x",
          reviewerVerdict: "x",
        },
      },
      config,
    ),
  ).toThrow(ProjectOperationsError);
  expect(() =>
    preflightRepositoryPublishing(executor, target, { ...config, multiDeveloper: true }),
  ).toThrow(ProjectOperationsError);
  const moved = Bun.spawnSync(
    ["git", "commit-tree", `${dirty.baseOid}^{tree}`, "-p", dirty.baseOid],
    { cwd: target, stdin: Buffer.from("move base\n") },
  )
    .stdout.toString()
    .trim();
  expect(
    Bun.spawnSync(["git", "update-ref", "refs/heads/main", moved, dirty.baseOid], { cwd: target })
      .exitCode,
  ).toBe(0);
  expect(() =>
    finishRepositoryPublishing(
      executor,
      target,
      {
        started,
        paths: ["dirty.txt"],
        authorizeInitiallyDirtyPaths: ["dirty.txt"],
        commitMessage: "x",
        title: "x",
        description: {
          problem: "x",
          audience: "x",
          userImpact: "x",
          verification: "x",
          reviewerVerdict: "x",
        },
      },
      config,
    ),
  ).toThrow(ProjectOperationsError);
});

test("publishing refuses a preflight-staged index instead of consuming user staging", () => {
  const target = localRepository();
  const executor = repositoryExecutor();
  fs.writeFileSync(path.join(target, "staged.txt"), "user staging\n");
  expect(Bun.spawnSync(["git", "add", "--", "staged.txt"], { cwd: target }).exitCode).toBe(0);
  const config = { mode: "local" as const, gate: "manual" as const };
  const preflight = preflightRepositoryPublishing(executor, target, config);
  const started = startRepositoryPublishing(
    executor,
    target,
    { preflight, featureBranch: "feature/staged" },
    config,
  );
  expect(() =>
    finishRepositoryPublishing(
      executor,
      target,
      {
        started,
        paths: ["staged.txt"],
        authorizeInitiallyDirtyPaths: ["staged.txt"],
        commitMessage: "x",
        title: "x",
        description: {
          problem: "x",
          audience: "x",
          userImpact: "x",
          verification: "x",
          reviewerVerdict: "x",
        },
      },
      config,
    ),
  ).toThrow(ProjectOperationsError);
  expect(
    Bun.spawnSync(["git", "diff", "--cached", "--name-only"], { cwd: target })
      .stdout.toString()
      .trim(),
  ).toBe("staged.txt");
});

test("PR bodies carry every required section and optional pipeline usage", () => {
  const base = {
    problem: "P",
    audience: "A",
    userImpact: "I",
    verification: "V",
    reviewerVerdict: "approved",
  };
  const body = buildPublishingPrBody(base);
  for (const heading of [
    "What happens / problem",
    "Who needs it",
    "User impact",
    "Verification",
    "Pipeline Reviewer verdict",
  ])
    expect(body).toContain(`## ${heading}`);
  expect(body).not.toContain("Pipeline usage");
  expect(buildPublishingPrBody({ ...base, pipelineUsage: { total: 12 } })).toContain('"total": 12');
});

test("GitHub publishing pins checks, approval, body stdin, push refspec, and squash merge", () => {
  const target = localRepository();
  expect(
    Bun.spawnSync(["git", "remote", "add", "origin", "https://github.com/example/project.git"], {
      cwd: target,
    }).exitCode,
  ).toBe(0);
  const requests: PublishingCommandRequest[] = [];
  const executor = {
    execute(request: PublishingCommandRequest) {
      requests.push(request);
      if (request.argv[0] === "gh") {
        const featureOid = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: target })
          .stdout.toString()
          .trim();
        const baseOid = Bun.spawnSync(["git", "rev-parse", "main"], { cwd: target })
          .stdout.toString()
          .trim();
        if (request.argv.includes("checks"))
          return { exitCode: 0, stdout: JSON.stringify([{ name: "test", state: "SUCCESS" }]) };
        if (request.argv.at(-1)?.endsWith("/reviews"))
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              { state: "APPROVED", user: { login: "second-developer" }, commit_id: featureOid },
            ]),
          };
        if (request.argv.includes("view"))
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              number: 7,
              url: "https://github.com/example/project/pull/7",
              author: { login: "author" },
              headRefOid: featureOid,
              baseRefOid: baseOid,
            }),
          };
        return { exitCode: 0, stdout: "{}" };
      }
      if (request.argv[0] === "git" && request.argv[1] === "push")
        return { exitCode: 0, stdout: "" };
      const result = Bun.spawnSync(request.argv, {
        cwd: request.cwd,
        env: { ...process.env, ...request.env },
        ...(request.stdin !== undefined && { stdin: Buffer.from(request.stdin) }),
      });
      return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
      };
    },
  };
  const config = {
    gate: "local-and-ci" as const,
    localTestCommand: ["git", "status", "--porcelain"],
    multiDeveloper: true,
  };
  const preflight = preflightRepositoryPublishing(executor, target, config);
  const started = startRepositoryPublishing(
    executor,
    target,
    { preflight, featureBranch: "feature/github" },
    config,
  );
  fs.writeFileSync(path.join(target, "github.txt"), "publish\n");
  const result = finishRepositoryPublishing(
    executor,
    target,
    {
      started,
      paths: ["github.txt"],
      commitMessage: "github publish",
      title: "GitHub publish",
      description: {
        problem: "Missing flow",
        audience: "Operators",
        userImpact: "Can publish",
        verification: "All tests pass",
        reviewerVerdict: "approved",
        pipelineUsage: { totalTokens: 12 },
      },
    },
    config,
  );
  expect(result).toMatchObject({
    phase: "finished",
    gate: "local-and-ci",
    ciGate: { ran: true, passed: true, count: 1 },
    approval: { required: true, approved: true },
  });
  expect(requests.find((request) => request.argv[1] === "push")?.argv).toEqual([
    "git",
    "push",
    "origin",
    "HEAD:refs/heads/feature/github",
  ]);
  const create = requests.find(
    (request) => request.argv[0] === "gh" && request.argv.includes("create"),
  );
  expect(create?.argv).toContain("--body-file");
  expect(create?.stdin).toContain("## Pipeline Reviewer verdict");
  expect(create?.stdin).toContain("## Pipeline usage");
  const merge = requests.find(
    (request) => request.argv[0] === "gh" && request.argv.includes("merge"),
  );
  expect(merge?.argv).toContain("--match-head-commit");
  expect(merge?.argv).not.toContain("--delete-branch");
});
