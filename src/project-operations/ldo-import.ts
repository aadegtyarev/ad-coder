import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { createWorkflowSession, type WorkflowSession } from "../orchestration/session";
import type { PipelineConfig, WorkflowPhase, WorkflowState } from "../orchestration/types";
import type { ProjectStore } from "../project-store/project-store";
import type { ProjectOperationsConfig } from "../project-store/types";
import { ProjectStoreError } from "../project-store/types";
import { ProjectOperationsError } from "./errors";
import {
  type CoordinatorRunResult,
  RunCoordinator,
  type RunCoordinatorOptions,
} from "./run-coordinator";

const LDO_ID = /^[a-z0-9][a-z0-9-]{0,95}$/;
const KNOWN_COMPLETED = new Set([
  "research",
  "security",
  "coder",
  "reviewer1",
  "coderFix1",
  "reviewer2",
  "recorder",
]);

export type LdoArtifactKind = "plan" | "run";

export interface LdoDocumentationLayout {
  root: string | null;
  contracts: string | null;
  notes: string | null;
  roadmap: string | null;
  architecture: string | null;
  backlog: string | null;
  readme: string | null;
  agents: string | null;
}

export interface LdoProjectDetection {
  detected: boolean;
  ldoRoot: string;
  plans: string | null;
  runs: string | null;
  documentation: LdoDocumentationLayout;
}

export interface LdoImportProvenance {
  sourceRelativePath: string;
  sha256: string;
  observedRoot: string;
  claimedRoot: string;
  baseHead: string;
  ldoId: string;
  kind: LdoArtifactKind;
  importedAt: string;
}

export interface LdoImportRecord {
  schemaVersion: 1;
  provenance: LdoImportProvenance;
  sourceBytesBase64: string;
  artifact: Record<string, unknown>;
}

export interface LdoManifestEntry {
  identity: string;
  digest: string;
  recordPath: string;
  importedAt: string;
  trustedAt?: string;
}

export interface LdoImportManifest {
  schemaVersion: 1;
  entries: LdoManifestEntry[];
}

export interface LdoPreviewItem {
  kind: LdoArtifactKind;
  id: string;
  sourceRelativePath: string;
  sha256?: string;
  status: "importable" | "already_imported" | "rejected";
  resumable: boolean;
  error?: { code: string; detail: string };
}

export interface LdoImportPreview {
  detection: LdoProjectDetection;
  items: LdoPreviewItem[];
  totalBytes: number;
  writes: false;
}

export interface LdoImportResult {
  imported: LdoManifestEntry[];
  skipped: LdoManifestEntry[];
  manifest: LdoImportManifest;
}

export interface ImportedLdoInspection {
  identity: string;
  digest: string;
  kind: LdoArtifactKind;
  id: string;
  task: string;
  provenance: LdoImportProvenance;
  sourceStatus: "unchanged" | "changed" | "missing";
  completedStages: string[];
  approved: boolean | null;
  terminal: boolean;
  firstIncompletePhase: WorkflowPhase | null;
  trustedForResume: boolean;
}

export type ImportedLdoResumeResult =
  | CoordinatorRunResult
  | { status: "complete"; inspection: ImportedLdoInspection };

interface Candidate {
  kind: LdoArtifactKind;
  id: string;
  relative: string;
  bytes: Buffer;
  digest: string;
  artifact: Record<string, unknown>;
}

function safeRelative(value: string, label: string): string {
  if (
    value === "" ||
    path.isAbsolute(value) ||
    value.split(/[\\/]/).some((part) => part === ".." || part === "")
  )
    throw new ProjectOperationsError("unsafe_import", label);
  return value;
}

function configuredPaths(targetDir: string, config: ProjectOperationsConfig) {
  const rootRelative = safeRelative(config.ldo?.root ?? ".codex/ldo", "ldo.root");
  const plansRelative = safeRelative(
    config.ldo?.plans ?? path.join(rootRelative, "plans"),
    "ldo.plans",
  );
  const runsRelative = safeRelative(
    config.ldo?.runs ?? path.join(rootRelative, "runs"),
    "ldo.runs",
  );
  return {
    rootRelative,
    root: path.join(targetDir, rootRelative),
    plansRelative,
    plans: path.join(targetDir, plansRelative),
    runsRelative,
    runs: path.join(targetDir, runsRelative),
  };
}

