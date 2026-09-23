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
  type CompactionFailure,
  ContextCompactionLostError,
  clearsOnExplicitAct,
  createBacklogStore,
  DEFAULT_REPOSITORY_PUBLISHING_CONFIG,
  detectLdoProject,
  FileBacklogStore,
  finishRepositoryPublishing,
  GitHubBacklogStore,
  importLdoArtifacts,
  inspectImportedLdoWork,
  PAUSES_CLEARED_BY_AN_EXPLICIT_ACT,
  ProjectOperationsError,
  ProjectStore,
  ProviderRejectionError,
  preflightRepositoryPublishing,
  previewLdoImport,
  probeGitHubBacklogCapability,
  type RunCheckpoint,
  RunCoordinator,
  resolveRepositoryPublishingConfig,
  resumeImportedLdoWork,
  routeDocumentationFollowUp,
  StageCloseoutError,
  StageLimitController,
  StageLimitError,
  startRepositoryPublishing,
  suggestBacklogMigrationOnce,
  validateFollowUp,
  WorkflowStageFailureError,
  WorkflowStageLimitError,
} from "../src";
import { CostAnomalyBlockedError } from "../src/economics/cost-anomaly";
import {
  MAX_PAUSE_CAUSE_MESSAGE_CHARS,
  MAX_PERSISTED_STRING_CHARS,
  OrchestrationError,
} from "../src/orchestration/types";
import { SUBMIT_VERDICT_TOOL_NAME } from "../src/orchestration/verdict";
import { defineRole } from "../src/role";
import {
  ConfiguredToolsUnavailableError,
  EmptyTurnError,
  ProviderUnavailableError,
  RunnerError,
  SuspendedRunError,
} from "../src/runner/errors";

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
      ldoRun("needs-fix", {
        coder: ldoCoder(),
        reviewer1: { ...ldoReview("changes_requested"), issues: [] },
      }),
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
        issues: [
          {
            severity: "major",
            findingId: "fix-it",
            what: "fix it",
            location: "src/a.ts:1",
            closureCriterion: "the focused regression test passes",
            resolution: "closed",
            evidence: "the focused regression test passes",
          },
        ],
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

test("RunCoordinator persists a failed stage's safe metrics and permits an explicit retry", async () => {
  const target = root();
  const store = new ProjectStore(target);
  const base = coordinatorSession(store, []);
  let attempts = 0;
  const session: WorkflowSession = {
    ...base,
    async step(state) {
      attempts += 1;
      if (attempts === 1) {
        throw new WorkflowStageFailureError(
          new Error("provider detail must not persist"),
          "failed-code",
          {
            stage: "code:1",
            status: "paused",
            provider: "faux",
            model: "faux-1",
            thinkingLevel: "unknown",
            durationMs: 12,
            input: 7,
            cachedInput: 2,
            freshInput: 5,
            output: 3,
            reasoning: 0,
            costUsd: 0.25,
            requestBytes: { systemPrompt: 0, prompt: 0, toolDefinitions: 0, total: 0 },
            readFiles: [],
            readFilesTotal: 0,
            readFilesTruncated: 0,
            diffBytes: 0,
            contextStrategy: "auto",
          },
        );
      }
      return base.step(state);
    },
  };
  const coordinator = new RunCoordinator(session, store, { runId: "failed-stage-pause" });
  const paused = await coordinator.run();
  expect(paused.checkpoint.pause?.code).toBe("stage_failed");
  // Issue #403: an untyped error now names itself in the pause instead of
  // leaving a generic action over an empty cause.
  expect(paused.checkpoint.pause?.cause).toEqual({
    code: "untyped_error",
    message: "Error: provider detail must not persist",
    recurrence: 0,
  });
  expect(paused.checkpoint.pause?.action).toContain("untyped_error");
  expect(paused.checkpoint.pause?.action).not.toContain("provider failure");
  expect(paused.checkpoint.workflowState.lastStageFailure).toEqual({
    phase: "code",
    code: "untyped_error",
    message: "Error: provider detail must not persist",
    recurrence: 0,
  });
  expect(paused.checkpoint.workflowState.stageMetrics).toEqual([
    expect.objectContaining({ stage: "code:1", costUsd: 0.25 }),
  ]);
  expect(JSON.stringify(paused.checkpoint.pause?.cause)).not.toContain("sk-");
  coordinator.resumeStage({ source: "operator", action: "retry" });
  expect((await coordinator.run()).status).toBe("complete");
  expect(attempts).toBe(2);
});

test("RunCoordinator names the rejecting provider in the pause instead of a generic stage failure", async () => {
  const target = root();
  const store = new ProjectStore(target);
  const base = coordinatorSession(store, []);
  let attempts = 0;
  const session: WorkflowSession = {
    ...base,
    async step(state) {
      attempts += 1;
      if (attempts === 1) {
        throw new WorkflowStageFailureError(
          new ProviderRejectionError("failed-code", 400),
          "failed-code",
          {
            stage: "code:1",
            status: "paused",
            provider: "faux",
            model: "faux-1",
            thinkingLevel: "unknown",
            durationMs: 12,
            input: 0,
            cachedInput: 0,
            freshInput: 0,
            output: 0,
            reasoning: 0,
            costUsd: 0,
            requestBytes: { systemPrompt: 0, prompt: 0, toolDefinitions: 0, total: 0 },
            readFiles: [],
            readFilesTotal: 0,
            readFilesTruncated: 0,
            diffBytes: 0,
            contextStrategy: "auto",
          },
        );
      }
      return base.step(state);
    },
  };
  const coordinator = new RunCoordinator(session, store, { runId: "rejected-stage-pause" });
  const paused = await coordinator.run();
  expect(paused.checkpoint.pause?.code).toBe("provider_rejected");
  expect(paused.checkpoint.pause?.action).toContain("HTTP 400");
  // The whole point of the fix: the pause must not send the operator to check
  // credentials for a request the provider answered and refused.
  expect(paused.checkpoint.pause?.action).not.toContain("authentication");
  coordinator.resumeStage({ source: "operator", action: "retry" });
  expect((await coordinator.run()).status).toBe("complete");
  expect(attempts).toBe(2);
});

const failureMetrics = {
  stage: "code:1",
  status: "paused",
  provider: "faux",
  model: "faux-1",
  thinkingLevel: "unknown",
  durationMs: 12,
  input: 0,
  cachedInput: 0,
  freshInput: 0,
  output: 0,
  reasoning: 0,
  costUsd: 0,
  requestBytes: { systemPrompt: 0, prompt: 0, toolDefinitions: 0, total: 0 },
  readFiles: [] as string[],
  readFilesTotal: 0,
  readFilesTruncated: 0,
  diffBytes: 0,
  contextStrategy: "auto",
} as const;

/** Run one coordinator whose first step throws, and return its paused checkpoint. */
async function pauseOnFailure(sourceError: unknown, runId: string): Promise<RunCheckpoint> {
  const target = root();
  const store = new ProjectStore(target);
  const base = coordinatorSession(store, []);
  const session: WorkflowSession = {
    ...base,
    async step() {
      throw new WorkflowStageFailureError(sourceError, "failed-code", { ...failureMetrics });
    },
  };
  const coordinator = new RunCoordinator(session, store, { runId });
  return (await coordinator.run()).checkpoint;
}

/**
 * The hostile-thrown-value variant (issue #403 review round): for a value
 * whose reads THROW, the typed wrapper (`WorkflowStageFailureError`) itself
 * would refuse during its own super(...) message read -- a different, typed
 * surface (src/orchestration/session.ts) -- so the hostile value is installed
 * AFTER the wrapper is built, and only the coordinator's untyped-cause builder
 * ever reads it.
 */
async function pauseOnHostileSource(sourceError: unknown, runId: string): Promise<RunCheckpoint> {
  const target = root();
  const store = new ProjectStore(target);
  const base = coordinatorSession(store, []);
  const session: WorkflowSession = {
    ...base,
    async step() {
      const failure = new WorkflowStageFailureError(new Error("benign wrap"), runId, {
        ...failureMetrics,
      });
      Object.defineProperty(failure, "sourceError", { value: sourceError });
      throw failure;
    },
  };
  const coordinator = new RunCoordinator(session, store, { runId });
  return (await coordinator.run()).checkpoint;
}

