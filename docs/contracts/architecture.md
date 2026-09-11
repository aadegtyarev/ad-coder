# Architecture contract

Structural rules the operator declared for ad-coder. A violation is always blocking.

- 2026-09-11: Headless-first. Capabilities live in a programmatic core (a library);
  the TUI, CLI and any API are thin fronts. No logic lives in a front.
- 2026-09-11: Every capability is reachable programmatically — a library API and a
  machine-mode CLI (--json / --auto / non-interactive), never interactive/TUI-only.
  A machine (script, CI, external orchestrator, Telegram bridge) can do all a human can.