function regularPathOrAbsent(
  targetDir: string,
  relative: string,
  directory: boolean,
): string | null {
  safeRelative(relative, relative);
  let cursor = targetDir;
  for (const part of relative.split(/[\\/]/)) {
    cursor = path.join(cursor, part);
    if (!fs.existsSync(cursor)) return null;
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new ProjectOperationsError("unsafe_import", relative);
  }
  const stat = fs.lstatSync(cursor);
  if (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
    throw new ProjectOperationsError("unsafe_import", relative);
  return relative;
}

export function detectLdoProject(
  targetDir: string,
  config: ProjectOperationsConfig = {},
): LdoProjectDetection {
  const observedRoot = fs.realpathSync(targetDir);
  const locations = configuredPaths(observedRoot, config);
  const docsRoot = config.documentation?.root ?? "docs";
  const configuredNotes = config.documentation?.notes;
  const notesCandidates = configuredNotes
    ? [configuredNotes]
    : [path.join(docsRoot, "NOTES.md"), path.join(docsRoot, "notes", "candidates.md")];
  const existingFile = (relative: string): string | null =>
    regularPathOrAbsent(observedRoot, relative, false);
  const documentation: LdoDocumentationLayout = {
    root: regularPathOrAbsent(observedRoot, docsRoot, true),
    contracts: regularPathOrAbsent(
      observedRoot,
      config.documentation?.contracts ?? path.join(docsRoot, "contracts"),
      true,
    ),
    notes: notesCandidates.map(existingFile).find((item) => item !== null) ?? null,
    roadmap: existingFile(path.join(docsRoot, "ROADMAP.md")),
    architecture: existingFile(path.join(docsRoot, "ARCHITECTURE.md")),
    backlog: existingFile(path.join(docsRoot, "BACKLOG.md")),
    readme: existingFile("README.md"),
    agents: existingFile("AGENTS.md"),
  };
  const plans = regularPathOrAbsent(observedRoot, locations.plansRelative, true);
  const runs = regularPathOrAbsent(observedRoot, locations.runsRelative, true);
  return {
    detected: plans !== null || runs !== null,
    ldoRoot: locations.rootRelative,
    plans,
    runs,
    documentation,
  };
}

function object(value: unknown, detail: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ProjectOperationsError("malformed_import", detail);
  return value as Record<string, unknown>;
}

function onlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  detail: string,
): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new ProjectOperationsError("unsupported_import", detail);
}

function validatePlan(value: unknown, detail: string): void {
  const plan = object(value, detail);
  onlyKeys(
    plan,
    ["complexity", "security_surface", "summary", "steps", "risks", "codebase_context"],
    detail,
  );
  const context = object(plan.codebase_context, detail);
  onlyKeys(
    context,
    [
      "stack",
      "conventions",
      "relevant_files",
      "test_command",
      "test_command_scoped",
      "run_command",
    ],
    detail,
  );
  if (
    typeof plan.summary !== "string" ||
    !Array.isArray(plan.steps) ||
    !["trivial", "medium", "complex"].includes(String(plan.complexity)) ||
    !["none", "low", "elevated"].includes(String(plan.security_surface)) ||
    !Array.isArray(plan.risks) ||
    !plan.risks.every((item) => typeof item === "string") ||
    typeof context.stack !== "string" ||
    typeof context.conventions !== "string" ||
    typeof context.test_command !== "string" ||
    !(typeof context.test_command_scoped === "string" || context.test_command_scoped === null) ||
    typeof context.run_command !== "string" ||
    !Array.isArray(context.relevant_files) ||
    !context.relevant_files.every((item) => {
      const file = object(item, detail);
      onlyKeys(file, ["path", "role", "note"], detail);
      return (
        typeof file.path === "string" &&
        typeof file.role === "string" &&
        typeof file.note === "string"
      );
    }) ||
    !plan.steps.every((item) => {
      const step = object(item, detail);
      onlyKeys(step, ["what", "files", "acceptance", "user_facing"], detail);
      return (
        typeof step.what === "string" &&
        Array.isArray(step.files) &&
        step.files.every((file) => typeof file === "string") &&
        typeof step.acceptance === "string" &&
        typeof step.user_facing === "boolean"
      );
    })
  )
    throw new ProjectOperationsError("malformed_import", detail);
}

function validateSecurity(value: unknown, detail: string): void {
  if (value === null || value === undefined) return;
  const security = object(value, detail);
  onlyKeys(security, ["status", "summary", "findings", "threat_model_notes"], detail);
  if (
    !["clean", "findings"].includes(String(security.status)) ||
    typeof security.summary !== "string" ||
    !(typeof security.threat_model_notes === "string" || security.threat_model_notes === null) ||
    !Array.isArray(security.findings) ||
    !security.findings.every((item) => {
      const finding = object(item, detail);
      onlyKeys(
        finding,
        ["severity", "category", "plan_step", "what", "exploit_scenario", "mitigation", "cwe"],
        detail,
      );
      return (
        ["critical", "high", "medium", "low", "info"].includes(String(finding.severity)) &&
        ["category", "plan_step", "what", "exploit_scenario", "mitigation"].every(
          (key) => typeof finding[key] === "string",
        ) &&
        (typeof finding.cwe === "string" || finding.cwe === null)
      );
    })
  )
    throw new ProjectOperationsError("malformed_import", detail);
}

