export type { FileCredentialStoreOptions } from "./auth/credential-store";
export {
  assertCredentialPathOutsideProject,
  defaultCredentialPath,
  FileCredentialStore,
} from "./auth/credential-store";
export type { AuthErrorCode } from "./auth/errors";
export { AuthError } from "./auth/errors";
export type { AuthLoginResult, AuthLogoutResult, AuthStatus } from "./auth/operations";
export { getAuthStatus, login, logout, requireModelAuthentication } from "./auth/operations";
export type { BuildInfo } from "./build-info";
export { resolveBuildInfo } from "./build-info";
export type {
  CostMode,
  ModelCapabilities,
  ReconcileCode,
  ReconcileWarning,
} from "./capabilities/capabilities";
export {
  breakEvenReads,
  cacheEfficiency,
  deriveCapabilities,
  reconcileRoleWithModel,
} from "./capabilities/capabilities";
export type { AuthCommandOptions, CodexLoginMethod } from "./cli/auth";
export { runAuthCommand } from "./cli/auth";
export type {
  ConsoleExitReason,
  ConsoleOutputMode,
  ConsoleRunResult,
  RunConsoleParams,
} from "./cli/console";
export { DEFAULT_CONSOLE_MAX_INPUT_BYTES, runConsole } from "./cli/console";
export type { DriveErrorCode, DriveWorkflowParams } from "./cli/drive";
export { DriveError, driveWorkflow, silentNoopWarning } from "./cli/drive";
export type {
  BudgetPercents,
  BuiltInPluginName,
  ConfigurableRole,
  ResolvableProvider,
  ResolvePipelineConfigOptions,
} from "./cli/resolve-config";
export {
  DEFAULT_PIPELINE_CONTEXT_CONFIG,
  DEFAULT_REQUEST_TIMEOUT_MS,
  resolveOrchestratorSeed,
  resolvePipelineConfig,
} from "./cli/resolve-config";
export type { ToolActivityRenderMode } from "./cli/tool-activity";
export { ToolActivityRenderer } from "./cli/tool-activity";
export type { ContextBudget, ContextBudgetPercents } from "./context/budget";
export {
  ContextBudgetError,
  DEFAULT_CONTEXT_BUDGET_PERCENTS,
  deriveContextBudget,
} from "./context/budget";
export type {
  CompactionFailure,
  CompactionMode,
  CompactionPolicy,
  Summarizer,
  SummarizerStopReason,
} from "./context/compactor";
export {
  assertSummarizerWindow,
  attachDurableCompaction,
  COMPACTION_SAFETY_PROMPT,
  ContextCompactionLostError,
  compactionLostErrorFrom,
  createSummarizer,
  describeCompactionFailure,
  durableCompactionSettings,
  resolveCompactionPolicy,
  SUMMARIZATION_PROMPT,
  SummarizerUnavailableError,
} from "./context/compactor";
export { assertContextFitsBudget, assertTurnFitsBudget } from "./context/preflight";
export type {
  ConsoleCommandArgument,
  ConsoleCommandDefinition,
  ConsoleCommandHelpEntry,
  ConsoleControlCode,
  ConsoleControlFailure,
  ConsoleControlResult,
} from "./conversation/console-control";
export {
  CONSOLE_COMMANDS,
  ConsoleControlError,
  consoleCommandNames,
  consoleCommandUsage,
  DEFAULT_CONSOLE_CONTROL_PAGE_SIZE,
  executeConsoleControl,
  findConsoleCommand,
} from "./conversation/console-control";
export type {
  ConversationConfig,
  ConversationSession,
  ConversationStepOptions,
  ConversationToolCall,
  ConversationTurnResult,
} from "./conversation/conversation";
export { startConversation } from "./conversation/conversation";
export type { CalibrationCostSample, CostForecast } from "./economics/forecast";
export { forecastCost, latestCreditBalance } from "./economics/forecast";
export * from "./evaluation/calibration";
export { DEFAULT_GATE_CAPTURE_BYTES, DEFAULT_PROJECT_GATES } from "./gates/project-gates";
export type { GateRunnerConfig } from "./gates/runner";
export { DEFAULT_GATE_RUNNER_CONFIG, GateRunner } from "./gates/runner";
export type {
  CommandExecutor,
  ExecResult,
  GateReport,
  GateResult,
  QualityGate,
  QualityGateKind,
} from "./gates/types";
export type {
  LedgerFileStats,
  LedgerReport,
  LedgerScopeStats,
  ToolCount,
} from "./ledger/analytics";
export {
  aggregateLedgerRecords,
  parseLedgerLine,
  readLedgerFiles,
  renderLedgerReport,
} from "./ledger/analytics";
export type { LedgerOptions, LedgerSink } from "./ledger/ledger";
export { FileLedgerSink, LEDGER_BASE_DIR, Ledger, MemoryLedgerSink } from "./ledger/ledger";
export type { LedgerRecord, UsageAmounts, UsageDelta } from "./ledger/types";
export { diffUsage, toolCallCounts, UsageDeltaTracker, usageAmounts } from "./ledger/usage";
export type {
  AttachToolActivityOptions,
  ToolActivityConfig,
  ToolActivityConsumer,
  ToolActivityDropNotice,
  ToolActivityErrorCode,
  ToolActivityEvent,
  ToolActivityKind,
  ToolActivityLifecycle,
  ToolActivityProjection,
  ToolActivityRecord,
  ToolActivitySnapshot,
} from "./observability/tool-activity";
export {
  attachToolActivity,
  boundToolActivityText,
  DEFAULT_TOOL_ACTIVITY_CONFIG,
  resolveToolActivityConfig,
  ToolActivityChannel,
  ToolActivityError,
} from "./observability/tool-activity";
export type {
  BackgroundDetachedLaunch,
  BackgroundEventPage,
  BackgroundHostLauncher,
  BackgroundLifecycle,
  BackgroundRunErrorCode,
  BackgroundRunEvent,
  BackgroundRunLimits,
  BackgroundRunNotice,
  BackgroundRunNoticeConsumer,
  BackgroundRunOutcome,
  BackgroundRunStatus,
  BackgroundTerminalLifecycle,
} from "./orchestration/background-runs";
export {
  BackgroundRunError,
  BackgroundRunManager,
  DEFAULT_BACKGROUND_RUN_LIMITS,
} from "./orchestration/background-runs";
export type {
  ChildPipelineSpec,
  ContentBinding,
  ContentBindingEntry,
  ControlPlaneConfig,
  ControlPlaneDependencies,
  ControlPlaneRunStatus,
  DecisionRecord,
  DecisionRequest,
  DurableRunRecord,
  ExternalLimit,
  LiveRetryCoordinatorOptions,
  PipelineExecution,
  ProviderAvailability,
  PublicationSummary,
  ResumeRunInput,
  RetryCoordinator,
  RunBreakpoint,
  RunMode,
  RunOperationalSummary,
  RunReport,
  RunScope,
  SafeDecisionStatus,
  SafeRunStatus,
  StartRunInput,
  TriageInput,
} from "./orchestration/control-plane";
export {
  buildControlPlaneTools,
  CONTROL_PLANE_TOOL_NAMES,
  createOrchestratorControlPlane,
  DEFAULT_CONTROL_PLANE_CONFIG,
  LiveRetryCoordinator,
  OrchestratorControlPlane,
  triageControlPlaneTask,
} from "./orchestration/control-plane";
export type { FollowUpCapture } from "./orchestration/follow-up";
export {
  buildSubmitFollowUpTool,
  formatFollowUpInstruction,
  SUBMIT_FOLLOW_UP_TOOL_NAME,
} from "./orchestration/follow-up";
export type {
  CostReport,
  DecompositionResult,
  DelegatableRoleName,
  DelegatedRoleResult,
  Orchestrator,
  OrchestratorConfig,
  OrchestratorDeps,
  OrchestratorErrorCode,
  RaisedStageLimits,
  RunPipelineResult,
  StepCost,
  StepView,
} from "./orchestration/orchestrator";
export {
  buildBuiltInPipelineTools,
  buildOrchestratorTools,
  buildReportStatusTool,
  buildRunRoleTool,
  CANCEL_PIPELINE_TOOL_NAME,
  CHOOSE_TRANSITION_TOOL_NAME,
  createOrchestrator,
  DECOMPOSE_TASK_TOOL_NAME,
  DELEGATABLE_ROLE_NAMES,
  OrchestratorError,
  PIPELINE_EVENTS_TOOL_NAME,
  PIPELINE_RESULT_TOOL_NAME,
  PIPELINE_STATUS_TOOL_NAME,
  REPORT_STATUS_TOOL_NAME,
  RESUME_PIPELINE_TOOL_NAME,
  RUN_PIPELINE_TOOL_NAME,
  RUN_ROLE_TOOL_NAME,
  RUN_STEP_TOOL_NAME,
  SHOW_COST_TOOL_NAME,
  START_PIPELINE_TOOL_NAME,
  startOrchestrator,
} from "./orchestration/orchestrator";
export { runPipeline } from "./orchestration/pipeline";
export type { PlanCapture } from "./orchestration/plan";
export {
  buildSubmitPlanTool,
  CONTRACT_INDEX,
  DEFAULT_SURFACE_ANALYSIS_LIMITS,
  parsePlan,
  SUBMIT_PLAN_TOOL_NAME,
} from "./orchestration/plan";
export type { StandaloneRunInspection } from "./orchestration/run-stop";
export { inspectStandaloneRun } from "./orchestration/run-stop";
export type { PipelineContextDecisionInput, WorkflowSession } from "./orchestration/session";
export {
  applyTransition,
  autoDriver,
  createWorkflowSession,
  selectPipelineContext,
  WorkflowStageFailureError,
  WorkflowStageLimitError,
} from "./orchestration/session";
export type {
  StageCloseoutFact,
  StageCloseoutReason,
  StageLimitReason,
  StageLimitSnapshot,
  StageLimits,
} from "./orchestration/stage-limits";
export {
  DEFAULT_STAGE_LIMITS,
  STAGE_LIMIT_KEY,
  StageCloseoutError,
  StageLimitController,
  StageLimitError,
} from "./orchestration/stage-limits";
export type { StopRunInput, StopRunOutcome, StopRunSuccess } from "./orchestration/stop-run";
export { DEFAULT_RUN_STOP_KILL_AFTER_MS, stopRun } from "./orchestration/stop-run";
export type {
  AvailableTransition,
  Complexity,
  ContractCoverage,
  ContractCoverageStatus,
  Driver,
  IssueSeverity,
  OrchestrationErrorCode,
  PipelineConfig,
  PipelineContextConfig,
  PipelineContextFallbackReason,
  PipelineContextMode,
  PipelineContextSelection,
  PipelineContextSnapshot,
  PipelineOutcome,
  PipelinePauseCause,
  PipelineResult,
  PipelineRouting,
  PipelineStageMetrics,
  Plan,
  ResearchDispatchIntent,
  ResearchProvenance,
  RoleSpec,
  RoundRecord,
  SecuritySurface,
  StageFailureRecord,
  StepResult,
  SurfaceAnalysis,
  SurfaceAnalysisEntry,
  SurfaceAnalysisLimits,
  TransitionKind,
  Verdict,
  VerdictIssue,
  VerdictStatus,
  WorkflowDefaults,
  WorkflowPhase,
  WorkflowState,
} from "./orchestration/types";
export { OrchestrationError } from "./orchestration/types";
export type { VerdictCapture } from "./orchestration/verdict";
export { buildSubmitVerdictTool, SUBMIT_VERDICT_TOOL_NAME } from "./orchestration/verdict";
export type { DefaultProfileModels } from "./profiles/default-profile";
export { buildDefaultProfile } from "./profiles/default-profile";
export type { ProfileErrorCode } from "./profiles/errors";
export { ProfileError } from "./profiles/errors";
export { resolveProfile } from "./profiles/resolve";
export type {
  Profile,
  ProfileEntry,
  ProfileRole,
  ResolvedSelection,
  SpawnOverride,
} from "./profiles/types";
export { parseProfile } from "./profiles/validate";
export * from "./project-calibration";
export type {
  BacklogClaim,
  BacklogItem,
  BacklogState,
  BacklogStore,
  ClaimInput,
} from "./project-operations/backlog";
export { BACKLOG_STATES, FileBacklogStore } from "./project-operations/backlog";
export type { DocumentationProposal } from "./project-operations/documentation";
export {
  appendDocumentationProposal,
  DocumentationRouter,
  routeDocumentationFollowUp,
} from "./project-operations/documentation";
export type { ProjectOperationsErrorCode } from "./project-operations/errors";
export { ProjectOperationsError } from "./project-operations/errors";
export {
  aggregateFollowUps,
  followUpSemanticId,
  projectBacklogFollowUp,
  validateFollowUp,
  validateFollowUpCandidate,
} from "./project-operations/follow-ups";
export type {
  BacklogMigrationProbe,
  GitHubCapability,
  GitHubClaimCoordinator,
  GitHubCommandExecutor,
  GitHubCommandRequest,
  GitHubCommandResult,
  MigrationSuggestion,
} from "./project-operations/github-backlog";
export {
  createBacklogStore,
  GitHubBacklogStore,
  probeBacklogMigration,
  probeGitHubBacklogCapability,
  suggestBacklogMigrationOnce,
} from "./project-operations/github-backlog";
export type {
  ImportedLdoInspection,
  ImportedLdoResumeResult,
  LdoArtifactKind,
  LdoDocumentationLayout,
  LdoImportManifest,
  LdoImportPreview,
  LdoImportProvenance,
  LdoImportRecord,
  LdoImportResult,
  LdoManifestEntry,
  LdoPreviewItem,
  LdoProjectDetection,
} from "./project-operations/ldo-import";
export {
  detectLdoProject,
  importLdoArtifacts,
  inspectImportedLdoWork,
  previewLdoImport,
  resumeImportedLdoWork,
} from "./project-operations/ldo-import";
export type {
  FinishPublishingInput,
  PublishingCommandExecutor,
  PublishingCommandRequest,
  PublishingCommandResult,
  PublishingDescription,
  PublishingResult,
  RepositoryPublishingPreflight,
  ResolvedPublishingConfig,
  StartedPublishing,
  StartPublishingInput,
} from "./project-operations/repository-publishing";
export {
  buildPublishingPrBody,
  DEFAULT_REPOSITORY_PUBLISHING_CONFIG,
  finishRepositoryPublishing,
  preflightRepositoryPublishing,
  resolveRepositoryPublishingConfig,
  startRepositoryPublishing,
} from "./project-operations/repository-publishing";
export type {
  ContractReviewRecord,
  CoordinatorCloseout,
  CoordinatorDriver,
  CoordinatorPhase,
  CoordinatorRunResult,
  DecisionResolution,
  DecisionStatus,
  OperatorDecision,
  ResearchPauseResolution,
  RunCheckpoint,
  RunCoordinatorOptions,
} from "./project-operations/run-coordinator";
export {
  clearsOnExplicitAct,
  createRunCoordinator,
  DEFAULT_RUN_COORDINATOR_OPTIONS,
  PAUSES_CLEARED_BY_AN_EXPLICIT_ACT,
  RunCoordinator,
} from "./project-operations/run-coordinator";
export type {
  BacklogFollowUp,
  ContractFollowUp,
  DesignDocDriftFollowUp,
  FollowUp,
  FollowUpCandidate,
  FollowUpEvidence,
  FollowUpProvenance,
  FollowUpValidationOptions,
  NoteFollowUp,
} from "./project-operations/types";
export { DEFAULT_PROJECT_OPERATIONS_CONFIG } from "./project-operations/types";
export { ProjectStoreFileSystem } from "./project-store/filesystem-store";
export {
  copyProjectAttachment,
  createProjectStore,
  deleteProjectSession,
  listProjectSessions,
  ProjectStore,
  resumeProjectSession,
} from "./project-store/project-store";
export type {
  AttachmentMetadata,
  CleanupResult,
  ProjectOperationsConfig,
  ProjectSessionMetadata,
  ProjectStoreArea,
  ProjectStoreByteLimits,
  ProjectStoreConfig,
  ProjectStoreErrorCode,
  ProjectStoreLayout,
  ProjectStoreRetention,
  PublishingGate,
  PublishingMode,
  RepositoryPublishingConfig,
  VersionedState,
} from "./project-store/types";
export { ProjectStoreError } from "./project-store/types";
export type { ExploreProjectConfig } from "./project-tools/explore";
export {
  buildExploreProjectTool,
  DEFAULT_EXPLORE_PROJECT_CONFIG,
  EXPLORE_PROJECT_TOOL_NAME,
} from "./project-tools/explore";
export type { ReadProjectConfig } from "./project-tools/read";
export {
  buildReadProjectTool,
  DEFAULT_READ_PROJECT_CONFIG,
  READ_PROJECT_TOOL_NAME,
} from "./project-tools/read";
export type { SearchProjectConfig } from "./project-tools/search";
export {
  buildSearchProjectTool,
  DEFAULT_SEARCH_PROJECT_CONFIG,
  SEARCH_PROJECT_TOOL_NAME,
} from "./project-tools/search";
export type { PromptErrorCode } from "./prompts/errors";
export { PromptError } from "./prompts/errors";
export type { ResolvePromptOptions } from "./prompts/prompts";
export { resolvePrompt } from "./prompts/prompts";
export type {
  ResearchPurpose,
  ResolvedRoleBrief,
  RoleBriefErrorCode,
  RoleBriefSource,
} from "./prompts/role-briefs";
export {
  composeRoleBrief,
  MODEL_INVENTORY_RESEARCH_BRIEF,
  RoleBriefError,
  resolveResearchRoleBrief,
} from "./prompts/role-briefs";
export type {
  AdmissionPriorityClass,
  ProviderAdmissionConfig,
  ProviderAdmissionScopeState,
  ProviderAdmissionSnapshot,
  ProviderAdmissionStore,
  ProviderAdmissionToken,
} from "./provider-admission";
export {
  ADMISSION_PRIORITY_CLASSES,
  AdmissionCancelledError,
  admissionFailureFrom,
  admissionScopeKey,
  DEFAULT_PROVIDER_ADMISSION_CONFIG,
  FileProviderAdmissionStore,
  MemoryProviderAdmissionStore,
  ProviderAdmissionController,
  QueueSaturatedError,
} from "./provider-admission";
export type { RegistryErrorCode } from "./registry/errors";
export { RegistryError } from "./registry/errors";
export {
  anthropicCompatiblePreset,
  deepseekPreset,
  openaiCodexPreset,
  openaiCompatiblePreset,
  openrouterPreset,
} from "./registry/presets";
export { resolveRegistry } from "./registry/resolve";
export type {
  ApiKind,
  CredentialSource,
  ModelConfig,
  ProviderConfig,
  RegistryConfig,
  ResolvedRegistry,
} from "./registry/types";
export { DEFAULT_CONTEXT_WINDOW, parseRegistryConfig } from "./registry/validate";
export type { Role, RoleRunDeps } from "./role";
export { defineRole, resolveRoleModel, toHarnessOptions } from "./role";
export type {
  EditDiagnosticRegion,
  EditDiagnosticsOptions,
} from "./runner/builtin-tools";
export {
  BASH_TOOL_DESCRIPTION,
  createBuiltinTools,
  DEFAULT_EDIT_DIAGNOSTIC_MAX_BYTES,
  locateEditOccurrences,
  locateNearestEditRegion,
  MAX_REPORTED_OCCURRENCES,
  wrapEditToolWithDiagnostics,
} from "./runner/builtin-tools";
export type {
  GenerationTruncationSignal,
  RunnerErrorCode,
  SettledTurnMessage,
} from "./runner/errors";
export {
  ConfiguredToolsUnavailableError,
  EmptyTurnError,
  extractProviderCodeToken,
  GenerationTruncatedError,
  ProviderLimitError,
  ProviderQuotaError,
  ProviderRejectionError,
  ProviderUnavailableError,
  providerLimitFrom,
  providerQuotaFrom,
  providerRejectionStatusFrom,
  RunnerError,
  resolveTargetDir,
  SuspendedRunError,
} from "./runner/errors";
export type { RoleRunner, RoleRunnerConfig, RunRoleOptions } from "./runner/role-runner";
export { createRoleRunner } from "./runner/role-runner";
export type {
  RoleObservations,
  RunRoleParams,
  RunRoleResult,
  SafeGitChangedFiles,
  SafeGitDiffProjection,
} from "./runner/runner";
export {
  measureSafeGitDiffBytes,
  readSafeGitChangedFiles,
  readSafeGitDiffProjection,
  runRole,
} from "./runner/runner";
export type { Tool } from "./runner/tool";
export { defineTool } from "./runner/tool";
export type {
  SessionLimitReason,
  SessionLimitSnapshot,
  SessionLimits,
} from "./session-limits";
export { SessionLimitController, SessionLimitError } from "./session-limits";
export { defaultStateDir, saveBindings } from "./session-manager/bindings";
export { DEFAULT_MAX_PROJECTS, deriveSessionId, SessionManager } from "./session-manager/manager";
export type {
  AttributedConnection,
  PeerCredentialsReader,
  SessionManagerServerOptions,
} from "./session-manager/server";
export { DEFAULT_SOCKET_NAME, SessionManagerServer } from "./session-manager/server";
export type { HandoffProposal, PersistedBindings } from "./session-manager/types";
export {
  type BindingRecord,
  DRIVER_KINDS,
  type DriverKind,
  type ProjectRecord,
  SESSION_FALLBACK_NAME,
  type SessionLeaseState,
  type SessionListItem,
  SessionManagerError,
  type SessionManagerErrorCode,
  type SessionManagerOptions,
  type SessionNameSource,
  validateDriverKey,
} from "./session-manager/types";
export type { BuildLoadSkillToolOptions, SkillLoadRecord } from "./skills/load-tool";
export {
  buildLoadSkillTool,
  formatSkillCatalogue,
  LOAD_SKILL_TOOL_NAME,
} from "./skills/load-tool";
export type {
  ResolvedSkill,
  ResolveSkillsOptions,
  SkillCatalogueEntry,
  SkillManifest,
  SkillRequires,
  SkillResolutionErrorCode,
} from "./skills/resolver";
export {
  dependenciesMet,
  listSkillIds,
  pluginNamesFromToolNames,
  resolveSkills,
  SkillResolutionError,
  skillCatalogue,
  skillInventory,
  unconditionalSkills,
} from "./skills/resolver";
export type { RoleSkillKit, RoleSkillKitOptions } from "./skills/role-kit";
export { roleSkillKit } from "./skills/role-kit";
export {
  stampBodyCheckErrors,
  stampCheckErrors,
  stampDeliveryText,
} from "./stamp/cli";
export type { ReviewStampFailure } from "./stamp/record-review-stamp";
export type {
  TelegramRoomBinding,
  TelegramRoomBindingErrorCode,
  TelegramRoomBindingErrorProjection,
  TelegramRoomBindingKind,
  TelegramRoomBindingRecord,
  TelegramRoomBindingsDocument,
} from "./telegram/room-bindings";
export {
  parseTelegramRoomBindings,
  serializeTelegramRoomBindings,
  TELEGRAM_ROOM_BINDINGS_VERSION,
  TELEGRAM_SESSION_ID_PATTERN,
  TelegramRoomBindingError,
  TelegramRoomBindingStore,
} from "./telegram/room-bindings";
export type {
  UpdateCommandResult,
  UpdateCommandRunner,
  UpdateErrorCode,
  UpdateErrorOptions,
  UpdateOptions,
  UpdateResult,
} from "./update/updater";
export {
  readInstalledRevision,
  UpdateError,
  updateAdCoder,
  updateCheckout,
} from "./update/updater";
export * from "./user-profile";
export type {
  ExtractedPage,
  ImageInspectionConfig,
  WebToolConfig,
  WebToolDependencies,
} from "./web/tools";
export {
  buildImageInspectionTool,
  buildWebTools,
  DEFAULT_WEB_TOOL_CONFIG,
  extractPage,
  htmlToText,
  INSPECT_IMAGE_TOOL_NAME,
  parseDuckDuckGoResults,
  WEB_READ_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
} from "./web/tools";
export type { WorkflowContext, WorkflowModule } from "./workflow";
export { isWorkflowModule } from "./workflow";
export {
  BUILT_IN_PIPELINE_WORKFLOW,
  BUILT_IN_PIPELINE_WORKFLOW_NAME,
} from "./workflows/builtin-pipeline";
export { resolveWorkflowModules } from "./workflows/registry";
export type { OrchestratorWorkflowModule } from "./workflows/types";
