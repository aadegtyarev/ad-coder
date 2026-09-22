import type { JsonlSessionMetadata } from "@earendil-works/pi-agent-core";

export type ProjectStoreArea =
  | "sessions"
  | "runs"
  | "scratch"
  | "attachments"
  | "downloads"
  | "cache"
  | "ledger"
  | "tmp";

export interface ProjectStoreLayout extends Record<ProjectStoreArea, string> {
  readonly targetDir: string;
  readonly root: string;
  readonly gitignore: string;
}

export type ProjectStoreRetention = Record<ProjectStoreArea, number>;

export interface ProjectStoreByteLimits {
  attachment: number;
  state: number;
  jsonlRecord: number;
}

export interface ProjectStoreLockRetryConfig {
  /** Milliseconds to wait after each failed acquisition, in order. */
  delaysMs?: readonly number[];
}

export interface ProjectStoreConfig {
  retention?: Partial<ProjectStoreRetention>;
  byteLimits?: Partial<ProjectStoreByteLimits>;
  /** Bounded policy for live versioned-state lock contention. */
  lockRetry?: ProjectStoreLockRetryConfig;
  projectOperations?: ProjectOperationsConfig;
}

export interface ProjectOperationsConfig {
  /** Optional trusted branch label added to engine-authored FollowUp provenance. */
  branch?: string;
  backlogBackend?: "files" | "github";
  evidenceLimit?: number;
  aggregationLimit?: number;
  claimLeaseMs?: number;
  documentation?: {
    root?: string;
    contracts?: string;
    notes?: string;
  };
  ldo?: {
    /** Project-relative LDO root. Defaults to .codex/ldo. */
    root?: string;
    plans?: string;
    runs?: string;
    artifactCountLimit?: number;
    perFileByteLimit?: number;
    aggregateByteLimit?: number;
  };
  github?: {
    repository?: string;
    stateLabels?: Partial<
      Record<"queued" | "claimed" | "in_progress" | "review" | "blocked" | "done", string>
    >;
    managedLabel?: string;
  };
  publishing?: RepositoryPublishingConfig;
  controlPlane?: import("../orchestration/control-plane").ControlPlaneConfig;
}

export type PublishingGate = "local" | "ci" | "local-and-ci" | "manual";
export type PublishingMode = "auto" | "github" | "local";

export interface RepositoryPublishingConfig {
  remote?: string;
  baseCandidates?: string[];
  protectedBases?: string[];
  featurePrefix?: string;
  mode?: PublishingMode;
  gate?: PublishingGate;
  localTestCommand?: string[];
  multiDeveloper?: boolean;
  outputByteLimit?: number;
}

export interface VersionedState<T> {
  version: number;
  value: T;
}

export interface AttachmentMetadata {
  id: string;
  name: string;
  path: string;
  size: number;
  sha256: string;
  createdAt: number;
}

export interface ProjectSessionMetadata extends JsonlSessionMetadata {}

export interface CleanupResult {
  area: ProjectStoreArea;
  removed: string[];
}

export type ProjectStoreErrorCode =
  | "invalid_config"
  | "invalid_id"
  | "not_found"
  | "already_exists"
  | "unsafe_path"
  | "unsafe_object"
  | "version_conflict"
  | "resource_limit"
  | "corrupt_state"
  /** Complete JSONL transactions claim the same durable sequence. */
  | "ambiguous_journal";

export class ProjectStoreError extends Error {
  override readonly name = "ProjectStoreError";
  constructor(
    readonly code: ProjectStoreErrorCode,
    readonly path: string,
    message: string,
  ) {
    super(message);
  }
}