function validateCoder(value: unknown, detail: string): void {
  const coder = object(value, detail);
  onlyKeys(
    coder,
    ["summary", "files_changed", "tests", "docs_updated", "deviations", "issue_outcomes"],
    detail,
  );
  if (
    typeof coder.summary !== "string" ||
    !Array.isArray(coder.files_changed) ||
    !coder.files_changed.every((item) => typeof item === "string") ||
    !Array.isArray(coder.docs_updated) ||
    !coder.docs_updated.every((item) => typeof item === "string") ||
    !Array.isArray(coder.deviations) ||
    !coder.deviations.every((item) => typeof item === "string")
  )
    throw new ProjectOperationsError("malformed_import", detail);
  const tests = object(coder.tests, detail);
  onlyKeys(tests, ["result", "command"], detail);
  if (typeof tests.result !== "string" || typeof tests.command !== "string")
    throw new ProjectOperationsError("malformed_import", detail);
}

function validateReview(value: unknown, detail: string): void {
  const review = object(value, detail);
  onlyKeys(review, ["status", "summary", "issues", "verification", "attacks"], detail);
  const verification = object(review.verification, detail);
  onlyKeys(verification, ["verdict", "criteria", "blockers"], detail);
  if (
    !["approved", "changes_requested"].includes(String(review.status)) ||
    typeof review.summary !== "string" ||
    !Array.isArray(review.issues) ||
    !review.issues.every((item) => {
      const issue = object(item, detail);
      onlyKeys(issue, ["file", "severity", "what", "suggestion"], detail);
      return (
        typeof issue.what === "string" &&
        typeof issue.file === "string" &&
        typeof issue.suggestion === "string" &&
        ["critical", "major", "minor", "nit"].includes(String(issue.severity))
      );
    }) ||
    !["verified", "partial", "failed", "nothing_to_drive"].includes(String(verification.verdict)) ||
    !Array.isArray(verification.criteria) ||
    !Array.isArray(verification.blockers) ||
    !verification.blockers.every((item) => typeof item === "string") ||
    !Array.isArray(review.attacks)
  )
    throw new ProjectOperationsError("malformed_import", detail);
}

