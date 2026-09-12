export type ProjectOperationsErrorCode =
  | "invalid_follow_up"
  | "resource_limit"
  | "unsafe_destination"
  | "invalid_transition"
  | "claim_conflict"
  | "not_claim_holder"
  | "not_found"
  | "github_unavailable"
  | "invalid_config"
  | "checkpoint_conflict"
  | "pending_decision"
  | "unauthorized_resolution"
  | "unresolved_review"
  | "malformed_import"
  | "unsupported_import"
  | "unsafe_import"
  | "stale_import"
  | "untrusted_import"
  | "not_repository"
  | "protected_base"
  | "base_moved"
  | "dirty_index"
  | "unauthorized_path"
  | "gate_failed"
  | "approval_required"
  | "publish_failed"
  | "stale_binding";

export class ProjectOperationsError extends Error {
  override readonly name = "ProjectOperationsError";
  constructor(
    readonly code: ProjectOperationsErrorCode,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
  }
}
