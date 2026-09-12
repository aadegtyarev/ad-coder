---
name: ldo-tui
description: Design and build terminal interfaces that earn the screen — keyboard-first, honest, degrading gracefully — in Textual (Python) or Ink (TypeScript)
---

A terminal is a small, scarce surface. Most of the time the right answer is a linear stream of text — a command with flags, not a full-screen interface. This skill is for the times that isn't true, when a 2D layout genuinely helps, and for making those not look like a web app wearing a costume.

Work in **Textual** (Python) or **Ink** (TypeScript/React). The principles are the same; only the primitives differ, and they're at the end.

## Decide the shape first

Before any layout, answer one question: **does this need to take over the screen at all?**

The strongest argument for restraint is accessibility. A screen reader consumes the terminal as a *stream* — text in, chronological. A full-screen TUI treats it as a *grid of cells* and redraws it, so the cursor jumps around and the reader hears fragments mixed together. For a blind user a well-designed linear CLI is not a compromise; it's faster and clearer than a "smart" TUI. Go full-screen only when the work is genuinely spatial: a list you navigate, a form, a dashboard of changing values.

When in doubt, build the stream version. It composes with pipes, scripts cleanly, and never traps anyone.

## Principles

### 1. Keyboard-first, and discoverable

The terminal's native input is the keyboard. Honour the conventions people already carry:

- `q` quits; `Esc` cancels or goes back (not always quit); `Ctrl+C` always interrupts, and always works. For a tool where quitting loses work, confirm an accidental `q`/`Esc` — "pressed one too many and lost my place" is a documented complaint, not a nitpick.
- `?` shows help, `/` searches, `:` opens a command line if you have one.
- `j`/`k` or arrows scroll; `g`/`G` top and bottom; `Tab` moves focus; `Enter` confirms, `Space` toggles.

Show the keybindings on screen, at least until the user is fluent. `?` is expected; a hidden keymap is a dead end.

### 2. Degrade in tiers, and respect the environment

Colour support is not uniform and you must not assume it. Build so each tier stands alone:

1. **Monochrome** — the tool is fully usable with no colour at all. Structure carries meaning: spacing, weight, characters.
2. **16 ANSI colours** — readable and correct everywhere.
3. **Truecolor** — the finishing layer, never load-bearing.

Then obey the signals. Respect `NO_COLOR`. Offer `--color=always|never|auto`. Detect whether `stdout` is a TTY, and when it isn't — piped, redirected, run by a script — emit plain text, no colour, no spinners, no boxes. A tool whose output only makes sense on a live terminal is one nobody can automate.

### 3. Density over chrome

Every border, every line of whitespace, every box-drawing frame is space a real value could have used. Terminals are small. Default to none of it; add a frame only when a region genuinely needs to be set apart. Two adjacent lists separated by a blank column reads better than two lists each wrapped in a box.

### 4. Don't lie with progress

A progress bar that stalls at 99% — because the real work is final verification you can't measure — is worse than no bar. If you can't compute honest progress, show a spinner, or a count (`47 files…`), or nothing. The research is clear that *perception* of progress can be engineered, but engineering it to look faster while it stalls is the lie this rule exists to stop.

### 5. Survive the environment

The terminal is hostile: it resizes, it runs inside `tmux` and `screen` and `ssh`, it's Windows Terminal or a Linux console with 8 colours. Re-render on `SIGWINCH`. Test inside a multiplexer. Use the alternate screen for full-screen apps and **restore it on exit** — including on crash — or you leave the user's scrollback destroyed. Test the wide-character and emoji case; it breaks layouts that counted columns.

## Anti-patterns (named, so you can spot them)

- **The terminal web-app** — borders, panels, widgets, gradients, trying to recreate a GUI. "The worst of both worlds: an inferior UI in an inferior rendering system." The reference is not your screen, it's `htop` and `lazygit` and the Unix tools.
- **Colour vomit** — every value a different hue with no system. Pick a small palette where colour *means* something: one for emphasis, one for warning, one muted. If red is both an error and a brand colour, you have no palette.
- **The lying progress bar** — a determinate bar for indeterminate work. See principle 4.
- **Undiscoverable keymaps** — power locked behind keys nobody told you about.
- **The required prompt** — an interactive question with no `--yes` / flag fallback, so the tool can't run in a script. Never require a prompt.
- **Broken on resize** — a layout that collapses or overlaps instead of reflowing.
- **Gradient and ASCII-art headings** — the "AI slop" look: purple-to-cyan title text, centered everything, decorative art. It reads as effort spent on appearance rather than the tool.
- **Full-screen redraw flicker** — repainting the whole frame each tick instead of the changed region.

