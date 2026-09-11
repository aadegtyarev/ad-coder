import { expect, test } from "bun:test";
import {
  anthropicCompatiblePreset,
  assertTurnFitsBudget,
  buildDefaultProfile,
  buildSubmitPlanTool,
  buildSubmitVerdictTool,
  ContextBudgetError,
  ContextCompactor,
  createRoleRunner,
  deepseekPreset,
  defineTool,
  diffUsage,
  GateRunner,
  isWorkflowModule,
  Ledger,
  openaiCodexPreset,
  openaiCompatiblePreset,
  openrouterPreset,
  OrchestrationError,
  parseProfile,
  parseRegistryConfig,
  ProfileError,
  RegistryError,
  resolveProfile,
  resolveRegistry,
  resolveTargetDir,
  runPipeline,
  runRole,
  RunnerError,
  SUBMIT_PLAN_TOOL_NAME,
  SUBMIT_VERDICT_TOOL_NAME,
  SUMMARIZATION_PROMPT,
  toolCallCounts,
  UsageDeltaTracker,
} from "ad-coder";
import type {
  ApiKind,
  Complexity,
  ContextBudget,
  CredentialSource,
  DefaultProfileModels,
  GateReport,
  IssueSeverity,
  ModelConfig,
  Plan,
  PlanCapture,
  OrchestrationErrorCode,
  PipelineConfig,
  PipelineResult,
  PipelineRouting,
  Profile,
  ProfileEntry,
  ProfileErrorCode,
  ProfileRole,
  ProviderConfig,
  QualityGate,
  RegistryConfig,
  RegistryErrorCode,
  ResolvedRegistry,
  ResolvedSelection,
  RoleRunner,
  SpawnOverride,
  RoleSpec,
  RoundRecord,
  SecuritySurface,
  RunRoleOptions,
  RunRoleParams,
  RunRoleResult,
  Summarizer,
  Tool,
  VerdictCapture,
  Verdict,
  VerdictIssue,
  VerdictStatus,
  WorkflowModule,
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
  expect(typeof createRoleRunner).toBe("function");
  expect(typeof defineTool).toBe("function");
  expect(typeof RunnerError).toBe("function");
  expect(typeof resolveTargetDir).toBe("function");
  expect(typeof runPipeline).toBe("function");
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
  // Type-only imports are erased; reference them so the imports are not unused.
  const _budget: ContextBudget | undefined = undefined;
  const _summarizer: Summarizer | undefined = undefined;
  const _tool: Tool | undefined = undefined;
  const _gate: QualityGate | undefined = undefined;
  const _report: GateReport | undefined = undefined;
  const _params: RunRoleParams | undefined = undefined;
  const _result: RunRoleResult | undefined = undefined;
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
  const _orchCode: OrchestrationErrorCode | undefined = undefined;
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