test("a harness-side stage failure is worded as harness work and carries its cause (issue #363)", async () => {
  // A stage can fail for reasons the HARNESS authored: the runner's own typed
  // measurement failure, an empty turn, a cost-anomaly block, unavailable
  // tools, a suspended deferral, a typed submission rejection, an orchestration
  // precondition. Mapping every one of them to "inspect the provider failure"
  // sent operators looking at the provider for failures it had nothing to do
  // with, and dropped the cause on the floor so the durable record could not
  // say what had happened at all.
  const cases: readonly (readonly [unknown, string, string | undefined])[] = [
    [
      new RunnerError("diff_metric_failed", "/tmp/target", "git diff HEAD failed (128)"),
      "diff_metric_failed",
      "git diff HEAD failed (128)",
    ],
    [new EmptyTurnError("failed-code", "assistant_error"), "empty_turn", undefined],
    [new ProviderUnavailableError("failed-code"), "provider_unavailable", undefined],
    [
      new CostAnomalyBlockedError("faux", "faux-1", {
        at: 0,
        chargedUsd: 1,
        expectedUsd: 0.5,
        ratio: 2,
        acceptedRatio: 1,
        confirmingObservations: 2,
      }),
      "cost_anomaly_blocked",
      undefined,
    ],
    [new ConfiguredToolsUnavailableError("failed-code"), "configured_tools_unavailable", undefined],
    [new SuspendedRunError("failed-code"), "suspended", undefined],
    [
      new ProjectOperationsError(
        "invalid_follow_up",
        "kind must be one of contract, note, design-doc-drift, backlog",
      ),
      "invalid_follow_up",
      "invalid_follow_up: kind must be one of contract, note, design-doc-drift, backlog",
    ],
    [
      new OrchestrationError("malformed_plan", "failed-code", "planner JSON handoff is invalid"),
      "malformed_plan",
      "planner JSON handoff is invalid",
    ],
  ];
  for (const [index, [sourceError, expectedCode, expectedMessage]] of cases.entries()) {
    const checkpoint = await pauseOnFailure(sourceError, `harness-cause-${index}`);
    const pause = checkpoint.pause;
    expect(pause?.code).toBe("stage_failed");
    // The classification is the point: a harness-side failure must not be
    // reported as a provider failure with advice to inspect the provider.
    expect(pause?.action).not.toContain("inspect the provider failure");
    expect(pause?.action).toContain(expectedCode);
    expect(pause?.cause).toEqual(expect.objectContaining({ code: expectedCode, recurrence: 0 }));
    if (expectedMessage === undefined) {
      // A fixed-harness message carries itself; the assertion above already
      // names the code, so nothing further is pinned per case.
      expect(pause?.cause?.message).toBeDefined();
    } else {
      expect(pause?.cause?.message).toBe(expectedMessage);
    }
    // The cause stays resumable by the same explicit operator act.
    expect(PAUSES_CLEARED_BY_AN_EXPLICIT_ACT).toContain("stage_failed");
  }
});

test("a harness-side budget boundary is worded as its own remedy (issue #458)", async () => {
  // Two more HARNESS-SIDE failures were still mapped to "inspect the provider
  // failure and retry the stage explicitly" with the cause dropped entirely
  // (issue #458): the closeout reserve a stage ceiling grants its own
  // deliverable, and a context whose compaction is spent. Neither is a
  // provider fault -- one is the stage's own ceiling, the other the harness's
  // summarization -- and neither has a retry that works, so the action has to
  // word the remedy that exists and the cause has to travel, or the recurrence
  // counter could never count the repeats.
  const failure: CompactionFailure = {
    attempt: 1,
    errorName: "CompactionError",
    stopReason: "summarization_failed",
    measuredTokens: 190_000,
    thresholdTokens: 160_000,
  };
  const cases: readonly (readonly [unknown, string, readonly string[], readonly string[]])[] = [
    [
      new StageCloseoutError("duration", "2613125/2700000 ms used, 90000 ms reserved"),
      "stage_closeout",
      [
        "duration closeout reserve (2613125/2700000 ms used, 90000 ms reserved)",
        "raise or disable the duration stage ceiling for this role",
        "then resume explicitly",
      ],
      ["retry the stage explicitly", "then retry"],
    ],
    [
      new ContextCompactionLostError({
        role: "coder",
        budget: { maxTokens: 180_000, reserveTokens: 20_000, keepRecentTokens: 50_000 },
        measuredTokens: 203_000,
        contextWindow: 200_000,
        failures: [failure],
      }),
      "context_compaction_lost",
      [
        "can no longer be compacted",
        "reopen the session from its durable state",
        "retrying the same prompt cannot succeed",
      ],
      ["retry the stage explicitly", "then retry"],
    ],
  ];
  for (const [index, [sourceError, expectedCode, mustName, mustNot]] of cases.entries()) {
    const checkpoint = await pauseOnFailure(sourceError, `budget-cause-${index}`);
    const pause = checkpoint.pause;
    expect(pause?.code).toBe("stage_failed");
    // The classification is the point: a budget boundary must not be reported
    // as a provider failure, and must not advise a retry that cannot work.
    expect(pause?.action).not.toContain("inspect the provider failure");
    for (const fragment of mustName) expect(pause?.action).toContain(fragment);
    for (const fragment of mustNot) expect(pause?.action).not.toContain(fragment);
    expect(pause?.cause).toEqual(expect.objectContaining({ code: expectedCode, recurrence: 0 }));
    // The cause stays resumable by the same explicit operator act.
    expect(PAUSES_CLEARED_BY_AN_EXPLICIT_ACT).toContain("stage_failed");
  }
});

test("repeated closeout failures count their recurrence at last (issue #458)", async () => {
  // The closeout failure used to record NOTHING, so `recurrenceOf` could only
  // ever answer 0: the counter that distinguishes a loop from a ceiling an
  // operator could raise could not advance for this class at all (issue #458).
  const target = root();
  const store = new ProjectStore(target);
  const base = coordinatorSession(store, []);
  let attempts = 0;
  const session: WorkflowSession = {
    ...base,
    async step(state) {
      attempts += 1;
      if (attempts <= 2)
        throw new WorkflowStageFailureError(
          new StageCloseoutError("duration", "2613125/2700000 ms used, 90000 ms reserved"),
          "failed-code",
          { ...failureMetrics },
        );
      return base.step(state);
    },
  };
  const coordinator = new RunCoordinator(session, store, { runId: "closeout-recurrence" });
  const first = await coordinator.run();
  // The FIRST failure records its cause into the durable workflowState ...
  expect(first.checkpoint.workflowState.lastStageFailure).toMatchObject({
    phase: "code",
    code: "stage_closeout",
    recurrence: 0,
  });
  coordinator.resumeStage({ source: "operator", action: "retry" });
  const second = await coordinator.run();
  // ... and the SAME cause on the next attempt is a recurrence -- the loop
  // signature that could never be counted while the cause was dropped.
  expect(second.checkpoint.pause?.cause).toMatchObject({ code: "stage_closeout", recurrence: 1 });
  expect(second.checkpoint.pause?.action).toContain(
    "the same cause has now been recorded 2 consecutive times",
  );
  expect(second.checkpoint.workflowState.lastStageFailure).toMatchObject({
    code: "stage_closeout",
    recurrence: 1,
  });
  coordinator.resumeStage({ source: "operator", action: "retry" });
  expect((await coordinator.run()).status).toBe("complete");
  expect(attempts).toBe(3);
});

