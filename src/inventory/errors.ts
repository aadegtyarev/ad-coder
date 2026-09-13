export type ModelInventoryErrorCode =
  | "invalid_config"
  | "duplicate_profile"
  | "unknown_profile"
  | "missing_selection"
  | "unknown_model";

/** Names-only inventory failure safe for logs and machine output. */
export class ModelInventoryError extends Error {
  override readonly name = "ModelInventoryError";
  constructor(
    readonly code: ModelInventoryErrorCode,
    readonly detail: string,
    message: string,
  ) {
    super(message);
  }
}
