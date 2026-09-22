# Skills contract

This contract owns skill discovery, selection, loading, and prompt integration.
Skills are trusted versioned instruction bundles, not an unbounded prompt directory.

## Guarantees

- Built-in skills ship with ad-coder; `.ad-coder/skills/<id>/` adds or overrides
  trusted project skills. Selected content has an id, version, source tier, and
  SHA-256 digest visible in effective configuration.
- Skills resolve as exactly one mode: the role catalogue default, an explicit
  `--skills` pin, or explicit off (`--no-skills` or persistent capability
  setting). Explicit flags win over the setting; off suppresses every skill.
- Unknown, malformed, duplicate, escaping, oversized, pinned, or loaded skills
  fail before provider dispatch. Bounded trusted directories are enumerated;
  this is not a claim to scan arbitrary filesystem content.
- A catalogue lists only skills reachable by a role and its resolved composition.
  It renders `id@version` and description; the loader accepts that exact address
  or bare id, refuses an unlisted version distinctly, and answers at most once
  per turn.
- The catalogue is the always-read trigger surface. Full instructions reach a
  prompt only through a load, pin, or justified `always` paste. When a listed
  skill describes the work, loading and following it is mandatory.
- `always` defaults false and is limited to text a role cannot understand its
  situation without. `requires` names resolved workflow modules or registered
  tool capabilities; an unmet requirement hides the skill from catalogue, paste,
  and configuration. An always skill is pasted rather than catalogued.
- Per-turn skill count and byte limits apply consistently to all source tiers.
  A loaded skill may not restate a role prompt, and role prompts may not name a
  tool the role was not granted.
- Every role prompt, including the summarizer, uses the same prompt loader and
  project override mechanism. Pipeline snapshots do not claim resume-stable
  selection until that is explicitly implemented.

## Configuration

Skills are enabled by default. Persistent capability settings and CLI pins or
off switches follow [configuration](config.md) precedence and worker transport.

## Verification

Test source precedence, selection modes, role scope, composition requirements,
address resolution, limits, and no-skills behaviour. Use the on-demand skill
trigger evaluation for shipped descriptions; it measures target loads, absent
non-target loads, and attributable tool activity.

## Related surfaces

- [Skill authoring](skill-authoring.md) owns an individual skill's content.
- [Role tools](role-tools.md) owns tool grants.
- [Tool observability](tool-observability.md) owns activity evidence.
