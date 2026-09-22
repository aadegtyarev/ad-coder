# Lifecycle hooks contract

This contract owns extensible harness lifecycle hooks.

## Guarantees

- Hooks expose stable semantic events: session start/resume/close; before and
  after turn; before and after role, agent, workflow, lane, tool, external
  action, retry, and quality gate; context compaction; durable wake; and settled
  error or result. An event has a versioned, bounded, secret-free payload and a
  durable identity when it affects work.
- When the selected SDK supplies a matching hook, ad-coder adapts that native
  hook to the semantic event. Its own hook runtime supplies only missing events;
  the two paths never invoke a subscriber twice for one lifecycle occurrence.
  SDK-specific names and payloads do not escape the adapter boundary.
- A hook declares an id, source, scope, event, kind, order, configuration schema,
  and compatible event version. Kinds are observer (cannot alter work), guard
  (allow or typed refusal), and explicitly owned transformer (bounded documented
  fields only). Ordering is deterministic by phase, configured priority, then id.
- Hook modules are trusted, versioned extension modules. Project prompts and
  untrusted tool output cannot register a hook. General subscribers receive
  redacted event projections; only a core-owned transformer may receive a named
  sensitive in-memory surface such as context transformation.
- Observer failure records a bounded diagnostic and continues. Guard or
  transformer failure refuses or pauses the affected action with a typed recovery
  path; it never makes success-shaped progress or silently removes a safety gate.
- Hook registration, enabled state, order, and limits are settings. TUI, machine
  API, and the orchestrator can list and configure hooks through the shared
  settings registry. Hook effects checkpoint durable completion markers, so
  resume and replay are idempotent for a lifecycle identity.

## Verification

Test native SDK adaptation, own-runtime fallback, exact-once delivery,
deterministic ordering, payload redaction, observer isolation, guard/transformer
refusal, incompatible-version rejection, settings parity, and replay after resume.

## Related surfaces

- [Extension modules](extension-modules.md) owns hook module boundaries.
- [Settings interface](settings-interface.md) owns configuration controls.
- [Resumability](resumability.md) owns replay and checkpoints.
- [Public error behaviour](errors.md) owns typed hook failures.
