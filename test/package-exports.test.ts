import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import type {
  ApiKind,
  AvailableTransition,
  BacklogItem,
  BacklogState,
  BacklogStore,
  BudgetPercents,
  Complexity,
  ConfigurableRole,
  ConsoleExitReason,
  ConsoleOutputMode,
  ConsoleRunResult,
  ContextBudget,
  ContextBudgetPercents,
  ConversationConfig,
  ConversationSession,
  ConversationStepOptions,
  ConversationToolCall,
  ConversationTurnResult,
  CostReport,
  CredentialSource,
  DefaultProfileModels,
  DriveErrorCode,
  Driver,
  DriveWorkflowParams,
  FollowUp,
  GateReport,
  GitHubCommandExecutor,
  ImportedLdoResumeResult,
  IssueSeverity,
  LdoImportManifest,
  LdoProjectDetection,
  ModelConfig,
  OrchestrationErrorCode,
  Orchestrator,
  OrchestratorConfig,
  OrchestratorDeps,
  OrchestratorErrorCode,
  PipelineConfig,
  PipelineResult,
  PipelineRouting,
  PipelineStageMetrics,
  Plan,
  PlanCapture,
  Profile,
  ProfileEntry,
  ProfileErrorCode,
  ProfileRole,
  ProjectOperationsConfig,
  ProjectStoreConfig,
  ProjectStoreLayout,
  PromptErrorCode,
  ProviderConfig,
  PublishingCommandExecutor,
  PublishingGate,
  PublishingResult,
  QualityGate,
  RegistryConfig,
  RegistryErrorCode,
  RepositoryPublishingConfig,
  RepositoryPublishingPreflight,
  ResolvableProvider,
  ResolvedRegistry,
  ResolvedSelection,
  ResolvePipelineConfigOptions,
  ResolvePromptOptions,
  RoleObservations,
  RoleRunner,
  RoleSpec,
  RoundRecord,
  RunConsoleParams,
  RunPipelineResult,
  RunRoleOptions,
  RunRoleParams,
  RunRoleResult,
  SecuritySurface,
  SessionLimitReason,
  SessionLimitSnapshot,
  SessionLimits,
  SpawnOverride,
  StepCost,
  StepResult,
  StepView,
  Summarizer,
  Tool,
  ToolActivityConfig,
  ToolActivityEvent,
  ToolActivityRecord,
  TransitionKind,
  Verdict,
  VerdictCapture,
  VerdictIssue,
  VerdictStatus,
  WorkflowDefaults,
  WorkflowModule,
  WorkflowPhase,
  WorkflowState,
} from "ad-coder";
import {
  aggregateFollowUps,
  anthropicCompatiblePreset,
  applyTransition,
  assertContextFitsBudget,
  assertSummarizerWindow,
  assertTurnFitsBudget,
  attachDurableCompaction,
  autoDriver,
  BACKLOG_STATES,
  buildDefaultProfile,
  buildOrchestratorTools,
  buildPublishingPrBody,
  buildSubmitPlanTool,
  buildSubmitVerdictTool,
  CHOOSE_TRANSITION_TOOL_NAME,
  COMPACTION_SAFETY_PROMPT,
  ContextBudgetError,
  ContextCompactionLostError,
  compactionLostErrorFrom,
  copyProjectAttachment,
  createBacklogStore,
  createOrchestrator,
  createProjectStore,
  createRoleRunner,
  createSummarizer,
  createWorkflowSession,
  DEFAULT_CONSOLE_MAX_INPUT_BYTES,
  DEFAULT_CONTEXT_BUDGET_PERCENTS,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_PROJECT_OPERATIONS_CONFIG,
  DEFAULT_REPOSITORY_PUBLISHING_CONFIG,
  DEFAULT_RUN_STOP_KILL_AFTER_MS,
  DEFAULT_TOOL_ACTIVITY_CONFIG,
  DocumentationRouter,
  DriveError,
  deepseekPreset,
  defineTool,
  deleteProjectSession,
  deriveContextBudget,
  describeCompactionFailure,
  detectLdoProject,
  diffUsage,
  driveWorkflow,
  durableCompactionSettings,
  FileBacklogStore,
  finishRepositoryPublishing,
  GateRunner,
  GitHubBacklogStore,
  importLdoArtifacts,
  inspectImportedLdoWork,
  isWorkflowModule,
  Ledger,
  LiveRetryCoordinator,
  listProjectSessions,
  OrchestrationError,
  OrchestratorError,
  openaiCodexPreset,
  openaiCompatiblePreset,
  openrouterPreset,
  ProfileError,
  ProjectOperationsError,
  ProjectStore,
  ProjectStoreError,
  PromptError,
  ProviderAdmissionController,
  ProviderLimitError,
  parseProfile,
  parseRegistryConfig,
  preflightRepositoryPublishing,
  previewLdoImport,
  probeBacklogMigration,
  probeGitHubBacklogCapability,
  projectBacklogFollowUp,
  RESUME_PIPELINE_TOOL_NAME,
  RegistryError,
  RUN_PIPELINE_TOOL_NAME,
  RUN_STEP_TOOL_NAME,
  RunnerError,
  resolvePipelineConfig,
  resolveProfile,
  resolvePrompt,
  resolveRegistry,
  resolveRepositoryPublishingConfig,
  resolveTargetDir,
  resumeImportedLdoWork,
  resumeProjectSession,
  routeDocumentationFollowUp,
  runConsole,
  runPipeline,
  runRole,
  SessionLimitController,
  SessionLimitError,
  SHOW_COST_TOOL_NAME,
  StageLimitController,
  StageLimitError,
  SUBMIT_PLAN_TOOL_NAME,
  SUBMIT_VERDICT_TOOL_NAME,
  SUMMARIZATION_PROMPT,
  silentNoopWarning,
  stampBodyCheckErrors,
  stampCheckErrors,
  stampDeliveryText,
  startConversation,
  startOrchestrator,
  startRepositoryPublishing,
  stopRun,
  suggestBacklogMigrationOnce,
  ToolActivityChannel,
  toolCallCounts,
  UsageDeltaTracker,
  validateFollowUp,
} from "ad-coder";
import { type DevManifest, devManifest, devVersionFromTag } from "../scripts/dev-package";

