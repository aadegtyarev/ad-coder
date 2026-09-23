# Skill practice research

For maintainers designing portable skills and economical skill discovery in
ad-coder. It answers which current conventions are stable enough for contracts.

## Findings

- The portable baseline is a skill directory with `SKILL.md`; YAML frontmatter
  requires `name` and `description`. The description must say what the skill does
  and when to use it, because it is the normal trigger surface.
- Progressive disclosure is the common model: metadata at startup, instructions
  only after activation, then references/assets as needed. This fits both small
  local context windows and large hosted-model windows better than eager loading.
- Scripts provide deterministic work without placing their source in model context;
  references should be focused and shallowly linked.
- Current hosts support explicit skill selection as well as automatic activation.
  The standards do not prescribe a role policy, selector algorithm, or vector
  retrieval, so those remain portable-host configuration rather than frontmatter.
- Repository skills are agent instructions and therefore a trust boundary. A skill
  cannot safely grant authority merely because it was selected.

## Sources checked

- [Agent Skills specification](https://github.com/agentskills/agentskills/blob/main/docs/specification.mdx)
  — portable format, directories, frontmatter, and progressive disclosure.
- [Anthropic: Agent Skills overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)
  — three-stage loading and metadata-triggered activation.
- [Anthropic: Skill authoring practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
  — concise instructions, resources, and scripts.
- [OpenAI: Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/)
  — metadata and skill-use instruction in the agent context.
- [Anthropic: repository skill trust](https://platform.claude.com/docs/en/managed-agents/skills)
  — repository skills as a trust boundary.
