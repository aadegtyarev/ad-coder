# Documentation contract

This contract governs project documentation: prose that lets its intended
reader understand and use a product surface.

## Guarantees

- Documentation language is a project setting, not a harness rule. A selected
  documentation practice uses that language for generated or proposed prose.
- Every document states its intended reader and the question it answers. Put
  the shortest usable path first; reveal rationale and internals only as needed.
- Documentation is concise but complete for a technically capable reader new to
  the project: it explains purpose, the usable path, important constraints, and
  where to continue. A top-level index provides that entry path when several
  documents cover a system.
- Define project-specific terms before their first use. Use descriptive headings,
  short paragraphs, lists, tables, and diagrams when they reduce reading effort.
- Write in plain information style: lead with useful facts and actions, use
  specific verbs and nouns, and remove filler, repetition, and ceremonial prose.
- Edit the affected section as a coherent whole. Do not preserve stale prose or
  append facts merely to avoid making a structural decision.
- Document durable user, operator, or maintainer knowledge that code, tests,
  typed interfaces, and generated help cannot communicate clearly. Do not restate
  implementation line by line or create prose merely to satisfy a process.
- Architecture documentation is a map, not a change log or implementation dump.
  It names components, connections, trust boundaries, and load-bearing decisions.
  Detailed algorithms belong with their subsystem or focused design document.

## Verification

- Documentation obeys the mechanical readability limits in
  `docs/readability.json`; `bun run check:docs` enforces them.
- Review documentation as a cold reader before relying on implementation detail.
  Unexplained jargon, contradictory sources, and prose that hides the reader's
  action or system map block the change.
- Re-read a canonical document as a whole when the readability gate reports it
  near its budget. A diff-only review does not replace a whole-document audit.

## Related surfaces

- [Contract form](meta-contract.md).
- [Quality gates](quality.md).
- [Release metadata](release.md).
- [Project practices](project-practices.md) owns portable adoption and removal.