// The README documents `from "ad-coder"` as the public surface, which only
// works while package.json's `exports` self-reference resolves. A type-only
// import would be erased before the resolver ever ran, so these are value
// imports and this call is what proves the module was really loaded.
test("the package is importable by its published name", () => {
  const workflow: WorkflowModule = {
    name: "self-import",
    async run() {
      return null;
    },
  };
  expect(isWorkflowModule(workflow)).toBe(true);
  expect(typeof diffUsage).toBe("function");
  expect(typeof toolCallCounts).toBe("function");
  expect(typeof UsageDeltaTracker).toBe("function");
  expect(typeof Ledger).toBe("function");
  expect(typeof ToolActivityChannel).toBe("function");
  expect(DEFAULT_TOOL_ACTIVITY_CONFIG.maxEventBytes).toBeGreaterThan(0);
  expect(typeof ContextCompactionLostError).toBe("function");
  expect(typeof ContextBudgetError).toBe("function");
  expect(typeof assertTurnFitsBudget).toBe("function");
  expect(typeof assertContextFitsBudget).toBe("function");
  expect(typeof createSummarizer).toBe("function");
  expect(typeof SUMMARIZATION_PROMPT).toBe("string");
  expect(typeof attachDurableCompaction).toBe("function");
  expect(typeof durableCompactionSettings).toBe("function");
  expect(typeof compactionLostErrorFrom).toBe("function");
  expect(typeof describeCompactionFailure).toBe("function");
  expect(typeof COMPACTION_SAFETY_PROMPT).toBe("string");
  expect(typeof GateRunner).toBe("function");
  expect(typeof runRole).toBe("function");
  expect(typeof ProviderLimitError).toBe("function");
  expect(typeof ProviderAdmissionController).toBe("function");
  expect(typeof LiveRetryCoordinator).toBe("function");
  expect(typeof ProjectStore).toBe("function");
  expect(typeof ProjectStoreError).toBe("function");
  expect(typeof ProjectOperationsError).toBe("function");
  expect(typeof detectLdoProject).toBe("function");
  expect(typeof previewLdoImport).toBe("function");
  expect(typeof importLdoArtifacts).toBe("function");
  expect(typeof inspectImportedLdoWork).toBe("function");
  expect(typeof resumeImportedLdoWork).toBe("function");
  expect(typeof validateFollowUp).toBe("function");
  expect(typeof aggregateFollowUps).toBe("function");
  expect(typeof projectBacklogFollowUp).toBe("function");
  expect(typeof routeDocumentationFollowUp).toBe("function");
  expect(typeof FileBacklogStore).toBe("function");
  expect(typeof createBacklogStore).toBe("function");
  expect(Array.isArray(BACKLOG_STATES)).toBe(true);
  expect(DEFAULT_PROJECT_OPERATIONS_CONFIG.backlogBackend).toBe("files");
  expect(typeof DocumentationRouter).toBe("function");
  expect(typeof GitHubBacklogStore).toBe("function");
  expect(typeof probeGitHubBacklogCapability).toBe("function");
  expect(typeof probeBacklogMigration).toBe("function");
  expect(typeof suggestBacklogMigrationOnce).toBe("function");
  expect(typeof buildPublishingPrBody).toBe("function");
  expect(typeof preflightRepositoryPublishing).toBe("function");
  expect(typeof startRepositoryPublishing).toBe("function");
  expect(typeof finishRepositoryPublishing).toBe("function");
  expect(typeof resolveRepositoryPublishingConfig).toBe("function");
  expect(DEFAULT_REPOSITORY_PUBLISHING_CONFIG.gate).toBe("local");
  expect(typeof createProjectStore).toBe("function");
  expect(typeof startConversation).toBe("function");
  expect(typeof createRoleRunner).toBe("function");
  expect(typeof defineTool).toBe("function");
  expect(typeof RunnerError).toBe("function");
  expect(typeof resolveTargetDir).toBe("function");
  expect(typeof runPipeline).toBe("function");
  expect(typeof StageLimitController).toBe("function");
  expect(typeof StageLimitError).toBe("function");
  expect(typeof createWorkflowSession).toBe("function");
  expect(typeof applyTransition).toBe("function");
  expect(typeof autoDriver).toBe("function");
  expect(typeof OrchestrationError).toBe("function");
  expect(typeof buildSubmitVerdictTool).toBe("function");
  expect(typeof SUBMIT_VERDICT_TOOL_NAME).toBe("string");
  expect(typeof buildSubmitPlanTool).toBe("function");
  expect(typeof SUBMIT_PLAN_TOOL_NAME).toBe("string");
  expect(typeof parseRegistryConfig).toBe("function");
  expect(typeof resolveRegistry).toBe("function");
  expect(typeof parseProfile).toBe("function");
  expect(typeof resolveProfile).toBe("function");
  expect(typeof buildDefaultProfile).toBe("function");
  expect(typeof ProfileError).toBe("function");
  expect(typeof deepseekPreset).toBe("function");
  expect(typeof openrouterPreset).toBe("function");
  expect(typeof openaiCompatiblePreset).toBe("function");
  expect(typeof anthropicCompatiblePreset).toBe("function");
  expect(typeof openaiCodexPreset).toBe("function");
  expect(typeof RegistryError).toBe("function");
  expect(typeof resolvePrompt).toBe("function");
  expect(typeof resolvePipelineConfig).toBe("function");
  expect(typeof PromptError).toBe("function");
  expect(typeof DriveError).toBe("function");
  expect(typeof driveWorkflow).toBe("function");
  expect(typeof runConsole).toBe("function");
  expect(DEFAULT_CONSOLE_MAX_INPUT_BYTES).toBe(65_536);
  expect(typeof silentNoopWarning).toBe("function");
  expect(typeof createOrchestrator).toBe("function");
  expect(typeof buildOrchestratorTools).toBe("function");
  expect(typeof startOrchestrator).toBe("function");
  expect(typeof SessionLimitController).toBe("function");
  expect(typeof SessionLimitError).toBe("function");
  expect(typeof OrchestratorError).toBe("function");
  expect(typeof RUN_PIPELINE_TOOL_NAME).toBe("string");
  expect(typeof RESUME_PIPELINE_TOOL_NAME).toBe("string");
  expect(typeof RUN_STEP_TOOL_NAME).toBe("string");
  expect(typeof CHOOSE_TRANSITION_TOOL_NAME).toBe("string");
  expect(typeof SHOW_COST_TOOL_NAME).toBe("string");
  expect(DEFAULT_CONTEXT_WINDOW).toBe(200_000);
  expect(DEFAULT_CONTEXT_BUDGET_PERCENTS.maxTokensPercent).toBe(0.8);
  expect(typeof deriveContextBudget).toBe("function");
  expect(typeof assertSummarizerWindow).toBe("function");
  expect(typeof stopRun).toBe("function");
  expect(DEFAULT_RUN_STOP_KILL_AFTER_MS).toBe(2_000);
  expect(typeof stampDeliveryText).toBe("function");
  expect(typeof stampCheckErrors).toBe("function");
  expect(typeof stampBodyCheckErrors).toBe("function");
  const _budgetPercents: BudgetPercents | undefined = undefined;
  const _contextBudgetPercents: ContextBudgetPercents | undefined = undefined;
  const _configurableRole: ConfigurableRole | undefined = undefined;
  const _resolvableProvider: ResolvableProvider | undefined = undefined;
  const _resolveConfigOpts: ResolvePipelineConfigOptions | undefined = undefined;
  const _storeConfig: ProjectStoreConfig | undefined = undefined;
  const _storeLayout: ProjectStoreLayout | undefined = undefined;
  const _operationsConfig: ProjectOperationsConfig | undefined = undefined;
  const _followUp: FollowUp | undefined = undefined;
  const _backlogItem: BacklogItem | undefined = undefined;
  const _backlogState: BacklogState | undefined = undefined;
  const _backlogStore: BacklogStore | undefined = undefined;
  const _githubExecutor: GitHubCommandExecutor | undefined = undefined;
  const _publishingExecutor: PublishingCommandExecutor | undefined = undefined;
  const _publishingGate: PublishingGate | undefined = undefined;
  const _publishingResult: PublishingResult | undefined = undefined;
  const _publishingConfig: RepositoryPublishingConfig | undefined = undefined;
  const _publishingPreflight: RepositoryPublishingPreflight | undefined = undefined;
  const _stageMetrics: PipelineStageMetrics | undefined = undefined;
  const _roleObservations: RoleObservations | undefined = undefined;
  const _toolActivityConfig: ToolActivityConfig | undefined = undefined;
  const _toolActivityEvent: ToolActivityEvent | undefined = undefined;
  const _toolActivityRecord: ToolActivityRecord | undefined = undefined;
  expect(_budgetPercents).toBeUndefined();
  expect(_contextBudgetPercents).toBeUndefined();
  expect(_configurableRole).toBeUndefined();
  expect(_resolvableProvider).toBeUndefined();
  expect(_resolveConfigOpts).toBeUndefined();
  expect(_storeConfig).toBeUndefined();
  expect(_storeLayout).toBeUndefined();
  expect(_operationsConfig).toBeUndefined();
  expect(_followUp).toBeUndefined();
  expect(_backlogItem).toBeUndefined();
  expect(_backlogState).toBeUndefined();
  expect(_backlogStore).toBeUndefined();
  expect(_githubExecutor).toBeUndefined();
  expect(_publishingExecutor).toBeUndefined();
  expect(_publishingGate).toBeUndefined();
  expect(_publishingResult).toBeUndefined();
  expect(_publishingConfig).toBeUndefined();
  expect(_publishingPreflight).toBeUndefined();
  expect(_stageMetrics).toBeUndefined();
  expect(_roleObservations).toBeUndefined();
  expect(_toolActivityConfig).toBeUndefined();
  expect(_toolActivityEvent).toBeUndefined();
  expect(_toolActivityRecord).toBeUndefined();
  // Type-only imports are erased; reference them so the imports are not unused.
  const _budget: ContextBudget | undefined = undefined;
  const _summarizer: Summarizer | undefined = undefined;
  const _tool: Tool | undefined = undefined;
  const _gate: QualityGate | undefined = undefined;
  const _report: GateReport | undefined = undefined;
  const _params: RunRoleParams | undefined = undefined;
  const _result: RunRoleResult | undefined = undefined;
  const _convConfig: ConversationConfig | undefined = undefined;
  const _convSession: ConversationSession | undefined = undefined;
  const _convStepOpts: ConversationStepOptions | undefined = undefined;
  const _convToolCall: ConversationToolCall | undefined = undefined;
  const _convTurnResult: ConversationTurnResult | undefined = undefined;
  const _consoleExitReason: ConsoleExitReason | undefined = undefined;
  const _consoleOutputMode: ConsoleOutputMode | undefined = undefined;
  const _consoleRunResult: ConsoleRunResult | undefined = undefined;
  const _runConsoleParams: RunConsoleParams | undefined = undefined;
  expect(_convConfig).toBeUndefined();
  expect(_convSession).toBeUndefined();
  expect(_convStepOpts).toBeUndefined();
  expect(_convToolCall).toBeUndefined();
  expect(_convTurnResult).toBeUndefined();
  expect(_consoleExitReason).toBeUndefined();
  expect(_consoleOutputMode).toBeUndefined();
  expect(_consoleRunResult).toBeUndefined();
  expect(_runConsoleParams).toBeUndefined();
  const _opts: RunRoleOptions | undefined = undefined;
  const _runner: RoleRunner | undefined = undefined;
  const _capture: VerdictCapture | undefined = undefined;
  const _planCapture: PlanCapture | undefined = undefined;
  const _complexity: Complexity | undefined = undefined;
  const _securitySurface: SecuritySurface | undefined = undefined;
  const _plan: Plan | undefined = undefined;
  const _verdict: Verdict | undefined = undefined;
  const _issue: VerdictIssue | undefined = undefined;
  const _status: VerdictStatus | undefined = undefined;
  const _severity: IssueSeverity | undefined = undefined;
  const _spec: RoleSpec | undefined = undefined;
  const _round: RoundRecord | undefined = undefined;
  const _pipelineConfig: PipelineConfig | undefined = undefined;
  const _pipelineResult: PipelineResult | undefined = undefined;
  const _pipelineRouting: PipelineRouting | undefined = undefined;
  expect(_pipelineRouting).toBeUndefined();
  const _workflowState: WorkflowState | undefined = undefined;
  const _stepResult: StepResult | undefined = undefined;
  const _availableTransition: AvailableTransition | undefined = undefined;
  const _transitionKind: TransitionKind | undefined = undefined;
  const _workflowPhase: WorkflowPhase | undefined = undefined;
  const _workflowDefaults: WorkflowDefaults | undefined = undefined;
  const _driver: Driver | undefined = undefined;
  const _ldoManifest: LdoImportManifest | undefined = undefined;
  const _ldoDetection: LdoProjectDetection | undefined = undefined;
  const _ldoResume: ImportedLdoResumeResult | undefined = undefined;
  const _driveErrorCode: DriveErrorCode | undefined = undefined;
  const _driveParams: DriveWorkflowParams | undefined = undefined;
  expect(_driveErrorCode).toBeUndefined();
  expect(_driveParams).toBeUndefined();
  expect(_workflowState).toBeUndefined();
  expect(_stepResult).toBeUndefined();
  expect(_availableTransition).toBeUndefined();
  expect(_transitionKind).toBeUndefined();
  expect(_workflowPhase).toBeUndefined();
  expect(_workflowDefaults).toBeUndefined();
  expect(_driver).toBeUndefined();
  expect(_ldoManifest).toBeUndefined();
  expect(_ldoDetection).toBeUndefined();
  expect(_ldoResume).toBeUndefined();
  const _orchCode: OrchestrationErrorCode | undefined = undefined;
  const _orchestrator: Orchestrator | undefined = undefined;
  const _orchestratorDeps: OrchestratorDeps | undefined = undefined;
  const _orchestratorConfig: OrchestratorConfig | undefined = undefined;
  const _orchestratorErrCode: OrchestratorErrorCode | undefined = undefined;
  const _runPipelineResult: RunPipelineResult | undefined = undefined;
  const _stepView: StepView | undefined = undefined;
  const _stepCost: StepCost | undefined = undefined;
  const _costReport: CostReport | undefined = undefined;
  const _sessionLimits: SessionLimits | undefined = undefined;
  const _sessionLimitSnapshot: SessionLimitSnapshot | undefined = undefined;
  const _sessionLimitReason: SessionLimitReason | undefined = undefined;
  expect(_orchestrator).toBeUndefined();
  expect(_orchestratorDeps).toBeUndefined();
  expect(_orchestratorConfig).toBeUndefined();
  expect(_orchestratorErrCode).toBeUndefined();
  expect(_runPipelineResult).toBeUndefined();
  expect(_stepView).toBeUndefined();
  expect(_stepCost).toBeUndefined();
  expect(_costReport).toBeUndefined();
  expect(_sessionLimits).toBeUndefined();
  expect(_sessionLimitSnapshot).toBeUndefined();
  expect(_sessionLimitReason).toBeUndefined();
  const _apiKind: ApiKind | undefined = undefined;
  const _credSource: CredentialSource | undefined = undefined;
  const _modelConfig: ModelConfig | undefined = undefined;
  const _providerConfig: ProviderConfig | undefined = undefined;
  const _registryConfig: RegistryConfig | undefined = undefined;
  const _registryErrCode: RegistryErrorCode | undefined = undefined;
  const _resolvedRegistry: ResolvedRegistry | undefined = undefined;
  const _profile: Profile | undefined = undefined;
  const _profileEntry: ProfileEntry | undefined = undefined;
  const _profileRole: ProfileRole | undefined = undefined;
  const _spawnOverride: SpawnOverride | undefined = undefined;
  const _resolvedSelection: ResolvedSelection | undefined = undefined;
  const _profileErrCode: ProfileErrorCode | undefined = undefined;
  const _defaultProfileModels: DefaultProfileModels | undefined = undefined;
  const _resolvePromptOptions: ResolvePromptOptions | undefined = undefined;
  const _promptErrCode: PromptErrorCode | undefined = undefined;
  expect(_resolvePromptOptions).toBeUndefined();
  expect(_promptErrCode).toBeUndefined();
  expect(_profile).toBeUndefined();
  expect(_profileEntry).toBeUndefined();
  expect(_profileRole).toBeUndefined();
  expect(_spawnOverride).toBeUndefined();
  expect(_resolvedSelection).toBeUndefined();
  expect(_profileErrCode).toBeUndefined();
  expect(_defaultProfileModels).toBeUndefined();
  expect(_apiKind).toBeUndefined();
  expect(_credSource).toBeUndefined();
  expect(_modelConfig).toBeUndefined();
  expect(_providerConfig).toBeUndefined();
  expect(_registryConfig).toBeUndefined();
  expect(_registryErrCode).toBeUndefined();
  expect(_resolvedRegistry).toBeUndefined();
  expect(_budget).toBeUndefined();
  expect(_summarizer).toBeUndefined();
  expect(_tool).toBeUndefined();
  expect(_gate).toBeUndefined();
  expect(_report).toBeUndefined();
  expect(_params).toBeUndefined();
  expect(_result).toBeUndefined();
  expect(_opts).toBeUndefined();
  expect(_runner).toBeUndefined();
  expect(_capture).toBeUndefined();
  expect(_planCapture).toBeUndefined();
  expect(_complexity).toBeUndefined();
  expect(_securitySurface).toBeUndefined();
  expect(_plan).toBeUndefined();
  expect(_verdict).toBeUndefined();
  expect(_issue).toBeUndefined();
  expect(_status).toBeUndefined();
  expect(_severity).toBeUndefined();
  expect(_spec).toBeUndefined();
  expect(_round).toBeUndefined();
  expect(_pipelineConfig).toBeUndefined();
  expect(_pipelineResult).toBeUndefined();
  expect(_orchCode).toBeUndefined();
});

