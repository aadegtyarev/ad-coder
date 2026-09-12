---
name: ldo-feedback
description: File a bug or observation about LDO itself — structured, secrets redacted, as a GitHub issue in the LDO repo
---

Feedback about LDO used to be free-form — whatever the operator felt like writing, in whatever shape. That's the problem: two reports about the same bug carry different information, one omits the version, another pastes a token straight into the issue. This skill makes it structured (every report has the same fields), safe (secrets and accounts are redacted by a script, not by memory), and actionable (it lands as a GitHub issue in `aadegtyarev/ldo-ai`).

## When

- The pipeline errored, stalled, or produced a wrong result and the cause looks like LDO, not the task
- You noticed a gap, a confusing message, or a behavior worth changing
- `/ldo-resume` hit an `abandoned` run for a reason that looks like a bug

Not for the project's own bugs — this is feedback on the orchestrator.

## The structured form

Fill every field. "Not applicable" is a valid answer; silently omitting the field isn't.

1. **Version + install** — the `version` in `.claude-plugin/plugin.json`, or in `.claude/LDO_VENDORED.md` if vendored. Say which install shape.
2. **Where** — which agent/phase (Planner / Coder / Reviewer / Security / Recorder), or "config", "vendoring", "the CLI block", "LDO as a whole".
3. **What happened** — the observed failure. Evidence, not assertion: the exact error line, the log, the diff, the unexpected output.
4. **What was expected** — what should have happened instead.
5. **How to reproduce** — the `task` text, the minimal steps, the relevant command. A bug nobody can reproduce stays open forever.
6. **Context / impact** — how it was found, what it cost (an extra review pass, a manual fix, a wrong result), any workaround.
7. **Environment** — Claude Code version, OS. (Secrets and accounts in any of these get redacted by the next step.)

## Redact, then show, then file

**Never post without the operator seeing the redacted text.** `gh issue create` publishes to a public repo; a redaction miss is a token in a public issue.

First resolve the gate. This skill runs with the cwd set to the operator's project, not the plugin root, so a bare `scripts/redact.sh` resolves against whatever repo happens to be open — which is somebody else's script. Use `${CLAUDE_PLUGIN_ROOT}/scripts/redact.sh`, or the path recorded in `.claude/LDO_VENDORED.md` for a vendored install. **A `redact.sh` found relative to the operator's cwd must not be used.** If neither path exists, that is the "the redaction gate is broken, do not file" branch below.

Then, before writing anything: `echo '.claude/ldo-feedback-*' >> .git/info/exclude` in the current project. `info/exclude` is never committed and never conflicts, and the `.gitignore` entry in the LDO repo does not protect the project you are actually working in.

The order is:

1. Confirm the gate works: `"$REDACT" --self-test` — every line must be `ok`. If any fail, do not proceed; the redaction itself is broken and needs fixing first.
2. Compose the title and body from the form above into a **private temp file outside any repo**, named so it cannot be confused with the postable one:
   ```
   umask 077
   RAW=$(mktemp -t ldo-feedback-UNREDACTED.XXXXXX)
   STAMP=$(date +%s)-$$
   BODY=.claude/ldo-feedback-body-$STAMP.md
   TITLE=.claude/ldo-feedback-title-$STAMP.txt
   ```
   The raw file holds exactly the tokens, home paths and hostnames the gate exists to strip. It never goes under `.claude/` and never inside a git working tree.
3. Redact into files, and **fail closed**:
   ```
   "$REDACT" < "$RAW" > "$BODY" || { echo "redaction failed"; rm -f "$RAW" "$BODY"; exit 1; }
   [ -s "$BODY" ] || { echo "redaction produced an empty body"; rm -f "$RAW" "$BODY"; exit 1; }
   ```
   and the same for the title. A failed or partial redaction still creates the output file through the redirection, so the exit status and a non-zero length are both checked. Reject a title containing a newline — a multi-line title means the composition step went wrong.