test("a closeout pause action fits the persisted ceiling for MAX_SAFE_INTEGER limits (issue #458 review)", async () => {
  // The review round measured the recurrence-1 closeout action OVER the
  // persisted ceiling: valid stage limits accept Number.MAX_SAFE_INTEGER, the
  // model_turns closeout detail then interpolates 16-digit numbers, and the
  // ordinary recurrence-1 action crossed the limit `requiredString` enforces
  // on every persisted record string -- so the REPEATED pause failed durable
  // serialization instead of producing a clearable pause. The ceiling here is
  // read from the writer's own constant (MAX_PERSISTED_STRING_CHARS), so the
  // test fails if either side moves. Both pauses are asserted: the first (no
  // recurrence tail) and the repeated one (the tail included -- exactly what
  // pushed the old wording over the edge).
  const maxSafe = Number.MAX_SAFE_INTEGER;
  // The real controller builds the closeout from the real limits: the detail
  // is the one StageLimits composes at the closeout boundary, not a hand-typed
  // stand-in.
  const controller = new StageLimitController(
    { maxModelTurns: maxSafe, finalResponseReserveModelTurns: 1 },
    () => 0,
    { modelTurns: maxSafe - 1 },
  );
  let closeoutError: StageCloseoutError | undefined;
  try {
    controller.admitToolTurn("read_file");
  } catch (error) {
    if (error instanceof StageCloseoutError) closeoutError = error;
  }
  expect(closeoutError).toBeDefined();
  const target = root();
  const store = new ProjectStore(target);
  const base = coordinatorSession(store, []);
  let attempts = 0;
  const session: WorkflowSession = {
    ...base,
    async step(state) {
      attempts += 1;
      if (attempts <= 2)
        throw new WorkflowStageFailureError(closeoutError!, "failed-code", {
          ...failureMetrics,
        });
      return base.step(state);
    },
  };
  const coordinator = new RunCoordinator(session, store, { runId: "closeout-ceiling" });
  const first = await coordinator.run();
  const firstAction = first.checkpoint.pause?.action;
  expect(first.checkpoint.pause?.code).toBe("stage_failed");
  expect(firstAction).toBeDefined();
  // Which ceiling was exhausted, the remedy, the act -- the shortening that
  // keeps the composition inside the ceiling must never drop one of these.
  expect(firstAction).toContain(`model_turns closeout reserve (${closeoutError!.detail})`);
  expect(firstAction).toContain("raise or disable the model_turns stage ceiling for this role");
  expect(firstAction).toContain("then resume explicitly");
  expect(firstAction!.length).toBeLessThanOrEqual(MAX_PERSISTED_STRING_CHARS);
  coordinator.resumeStage({ source: "operator", action: "retry" });
  const second = await coordinator.run();
  const secondAction = second.checkpoint.pause?.action;
  expect(second.checkpoint.pause?.cause).toMatchObject({ code: "stage_closeout", recurrence: 1 });
  expect(secondAction).toBeDefined();
  // The recurrence tail -- the loop signature -- lives inside the same budget:
  expect(secondAction).toContain("the same cause has now been recorded 2 consecutive times");
  expect(secondAction).toContain("raise or disable the model_turns stage ceiling for this role");
  expect(secondAction!.length).toBeLessThanOrEqual(MAX_PERSISTED_STRING_CHARS);
});

test("a closeout action that would not fit is clipped visibly, never mid-remedy (issue #458 review)", async () => {
  // The deliberate bound behind the ceiling guarantee: the detail is the ONLY
  // piece a too-long composition may lose, because the reason, the remedy and
  // the recurrence tail are what the operator needs and are never cut. An
  // oversized detail (harness-internal; the controller's own templates stay
  // far below this) drives the bound: the head of the detail survives, the
  // fixed clip marker says a cut happened -- legible, not silent -- and the
  // total lands within the persisted ceiling on the first pause and, with the
  // recurrence tail inside the same budget, on the repeated one too.
  const target = root();
  const store = new ProjectStore(target);
  const base = coordinatorSession(store, []);
  let attempts = 0;
  const detail = "x".repeat(400);
  const session: WorkflowSession = {
    ...base,
    async step(state) {
      attempts += 1;
      if (attempts <= 2)
        throw new WorkflowStageFailureError(
          new StageCloseoutError("model_turns", detail),
          "failed-code",
          { ...failureMetrics },
        );
      return base.step(state);
    },
  };
  const coordinator = new RunCoordinator(session, store, { runId: "closeout-clip" });
  const first = await coordinator.run();
  const firstAction = first.checkpoint.pause?.action;
  expect(firstAction).toBeDefined();
  expect(firstAction!.length).toBeLessThanOrEqual(MAX_PERSISTED_STRING_CHARS);
  expect(firstAction).toContain("model_turns closeout reserve (");
  expect(firstAction).toContain("...[clipped]");
  expect(firstAction).not.toContain(detail);
  // The remedy and the resume act survive the clip INTACT, after the cut:
  expect(firstAction).toContain(
    "); raise or disable the model_turns stage ceiling for this role, then resume explicitly",
  );
  coordinator.resumeStage({ source: "operator", action: "retry" });
  const second = await coordinator.run();
  const secondAction = second.checkpoint.pause?.action;
  expect(secondAction).toBeDefined();
  expect(secondAction!.length).toBeLessThanOrEqual(MAX_PERSISTED_STRING_CHARS);
  expect(secondAction).toContain("the same cause has now been recorded 2 consecutive times");
  expect(secondAction).toContain(
    "); raise or disable the model_turns stage ceiling for this role, then resume explicitly",
  );
});

test("a context-compaction pause action fits the persisted ceiling at every recurrence (issue #458 review round 3)", async () => {
  // The closeout branch gained the bound in the first review round; the
  // compaction branch kept composing unbounded and the SECOND round measured
  // it over the writer's ceiling -- 206 characters without the recurrence
  // tail, 264 with it -- so a REPEATED context-compaction pause failed durable
  // serialization instead of producing a clearable pause. The ceiling here is
  // read from the writer's own constant, and the assertion is made at three
  // recurrence depths, because the tail that broke it only appears from the
  // second pause on.
  const failure: CompactionFailure = {
    attempt: 1,
    errorName: "CompactionError",
    stopReason: "summarization_failed",
    measuredTokens: 190_000,
    thresholdTokens: 160_000,
  };
  const compactionError = new ContextCompactionLostError({
    role: "coder",
    budget: { maxTokens: 180_000, reserveTokens: 20_000, keepRecentTokens: 50_000 },
    measuredTokens: 203_000,
    contextWindow: 200_000,
    failures: [failure],
  });
  const target = root();
  const store = new ProjectStore(target);
  const base = coordinatorSession(store, []);
  let attempts = 0;
  const session: WorkflowSession = {
    ...base,
    async step(state) {
      attempts += 1;
      if (attempts <= 3)
        throw new WorkflowStageFailureError(compactionError, "failed-code", { ...failureMetrics });
      return base.step(state);
    },
  };
  const coordinator = new RunCoordinator(session, store, { runId: "compaction-ceiling" });
  const first = await coordinator.run();
  const firstAction = first.checkpoint.pause?.action;
  expect(first.checkpoint.pause?.cause).toMatchObject({
    code: "context_compaction_lost",
    recurrence: 0,
  });
  expect(firstAction).toBeDefined();
  // The first pause still fits whole -- and the conditional aside is what the
  // later clippings are allowed to shorten, never the remedy.
  expect(firstAction).toContain(
    "choosing a different summarizer model when the summarizer itself failed",
  );
  expect(firstAction!.length).toBeLessThanOrEqual(MAX_PERSISTED_STRING_CHARS);
  const recurrences: readonly (readonly [number, string])[] = [
    [1, "2 consecutive times"],
    [2, "3 consecutive times"],
  ];
  for (const [depth, tail] of recurrences) {
    coordinator.resumeStage({ source: "operator", action: "retry" });
    const next = await coordinator.run();
    const action = next.checkpoint.pause?.action;
    expect(next.checkpoint.pause?.cause).toMatchObject({
      code: "context_compaction_lost",
      recurrence: depth,
    });
    expect(action).toBeDefined();
    expect(action!.length).toBeLessThanOrEqual(MAX_PERSISTED_STRING_CHARS);
    // The loop signature is the whole point of the tail: it must survive the
    // cut, along with the reason and the remedy the stage has to act on.
    expect(action).toContain(`the same cause has now been recorded ${tail}`);
    expect(action).toContain("can no longer be compacted");
    expect(action).toContain("reopen the session from its durable state (");
    expect(action).toContain("retrying the same prompt cannot succeed");
    // And the cut is legible, never silent.
    expect(action).toContain("...[clipped]");
    expect(action).not.toContain(
      "choosing a different summarizer model when the summarizer itself failed",
    );
  }
  expect(attempts).toBe(3);
});