test("the package-root exact-run stop is typed and does not invoke a CLI", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-stop-export-"));
  try {
    await expect(stopRun({ runId: "missing_run", targetDir: root })).resolves.toMatchObject({
      status: "not_found",
      runId: "missing_run",
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a package consumer can stop its own recorded run through typed results", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-stop-consumer-")));
  const runId = "consumer_stop";
  const ready = path.join(root, "ready");
  const stopped = path.join(root, "stopped");
  const script = path.join(root, "run.ts");
  fs.writeFileSync(
    script,
    `import * as fs from "node:fs";
fs.writeFileSync(process.env.READY!, "ready");
process.on("SIGTERM", () => { fs.writeFileSync(process.env.STOPPED!, "stopped"); process.exit(0); });
await Bun.sleep(60_000);`,
  );
  const child = Bun.spawn(
    [process.execPath, "run", script, "role", "coder", "--target-dir", root],
    {
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env, READY: ready, STOPPED: stopped },
    },
  );
  try {
    const deadline = Date.now() + 5_000;
    while (!fs.existsSync(ready)) {
      if (Date.now() > deadline) throw new Error("consumer stop fixture did not become ready");
      await Bun.sleep(20);
    }
    // This is the same durable record a role launcher creates. The consumer
    // uses only package-root APIs; it neither invokes nor parses the CLI.
    const store = new ProjectStore(root);
    store.writeVersionedJson(path.join(store.layout.runs, `standalone-${runId}.json`), {
      schemaVersion: 2,
      runId,
      role: "coder",
      status: "running",
      process: { pid: child.pid },
    });

    const outcome = await stopRun({ runId, targetDir: root });
    expect(["signalled", "stopped"]).toContain(outcome.status);
    if (outcome.status === "signalled" || outcome.status === "stopped") {
      expect(outcome.result).toMatchObject({ runId, kind: "standalone", pid: child.pid });
      expect(typeof outcome.result.escalated).toBe("boolean");
    } else {
      throw new Error(`unexpected typed stop outcome: ${outcome.status}`);
    }
    while (!fs.existsSync(stopped)) {
      if (Date.now() > deadline) throw new Error("typed stop did not reach its recorded process");
      await Bun.sleep(20);
    }
    expect(fs.readFileSync(stopped, "utf8")).toBe("stopped");
    expect(fs.existsSync(path.join(store.layout.runs, `stop-${runId}.json`))).toBe(true);
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // The typed stop already ended the fixture.
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the published name resolves the same module as the relative path", async () => {
  const byName = await import("ad-coder");
  const byPath = await import("../src/index");
  expect(byName.isWorkflowModule).toBe(byPath.isWorkflowModule);
});