## Keys, and where they break

Terminals encode keys as bytes, and several of those encodings collide. If you bind control-key combos you will hit this — so design for the lowest common denominator, not the terminal you're testing in.

- **`Ctrl` + letter is `key & 0x1F`.** So `Ctrl-M` is Enter, `Ctrl-I` is Tab, `Ctrl-H` is Backspace, `Ctrl-[` is Esc, `Ctrl-D` is end-of-file. You can't bind these as distinct actions.
- **`Ctrl-S` / `Ctrl-Q` are XON/XOFF.** With default TTY settings the kernel freezes output on `Ctrl-S` and your app never sees the key — the screen just stops. Don't bind them; if you must, tell users to `stty -ixon`.
- **`Ctrl+Shift+letter` is indistinguishable from `Ctrl+letter`** in the legacy encoding. Shift as a separate modifier needs the Kitty protocol, below.
- **macOS has no Meta key by default.** Option composes characters; `Alt`/`Meta` bindings silently do nothing until the user changes a terminal setting. Never make a Meta binding essential.
- **Modifier + arrow is unreliable** — encodings vary across terminals and terminfo has no standard caps for `Ctrl`/`Alt`+arrow. Bare arrows are safe; modified arrows aren't.
- **`Esc` is ambiguous.** The byte `0x1B` is both a lone Esc and the prefix of every escape sequence, so parsers wait on a timer to decide — and under `tmux` that timer defaults to half a second. A laggy Esc is a terminal problem, not yours, but it's why Esc-to-quit can feel sluggish.

The **Kitty keyboard protocol** (`CSI u`) fixes the ambiguity and is supported by kitty, foot, Ghostty, iTerm2, WezTerm, Alacritty, Windows Terminal, and the libraries Textual (≥0.67), Bubble Tea v2, and crossterm. **But `tmux` does not pass it through** — the enable sequence is silently dropped, and a large share of users run inside a multiplexer. Design for the legacy encoding; opt into Kitty as progressive enhancement when you detect it.

## Process — two passes, with a critique between

**Pass 1: design before code.** Decide stream vs. full-screen. Sketch the layout in ASCII and write out the keymap and the palette — three colours at most, each with a job. Write the one sentence a first-time user reads on launch.

Then **critique it against the anti-pattern list above**, before writing anything. Be the skeptic: which of these is this design flirting with? A layout that survives the critique is worth building; one that doesn't usually means the stream version was right after all.

**Pass 2: build.** Follow the result. Test with the framework's test harness, then by hand inside `tmux`, at 40 columns, over `ssh`, with `NO_COLOR=1` set.

## Restraint

One signature element — a single interaction or visual choice that makes the tool memorable — and discipline everywhere else. The tool that does one thing well and gets out of the way is the one people keep.

## Framework notes

The principles above are framework-agnostic. When you build, the current primitives:

**Textual (Python)** — `App` subclass with a `compose()` generator yielding widgets; `textual.containers` (`Container`, `Horizontal`, `Vertical`) for layout; styling in a `.tcss` stylesheet (`CSS_PATH`) or inline (`CSS`), a real CSS dialect with grid; find widgets with `query_one` / `query`. Test headless with `Pilot` — `async with app.run_test() as pilot`, then `pilot.press(...)`, `pilot.click(...)`, `pilot.pause()`. Use `@work` for background tasks rather than raw `asyncio`. Type `compose() -> ComposeResult`.

**Ink (TypeScript/React)** — `render(<App/>)` from `ink`, React hooks from `react`. Every element is a flexbox `<Box>` (`flexDirection`, `justifyContent`, `alignItems`, `width`/`height`, `gap`). **All text must be inside `<Text>`; never nest a `<Box>` in a `<Text>`.** Keyboard via `useInput((input, key) => …)` where `key` carries `upArrow`, `return`, `escape`, `tab`, `backspace`. Quit with `exit()` from `useApp()`, or `Ctrl+C` (on by default). Test with `ink-testing-library` — `render(<App/>)` returns `lastFrame()` as a string. Use `<Static>` for output that scrolls above the live region.

For anything beyond the skeleton, the framework's own docs are the source — this skill is about taste, not an API reference, and an API reference here would be stale before it was useful.