test("a budget-boundary pause stays clearable by an explicit operator act (issue #458)", async () => {
  const target = root();
  const store = new ProjectStore(target);
  const base = coordinatorSession(store, []);
  let attempts = 0;
  const failure: CompactionFailure = {
    attempt: 1,
    errorName: "CompactionError",
    stopReason: "summarization_failed",
    measuredTokens: 190_000,
    thresholdTokens: 160_000,
  };
  const session: WorkflowSession = {
    ...base,
    async step(state) {
      attempts += 1;
      if (attempts === 1)
        throw new WorkflowStageFailureError(
          new ContextCompactionLostError({
            role: "coder",
            budget: { maxTokens: 180_000, reserveTokens: 20_000, keepRecentTokens: 50_000 },
            measuredTokens: 203_000,
            contextWindow: 200_000,
            failures: [failure],
          }),
          "failed-code",
          { ...failureMetrics },
        );
      return base.step(state);
    },
  };
  const coordinator = new RunCoordinator(session, store, { runId: "budget-pause-resumable" });
  const paused = await coordinator.run();
  // The cause travels, ...
  expect(paused.checkpoint.pause?.cause).toMatchObject({ code: "context_compaction_lost" });
  // ... and naming it must not cost the pause its resumability: the code is
  // still `stage_failed`, which the explicit operator act clears (an
  // unauthorized act is what `resumeStage` refuses).
  expect(clearsOnExplicitAct(paused.checkpoint.pause?.code)).toBe(true);
  coordinator.resumeStage({ source: "operator", action: "retry" });
  expect((await coordinator.run()).status).toBe("complete");
  expect(attempts).toBe(2);
});

test("a recorded stage failure reaches the next attempt and counts recurrences (issue #363)", async () => {
  // Criterion 1: a typed submission rejection must reach the next attempt, so
  // an explicit retry can converge instead of repeating the identical rejected
  // submission forever. The recorded cause travels in the checkpoint's
  // workflowState (the session reads it from there), and the SAME cause on the
  // next attempt is the loop signature -- distinguishable from an
  // underestimate, which would be a stage_limit pause with limit fields.
  const target = root();
  const store = new ProjectStore(target);
  const base = coordinatorSession(store, []);
  let attempts = 0;
  const seenStates: WorkflowState[] = [];
  const session: WorkflowSession = {
    ...base,
    async step(state) {
      attempts += 1;
      seenStates.push(state);
      if (attempts === 1 || attempts === 2) {
        throw new WorkflowStageFailureError(
          new ProjectOperationsError(
            "invalid_follow_up",
            attempts === 1
              ? "kind must be one of contract, note, design-doc-drift, backlog"
              : "evidence must be non-empty",
          ),
          "failed-code",
          { ...failureMetrics },
        );
      }
      if (attempts === 3) {
        throw new WorkflowStageFailureError(
          new OrchestrationError(
            "malformed_plan",
            "failed-code",
            "planner JSON handoff is invalid",
          ),
          "failed-code",
          { ...failureMetrics },
        );
      }
      return base.step(state);
    },
  };
  const coordinator = new RunCoordinator(session, store, { runId: "carry-cause" });
  const first = await coordinator.run();
  expect(first.checkpoint.workflowState.lastStageFailure).toEqual({
    phase: "code",
    code: "invalid_follow_up",
    message: "invalid_follow_up: kind must be one of contract, note, design-doc-drift, backlog",
    recurrence: 0,
  });

  coordinator.resumeStage({ source: "operator", action: "retry" });
  const second = await coordinator.run();
  // Same stage + same code: the recorded pause says so -- a recurrence, not a
  // first failure and not a ceiling underestimate.
  expect(second.checkpoint.pause?.cause).toMatchObject({
    code: "invalid_follow_up",
    recurrence: 1,
  });
  expect(second.checkpoint.pause?.action).toContain("consecutive");
  expect(second.checkpoint.pause?.limitReason).toBeUndefined();
  expect(second.checkpoint.pause?.limit).toBeUndefined();
  expect(seenStates[1]?.lastStageFailure).toMatchObject({ code: "invalid_follow_up" });

  coordinator.resumeStage({ source: "operator", action: "retry" });
  const third = await coordinator.run();
  // A DIFFERENT code restarts the count.
  expect(third.checkpoint.pause?.cause).toMatchObject({
    code: "malformed_plan",
    recurrence: 0,
  });
  expect(third.checkpoint.pause?.action).not.toContain("consecutive");
  expect(third.checkpoint.workflowState.lastStageFailure).toMatchObject({
    code: "malformed_plan",
    recurrence: 0,
  });

  coordinator.resumeStage({ source: "operator", action: "retry" });
  expect((await coordinator.run()).status).toBe("complete");
  expect(attempts).toBe(4);
});

test("an untyped stage failure names itself with a bounded redacted cause (issue #403)", async () => {
  const checkpoint = await pauseOnFailure(
    new Error("plain harness throw\nsecond line is dropped"),
    "untyped-cause",
  );
  const pause = checkpoint.pause;
  expect(pause?.code).toBe("stage_failed");
  expect(pause?.cause?.code).toBe("untyped_error");
  expect(pause?.cause?.message).toBe("Error: plain harness throw");
  expect(pause?.cause?.recurrence).toBe(0);
  // The action names the recorded code token and points the operator at the
  // recorded durable cause; the bounded message itself stays in
  // `cause.message`, not in `action` (the action is bounded to 256 chars by
  // `requiredString`, and the message can reach its 512-char ceiling).
  expect(pause?.action).toContain("untyped_error");
  expect(pause?.action).toContain("recorded durable cause");
  expect(pause?.action).toContain("harness bug");
  expect(pause?.action).toContain("retry the stage explicitly");
  expect(pause?.action).not.toContain("plain harness throw");
  // The old wording sent the operator to inspect a PROVIDER, but a plain
  // throwing error is exactly the harness-side suspect.
  expect(pause?.action).not.toContain("provider failure");
  expect(pause?.action).not.toContain("inspect the provider failure");
  expect(checkpoint.workflowState.lastStageFailure).toEqual({
    phase: "code",
    code: "untyped_error",
    message: "Error: plain harness throw",
    recurrence: 0,
  });
});

test("the untyped cause redacts every credential shape found in the raw message (issue #403 mitigation F1)", async () => {
  const shapes: readonly (readonly [string])[] = [
    ["api_key=sk-1234567890abcdef"],
    // Built by concatenation so the artifact smoke audit does not read this
    // TEST's test literally as a tracked-file AWS credential candidate.
    [`AKIA${"I".repeat(20)}`],
    [`AIza${"S".repeat(35)}`],
    ["eyJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJ0ZXN0In0.abcDEF123"],
    ["Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig"],
    ["token: ghp_1234567890abcdefghij"],
    ["password=hunter2hunter2"],
  ];
  for (const [index, [secret]] of shapes.entries()) {
    const checkpoint = await pauseOnFailure(
      new Error(`transport failed: ${secret}`),
      `redact-${index}`,
    );
    const pause = checkpoint.pause;
    expect(pause?.cause?.code).toBe("untyped_error");
    expect(pause?.cause?.message).toContain("[redacted]");
    expect(JSON.stringify(checkpoint)).not.toContain(secret);
  }
});

test("the untyped cause strips control characters and ANSI escapes (issue #403 mitigation F3)", async () => {
  const checkpoint = await pauseOnFailure(
    new Error("ok\rforged line\u001b[2J\u001b[Hzero\u200bwidth"),
    "control-strip",
  );
  expect(checkpoint.pause?.cause?.message).toContain("forged line");
  // Only printable ASCII survives into durable state (issue #403 mitigation F3).
  const printable = (value: string) =>
    [...value].every((character) => character >= "\x20" && character <= "\x7e");
  expect(printable(checkpoint.pause?.cause?.message ?? "")).toBe(true);
  // The action never carries the cause message (the message stays in
  // `cause.message`, where the printable-ASCII discipline already holds);
  // the action must still be printable-ASCII anyway -- the bounded text it
  // composes is all harness-authored.
  expect(printable(checkpoint.pause?.action ?? "")).toBe(true);
});

