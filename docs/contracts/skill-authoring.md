# Skill authoring contract

This contract owns the portable Agent Skills format and writing rules for one
ad-coder skill.

## Guarantees

- A skill is a directory containing `SKILL.md`. That file begins with YAML
  frontmatter and Markdown instructions. Required standard fields are `name`
  (lowercase kebab-case, at most 64 characters) and `description` (non-empty,
  at most 1024 characters); unsupported frontmatter is preserved as metadata,
  not used as ad-coder policy.
- A skill may contain focused `scripts/`, `references/`, and `assets/` resources.
  Instructions use relative paths, keep reference chains shallow, and load a
  resource only when it serves the active task. A script's output, not its source,
  is the default context contribution.
- Description states both capability and concrete “Use when” triggers, including
  likely operator wording. It is the universal discovery surface; activation
  conditions do not live only in the body.
- The body gives a concise imperative method, required inputs/outputs, failure
  prevention, and completion check. It does not duplicate a role prompt, a
  contract, or a tool grant. Move specialized examples and long reference material
  into focused resources.
- A skill grants no tool, external-effect, or role authority. Role eligibility,
  mandatory use, and load policy are separately configured by ad-coder, so the
  same standard skill remains portable to another harness.
- A content digest, source identity, and optional author-supplied version identify
  a resolved skill. Changing instructions or resources changes the digest; an
  absent version is valid and never replaced with an invented one.

## Verification

Validate standard frontmatter, path/name agreement, description budget, resource
containment, digest, and referenced-resource reachability. Evaluate target and
non-target discovery, instruction loading, and completion checks with real tasks.

## Related surfaces

- [Skills](skills.md) owns discovery, selection, and role composition.
- [Role tools](role-tools.md) owns tool grants.
- [Security](security.md) owns trusted-source policy.
