# Documentation contract

For contributors and reviewing agents, this contract answers: what must make a
project document usable by a human, and which checks block an unclear change?

Documentation is a product surface. A change is not complete when its prose is
technically true but costly for its intended reader to understand.

- State the intended reader and the question the document answers. Put the
  shortest usable path first; rationale and internals follow by progressive
  disclosure.
- Architecture documentation is a map, not a change log or implementation dump.
  It names components, connections, trust boundaries, and load-bearing decisions;
  detailed algorithms belong beside the subsystem or in a focused design note.
- Edit the whole affected section for coherence. Do not preserve every historical
  sentence or append facts merely because deleting and restructuring requires
  judgment.
- Define project-specific terms before first use. Prefer short paragraphs,
  descriptive headings, lists, tables, and diagrams when they reduce reading
  effort. Mechanical limits are configured in `docs/readability.json` and enforced
  by `bun run check:docs`.
- For every changed documentation surface, the Planner identifies its reader and
  task. The Reviewer performs a cold-reader pass before consulting implementation
  detail and blocks unclear ordering, unexplained jargon, contradictory sources,
  and prose that hides the action or system map.
- Documentation participates in the whole-project audit defined by the quality
  contract. Also run a whole-document audit when the readability gate reports a
  canonical document near or beyond its budget. A per-diff review is not a
  substitute for periodically reading the document end to end.