function isoDate(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validateUsage(value: unknown, detail: string): void {
  if (!Array.isArray(value)) throw new ProjectOperationsError("malformed_import", detail);
  for (const item of value) {
    const entry = object(item, detail);
    onlyKeys(entry, ["stage", "model", "usage"], detail);
    if (
      typeof entry.stage !== "string" ||
      !(entry.model === null || typeof entry.model === "string")
    )
      throw new ProjectOperationsError("malformed_import", detail);
    if (entry.usage !== null) {
      const usage = object(entry.usage, detail);
      if (
        Object.values(usage).some(
          (token) => typeof token !== "number" || !Number.isFinite(token) || token < 0,
        )
      )
        throw new ProjectOperationsError("malformed_import", detail);
    }
  }
}

function validateTokenUsage(value: unknown, detail: string): void {
  const summary = object(value, detail);
  onlyKeys(
    summary,
    [
      "status",
      "input_tokens",
      "cache_creation_input_tokens",
      "cached_input_tokens",
      "output_tokens",
      "total_tokens",
      "stages",
    ],
    detail,
  );
  if (!["measured", "partial", "unavailable"].includes(String(summary.status)))
    throw new ProjectOperationsError("malformed_import", detail);
  for (const key of [
    "input_tokens",
    "cache_creation_input_tokens",
    "cached_input_tokens",
    "output_tokens",
    "total_tokens",
  ]) {
    const token = summary[key];
    if (!(token === null || (typeof token === "number" && Number.isFinite(token) && token >= 0)))
      throw new ProjectOperationsError("malformed_import", detail);
  }
  if (!Array.isArray(summary.stages)) throw new ProjectOperationsError("malformed_import", detail);
  for (const stageValue of summary.stages) {
    const stage = object(stageValue, detail);
    onlyKeys(
      stage,
      [
        "stage",
        "model",
        "input_tokens",
        "cache_creation_input_tokens",
        "cached_input_tokens",
        "output_tokens",
        "total_tokens",
      ],
      detail,
    );
    if (
      typeof stage.stage !== "string" ||
      !(stage.model === null || typeof stage.model === "string")
    )
      throw new ProjectOperationsError("malformed_import", detail);
    for (const key of [
      "input_tokens",
      "cache_creation_input_tokens",
      "cached_input_tokens",
      "output_tokens",
      "total_tokens",
    ]) {
      const token = stage[key];
      if (!(token === null || (typeof token === "number" && Number.isFinite(token) && token >= 0)))
        throw new ProjectOperationsError("malformed_import", detail);
    }
  }
}

function validateBacklog(value: unknown, detail: string): void {
  const backlog = object(value, detail);
  onlyKeys(backlog, ["destination", "file", "count"], detail);
  if (
    typeof backlog.destination !== "string" ||
    !(backlog.file === null || typeof backlog.file === "string") ||
    !Number.isSafeInteger(backlog.count) ||
    Number(backlog.count) < 0
  )
    throw new ProjectOperationsError("malformed_import", detail);
}

function validateArtifact(
  value: unknown,
  kind: LdoArtifactKind,
  id: string,
): Record<string, unknown> {
  const artifact = object(value, id);
  onlyKeys(
    artifact,
    kind === "plan"
      ? ["version", "id", "root", "baseHead", "createdAt", "task", "plan", "security", "usage"]
      : [
          "version",
          "id",
          "root",
          "baseHead",
          "task",
          "plan",
          "security",
          "status",
          "startedAt",
          "usage",
          "completed",
          "tokenUsage",
          "completedAt",
          "approved",
          "backlog",
        ],
    id,
  );
  if (
    artifact.version !== 1 ||
    artifact.id !== id ||
    typeof artifact.root !== "string" ||
    typeof artifact.baseHead !== "string" ||
    typeof artifact.task !== "string" ||
    (kind === "plan" && !isoDate(artifact.createdAt)) ||
    (kind === "run" && !isoDate(artifact.startedAt))
  )
    throw new ProjectOperationsError("malformed_import", id);
  validatePlan(artifact.plan, id);
  validateSecurity(artifact.security, id);
  validateUsage(artifact.usage, id);
  if (kind === "run") {
    if (!["running", "completed"].includes(String(artifact.status)))
      throw new ProjectOperationsError("malformed_import", id);
    const completed = object(artifact.completed, id);
    if (Object.keys(completed).some((key) => !KNOWN_COMPLETED.has(key)))
      throw new ProjectOperationsError("unsupported_import", id);
    for (const key of ["coder", "coderFix1"])
      if (completed[key] !== undefined) validateCoder(completed[key], id);
    for (const key of ["reviewer1", "reviewer2"])
      if (completed[key] !== undefined) validateReview(completed[key], id);
    const review1 = completed.reviewer1 as Record<string, unknown> | undefined;
    const review2 = completed.reviewer2 as Record<string, unknown> | undefined;
    const finalReview = review2 ?? review1;
    if (artifact.tokenUsage !== undefined) validateTokenUsage(artifact.tokenUsage, id);
    if (
      (completed.reviewer1 !== undefined && completed.coder === undefined) ||
      (completed.coderFix1 !== undefined && review1?.status !== "changes_requested") ||
      (completed.reviewer2 !== undefined && completed.coderFix1 === undefined) ||
      (completed.reviewer2 !== undefined && review1?.status !== "changes_requested") ||
      review2?.status === "changes_requested" ||
      (artifact.status === "completed" &&
        (!isoDate(artifact.completedAt) ||
          finalReview?.status !== "approved" ||
          artifact.approved !== true ||
          artifact.tokenUsage === undefined ||
          artifact.backlog === undefined)) ||
      (artifact.status === "running" && artifact.approved !== undefined)
    )
      throw new ProjectOperationsError("stale_import", id);
    if (artifact.status === "completed") validateBacklog(artifact.backlog, id);
  }
  return artifact;
}

function limits(config: ProjectOperationsConfig): [string, number][] {
  return [
    ["artifactCountLimit", config.ldo?.artifactCountLimit ?? 0],
    ["perFileByteLimit", config.ldo?.perFileByteLimit ?? 0],
    ["aggregateByteLimit", config.ldo?.aggregateByteLimit ?? 0],
  ];
}

function validateLimits(config: ProjectOperationsConfig): void {
  for (const [name, value] of limits(config))
    if (!Number.isSafeInteger(value) || value < 0)
      throw new ProjectOperationsError("invalid_config", `ldo.${name}`);
}

interface ApprovedDirectory {
  fd: number;
  descriptorPath: string;
  stat: fs.Stats;
}

function openApprovedDirectory(absolute: string, relative: string): ApprovedDirectory {
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      absolute,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
    const descriptorPath = `/proc/self/fd/${fd}`;
    const resolved = fs.realpathSync(descriptorPath);
    if (resolved !== absolute) throw new ProjectOperationsError("unsafe_import", relative);
    // Child opens through this descriptor stay on the verified directory if a pathname ancestor moves.
    return { fd, descriptorPath, stat: fs.fstatSync(fd) };
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    if (error instanceof ProjectOperationsError) throw error;
    throw new ProjectOperationsError("unsafe_import", relative);
  }
}

function directoryIdentityUnchanged(directory: ApprovedDirectory): boolean {
  const current = fs.fstatSync(directory.fd);
  return current.dev === directory.stat.dev && current.ino === directory.stat.ino;
}

