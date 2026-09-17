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
- 2026-09-17 (issue #241): **`bash` carries the user's full authority;
  `--target-dir` is only a working directory, not an isolation boundary.**
  `--target-dir` sets the starting cwd of `bash` and bounds the file and
  project tools; it does NOT confine `bash`. A run can `cd` anywhere, run
  `git -C <other path>`, use absolute paths, or reach any tool that takes a
  path, and the commands it can already invoke subvert any textual gate
  ("work only here") the moment the model forgets it mid-task. A command
  string filter would be a fake boundary for exactly these reasons (`git -C`,
  `$(...)`, env vars, path-taking tools), so none is installed; if isolation
  matters, it must come from the shell layer (a dedicated OS user or a
  container), which is where this issue's concurrent-worktrees episode must be
  contained too.
  Consequences an operator accepts: the blast radius of `bash` is everything
  the invoking user can read and write -- any repository, any dotfile, any
  credential store. Two runs in separate worktrees are NOT isolated from each
  other by `--target-dir` alone. The file and project tools DO bound their own
  paths to the target; an advisory boundary there is documented, and one tool
  refusing an outside path while `bash` reaches the same path is a known,
  accepted asymmetry of this declaration.

## Accepted risks

A target project's prompt author can direct a role with the same authority the
operator granted that role. This is intentional trusted configuration, not an
untrusted-content boundary. The fixed bare role-name validation remains a path
construction invariant, not a prompt trust cage.
