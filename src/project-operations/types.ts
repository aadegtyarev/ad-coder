import type { ProjectOperationsConfig } from "../project-store/types";

export interface FollowUpProvenance {
  producer: string;
  runId: string;
  branch?: string;
}

export interface FollowUpEvidence {
  summary: string;
  path?: string;
  line?: number;
  sha256?: string;
}

interface FollowUpBase {
  title: string;
  evidence: FollowUpEvidence[];
  provenance: FollowUpProvenance[];
}

/** Model-submitted shape. Provenance is always added by the harness. */
export type FollowUpCandidate =
  | Omit<ContractFollowUp, "provenance">
  | Omit<NoteFollowUp, "provenance">
  | Omit<DesignDocDriftFollowUp, "provenance">
  | Omit<BacklogFollowUp, "provenance">;

export interface ContractFollowUp extends FollowUpBase {
  kind: "contract";
  contract?: string;
}
export interface NoteFollowUp extends FollowUpBase {
  kind: "note";
}
export interface DesignDocDriftFollowUp extends FollowUpBase {
  kind: "design-doc-drift";
  document: string;
}
export interface BacklogFollowUp extends FollowUpBase {
  kind: "backlog";
  priority?: "low" | "medium" | "high";
}

export type FollowUp = ContractFollowUp | NoteFollowUp | DesignDocDriftFollowUp | BacklogFollowUp;

export interface FollowUpValidationOptions {
  evidenceLimit?: number;
  aggregationLimit?: number;
}

export const DEFAULT_PROJECT_OPERATIONS_CONFIG: Required<
  Pick<
    ProjectOperationsConfig,
    "backlogBackend" | "evidenceLimit" | "aggregationLimit" | "claimLeaseMs" | "ldo" | "publishing"
  >
> = {
  backlogBackend: "files",
  evidenceLimit: 0,
  aggregationLimit: 0,
  claimLeaseMs: 0,
  ldo: {
    root: ".codex/ldo",
    artifactCountLimit: 0,
    perFileByteLimit: 0,
    aggregateByteLimit: 0,
  },
  publishing: {
    remote: "origin",
    baseCandidates: ["main", "master"],
    protectedBases: ["main", "master"],
    featurePrefix: "feature/",
    mode: "auto",
    gate: "local",
    localTestCommand: ["bun", "test"],
    multiDeveloper: false,
    outputByteLimit: 0,
  },
};
