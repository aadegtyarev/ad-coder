export type UserProfileErrorCode =
  | "invalid_profile"
  | "unsupported_version"
  | "invalid_path"
  | "not_found"
  | "unsafe_file"
  | "conflict"
  | "io_error";

/** Error surface for profile validation, persistence, and explicit import conflicts. */
export class UserProfileError extends Error {
  override readonly name = "UserProfileError";
  constructor(
    readonly code: UserProfileErrorCode,
    readonly detail: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
