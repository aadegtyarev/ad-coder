import { expect, test } from "bun:test";
import type {
  ApiKind,
  AvailableTransition,
  BudgetPercents,
  Complexity,
  ContextBudget,
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
  GateReport,
  IssueSeverity,
  ModelConfig,
  OrchestrationErrorCode,
  Orchestrator,
  OrchestratorConfig,
  OrchestratorDeps,
  OrchestratorErrorCode,
  PipelineConfig,
  PipelineResult,
  PipelineRouting,
  Plan,
  PlanCapture,
  Profile,
  ProfileEntry,
  ProfileErrorCode,
  ProfileRole,
  PromptErrorCode,
  ProviderConfig,
  QualityGate,
  RegistryConfig,
  RegistryErrorCode,
  ResolvableProvider,
  ResolvedRegistry,
  ResolvedSelection,
  ResolvePipelineConfigOptions,
  ResolvePromptOptions,
  RoleRunner,
  RoleSpec,
  RoundRecord,
  RunPipelineResult,
  RunRoleOptions,
  RunRoleParams,
  RunRoleResult,
  SecuritySurface,
  SpawnOverride,
  StepCost,
  StepResult,
  StepView,
  Summarizer,
  Tool,
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
  anthropicCompatiblePreset,
  applyTransition,
  assertTurnFitsBudget,
  autoDriver,
  buildDefaultProfile,
  buildOrchestratorTools,
  buildSubmitPlanTool,
  buildSubmitVerdictTool,
  CHOOSE_TRANSITION_TOOL_NAME,
  ContextBudgetError,
  ContextCompactor,
  createOrchestrator,
  createRoleRunner,
  createWorkflowSession,
  DriveError,
  deepseekPreset,
  defineTool,
  diffUsage,
  driveWorkflow,
  GateRunner,
  isWorkflowModule,
  Ledger,
  OrchestrationError,
  OrchestratorError,
  openaiCodexPreset,
  openaiCompatiblePreset,
  openrouterPreset,
  ProfileError,
  PromptError,
  parseProfile,
  parseRegistryConfig,
  RegistryError,
  RUN_PIPELINE_TOOL_NAME,
  RUN_STEP_TOOL_NAME,
  RunnerError,
  resolvePipelineConfig,
  resolveProfile,
  resolvePrompt,
  resolveRegistry,
  resolveTargetDir,
  runPipeline,
  runRole,
  SHOW_COST_TOOL_NAME,
  SUBMIT_PLAN_TOOL_NAME,
  SUBMIT_VERDICT_TOOL_NAME,
  SUMMARIZATION_PROMPT,
  silentNoopWarning,
  startConversation,
  startOrchestrator,
  toolCallCounts,
  UsageDeltaTracker,
} from "ad-coder";

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
  expect(typeof ContextCompactor).toBe("function");
  expect(typeof ContextBudgetError).toBe("function");
  expect(typeof assertTurnFitsBudget).toBe("function");
  expect(typeof SUMMARIZATION_PROMPT).toBe("string");
  expect(typeof GateRunner).toBe("function");
  expect(typeof runRole).toBe("function");
  expect(typeof startConversation).toBe("function");
  expect(typeof createRoleRunner).toBe("function");
  expect(typeof defineTool).toBe("function");
  expect(typeof RunnerError).toBe("function");
  expect(typeof resolveTargetDir).toBe("function");
  expect(typeof runPipeline).toBe("function");
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
  expect(typeof silentNoopWarning).toBe("function");
  expect(typeof createOrchestrator).toBe("function");
  expect(typeof buildOrchestratorTools).toBe("function");
  expect(typeof startOrchestrator).toBe("function");
  expect(typeof OrchestratorError).toBe("function");
  expect(typeof RUN_PIPELINE_TOOL_NAME).toBe("string");
  expect(typeof RUN_STEP_TOOL_NAME).toBe("string");
  expect(typeof CHOOSE_TRANSITION_TOOL_NAME).toBe("string");
  expect(typeof SHOW_COST_TOOL_NAME).toBe("string");
  const _budgetPercents: BudgetPercents | undefined = undefined;
  const _resolvableProvider: ResolvableProvider | undefined = undefined;
  const _resolveConfigOpts: ResolvePipelineConfigOptions | undefined = undefined;
  expect(_budgetPercents).toBeUndefined();
  expect(_resolvableProvider).toBeUndefined();
  expect(_resolveConfigOpts).toBeUndefined();
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
  expect(_convConfig).toBeUndefined();
  expect(_convSession).toBeUndefined();
  expect(_convStepOpts).toBeUndefined();
  expect(_convToolCall).toBeUndefined();
  expect(_convTurnResult).toBeUndefined();
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
  const _orchCode: OrchestrationErrorCode | undefined = undefined;
  const _orchestrator: Orchestrator | undefined = undefined;
  const _orchestratorDeps: OrchestratorDeps | undefined = undefined;
  const _orchestratorConfig: OrchestratorConfig | undefined = undefined;
  const _orchestratorErrCode: OrchestratorErrorCode | undefined = undefined;
  const _runPipelineResult: RunPipelineResult | undefined = undefined;
  const _stepView: StepView | undefined = undefined;
  const _stepCost: StepCost | undefined = undefined;
  const _costReport: CostReport | undefined = undefined;
  expect(_orchestrator).toBeUndefined();
  expect(_orchestratorDeps).toBeUndefined();
  expect(_orchestratorConfig).toBeUndefined();
  expect(_orchestratorErrCode).toBeUndefined();
  expect(_runPipelineResult).toBeUndefined();
  expect(_stepView).toBeUndefined();
  expect(_stepCost).toBeUndefined();
  expect(_costReport).toBeUndefined();
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

test("the published name resolves the same module as the relative path", async () => {
  const byName = await import("ad-coder");
  const byPath = await import("../src/index");
  expect(byName.isWorkflowModule).toBe(byPath.isWorkflowModule);
});
