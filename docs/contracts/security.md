# Security contract

This contract owns the trust and authority boundaries of an ad-coder run.

## Guarantees

- Project-local `.ad-coder/prompts/*.md` overrides are trusted operator
  configuration and load automatically, byte-for-byte. A project prompt author
  can direct a role with the authority granted to that role.
- Prompt overrides have no opt-in, ownership, permission, content, size,
  symlink, or sandbox validation. The fixed role-name validation is a path
  construction invariant, not a trust boundary.
- Using an already-authorized tool does not itself introduce a new security
  surface. New input, persistence, credential, permission, execution, or
  outbound surfaces do, and require security review.
- Research sends only bounded questions and non-secret facts through explicitly
  configured tools. Its destination and provenance are visible and durable.
- `bash` has the invoking user's full authority in the default open execution
  mode. `--target-dir` sets its starting directory; it is not sandboxing. File
  and project tools enforce their own target paths, but that advisory boundary
  does not constrain bash. [Execution boundary](execution-boundary.md) owns the
  future enforceable execution seam and the limited destructive-command guard.

## Accepted risks

Runs in separate worktrees are not isolated by `--target-dir`: bash can use
absolute paths, change directory, or invoke path-taking programs. The blast
radius is everything the invoking user can access. Isolation requiring a real
boundary must use a dedicated OS user or container.

## Verification

Review any change that adds an authority surface or changes prompt loading,
research delivery, target-path enforcement, or shell execution. Test the
relevant refusal or containment path; do not claim isolation from a textual
command filter.

## Related surfaces

- [Role tools](role-tools.md) owns which tools a role receives.
- [Configuration](config.md) owns persisted settings and credentials.
- [Product changes](product-change.md) owns the review and delivery workflow.
- [Execution boundary](execution-boundary.md) owns tool execution policy.
