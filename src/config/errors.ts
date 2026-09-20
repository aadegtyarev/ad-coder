/** Why a `models.yaml` or `settings.yaml` was rejected. A discriminant the caller can branch on. */
export type ConfigErrorCode =
  | "invalid_config"
  | "unknown_provider"
  | "unknown_model"
  | "unknown_role"
  | "invalid_complexity"
  | "orphan_override"
  | "unknown_profile"
  /**
   * The resolve could not pick a route (issue #453). Every rung of the
   * precedence ladder -- models.yaml, --inventory-config, --registry-config,
   * --provider, and the env-preset provider keys -- was absent at resolve
   * time. The `detail` is the names of the absent rungs and the env-var
   * NAMES that could have resolved one, never a credential value and never
   * provider prose. The console keeps its present env-preset/codex fallback;
   * the detached worker entry is the only caller that asks the resolve to
   * raise this code instead of substituting a route.
   */
  | "route_unresolved";

/**
 * Raised when an operator-edited config document fails validation. Carries a
 * `code` discriminant and a `detail` string holding ONLY an identifier -- a
 * provider NAME, a model NAME, a `ProfileRole` token, a `Complexity` token, a
 * profile NAME, a `role@complexity` row key, a `provider:model` rung, or a field
 * path -- NEVER a value, never a credential, never a header, never a config
 * body.
 *
 * Mirrors `RegistryError`/`ProfileError` exactly (a `code`, a names-only
 * `detail`, dense WHY). The config layer is the first one an operator edits by
 * hand, so it is the likeliest one to be pasted into a bug report along with
 * whatever the file contains; `detail` being names-only is what makes that
 * safe. `providers.<name>.headers` values and `<name>.credential` are the two
 * places a secret can live in these files, and the module never echoes either
 * -- not in `detail`, not in `message`.
 *
 * `invalid_config` is the code for every shape problem (a wrong type, a
 * missing field, an unknown key), the same way `ProfileError` uses it for every
 * field-level deviation: the `code` tells a caller which RECOVERY applies, and
 * every shape problem has the same one -- fix the file.
 */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
  readonly code: ConfigErrorCode;
  /** A provider/model/profile/role/complexity name, a row key, a rung, or a field path -- never a value. */
  readonly detail: string;

  constructor(code: ConfigErrorCode, detail: string, message: string) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}
