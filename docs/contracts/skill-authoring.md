# Skill authoring contract

This contract owns the shape and writing rules of one skill under
`prompts/skills/<id>/` or `.ad-coder/skills/<id>/`.

## Guarantees

- A skill directory has `skill.json` and `instructions.md`. The manifest id
  matches its directory and declares version, trigger description, and every
  role that can perform the task; optional `always` and `requires` follow the
  [skills](skills.md) contract.
- A manifest is at most 4 KiB, instructions at most 16 KiB, and a role loads at
  most four skills per turn. Exceeding a limit fails loudly rather than evicting
  unspecified content.
- A description names the capability, says “Use when” with the work situation,
  and includes likely operator wording. It is at most 1,536 characters, specific
  enough to trigger and narrow enough to avoid unrelated loads. Changing it
  changes the skill version.
- `instructions.md` starts with the project-wide mandatory-instruction statement
  in its own paragraph. It teaches a concrete method, failure prevention, and
  stopping rule; it does not duplicate the role prompt or pad recurring context.
- The role prompt owns obligations that always apply. The harness owns an
  obligation tied to a lifecycle event. A skill owns technique: it is optional to
  load but binding when its description matches. Do not use `always` to carry an
  obligation that must survive a missed load.
- Write for progressive disclosure: descriptions are cheap catalogue entries,
  while loaded instructions recur on later session turns and therefore carry a
  continuing token cost.

## Verification

Validate manifest schema, id, size limits, mandatory opening, and description
budget. Review trigger wording and run the on-demand target/non-target trigger
evaluation when changing a shipped skill's applicability.

## Related surfaces

- [Skills](skills.md) owns resolver and loading behaviour.
- [Role tools](role-tools.md) owns role tool availability.
- [Quality](quality.md) owns project checks.
