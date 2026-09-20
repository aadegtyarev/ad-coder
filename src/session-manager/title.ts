/**
 * Bounded untrusted title generation (docs/ROADMAP.md 2026-09-14;
 * docs/contracts/session-manager.md): ONE shared sanitizer for every name that
 * reaches a session — length limit, ANSI and zero-width stripping, markdown
 * flattening, whitespace collapse, and a secret screen — before anything
 * persists. A screen failure leaves the neutral fallback, on BOTH paths: the
 * contract screens "titles ... and manual names" alike. What the manual path
 * keeps that a generated one cannot touch is its SOURCE: a manual name is
 * never replaced by a later generated title.
 */

import { SESSION_FALLBACK_NAME, type SessionNameSource } from "./types";

export const DEFAULT_TITLE_MAX_LENGTH = 48;
export const MANUAL_NAME_MAX_LENGTH = 64;

// Constructed rather than regex-literal: the lint refuses literal control
// characters and escape sequences in regex literals, so the ANSI bytes are
// joined from numeric constants instead — ONE shared definition, no state.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const ANSI_PATTERN = new RegExp(
  `${ESC}(?:\\[[0-9;]*[A-Za-z]|\\][^${BEL}]*(?:${BEL}|${ESC}\\\\)|[P^_][^${ESC}]*${ESC}\\\\)`,
  "g",
);
// Literal control characters and escape sequences are refused in regex
// literals by the lint, so these are written as Unicode property escapes:
// Cf (zero-width/directional) plus Zl/Zp separators cover the invisible
// families, and the full Cc control category is stripped just below.
const ZERO_WIDTH_PATTERN = /[\p{Cf}\p{Zl}\p{Zp}]/gu;
// The entire Cc (control) category, not just \r\n\t: NUL, backspace, DEL
// and the rest are all surfaces that must never survive into a display name.
const CONTROL_PATTERN = /\p{Cc}/gu;
const MARKDOWN_PATTERN = /[*_`#~]+/g;

/** One screen, one list, shared by every non-manual name path. */
const SECRET_SCREEN_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/,
  /\bg(?:sk|ha)_[A-Za-z0-9_-]{8,}\b/,
  /\bxox[baprs]-[A-Za-z0-9_-]{8,}\b/,
  /\beyJ[A-Za-z0-9_-]{20,}\b/, // a JWT header is never a session title
  /(?:api[\s_-]*key|token|secret|password|passwd|auth|bearer)\s*[:=]\s*\S+/i,
  /\b\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\b/, // a card number is never a session title
  /\bBEGIN (?:RSA )?PRIVATE KEY\b/,
];

export interface SanitizedTitle {
  value: string;
  nameSource: SessionNameSource;
  /** True when the draft was refused by the screen or the length cap. */
  fellBack: boolean;
}

function clamp(value: string, maxLength: number): string {
  // Code POINTS, not UTF-16 units (docs/contracts/session-manager.md, "length-
  // capped in code points"): slicing units cuts a surrogate pair in half and
  // persists a LONE surrogate into a display name. Measured before this fix
  // (issue #365, pinned by the astral test in test/session-manager.test.ts):
  // sixty astral characters clamped to 25 code points with
  // `isWellFormed() === false`, where the cap is 48.
  const points = [...value];
  if (points.length <= maxLength) return value;
  return `${points
    .slice(0, maxLength - 1)
    .join("")
    .trimEnd()}…`;
}

export function sanitizeTitle(
  raw: string | undefined,
  maxLength = DEFAULT_TITLE_MAX_LENGTH,
): SanitizedTitle {
  if (typeof raw !== "string" || raw.trim().length === 0)
    return { value: SESSION_FALLBACK_NAME, nameSource: "generated", fellBack: true };
  // Screen BEFORE the transforms: a separator inside the draft (a markdown
  // `_`, an ANSI sequence) can be moved or removed by them and would otherwise
  // hide a secret from its own pattern.
  if (SECRET_SCREEN_PATTERNS.some((pattern) => pattern.test(raw)))
    return { value: SESSION_FALLBACK_NAME, nameSource: "generated", fellBack: true };
  const stripped = raw
    .replace(ANSI_PATTERN, " ")
    .replace(ZERO_WIDTH_PATTERN, "")
    .replace(MARKDOWN_PATTERN, " ")
    .replace(CONTROL_PATTERN, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (stripped.length === 0)
    return { value: SESSION_FALLBACK_NAME, nameSource: "generated", fellBack: true };
  // Screen AGAIN after the transforms: a secret split by a control or markdown
  // character still must fall back rather than persist.
  if (SECRET_SCREEN_PATTERNS.some((pattern) => pattern.test(stripped)))
    return { value: SESSION_FALLBACK_NAME, nameSource: "generated", fellBack: true };
  return { value: clamp(stripped, maxLength), nameSource: "generated", fellBack: false };
}

/**
 * A manual name is bounded, control-stripped — and secret-screened, exactly as
 * the contract requires of it: "Titles are UNTRUSTED model output and manual
 * names are remote user input: both are length-capped in code points, stripped
 * of ANSI escape sequences and control characters, secret-screened ... A
 * candidate that sanitizes to empty falls back to `New session`." A name that
 * trips the screen therefore leaves that SAME neutral fallback rather than
 * persisting a pasted secret into a display name every front renders; a name
 * that strips to nothing is still the typed refusal it always was. What no
 * later step may do is replace a manual name with a GENERATED one — the source
 * stays `manual` (`SessionManager.setTitleFromGeneration`).
 *
 * Note the two transforms this path does NOT apply: control and zero-width
 * characters are removed by the character-class strip below rather than by
 * their own patterns (the class already covers `\p{Cc}`, `\p{Cf}`, `\p{Zl}`,
 * `\p{Zp}` and runs first, which is why the zero-width call that used to sit
 * there was provably dead and is gone), and markdown characters are KEPT in the
 * persisted name — the contract does not ask a manual name to be flattened. The
 * screen still sees the flattened projection, so keeping them hides nothing.
 */
export function createManualSessionName(raw: string): string {
  // The manual strip, in the order the contract's clauses imply: ANSI sequences
  // go FIRST, as whole sequences. Round 2 measured what happens otherwise:
  // ESC is a control character and the class strip below only replaces it, so
  // `token<ESC>[31m=supersecret` became `token [31m=supersecret` -- the screen
  // saw no assignment and the secret persisted into a display name.
  const value = raw
    .replace(ANSI_PATTERN, " ")
    .replace(/[^\p{L}\p{N}\p{Zs}\p{P}\p{S}]/gu, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (value.length === 0)
    throw new RangeError("a manual name must contain at least one visible character");
  // Screen the form this path will PERSIST. It is also every form the RAW draft
  // can match, and that is why there is no separate raw screen here: these
  // transforms only ever REPLACE a character with an ordinary space, they never
  // delete, and every pattern either spans whitespace freely (`\s*`, `\S+`) or
  // works on characters the strip keeps, so nothing that matches the raw draft
  // stops matching after normalization. What this screen catches on its own is
  // the separator the FLATTENED form destroys: `sk-abcdefg_h1234` is one token
  // to this screen and two to the next.
  if (SECRET_SCREEN_PATTERNS.some((pattern) => pattern.test(value))) return SESSION_FALLBACK_NAME;
  // And screen the markdown-flattened PROJECTION -- the exact form the
  // generated path screens. A manual name keeps `* _ ` # ~` (the contract does
  // not ask this path to flatten them), and a separator it KEEPS must not hide
  // a secret the generated path would catch: `token*=supersecret` is caught
  // here and nowhere else. The projection is never persisted.
  const flattened = value.replace(MARKDOWN_PATTERN, " ").replace(/\s{2,}/g, " ");
  if (SECRET_SCREEN_PATTERNS.some((pattern) => pattern.test(flattened)))
    return SESSION_FALLBACK_NAME;
  return clamp(value, MANUAL_NAME_MAX_LENGTH);
}