function readCandidate(
  approvedDirectory: ApprovedDirectory,
  relative: string,
  kind: LdoArtifactKind,
  config: ProjectOperationsConfig,
  aggregateRemaining?: number,
  onRead?: (size: number) => void,
): Candidate {
  const filename = path.basename(relative);
  const id = filename.slice(0, -5);
  if (!LDO_ID.test(id) || filename !== `${id}.json`)
    throw new ProjectOperationsError("unsafe_import", relative);
  let fd: number | undefined;
  try {
    if (!directoryIdentityUnchanged(approvedDirectory))
      throw new ProjectOperationsError("unsafe_import", relative);
    fd = fs.openSync(
      path.join(approvedDirectory.descriptorPath, filename),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || !directoryIdentityUnchanged(approvedDirectory))
      throw new ProjectOperationsError("unsafe_import", relative);
    const max = config.ldo?.perFileByteLimit ?? 0;
    if (max > 0 && stat.size > max) throw new ProjectOperationsError("resource_limit", relative);
    if (aggregateRemaining !== undefined && stat.size > aggregateRemaining)
      throw new ProjectOperationsError("resource_limit", "ldo.aggregateByteLimit");
    const allocated = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < allocated.length) {
      const read = fs.readSync(fd, allocated, offset, allocated.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    const bytes = allocated.subarray(0, offset);
    if (max > 0 && bytes.length > max) throw new ProjectOperationsError("resource_limit", relative);
    const after = fs.fstatSync(fd);
    if (
      after.dev !== stat.dev ||
      after.ino !== stat.ino ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs
    )
      throw new ProjectOperationsError("unsafe_import", relative);
    onRead?.(bytes.length);
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new ProjectOperationsError("malformed_import", relative);
    }
    return {
      kind,
      id,
      relative,
      bytes,
      digest: crypto.createHash("sha256").update(bytes).digest("hex"),
      artifact: validateArtifact(parsed, kind, id),
    };
  } catch (error) {
    if (error instanceof ProjectOperationsError) throw error;
    throw new ProjectOperationsError("unsafe_import", relative);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function candidates(targetDir: string, config: ProjectOperationsConfig): Candidate[] {
  validateLimits(config);
  const detected = detectLdoProject(targetDir, config);
  const configured = configuredPaths(fs.realpathSync(targetDir), config);
  const result: Candidate[] = [];
  let seen = 0;
  let total = 0;
  const count = config.ldo?.artifactCountLimit ?? 0;
  const aggregate = config.ldo?.aggregateByteLimit ?? 0;
  for (const [kind, relative, absolute] of [
    ["plan", detected.plans, configured.plans],
    ["run", detected.runs, configured.runs],
  ] as const) {
    if (relative === null) continue;
    const directory = openApprovedDirectory(absolute, relative);
    try {
      for (const entry of fs
        .readdirSync(directory.descriptorPath, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))) {
        const sourceRelative = path.join(relative, entry.name);
        seen += 1;
        if (count > 0 && seen > count)
          throw new ProjectOperationsError("resource_limit", "ldo.artifactCountLimit");
        if (!entry.isFile() || entry.isSymbolicLink())
          throw new ProjectOperationsError("unsafe_import", sourceRelative);
        const item = readCandidate(
          directory,
          sourceRelative,
          kind,
          config,
          aggregate > 0 ? aggregate - total : undefined,
        );
        result.push(item);
        total += item.bytes.length;
      }
    } finally {
      fs.closeSync(directory.fd);
    }
  }
  return result;
}

const manifestPath = (store: ProjectStore) =>
  path.join(store.layout.runs, "ldo-import-manifest.json");

function readManifest(store: ProjectStore): { version: number; value: LdoImportManifest } {
  try {
    const persisted = store.readVersionedJson<LdoImportManifest>(manifestPath(store));
    if (
      persisted.value.schemaVersion !== 1 ||
      !Array.isArray(persisted.value.entries) ||
      !persisted.value.entries.every(
        (entry) =>
          typeof entry.identity === "string" &&
          typeof entry.digest === "string" &&
          /^[a-f0-9]{64}$/.test(entry.digest) &&
          typeof entry.recordPath === "string" &&
          typeof entry.importedAt === "string" &&
          (entry.trustedAt === undefined || typeof entry.trustedAt === "string"),
      )
    )
      throw new ProjectOperationsError("malformed_import", "ldo-import-manifest");
    const keys = persisted.value.entries.map((entry) => `${entry.identity}:${entry.digest}`);
    if (
      new Set(keys).size !== keys.length ||
      persisted.value.entries.some(
        (entry) =>
          !/^(plan|run):[a-z0-9][a-z0-9-]{0,95}$/.test(entry.identity) ||
          safeRelative(entry.recordPath, "ldo-import-manifest") !== entry.recordPath,
      )
    )
      throw new ProjectOperationsError("malformed_import", "ldo-import-manifest");
    return persisted;
  } catch (error) {
    if (error instanceof ProjectStoreError && error.code === "not_found")
      return { version: 0, value: { schemaVersion: 1, entries: [] } };
    throw error;
  }
}

export function previewLdoImport(
  source: ProjectStore | string,
  config: ProjectOperationsConfig = {},
): LdoImportPreview {
  const isStore = typeof source !== "string";
  const targetDir = isStore ? source.layout.targetDir : fs.realpathSync(source);
  const operations = isStore ? source.projectOperations : config;
  validateLimits(operations);
  const detection = detectLdoProject(targetDir, operations);
  const locations = configuredPaths(targetDir, operations);
  const found: Candidate[] = [];
  const rejected: LdoPreviewItem[] = [];
  let seen = 0;
  let totalBytes = 0;
  const count = operations.ldo?.artifactCountLimit ?? 0;
  const aggregate = operations.ldo?.aggregateByteLimit ?? 0;
  for (const [kind, relative, absolute] of [
    ["plan", detection.plans, locations.plans],
    ["run", detection.runs, locations.runs],
  ] as const) {
    if (relative === null) continue;
    const directory = openApprovedDirectory(absolute, relative);
    try {
      for (const entry of fs
        .readdirSync(directory.descriptorPath, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))) {
        const sourceRelativePath = path.join(relative, entry.name);
        seen += 1;
        if (count > 0 && seen > count)
          throw new ProjectOperationsError("resource_limit", "ldo.artifactCountLimit");
        try {
          if (!entry.isFile() || entry.isSymbolicLink())
            throw new ProjectOperationsError("unsafe_import", sourceRelativePath);
          const item = readCandidate(
            directory,
            sourceRelativePath,
            kind,
            operations,
            aggregate > 0 ? aggregate - totalBytes : undefined,
            (size) => {
              totalBytes += size;
            },
          );
          found.push(item);
        } catch (error) {
          const safe =
            error instanceof ProjectOperationsError
              ? error
              : new ProjectOperationsError("unsafe_import", sourceRelativePath);
          if (safe.code === "resource_limit") throw safe;
          rejected.push({
            kind,
            id: entry.name.endsWith(".json") ? entry.name.slice(0, -5) : entry.name,
            sourceRelativePath,
            status: "rejected",
            resumable: false,
            error: { code: safe.code, detail: safe.detail },
          });
        }
      }
    } finally {
      fs.closeSync(directory.fd);
    }
  }
  let manifest: LdoImportManifest = { schemaVersion: 1, entries: [] };
  if (isStore) manifest = readManifest(source).value;
  else {
    const existing = path.join(targetDir, ".ad-coder", "runs", "ldo-import-manifest.json");
    if (fs.existsSync(existing)) {
      regularPathOrAbsent(targetDir, ".ad-coder/runs", true);
      const stat = fs.lstatSync(existing);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
        throw new ProjectOperationsError(
          "unsafe_import",
          ".ad-coder/runs/ldo-import-manifest.json",
        );
      const parsed = JSON.parse(fs.readFileSync(existing, "utf8")) as { value?: LdoImportManifest };
      if (parsed.value?.schemaVersion !== 1 || !Array.isArray(parsed.value.entries))
        throw new ProjectOperationsError("malformed_import", "ldo-import-manifest");
      manifest = parsed.value;
    }
  }
  return {
    detection,
    items: [
      ...found.map(
        (item) =>
          ({
            kind: item.kind,
            id: item.id,
            sourceRelativePath: item.relative,
            sha256: item.digest,
            status: manifest.entries.some(
              (entry) =>
                entry.identity === `${item.kind}:${item.id}` && entry.digest === item.digest,
            )
              ? "already_imported"
              : "importable",
            resumable: !isTerminal(item.artifact, item.kind),
          }) satisfies LdoPreviewItem,
      ),
      ...rejected,
    ],
    totalBytes,
    writes: false,
  };
}