test("the untyped cause removes control bytes BEFORE redaction so an embedded secret cannot survive as '?' (issue #403 review round 2)", async () => {
  // A control byte inside the credential token: replacing non-printables
  // AFTER redaction would turn `sk-<ESC>1234...` into `sk-?1234...`, a
  // pattern the redactor no longer matches, leaking the bone of the secret.
  const checkpoint = await pauseOnFailure(
    new Error(`border sk-\u001b1234567890abcdef tail`),
    "strip-before-redact",
  );
  expect(checkpoint.pause?.cause?.code).toBe("untyped_error");
  expect(checkpoint.pause?.cause?.message).toContain("[redacted]");
  expect(JSON.stringify(checkpoint)).not.toContain("sk-?1234567890abcdef");
  expect(JSON.stringify(checkpoint)).not.toContain("1234567890abcdef");
});

test("the untyped cause redacts BEFORE clipping so a boundary-straddling secret leaks nothing (issue #403 mitigation F2)", async () => {
  // Padding puts the credential across the 512-char ceiling: a cap-first
  // implementation would persist a truncated but reconstructible prefix.
  const padding = "p".repeat(505);
  const checkpoint = await pauseOnFailure(
    new Error(`${padding} api_key=sk-1234567890abcdef tail`),
    "redact-before-cap",
  );
  expect(checkpoint.pause?.cause?.message?.length).toBeLessThanOrEqual(512);
  expect(JSON.stringify(checkpoint)).not.toContain("sk-1234567890abcdef");
  expect(JSON.stringify(checkpoint)).not.toContain("api_key=sk");
});

test("an untyped error wrapped in a hostile Proxy still settles the durable cause (issue #403 review round)", async () => {
  // Every read the cause builder makes sits behind the Proxy's traps: a trap
  // that throws must not crash the stage-failure catch (the #412 discipline
  // from console.ts), it must degrade to the fixed `Unknown` fallback.
  const target = new Error("real message behind the proxy");
  const hostile = new Proxy(target, {
    get(_t, property, receiver) {
      if (property === "message") throw new TypeError("no reads");
      return Reflect.get(_t, property, receiver);
    },
    getOwnPropertyDescriptor(): PropertyDescriptor {
      throw new TypeError("no own reads");
    },
  });
  const checkpoint = await pauseOnHostileSource(hostile, "hostile-proxy");
  const pause = checkpoint.pause;
  expect(pause?.code).toBe("stage_failed");
  expect(pause?.cause?.code).toBe("untyped_error");
  // The name read survives the `get` trap through the PROTOTYPE chain; the
  // message line is absent because the `get` trap refuses.
  expect(pause?.cause?.message).toBe("Error:");
  expect(JSON.stringify(checkpoint)).not.toContain("real message");
});

test("a forged or oversized own constructor cannot name the untyped cause (issue #403 review round)", async () => {
  const forged = new Error("honest first line");
  Object.defineProperty(forged, "constructor", {
    value: { name: `Evil<img>${"x".repeat(200)}` },
    enumerable: false,
  });
  const checkpoint = await pauseOnFailure(forged, "forged-constructor");
  expect(checkpoint.pause?.code).toBe("stage_failed");
  expect(checkpoint.pause?.cause?.code).toBe("untyped_error");
  // The PROTOTYPE's constructor names it; the forged own property never read.
  expect(checkpoint.pause?.cause?.message).toBe("Error: honest first line");
  expect(JSON.stringify(checkpoint)).not.toContain("Evil");
});

test("a throwing message getter degrades the line, not the stage (issue #403 review round)", async () => {
  const hostile = new Error("never read");
  Object.defineProperty(hostile, "message", {
    get() {
      throw new TypeError("getter refuses");
    },
  });
  const checkpoint = await pauseOnHostileSource(hostile, "throwing-message");
  expect(checkpoint.pause?.code).toBe("stage_failed");
  expect(checkpoint.pause?.cause?.code).toBe("untyped_error");
  // Deterministic fallback: the constructor keeps naming, the absent line is
  // simply not carried.
  expect(checkpoint.pause?.cause?.message).toBe("Error:");
  expect(JSON.stringify(checkpoint)).not.toContain("never read");
});

test("an unsafe_request pause stays decodable for a maximal message (issue #467)", async () => {
  // The research request's failure used to be interpolated into `action`
  // verbatim: any message over 256 chars made the whole record UNDECODABLE on
  // round-trip (`requiredString` in src/orchestration/background-runs.ts
  // rejects a persisted field over 256 chars) -- the same failure mode #403
  // fixed for the untyped stage action. The action must be bounded BY
  // CONSTRUCTION for any message, adversarial included, and the message must
  // survive bounded, redacted and VISIBLY clipped in the recorded durable
  // cause -- never silently cut.
  const message = `transport failed with api_key=sk-1234567890abcdef after ${"x".repeat(600)}`;
  const target = root();
  const store = new ProjectStore(target);
  const base = coordinatorSession(store, []);
  const session: WorkflowSession = {
    ...base,
    initialState: () => ({ ...coordinatorState(), phase: "research" }),
    prepareResearch: () => {
      throw new Error(message);
    },
  };
  const coordinator = new RunCoordinator(session, store, { runId: "unsafe-request-bound" });
  expect(await coordinator.prepareStep()).toBeUndefined();
  const pause = coordinator.checkpoint.pause;
  expect(pause?.code).toBe("unsafe_request");
  // THE INVARIANT: the composed action fits the 256-char persisted ceiling for
  // ANY message, so the record decodes on round-trip.
  expect(pause?.action.length).toBeLessThanOrEqual(256);
  // The action names the pause's recorded code token and the cause's.
  expect(pause?.action).toContain("unsafe_request");
  expect(pause?.action).toContain("untyped_error");
  // Nothing silently lost: the bounded, redacted message survives in
  // `cause.message` (its own 512-char ceiling), its cut marked, the
  // credential inside it redacted before the clip.
  expect(pause?.cause?.code).toBe("untyped_error");
  expect(pause?.cause?.recurrence).toBe(0);
  expect(pause?.cause?.message?.length).toBeLessThanOrEqual(512);
  expect(pause?.cause?.message?.startsWith("Error: transport failed with [redacted] after")).toBe(
    true,
  );
  expect(pause?.cause?.message?.endsWith("...[clipped]")).toBe(true);
  expect(JSON.stringify(coordinator.checkpoint)).not.toContain("sk-1234567890abcdef");
});

test("a research_rejected pause stays decodable for a maximal message (issue #467)", async () => {
  // Same unbounded interpolation as `unsafe_request` (issue #467): the raw
  // error message became the action, so any message over 256 chars made the
  // record undecodable on round-trip. Same fix shape as the untyped stage
  // action (issue #403): the action names the code tokens and never carries
  // the message; the bounded, redacted message lives in the recorded cause,
  // visibly clipped at its own 512-char ceiling.
  const message = `research transport failed with api_key=sk-1234567890abcdef after ${"x".repeat(600)}`;
  const target = root();
  const store = new ProjectStore(target);
  const base = coordinatorSession(store, []);
  const session: WorkflowSession = {
    ...base,
    initialState: () => ({ ...coordinatorState(), phase: "research" }),
    prepareResearch: () => ({
      effectId: "bounded-research-effect",
      destination: "example.invalid",
      queryHash: "a".repeat(64),
      surfaceIds: [],
    }),
    async step() {
      throw new Error(message);
    },
  };
  const coordinator = new RunCoordinator(session, store, { runId: "research-rejected-bound" });
  expect(await coordinator.prepareStep()).toBeUndefined();
  const pause = coordinator.checkpoint.pause;
  expect(pause?.code).toBe("research_rejected");
  expect(pause?.action.length).toBeLessThanOrEqual(256);
  expect(pause?.action).toContain("research_rejected");
  expect(pause?.action).toContain("untyped_error");
  expect(pause?.cause?.code).toBe("untyped_error");
  expect(pause?.cause?.message?.length).toBeLessThanOrEqual(512);
  expect(
    pause?.cause?.message?.startsWith("Error: research transport failed with [redacted] after"),
  ).toBe(true);
  expect(pause?.cause?.message?.endsWith("...[clipped]")).toBe(true);
  expect(JSON.stringify(coordinator.checkpoint)).not.toContain("sk-1234567890abcdef");
});

