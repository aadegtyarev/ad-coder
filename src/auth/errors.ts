export type AuthErrorCode =
  | "credential_store"
  | "invalid_credential_path"
  | "authentication_required"
  | "authentication_failed";

export class AuthError extends Error {
  override readonly name = "AuthError";

  constructor(
    readonly code: AuthErrorCode,
    readonly detail: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function authenticationRequired(providerId: string, cause?: unknown): AuthError {
  return new AuthError(
    cause === undefined ? "authentication_required" : "authentication_failed",
    providerId,
    `provider "${providerId}" is not authenticated; run "ad-coder auth login"`,
    undefined,
  );
}