export function importLdoArtifacts(
  store: ProjectStore,
  options: { trustDigests?: readonly string[]; now?: () => Date } = {},
): LdoImportResult {
  if (
    options.trustDigests !== undefined &&
    (!Array.isArray(options.trustDigests) ||
      !options.trustDigests.every((digest) => /^[a-f0-9]{64}$/.test(digest)) ||
      new Set(options.trustDigests).size !== options.trustDigests.length)
  )
    throw new ProjectOperationsError("invalid_config", "trustDigests");
  const found = candidates(store.layout.targetDir, store.projectOperations);
  const persisted = readManifest(store);
  const entries = [...persisted.value.entries];
  const imported: LdoManifestEntry[] = [];
  const skipped: LdoManifestEntry[] = [];
  let manifestChanged = false;
  const now = (options.now ?? (() => new Date()))().toISOString();
  for (const item of found) {
    const identity = `${item.kind}:${item.id}`;
    const existing = entries.find(
      (entry) => entry.identity === identity && entry.digest === item.digest,
    );
    if (existing !== undefined) {
      if (options.trustDigests?.includes(item.digest) && existing.trustedAt === undefined) {
        existing.trustedAt = now;
        manifestChanged = true;
      }
      skipped.push(existing);
      continue;
    }
    const recordName = `${item.kind}-${item.id}-${item.digest}.json`;
    const recordPath = path.join(store.layout.runs, "ldo-imports", recordName);
    const record: LdoImportRecord = {
      schemaVersion: 1,
      provenance: {
        sourceRelativePath: item.relative,
        sha256: item.digest,
        observedRoot: store.layout.targetDir,
        claimedRoot: String(item.artifact.root),
        baseHead: String(item.artifact.baseHead),
        ldoId: item.id,
        kind: item.kind,
        importedAt: now,
      },
      sourceBytesBase64: item.bytes.toString("base64"),
      artifact: item.artifact,
    };
    try {
      store.writeVersionedJson(recordPath, record, 0);
    } catch (error) {
      if (!(error instanceof ProjectStoreError) || error.code !== "version_conflict") throw error;
      const prior = store.readVersionedJson<LdoImportRecord>(recordPath).value;
      if (prior.provenance.sha256 !== item.digest)
        throw new ProjectOperationsError("checkpoint_conflict", identity);
    }
    const entry: LdoManifestEntry = {
      identity,
      digest: item.digest,
      recordPath: path.relative(store.layout.root, recordPath),
      importedAt: now,
      ...(options.trustDigests?.includes(item.digest) ? { trustedAt: now } : {}),
    };
    entries.push(entry);
    imported.push(entry);
    manifestChanged = true;
  }
  if (manifestChanged)
    store.writeVersionedJson(manifestPath(store), { schemaVersion: 1, entries }, persisted.version);
  return { imported, skipped, manifest: { schemaVersion: 1, entries } };
}

