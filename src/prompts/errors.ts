/** Why a prompt could not be resolved. A discriminant the caller can branch on. */
export type PromptErrorCode = "invalid_name" | "not_found";

/**
 * Raised when `resolvePrompt` refuses a name or cannot find a prompt file.
 * Carries a `code` discriminant, the offending `promptName` (the bare name the
 * caller asked for -- `Error.name` is taken, so a distinct field), and
 * `pathsTried`, the absolute candidate paths searched in override order.
 *
 * It carries ONLY the name and the paths tried -- NEVER the file contents or
 * the prompt body. A system prompt is read verbatim as the cacheable cache
 * prefix and could hold sensitive instructions, so a `PromptError` an operator
 * pastes into a bug report exposes a name and some paths, nothing more. Mirrors
 * the names-and-paths-only contract of `RegistryError` and `RunnerError`.
 */
export class PromptError extends Error {
  override readonly name = "PromptError";
  readonly code: PromptErrorCode;
  /** The offending bare prompt name -- never a value, never file content. */
  readonly promptName: string;
  /** The absolute candidate paths searched, in override order -- never content. */
  readonly pathsTried: readonly string[];

  constructor(
    code: PromptErrorCode,
    promptName: string,
    pathsTried: readonly string[],
    message: string,
  ) {
    super(message);
    this.code = code;
    this.promptName = promptName;
    this.pathsTried = pathsTried;
  }
}