test("an untyped failure records lastStageFailure and repeats its loop signature only on an identical cause (issue #403)", async () => {
  const target = root();
  const store = new ProjectStore(target);
  const base = coordinatorSession(store, []);
  let attempts = 0;
  const session: WorkflowSession = {
    ...base,
    async step(state) {
      attempts += 1;
      if (attempts === 1 || attempts === 2) {
        throw new WorkflowStageFailureError(new Error("same untyped"), "failed-code", {
          ...failureMetrics,
        });
      }
      if (attempts === 3) {
        throw new WorkflowStageFailureError(new Error("different untyped"), "failed-code", {
          ...failureMetrics,
        });
      }
      return base.step(state);
    },
  };
  const coordinator = new RunCoordinator(session, store, { runId: "untyped-recurrence" });
  const first = await coordinator.run();
  expect(first.checkpoint.workflowState.lastStageFailure).toEqual({
    phase: "code",
    code: "untyped_error",
    message: "Error: same untyped",
    recurrence: 0,
  });
  coordinator.resumeStage({ source: "operator", action: "retry" });
  const second = await coordinator.run();
  expect(second.checkpoint.pause?.cause).toMatchObject({ code: "untyped_error", recurrence: 1 });
  expect(second.checkpoint.pause?.action).toContain("recorded 2 consecutive times");
  expect(second.checkpoint.pause?.limitReason).toBeUndefined();
  coordinator.resumeStage({ source: "operator", action: "retry" });
  const third = await coordinator.run();
  // A different concrete cause resets the count: every untyped error shares
  // the one code token, so only message identity can bound the loop.
  expect(third.checkpoint.pause?.cause).toMatchObject({
    code: "untyped_error",
    message: "Error: different untyped",
    recurrence: 0,
  });
  expect(third.checkpoint.pause?.action).not.toContain("consecutive");
  coordinator.resumeStage({ source: "operator", action: "retry" });
  expect((await coordinator.run()).status).toBe("complete");
  expect(attempts).toBe(4);
});

/**
 * The review-phase variant of `pauseOnFailure`: the coordinator starts in the
 * review state, so the first `step` throws while `workflowState.phase ===
 * "review"` and the failure settles through the `review_not_run` branch.
 */
async function pauseOnReviewFailure(sourceError: unknown, runId: string): Promise<RunCheckpoint> {
  const target = root();
  const store = new ProjectStore(target);
  const base = coordinatorSession(store, []);
  const session: WorkflowSession = {
    ...base,
    initialState: () => ({ ...coordinatorState(), phase: "review" }),
    async step() {
      throw new WorkflowStageFailureError(sourceError, "failed-review", {
        ...failureMetrics,
      });
    },
  };
  const coordinator = new RunCoordinator(session, store, { runId });
  return (await coordinator.run()).checkpoint;
}

test("a review-phase untyped failure settles the review_not_run pause with its bounded cause (issue #403 review round 4)", async () => {
  const checkpoint = await pauseOnReviewFailure(
    new Error("reviewer harness threw\nsecond line is dropped"),
    "review-untyped-cause",
  );
  const pause = checkpoint.pause;
  expect(pause?.code).toBe("review_not_run");
  expect(pause?.cause).toEqual({
    code: "untyped_error",
    message: "Error: reviewer harness threw",
    recurrence: 0,
  });
  // The action keeps the verdict frame and points the operator at the
  // recorded durable cause plus the harness-bug caveat -- the same
  // discipline as the generic stage_failed path; the bounded message itself
  // stays in `cause.message` so the action stays within the 256-char
  // `requiredString` ceiling.
  expect(pause?.action).toContain("did not run to a verdict");
  expect(pause?.action).toContain("recorded durable cause");
  expect(pause?.action).toContain("harness bug");
  expect(pause?.action).not.toContain("reviewer harness threw");
  // The cause is recorded on the checking exactly like the generic path: the
  // retrying reviewer reads it from the checkpoint's workflowState.
  expect(checkpoint.workflowState.lastStageFailure).toEqual({
    phase: "review",
    code: "untyped_error",
    message: "Error: reviewer harness threw",
    recurrence: 0,
  });
  // A coded pause stays clearable by the same explicit operator act.
  expect(clearsOnExplicitAct(pause?.code)).toBe(true);
});

test("a repeated identical review-phase untyped failure shows the recurrence loop wording (issue #403 review round 4)", async () => {
  const target = root();
  const store = new ProjectStore(target);
  const base = coordinatorSession(store, []);
  const session: WorkflowSession = {
    ...base,
    initialState: () => ({ ...coordinatorState(), phase: "review" }),
    async step() {
      throw new WorkflowStageFailureError(new Error("same reviewer throw"), "failed-review", {
        ...failureMetrics,
      });
    },
  };
  const coordinator = new RunCoordinator(session, store, { runId: "review-untyped-recurrence" });
  const first = await coordinator.run();
  expect(first.checkpoint.pause?.cause).toMatchObject({ code: "untyped_error", recurrence: 0 });
  expect(first.checkpoint.pause?.action).not.toContain("consecutive");
  coordinator.resumeStage({ source: "operator", action: "retry" });
  const second = await coordinator.run();
  // Same stage, same code, same recorded message: a loop, not two unknowns.
  expect(second.checkpoint.pause?.cause).toMatchObject({
    code: "untyped_error",
    message: "Error: same reviewer throw",
    recurrence: 1,
  });
  expect(second.checkpoint.pause?.action).toContain("did not run to a verdict");
  expect(second.checkpoint.pause?.action).toContain("recorded 2 consecutive times");
  expect(second.checkpoint.pause?.action).toContain("harness bug");
  expect(second.checkpoint.workflowState.lastStageFailure).toMatchObject({
    phase: "review",
    code: "untyped_error",
    recurrence: 1,
  });
});

