# LDO — vendored copy

Vendored from LDO v2.52.0 on 2026-09-12T17:11:49Z.

This is a project-native install, not a plugin — no `/plugin update` applies
to it. There is no background check pulling in newer versions; that would
mean phoning home from inside a project's own dev pipeline, and this
deliberately doesn't do that.

To refresh: re-run `scripts/vendor.sh` from a current LDO checkout, pointed
at this project. Check LDO's own CHANGELOG.md for what changed since
v2.52.0 before overwriting — a vendored copy already customized for
this project (routing in CLAUDE.md, project contracts) isn't touched by
vendoring; only the LDO-owned files under .claude/agents, .claude/skills,
.claude/workflows, .claude/core, .claude/adapters, .claude/schemas and
.claude/scripts are replaced.
