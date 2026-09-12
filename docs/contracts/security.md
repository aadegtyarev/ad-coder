# Security contract

Security decisions the operator declared for ad-coder. A violation is always blocking.

- 2026-09-12: Project-local `.ad-coder/prompts/*.md` role overrides are trusted
  operator configuration and activate automatically, byte-verbatim.
- 2026-09-12: Prompt overrides have no opt-in, symlink, size, ownership, mode,
  permission-validation, content-validation, or sandbox restriction in this MVP.
- 2026-09-12: Ordinary use of already-authorized tools is accepted existing
  authority and does not alone elevate Security; newly introduced input,
  persistence, credential, permission, execution, or outbound surfaces do.
- 2026-09-12: Research sends only bounded questions and non-secret facts through
  explicitly configured tools; destinations and provenance are visible and persisted.

## Accepted risks

A target project's prompt author can direct a role with the same authority the
operator granted that role. This is intentional trusted configuration, not an
untrusted-content boundary. The fixed bare role-name validation remains a path
construction invariant, not a prompt trust cage.