function isTerminal(artifact: Record<string, unknown>, kind: LdoArtifactKind): boolean {
  return kind === "run" && artifact.status === "completed";
}

function validateLoadedRecord(value: LdoImportRecord, entry: LdoManifestEntry): LdoImportRecord {
  const recordObject = object(value, entry.identity);
  onlyKeys(
    recordObject,
    ["schemaVersion", "provenance", "sourceBytesBase64", "artifact"],
    entry.identity,
  );
  const record = recordObject as unknown as LdoImportRecord;
  const provenanceObject = object(record.provenance, entry.identity);
  onlyKeys(
    provenanceObject,
    [
      "sourceRelativePath",
      "sha256",
      "observedRoot",
      "claimedRoot",
      "baseHead",
      "ldoId",
      "kind",
      "importedAt",
    ],
    entry.identity,
  );
  const provenance = provenanceObject as unknown as LdoImportProvenance;
  if (
    record.schemaVersion !== 1 ||
    typeof record.sourceBytesBase64 !== "string" ||
    provenance.sha256 !== entry.digest ||
    !["plan", "run"].includes(provenance.kind) ||
    `${provenance.kind}:${provenance.ldoId}` !== entry.identity ||
    typeof provenance.sourceRelativePath !== "string" ||
    typeof provenance.observedRoot !== "string" ||
    typeof provenance.claimedRoot !== "string" ||
    typeof provenance.baseHead !== "string" ||
    typeof provenance.importedAt !== "string"
  )
    throw new ProjectOperationsError("checkpoint_conflict", entry.identity);
  safeRelative(provenance.sourceRelativePath, entry.identity);
  const bytes = Buffer.from(record.sourceBytesBase64, "base64");
  if (
    bytes.toString("base64") !== record.sourceBytesBase64 ||
    crypto.createHash("sha256").update(bytes).digest("hex") !== entry.digest
  )
    throw new ProjectOperationsError("checkpoint_conflict", entry.identity);
  let sourceArtifact: unknown;
  try {
    sourceArtifact = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ProjectOperationsError("malformed_import", entry.identity);
  }
  const validated = validateArtifact(sourceArtifact, provenance.kind, provenance.ldoId);
  if (JSON.stringify(validated) !== JSON.stringify(record.artifact))
    throw new ProjectOperationsError("checkpoint_conflict", entry.identity);
  return record;
}

function loadEntry(store: ProjectStore, identity: string, digest?: string) {
  if (!/^(plan|run):[a-z0-9][a-z0-9-]{0,95}$/.test(identity))
    throw new ProjectOperationsError("unsafe_import", "identity");
  if (digest !== undefined && !/^[a-f0-9]{64}$/.test(digest))
    throw new ProjectOperationsError("unsafe_import", "digest");
  const manifest = readManifest(store).value;
  const matches = manifest.entries.filter(
    (entry) => entry.identity === identity && (digest === undefined || entry.digest === digest),
  );
  const entry = matches.at(-1);
  if (entry === undefined) throw new ProjectOperationsError("not_found", identity);
  const record = validateLoadedRecord(
    store.readVersionedJson<LdoImportRecord>(path.join(store.layout.root, entry.recordPath)).value,
    entry,
  );
  return { entry, record };
}

function incomplete(
  artifact: Record<string, unknown>,
  kind: LdoArtifactKind,
): WorkflowPhase | null {
  if (isTerminal(artifact, kind)) return null;
  if (kind === "plan") return "code";
  const completed = artifact.completed as Record<string, unknown>;
  if (completed.coder === undefined) return "code";
  if (completed.reviewer1 === undefined) return "review";
  const first = completed.reviewer1 as Record<string, unknown>;
  if (first.status === "approved") return null;
  if (completed.coderFix1 === undefined) return "code";
  if (completed.reviewer2 === undefined) return "review";
  return null;
}

