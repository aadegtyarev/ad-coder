# Project practices contract

This contract owns optional, portable bundles of project practices, such as
documentation, contracts, decomposition, and quality setup.

## Guarantees

- A practice bundle is named, versioned, and composed of independently
  selectable practices. It declares its templates, settings, commands, and
  dependencies before any project file changes.
- `bootstrap` and `init` may propose a bundle from detected project evidence,
  but selection is the operator's. They show a concise preview and affected paths;
  no practice is enabled, written, or installed merely by detection.
- An operator can list, inspect, enable, disable, update, replace, or remove a
  selected bundle or one practice through equivalent TUI and machine operations.
  The same headless operations are available to the orchestrator under its normal
  mutation authority.
- Enabling creates only selected, namespaced managed assets and declared settings.
  It does not rewrite existing project prose, quality configuration, or source.
- Removal deletes only an unmodified managed asset owned by that selection. A
  changed, moved, or ambiguous asset is reported with a preview and requires an
  explicit operator resolution; user-authored content is never silently removed.
- Updating or replacing a bundle is a previewed migration between its declared
  asset revisions. It preserves project overrides and treats unresolved changes
  as operator decisions rather than overwriting them.
- A disabled or removed practice leaves the core and unrelated selected practices
  operational. Its former guidance is not injected into roles or presented as a
  project requirement.

## Configuration

Selected bundles, versions, individual practice state, and their project/profile
defaults follow standard settings precedence. A project may provide its own bundle
or replace any shipped bundle without changing the core.

## Verification

Test empty-project and existing-project preview, selective enablement, no-write
decline, TUI/API/orchestrator parity, unmodified removal, modified-asset conflict,
replacement, and core operation after every practice is disabled.

## Related surfaces

- [Documentation](documentation.md) owns documentation quality.
- [Decomposition](decomposition.md) owns structural code separation.
- [Quality bootstrap](quality-bootstrap.md) owns quality-gate setup.
- [Configuration](config.md) owns setting precedence.
- [Extension modules](extension-modules.md) owns optional module boundaries.