test("package-root project operations persist sessions and attachments", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-exports-"));
  try {
    const source = path.join(root, "source.txt");
    fs.writeFileSync(source, "public attachment");
    const first = createProjectStore(root);
    const session = await first.createSession("public_session");
    await session.close(BACKGROUND_CONTEXT);
    const attachment = await copyProjectAttachment(first, source, "public.txt", "public_file");

    const second = createProjectStore(root);
    expect((await listProjectSessions(second)).map(({ id }) => id)).toEqual(["public_session"]);
    const resumed = await resumeProjectSession(second, "public_session");
    await resumed.close(BACKGROUND_CONTEXT);
    expect(fs.readFileSync(attachment.path, "utf8")).toBe("public attachment");
    await deleteProjectSession(second, "public_session");
    expect(await listProjectSessions(second)).toEqual([]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a dev tag produces the second package, and a stable tag is refused", () => {
  // The dev channel is a separate package rather than a dist-tag, so an
  // early-access install does not overwrite the stable command (issue #268).
  const manifest: DevManifest = {
    name: "ad-coder",
    version: "0.52.0",
    bin: { "ad-coder": "./bin/ad-coder.mjs" },
    description: "A harness.",
  };
  const dev = devManifest(manifest, devVersionFromTag("v0.53.0-dev.1"));
  expect(dev.name).toBe("ad-coder-dev");
  expect(dev.version).toBe("0.53.0-dev.1");
  // The binary is renamed too: two packages installing `ad-coder` would fight
  // over the same path, which is the thing this design exists to avoid.
  expect(dev.bin).toEqual({ "ad-coder-dev": "./bin/ad-coder.mjs" });
  // Everything else is identical -- a preview that behaves differently is not a
  // preview of what ships.
  expect(dev.version).not.toBe(manifest.version);
  expect(Object.keys(dev).sort()).toEqual(Object.keys(manifest).sort());

  // A stable-looking tag must not reach the dev package: publishing `0.53.0`
  // there would claim a released version for a preview.
  expect(() => devVersionFromTag("v0.53.0")).toThrow("v1.2.3-dev.4");
  expect(() => devVersionFromTag("v0.53.0-dev")).toThrow("v1.2.3-dev.4");
});