test("an untyped stage failure with a 512-char cause message keeps its action within the 256-char requiredString ceiling (issue #403 round-trip)", async () => {
  // The untyped-failure action composed in src/project-operations/run-coordinator.ts
  // was previously interpolating `cause.message` (bounded at 512 by
  // `MAX_PAUSE_CAUSE_MESSAGE_CHARS` in src/orchestration/types.ts) into static
  // text already over 200 chars -- so the persisted `action` was always
  // longer than 256 chars for a fully-loaded cause. `requiredString`
  // (src/orchestration/background-runs.ts) rejects any persisted record field
  // string over 256 chars, so the background run record and the coordinator
  // checkpoint became unreadable, and `background status` exited 1 with
  // {"error":{"code":"not_found","detail":"background_run"}}. This pins the
  // contract: action.length <= 256 in BOTH variants (first-occurrence and
  // recurrence) of BOTH pause codes (stage_failed and review_not_run) for a
  // message at the 512-char ceiling, while the message itself still reaches
  // the record through `cause.message`.
  const fullCauseMessage = "x".repeat(MAX_PAUSE_CAUSE_MESSAGE_CHARS);
  // The composed `cause.message` is `<constructor>: <first-line>`, clipped
  // VISIBLY (issue #467): a line longer than `MAX_PAUSE_CAUSE_MESSAGE_CHARS`
  // keeps its head and ends in the fixed `...[clipped]` marker, all within
  // the ceiling total, so the persisted message for an Error-sourced cause at
  // the message ceiling is `Error: ` + the clipped head + the marker.
  const persistedMessage = `Error: ${"x".repeat(MAX_PAUSE_CAUSE_MESSAGE_CHARS - "Error: ".length - "...[clipped]".length)}...[clipped]`;

  // First-occurrence stage_failed.
  const stageStore = new ProjectStore(root());
  const stageSession: WorkflowSession = {
    ...coordinatorSession(stageStore, []),
    async step() {
      throw new WorkflowStageFailureError(new Error(fullCauseMessage), "failed-code", {
        ...failureMetrics,
      });
    },
  };
  const stageCoordinator = new RunCoordinator(stageSession, stageStore, {
    runId: "untyped-long-message-stage",
  });
  const first = await stageCoordinator.run();
  expect(first.checkpoint.pause?.code).toBe("stage_failed");
  expect(first.checkpoint.pause?.cause?.code).toBe("untyped_error");
  expect(first.checkpoint.pause?.cause?.message).toBe(persistedMessage);
  expect(first.checkpoint.pause?.cause?.recurrence).toBe(0);
  expect(first.checkpoint.pause?.action?.length ?? Number.MAX_SAFE_INTEGER).toBeLessThanOrEqual(
    256,
  );
  // Recurrence stage_failed: same cause, same code -> count climbs.
  stageCoordinator.resumeStage({ source: "operator", action: "retry" });
  const second = await stageCoordinator.run();
  expect(second.checkpoint.pause?.code).toBe("stage_failed");
  expect(second.checkpoint.pause?.cause?.code).toBe("untyped_error");
  expect(second.checkpoint.pause?.cause?.recurrence).toBe(1);
  expect(second.checkpoint.pause?.cause?.message).toBe(persistedMessage);
  expect(second.checkpoint.pause?.action?.length ?? Number.MAX_SAFE_INTEGER).toBeLessThanOrEqual(
    256,
  );

  // First-occurrence review_not_run.
  const reviewStore = new ProjectStore(root());
  const reviewSession: WorkflowSession = {
    ...coordinatorSession(reviewStore, []),
    initialState: () => ({ ...coordinatorState(), phase: "review" }),
    async step() {
      throw new WorkflowStageFailureError(new Error(fullCauseMessage), "failed-review", {
        ...failureMetrics,
      });
    },
  };
  const reviewCoordinator = new RunCoordinator(reviewSession, reviewStore, {
    runId: "untyped-long-message-review",
  });
  const reviewFirst = await reviewCoordinator.run();
  expect(reviewFirst.checkpoint.pause?.code).toBe("review_not_run");
  expect(reviewFirst.checkpoint.pause?.cause?.code).toBe("untyped_error");
  expect(reviewFirst.checkpoint.pause?.cause?.recurrence).toBe(0);
  expect(reviewFirst.checkpoint.pause?.cause?.message).toBe(persistedMessage);
  expect(
    reviewFirst.checkpoint.pause?.action?.length ?? Number.MAX_SAFE_INTEGER,
  ).toBeLessThanOrEqual(256);
  // Recurrence review_not_run.
  reviewCoordinator.resumeStage({ source: "operator", action: "retry" });
  const reviewRecurrence = await reviewCoordinator.run();
  expect(reviewRecurrence.checkpoint.pause?.code).toBe("review_not_run");
  expect(reviewRecurrence.checkpoint.pause?.cause?.code).toBe("untyped_error");
  expect(reviewRecurrence.checkpoint.pause?.cause?.recurrence).toBe(1);
  expect(reviewRecurrence.checkpoint.pause?.cause?.message).toBe(persistedMessage);
  expect(
    reviewRecurrence.checkpoint.pause?.action?.length ?? Number.MAX_SAFE_INTEGER,
  ).toBeLessThanOrEqual(256);
});

test("RunCoordinator durably pauses a cooperatively interrupted workflow and resumes it", async () => {
  const target = root();
  const store = new ProjectStore(target);
  let interrupted = true;
  const coordinator = new RunCoordinator(coordinatorSession(store, []), store, {
    runId: "interrupted-workflow",
    interrupted: () => interrupted,
  });
  const paused = await coordinator.run();
  expect(paused.checkpoint.pause).toEqual({
    phase: "code",
    code: "interrupted",
    action: "resume the interrupted workflow explicitly",
  });

  interrupted = false;
  coordinator.resumeStage({ source: "operator", action: "retry" });
  expect((await coordinator.run()).status).toBe("complete");
});

test("RunCoordinator durably pauses a limited stage and resumes only that stage", async () => {
  const target = root();
  const store = new ProjectStore(target);
  const base = coordinatorSession(store, []);
  let attempts = 0;
  const session: WorkflowSession = {
    ...base,
    stageLimits: { maxDurationMs: 10 },
    async step(state) {
      attempts += 1;
      if (attempts === 1) {
        const limit = new StageLimitError("duration", 10, 10, {
          maxDurationMs: 10,
          maxModelTurns: 0,
          maxToolTurns: 0,
          maxInputTokens: 0,
          maxCostUsd: 0,
          finalResponseReserveModelTurns: 0,
          finalResponseReserveDurationMs: 0,
          finalResponseReserveToolTurns: 0,
          finalResponseReserveInputTokens: 0,
          elapsedMs: 10,
          modelTurns: 1,
          toolTurns: 1,
          inputTokens: 7,
          lastInputTokens: 7,
          costUsd: 0.25,
          costInFlight: false,
        });
        throw new WorkflowStageLimitError(limit, "paused-code", {
          stage: "code:1",
          status: "paused",
          input: 7,
          cachedInput: 2,
          freshInput: 5,
          output: 3,
          costUsd: 0.25,
          requestBytes: { systemPrompt: 0, prompt: 0, toolDefinitions: 0, total: 0 },
          readFiles: [],
          readFilesTotal: 0,
          readFilesTruncated: 0,
          diffBytes: 0,
          contextStrategy: "auto",
        });
      }
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
    limitReason: "duration",
    limit: 10,
  });
  expect(attempts).toBe(1);
  expect(paused.checkpoint.workflowState.runIds).toEqual(["paused-code"]);
  expect(paused.checkpoint.workflowState.stageMetrics).toEqual([
    expect.objectContaining({ stage: "code:1", status: "paused", costUsd: 0.25 }),
  ]);
  expect(paused.checkpoint.workflowState.activeStage).toMatchObject({
    phase: "code",
    step: "code:1",
    runId: "paused-code",
    metrics: expect.objectContaining({ status: "paused", costUsd: 0.25 }),
    snapshot: {
      elapsedMs: 10,
      modelTurns: 1,
      toolTurns: 1,
      inputTokens: 7,
      lastInputTokens: 7,
      costUsd: 0.25,
    },
  });
  expect(() => coordinator.resumeStage({ source: "operator", action: "retry" })).toThrow(
    "unchanged duration stage limit",
  );
  const resumed = new RunCoordinator(
    { ...session, stageLimits: { maxDurationMs: 20 } },
    new ProjectStore(target),
    { runId: "stage-limit-pause", resumeExisting: true },
  );
  resumed.resumeStage({ source: "operator", action: "retry" });
  const completed = await resumed.run();
  expect(completed.status).toBe("complete");
  expect(completed.checkpoint.workflowState.stageMetrics).toEqual(
    paused.checkpoint.workflowState.stageMetrics,
  );
  expect(attempts).toBe(2);

  // A raise lands on the ROLE that ran the paused stage, not on the session
  // default: the orchestrator raises `coder` when the code stage exhausts its
  // budget (issue #208). Validating against the session-wide ceiling saw an
  // unchanged number and refused the raise, leaving the run unresumable however
  // large the new ceiling was -- observed live, two resumes at 900000ms both
  // rejected against the 180000ms default, so the pipeline could not progress
  // past a stage that legitimately needed longer.
  const roleTarget = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-role-raise-"));
  let roleAttempts = 0;
  const roleSession = {
    ...base,
    stageLimits: { maxDurationMs: 10 },
    async step(state: WorkflowState) {
      roleAttempts += 1;
      if (roleAttempts === 1) {
        const limit = new StageLimitError("duration", 10, 10, {
          maxDurationMs: 10,
          maxModelTurns: 0,
          maxToolTurns: 0,
          maxInputTokens: 0,
          maxCostUsd: 0,
          finalResponseReserveModelTurns: 0,
          finalResponseReserveDurationMs: 0,
          finalResponseReserveToolTurns: 0,
          finalResponseReserveInputTokens: 0,
          elapsedMs: 10,
          modelTurns: 1,
          toolTurns: 1,
          inputTokens: 7,
          lastInputTokens: 7,
          costUsd: 0.25,
          costInFlight: false,
        });
        throw new WorkflowStageLimitError(limit, "role-paused-code", {
          stage: "code:1",
          status: "paused",
          input: 7,
          cachedInput: 2,
          freshInput: 5,
          output: 3,
          costUsd: 0.25,
          requestBytes: { systemPrompt: 0, prompt: 0, toolDefinitions: 0, total: 0 },
          readFiles: [],
          readFilesTotal: 0,
          readFilesTruncated: 0,
          diffBytes: 0,
          contextStrategy: "auto",
        });
      }
      return base.step(state);
    },
  };
  const rolePaused = await new RunCoordinator(roleSession, new ProjectStore(roleTarget), {
    runId: "role-raise",
  }).run();
  expect(rolePaused.status).toBe("paused");

  // The session ceiling is deliberately left at its original value: this is
  // exactly the shape the orchestrator produces, and reading it instead of the
  // role's would see "unchanged" and refuse.
  const roleRaised = new RunCoordinator(
    {
      ...roleSession,
      stageLimits: { maxDurationMs: 10 },
      roleStageLimits: { coder: { maxDurationMs: 40 } },
    },
    new ProjectStore(roleTarget),
    { runId: "role-raise", resumeExisting: true },
  );
  roleRaised.resumeStage({ source: "host_config", action: "retry" });
  expect((await roleRaised.run()).status).toBe("complete");
  fs.rmSync(roleTarget, { recursive: true, force: true });
});

