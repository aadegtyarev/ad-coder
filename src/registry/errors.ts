/** Why a registry config or resolution was rejected. A discriminant the caller can branch on. */
export type RegistryErrorCode =
  | "invalid_config"
  | "duplicate_provider"
  | "duplicate_model"
  | "unsupported_api"
  | "missing_credential"
  | "unknown_model";

/**
 * Raised when a `RegistryConfig` fails validation or a resolution precondition
 * fails. Carries a `code` discriminant and a `detail` string holding ONLY an
 * identifier -- a provider id, a model name, an env-var NAME, or a field name --
 * NEVER a credential value, never a secret, never the offending config content.
 *
 * Mirrors the house style of `RunnerError` (numbers and names, dense WHY,
 * nothing that leaks): a `missing_credential` names the env-var it could not
 * read, not the value it expected; a `duplicate_model` names the colliding key,
 * not the model's payload. This is load-bearing for the credential boundary --
 * an operator can paste a `RegistryError` into a bug report without exposing a
 * key.
 */
export class RegistryError extends Error {
  override readonly name = "RegistryError";
  readonly code: RegistryErrorCode;
  /** The offending provider id, model name, env-var NAME, or field name -- never a value. */
  readonly detail: string;

  constructor(code: RegistryErrorCode, detail: string, message: string) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}
