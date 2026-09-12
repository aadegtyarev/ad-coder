export type ProjectOperationsErrorCode =
  | "invalid_follow_up"
  | "resource_limit"
  | "unsafe_destination"
  | "invalid_transition"
  | "claim_conflict"
  | "not_claim_holder"
  | "not_found"
  | "github_unavailable"
  | "invalid_config";

export class ProjectOperationsError extends Error {
  override readonly name = "ProjectOperationsError";
  constructor(
    readonly code: ProjectOperationsErrorCode,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
  }
}
