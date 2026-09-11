/** Why a profile config or a profile resolution was rejected. A discriminant the caller can branch on. */
export type ProfileErrorCode =
  | "invalid_config"
  | "duplicate_entry"
  | "unknown_role"
  | "invalid_complexity"
  | "missing_mapping"
  | "unknown_model";

/**
 * Raised when a `Profile` fails validation or a `(role, complexity)` resolution
 * precondition fails. Carries a `code` discriminant and a `detail` string
 * holding ONLY an identifier -- a `ProfileRole` token, a `Complexity` token, a
 * composite `role:complexity` key, a registry model NAME, or a field name --
 * NEVER a value, never a secret, never the offending config content.
 *
 * Mirrors `RegistryError`/`OrchestrationError` exactly (a `code`, a names-only
 * `detail`, dense WHY): this is load-bearing for the credential boundary an
 * operator can paste a `ProfileError` into a bug report without leaking a key or
 * config body. The profile layer handles model NAMES only never a credential
 * so `detail` has nothing sensitive to carry in the first place, and this
 * invariant keeps it that way as the module grows.
 *
 * `unknown_model` is INTENTIONALLY the same code string `RegistryError` uses:
 * `resolveProfile` catches a `RegistryError('unknown_model')` from the registry
 * lookup and rethrows it as a `ProfileError('unknown_model', name)` so the
 * profile layer presents ONE typed error surface. The two are distinguished by
 * error CLASS, not by code a caller that must tell them apart asserts
 * `instanceof ProfileError`, never on `code === 'unknown_model'` alone.
 */
export class ProfileError extends Error {
  override readonly name = "ProfileError";
  readonly code: ProfileErrorCode;
  /** A role/complexity/model-name/field token or a `role:complexity` key -- never a value. */
  readonly detail: string;

  constructor(code: ProfileErrorCode, detail: string, message: string) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}
