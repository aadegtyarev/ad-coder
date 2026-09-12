# Public release readiness

**Date:** 2026-09-12

This is an exceptional pre-publication audit. Gitleaks scanned all 145 reachable
Git commits (4.34 MB) and found no secrets. A second scan of the exact tracked
and proposed-PR file set (2.05 MB) also found no secrets. No credential file,
`.env`, private key, `.ad-coder/`, or `.codex/` path is tracked.

A broad scan of the whole local directory did flag generic-key candidates inside
ignored `.ad-coder/sessions/` transcripts. Those runtime files are not part of
Git or the public artifact and were intentionally not deleted by this audit; they
remain local sensitive state under the operator's control.

Release metadata was corrected from the historically reused `0.1.0` to `0.2.0`.
The quality contract now requires user-visible changelog entries and SemVer bumps
for installable releases. CI verifies manifest/changelog consistency, while the
artifact smoke verifies that `ad-coder about` reports the packed manifest version.

Built-in role prompts and the repository's LDO instructions now explicitly
prevent an ad-coder worker from recursively starting LDO or another pipeline.