export function inspectImportedLdoWork(
  store: ProjectStore,
  identity: string,
  digest?: string,
): ImportedLdoInspection {
  const { entry, record } = loadEntry(store, identity, digest);
  const source = path.join(store.layout.targetDir, record.provenance.sourceRelativePath);
  let sourceStatus: ImportedLdoInspection["sourceStatus"] = "missing";
  try {
    const sourceDirectory = path.dirname(record.provenance.sourceRelativePath);
    regularPathOrAbsent(store.layout.targetDir, sourceDirectory, true);
    const directory = openApprovedDirectory(
      path.join(store.layout.targetDir, sourceDirectory),
      sourceDirectory,
    );
    try {
      const current = readCandidate(
        directory,
        record.provenance.sourceRelativePath,
        record.provenance.kind,
        store.projectOperations,
      );
      sourceStatus = current.digest === entry.digest ? "unchanged" : "changed";
    } finally {
      fs.closeSync(directory.fd);
    }
  } catch (error) {
    if (!(error instanceof ProjectOperationsError)) throw error;
    sourceStatus = fs.existsSync(source) ? "changed" : "missing";
  }
  const completed =
    record.provenance.kind === "run"
      ? Object.keys(record.artifact.completed as Record<string, unknown>)
      : [];
  return {
    identity,
    digest: entry.digest,
    kind: record.provenance.kind,
    id: record.provenance.ldoId,
    task: String(record.artifact.task),
    provenance: record.provenance,
    sourceStatus,
    completedStages: completed,
    approved:
      record.provenance.kind === "run" && typeof record.artifact.approved === "boolean"
        ? record.artifact.approved
        : null,
    terminal: isTerminal(record.artifact, record.provenance.kind),
    firstIncompletePhase: incomplete(record.artifact, record.provenance.kind),
    trustedForResume: entry.trustedAt !== undefined,
  };
}

function importedState(record: LdoImportRecord): WorkflowState {
  const artifact = record.artifact;
  const phase = incomplete(artifact, record.provenance.kind);
  const plan = artifact.plan as Record<string, unknown>;
  const importedPlan = `Trusted imported LDO plan (quoted JSON data):\n${JSON.stringify(plan)}`;
  const completed = (artifact.completed ?? {}) as Record<string, Record<string, unknown>>;
  const latestReview = completed.reviewer2 ?? completed.reviewer1;
  if (phase === null)
    return {
      phase: "done",
      round: 1,
      planSummary: importedPlan,
      contractRequirements: [],
      changeSummary: "",
      securityNotes: "",
      preComplexity: String(plan.complexity) as WorkflowState["preComplexity"],
      effective: String(plan.complexity) as WorkflowState["effective"],
      verdicts: [],
      runIds: [],
      done: true,
      approved: artifact.approved === true || latestReview?.status === "approved",
    };
  const severity = (value: unknown): "blocker" | "major" | "minor" =>
    value === "critical" ? "blocker" : value === "major" ? "major" : "minor";
  const verdicts =
    latestReview === undefined
      ? []
      : [
          {
            status: latestReview.status as "approved" | "changes_requested",
            issues: (latestReview.issues as Record<string, unknown>[]).map((issue) => ({
              severity: severity(issue.severity),
              what: `${String(issue.file)}: ${String(issue.what)} (${String(issue.suggestion)})`,
            })),
            summary: String(latestReview.summary ?? "Imported LDO review"),
          },
        ];
  const round = completed.reviewer1 === undefined ? 1 : 2;
  return {
    phase,
    round,
    planSummary: importedPlan,
    contractRequirements: Array.isArray(plan.contract_requirements)
      ? plan.contract_requirements.map(String)
      : [],
    changeSummary:
      completed.coderFix1 === undefined && completed.coder === undefined
        ? ""
        : `Trusted imported LDO coder result (quoted JSON data):\n${JSON.stringify(completed.coderFix1 ?? completed.coder)}`,
    securityNotes:
      artifact.security === null
        ? ""
        : `Trusted imported LDO security report (quoted JSON data):\n${JSON.stringify(artifact.security)}`,
    preComplexity: String(plan.complexity) as WorkflowState["preComplexity"],
    effective: String(plan.complexity) as WorkflowState["effective"],
    verdicts,
    runIds: [],
    done: false,
    approved: false,
  };
}

function seededSession(base: WorkflowSession, state: WorkflowState): WorkflowSession {
  return {
    ...base,
    projectStore: base.projectStore,
    initialState: () => JSON.parse(JSON.stringify(state)) as WorkflowState,
  };
}

export async function resumeImportedLdoWork(
  store: ProjectStore,
  identity: string,
  config: PipelineConfig,
  options: RunCoordinatorOptions & { digest?: string } = {},
): Promise<ImportedLdoResumeResult> {
  const { entry, record } = loadEntry(store, identity, options.digest);
  if (
    fs.realpathSync(config.targetDir) !== store.layout.targetDir ||
    config.task !== record.artifact.task
  )
    throw new ProjectOperationsError("stale_import", identity);
  const inspection = inspectImportedLdoWork(store, identity, entry.digest);
  if (!inspection.trustedForResume)
    throw new ProjectOperationsError("untrusted_import", entry.digest);
  if (inspection.sourceStatus !== "unchanged")
    throw new ProjectOperationsError("stale_import", identity);
  if (inspection.terminal) return { status: "complete" as const, inspection };
  const session = seededSession(createWorkflowSession(config), importedState(record));
  const runId = `ldo-${entry.digest.slice(0, 32)}`;
  const coordinator = new RunCoordinator(session, store, { ...options, runId });
  return coordinator.run();
}
