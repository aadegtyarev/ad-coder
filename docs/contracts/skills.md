# Skills contract

Skills are trusted, versioned instruction bundles loaded only when selected for
a role/task. They reduce permanent role-prompt size; they are not a second
unbounded prompt directory.

- A skill has a safe `id`, `version`, concise manifest description, role scope,
  and `instructions.md`. Its selected content and source have a SHA-256 digest.
- Built-in skills ship with ad-coder. A project may add or override a skill at
  `.ad-coder/skills/<id>/`; project skills are trusted operator configuration,
  like project prompt overrides. Package/remote skills require an explicit later
  plugin installation path.
- V1 resolves only explicitly selected IDs and therefore does not scan or
  enumerate skill directories. Selected manifests and instructions load under
  separate finite count/byte limits. Unknown, malformed, duplicate, escaping,
  or oversized skills fail loudly before provider dispatch. Bounded manifest
  discovery is a separately tracked v2 capability.
- Selection is programmatic and visible: callers supply skill IDs through the
  library or console `--skills`. Version, source tier and digest are exposed by
  the resolver. Durable pipeline snapshots are a separately tracked v2 boundary;
  v1 never claims resume-stable skill selection.
  Future discovery may let the orchestrator recommend skills from manifest
  descriptions, but it must never silently inject full instructions into every
  role prompt.
- Built-in `architecture-recon`, `task-slicing`, `acceptance-review`, and
  `delivery-calibration` are the
  first shipped skills. Their outputs respectively bound exploration, define a
  minimal acceptance-tested slice, verify delivery independently, and estimate
  accepted-result cost before bounded dispatch.