/**
 * The drift alarm for the explicit-act pause table (issue #315's live resume).
 *
 * THE CONTRACT: `PAUSES_CLEARED_BY_AN_EXPLICIT_ACT` must list exactly the
 * codes `resumeStage`'s guard accepts from source `operator`/`host_config`.
 * Both fronts (the orchestrator's `resume_pipeline`, the CLI's
 * `drive --resume-run`) clear an accepted pause through this table, so if the
 * table and the guard drift apart one of two things breaks:
 *
 * - a code missing from the table (first half) means a front refuses to clear
 *   a pause the coordinator would honour -- the `plan_not_submitted` pause
 *   could never be resumed, observed live in
 *   e4ccfbdb-37b1-47bd-8bc3-3d5e6ac5372f;
 * - a code IN the table but not in the guard (second half) means a front
 *   clears a pause the coordinator then rejects, stranding the operator.
 */
test("RunCoordinator's explicit-act pause table and resumeStage guard agree on both sides", async () => {
  const target = root();
  const store = new ProjectStore(target);
  const base = coordinatorSession(store, []);
  // The contract pinned from BOTH directions: the exported table must equal
  // this expected list exactly (removal, addition or rename all fail here),
  // and each candidate must behave as the guard does (clear vs. refuse).
  // `expectedTable` is the independent enumeration the exactness needs; edits
  // to the table are supposed to fail here until both sides are updated.
  const expectedTable: string[] = [
    "stage_limit",
    "stage_failed",
    "provider_rejected",
    "interrupted",
    "review_not_run",
    "plan_not_submitted",
    "plan_not_json",
  ];
  expect([...(PAUSES_CLEARED_BY_AN_EXPLICIT_ACT as readonly string[])].sort()).toEqual(
    expectedTable.slice().sort(),
  );
  const tableSet = new Set<string>(PAUSES_CLEARED_BY_AN_EXPLICIT_ACT);
  const knownRejectedCodes: readonly string[] = [
    "ambiguous_dispatch",
    "researcher_unavailable",
    "unsafe_request",
  ];
  const candidates: readonly string[] = [...expectedTable, ...knownRejectedCodes];
  for (const code of candidates) {
    const runId = `table-${code}`;
    // `stage_limit` needs its limit evidence for the raise check in resumeStage.
    const pause: NonNullable<RunCheckpoint["pause"]> =
      code === "stage_limit"
        ? {
            phase: "code",
            code,
            action: "increase or disable the limit",
            limitReason: "duration",
            limit: 10,
          }
        : { phase: "code", code, action: "resume the stage explicitly" };
    const checkpoint: RunCheckpoint = {
      schemaVersion: 1,
      runId,
      phase: "workflow",
      workflowState: coordinatorState(),
      followUps: [],
      completedEffects: [],
      decisions: [],
      contractReviews: [],
      pause,
    };
    fs.mkdirSync(store.layout.runs, { recursive: true });
    const checkpointPath = path.join(store.layout.runs, `coordinator-${runId}.json`);
    store.writeVersionedJson(checkpointPath, checkpoint, 0);
    const coordinator = new RunCoordinator(base, store, { runId });
    expect(coordinator.checkpoint.pause?.code).toBe(code);
    if (code === "stage_limit") continue; // covered separately by its own test
    if (tableSet.has(code)) {
      coordinator.resumeStage({ source: "operator", action: "retry" });
      expect(store.readVersionedJson<RunCheckpoint>(checkpointPath).value.pause).toBeUndefined();
    } else {
      expect(() => coordinator.resumeStage({ source: "operator", action: "retry" })).toThrow(
        new ProjectOperationsError("unauthorized_resolution", runId),
      );
      // The guard refused: the checkpoint must keep its pause.
      expect(store.readVersionedJson<RunCheckpoint>(checkpointPath).value.pause).toBeDefined();
    }
  }

  // The negative half spelled out for the pause the work names: `ambiguous_dispatch`
  // is a research-phase pause handled by `resumeResearch`, NOT by the stage guard. If
  // the table ever grew to include it, a front would clear a pause `resumeStage` refuses.
  const runId = "table-ambiguous-dispatch";
  const checkpoint: RunCheckpoint = {
    schemaVersion: 1,
    runId,
    phase: "workflow",
    workflowState: coordinatorState(),
    followUps: [],
    completedEffects: [],
    decisions: [],
    contractReviews: [],
    pause: {
      phase: "research",
      code: "ambiguous_dispatch",
      action: "reconcile the provider effect by its effectId, then resume explicitly",
    },
  };
  const ambiguousPath = path.join(store.layout.runs, `coordinator-${runId}.json`);
  store.writeVersionedJson(ambiguousPath, checkpoint, 0);
  const coordinator = new RunCoordinator(base, store, { runId });
  expect(() => coordinator.resumeStage({ source: "operator", action: "retry" })).toThrow(
    new ProjectOperationsError("unauthorized_resolution", runId),
  );
  expect(store.readVersionedJson<RunCheckpoint>(ambiguousPath).value.pause).toBeDefined();
});

test("RunCoordinator retains safe usage from a rejected research stage", async () => {
  const store = new ProjectStore(root());
  const base = coordinatorSession(store, []);
  const session: WorkflowSession = {
    ...base,
    initialState: () => ({ ...coordinatorState(), phase: "research" }),
    prepareResearch: () => ({
      effectId: "failed-research-effect",
      destination: "example.invalid",
      queryHash: "a".repeat(64),
      surfaceIds: [],
    }),
    async step() {
      throw new WorkflowStageFailureError(new Error("transport failed"), "failed-research", {
        stage: "research",
        status: "paused",
        provider: "faux",
        model: "faux-1",
        thinkingLevel: "low",
        durationMs: 0,
        input: 12,
        cachedInput: 8,
        freshInput: 4,
        output: 3,
        reasoning: 1,
        costUsd: 0.25,
        requestBytes: { systemPrompt: 0, prompt: 0, toolDefinitions: 0, total: 0 },
        readFiles: [],
        readFilesTotal: 0,
        readFilesTruncated: 0,
        diffBytes: 0,
        contextStrategy: "auto",
      });
    },
  };
  const coordinator = new RunCoordinator(session, store, { runId: "failed-research-usage" });
  expect(await coordinator.prepareStep()).toBeUndefined();
  expect(coordinator.checkpoint.pause?.code).toBe("research_rejected");
  expect(coordinator.checkpoint.workflowState.runIds).toContain("failed-research");
  expect(coordinator.checkpoint.workflowState.stageMetrics?.at(-1)).toMatchObject({
    stage: "research",
    costUsd: 0.25,
    input: 12,
  });
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
        issues: [
          {
            severity: "major",
            findingId: "rule-not-satisfied",
            what: "Rule is not satisfied",
            location: "src/example.ts:1",
            closureCriterion: "the focused regression test passes",
          },
        ],
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