4. **Show the redacted title and body to the operator and wait for confirmation.** The operator is the last gate — if the script over-redacted something harmless (a commit hash, an IP that wasn't sensitive) or under-redacted, they see it here. Over-redaction is deliberate and safe; under-redaction is the failure to catch. Record `sha256sum "$BODY" "$TITLE"` at the moment you show them.
5. On confirmation, re-check that hash — nothing may have rewritten the files between the operator approving the bytes and `gh` reading them — and prove the file about to be published has been through the gate:
   ```
   "$REDACT" < "$BODY" | diff - "$BODY" || { echo "body was not produced by redact.sh — refusing to post"; exit 1; }
   ```
   Redaction is idempotent, so re-running it over an already-redacted file is a no-op; any difference means the file is not the gate's output. **The only file that may ever be passed to `--body-file` is the output of redact.sh.**
6. Then file it:
   ```
   gh issue create --repo aadegtyarev/ldo-ai --title "$(cat "$TITLE")" --body-file "$BODY"
   ```
   Two reasons for this exact shape. `--body-file`: a multi-KB markdown body with backticks, `$`, quotes and fenced blocks passed as an inline shell argument is how issues #5–#8 were filed with a zero-length body, and `gh issue create` returns a URL and exit 0 either way. `"$(cat …)"` for the title: the title is model-composed from run material, and redact.sh neutralizes secret *shapes*, not shell metacharacters — `$`, backticks and `$(…)` pass through it untouched and a double-quoted argument still performs command substitution. The result of a command substitution is not re-evaluated, so metacharacters inside the file are inert. Do not undo either of these.
7. **Verify it landed.** Read the issue back and diff it against the file you posted:
   ```
   gh issue view <n> --repo aadegtyarev/ldo-ai --json body --jq .body > /tmp/ldo-feedback-posted.md
   diff /tmp/ldo-feedback-posted.md "$BODY"
   ```
   A difference confined to a trailing newline is fine; anything else is a failure. On failure the body file is still on disk, so reattach it rather than retyping: `gh issue edit <n> --repo aadegtyarev/ldo-ai --body-file "$BODY"`, then read back again. If that edit itself fails — it was measured failing on an unrelated `projectCards` GraphQL deprecation while shipping 2.33.0 — go through the API instead, which sets the body from a JSON field and never touches a command line:
   ```
   python3 -c "import json,sys;json.dump({'body':open(sys.argv[1]).read()},open(sys.argv[2],'w'))" "$BODY" "$BODY.json"
   gh api -X PATCH repos/aadegtyarev/ldo-ai/issues/<n> --input "$BODY.json" --jq '.body | length'
   ```
   then read back again. **Reporting the URL to the operator without having run this check is not filing it.** `/ldo-ship` runs the same read-back after `gh pr create`, against the same failure: `gh` returns a URL and exit 0 whether the body arrived or not.
8. Last, on the success path and on every failure path alike: `rm -f "$RAW" "$BODY" "$BODY.json" "$TITLE" /tmp/ldo-feedback-posted.md`. The raw file is the one that matters — it is unredacted by definition.

## If you can't file

- **No `gh` or not authenticated**: the redacted body file from step 3 already exists; tell the operator its path and to post it manually, and skip only the deletion of that one file. Never skip the redaction because `gh` isn't there — the redaction is the point, the issue is the destination. Delete the raw temp file regardless.
- **Redaction self-test fails, or the gate cannot be resolved from the plugin root**: report that the gate is broken and do not file; nothing leaves the machine, and the raw temp file is deleted.

## Keep it minimal

One issue per distinct problem, not one per run. A run that failed because the task was ambiguous isn't an LDO bug — it's a task problem. Before filing, ask: is the defect in the orchestrator, or in the input it was given? Two reports of the same bug are worse than one; check for an existing open issue first with `gh issue list --repo aadegtyarev/ldo-ai --state open`.
