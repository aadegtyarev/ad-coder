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
//
// Seven alternatives, LONGEST FIRST within each introducer, because the last
// one of a pair is a catch-all: an Fe/Fs/Fp escape is ESC plus exactly ONE byte
// in 0x30–0x7E (ECMA-48), and that byte is also what opens the longer forms —
// so a terminated sequence must be consumed whole rather than split into its
// opener plus text, and an UNTERMINATED one must still lose its ESC. Round 3
// measured what the old two-alternative form left behind, on BOTH name paths:
// `ESC 7` (DECSC), `ESC c` (RIS), `ESC X … ESC \` (SOS), and the CSI forms the
// old parameter class could not spell — private `ESC [ ?25l` and intermediate
// `ESC [ 1 q`. Each survived as ordinary text (`token 7=supersecret`,
// `token [?25l=supersecret`) and hid the assignment from the secret screen.
// Round 4 measured the two families that were still missing, both of which
// produce the same hidden assignment: the 8-BIT (C1) introducers, which are the
// same sequences one byte wide and are turned into a space by the class strip
// below — leaving their payload (`token 31m=supersecret`); and the CSI
// parameter byte `=`, whose consumption DESTROYS the assignment while keeping
// the secret (`token<ESC>[=supersecret` became `token upersecret`).
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const C1_CSI = String.fromCharCode(0x9b);
const C1_OSC = String.fromCharCode(0x9d);
const C1_ST = String.fromCharCode(0x9c);
const C1_STRING_OPENERS = [0x90, 0x98, 0x9e, 0x9f]
  .map((code) => String.fromCharCode(code))
  .join("");
// The string terminator, shared by the 7-bit and 8-bit forms: ST is either
// `ESC \` or the single C1 byte 0x9C.
const ST = `(?:${ESC}\\\\|${C1_ST})`;
// CSI payload: parameter bytes 0x30–0x3F WITHOUT `=`, then intermediate bytes
// 0x20–0x2F, then one final byte 0x40–0x7E. `=` is excluded deliberately — it
// is the one parameter byte that doubles as the assignment operator this screen
// looks for. Excluding it costs only the rare real `ESC [ = …` sequence, which
// then keeps its `=` as ordinary text: a false positive at worst, never a
// hidden secret.
const CSI_BODY = "[0-9;:?<>]*[ -/]*[@-~]";
// The single-byte catch-all covers every Fe/Fs/Fp escape EXCEPT the two bytes
// that are this screen's assignment operators: a catch-all that eats `ESC =`
// turns `token<ESC>=hunter2000` into `token hunter2000`, destroying the
// assignment and keeping the secret. Round 4 measured exactly that leak on both
// paths -- a regression the catch-all itself introduced, which is why it is
// excluded here rather than left to the class strip. `ESC :` and `ESC =` are
// unassigned in ECMA-48, so nothing real is lost.
const FE_BODY = "[0-9;<>?@-~]";
// An introducer whose sequence does NOT match the strict bodies above consumes
// up to the next assignment operator -- or to the end of the input when there is
// none. Round 4 filed this as a blocker, with four repros: an UNTERMINATED
// sequence (no BEL/ST/CSI final byte at all, `ESC ] 0;foo=supersecret`,
// `ESC P foo=supersecret`) never matched a strict alternative, so the single-byte
// catch-all removed the introducer ALONE and left the payload as ordinary text --
// and the payload carries the `=` of the assignment it was hiding, one word away
// from the keyword the screen looks for. Consuming the payload is what a terminal
// does with it: an unterminated string never ends, so nothing after it is
// displayed text. `=` is where the consumption STOPS rather than a byte it
// swallows, because it is the one byte the secret screen has to see: everything
// before it is sequence payload (removed), everything from it on is text (shown).
// That keeps the invariant the screen needs -- the leftover ALWAYS starts with
// the operator, and the text before the introducer is untouched, so `keyword =`
// stays adjacent exactly as it is in an ordinary draft (`token<ESC>]0;foo=secret`
// becomes `token =secret` and falls back). A payload with no operator at all has
// nothing to stop at: it is consumed to the end of the input, which is the same
// terminal behaviour and leaves no payload behind either way. The strict
// alternatives run first, so a properly terminated sequence -- even one whose
// payload contains `=` -- is still removed whole.
const UNTERMINATED_BODY = "[^=]*";
const ANSI_PATTERN = new RegExp(
  `${ESC}(?:` +
    `\\[${CSI_BODY}` + // CSI
    `|\\][^${BEL}]*(?:${BEL}|${ST})` + // OSC, to BEL or to ST
    `|[PX^_][^${ESC}]*${ST}` + // DCS, PM, APC, SOS, each to ST
    `|\\[${UNTERMINATED_BODY}` + // unterminated CSI
    `|\\]${UNTERMINATED_BODY}` + // unterminated OSC
    `|[PX^_]${UNTERMINATED_BODY}` + // unterminated DCS, PM, APC, SOS
    `|${FE_BODY}` + // any other Fe/Fs/Fp: ESC plus one byte
    `)` +
    `|${C1_CSI}${CSI_BODY}` + // 8-bit CSI
    `|${C1_CSI}${UNTERMINATED_BODY}` + // unterminated 8-bit CSI
    `|${C1_OSC}[^${BEL}${C1_ST}]*(?:${BEL}|${ST})` + // 8-bit OSC
    `|${C1_OSC}${UNTERMINATED_BODY}` + // unterminated 8-bit OSC
    `|[${C1_STRING_OPENERS}][^${ESC}${C1_ST}]*${ST}` + // 8-bit DCS/SOS/PM/APC
    `|[${C1_STRING_OPENERS}]${UNTERMINATED_BODY}`, // unterminated 8-bit strings
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
  // Screen the RAW draft first, in the same order as the generated path. Round
  // 3 disproved the claim that the screens below dominate this one: `token<BEL>`
  // IS matched here (`\S+` counts the BEL as a non-whitespace character) and is
  // matched by nothing after the strip, which turns the BEL into a space and
  // trims it away. So the line is not redundant, and it is not asserted as
  // harmless either — it has its own failing control in the test file. It
  // cannot shadow the typed refusal below: every pattern in the shared list
  // needs at least one visible character, so a draft that strips to nothing
  // never reaches this line.
  if (SECRET_SCREEN_PATTERNS.some((pattern) => pattern.test(raw))) return SESSION_FALLBACK_NAME;
  // The manual strip, in the order the contract's clauses imply: ANSI sequences
  // go FIRST, as whole sequences. Round 2 measured what happens otherwise:
  // ESC is a control character and the class strip below only replaces it, so
  // `token<ESC>[31m=supersecret` became `token [31m=supersecret` -- the screen
  // saw no assignment and the secret persisted into a display name. Round 3
  // found the same shape one level down, in the escape grammar itself: the
  // pattern only spelled CSI, OSC and DCS/PM/APC, so `ESC 7`, `ESC c`, `ESC X`
  // and `ESC [ ?25l` were not sequences to it at all and survived as text.
  const value = raw
    .replace(ANSI_PATTERN, " ")
    .replace(/[^\p{L}\p{N}\p{Zs}\p{P}\p{S}]/gu, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (value.length === 0)
    throw new RangeError("a manual name must contain at least one visible character");
  // Screen the form this path will PERSIST. What this screen catches on its own
  // is the separator the FLATTENED form destroys: `sk-abcdefg_h1234` is one
  // token to this screen and two to the next.
  // Screen the form this path will PERSIST — the contract's own screen on the
  // value that is about to be stored. It is the WEAKEST of the three, and that
  // is MEASURED, not assumed: a brute force over 7392 injected drafts (every
  // position of every separator family in eight secret shapes) found exactly one
  // shape it catches alone — a hidden separator before the `=` plus a tail made
  // ONLY of markdown characters, `token<ZWSP>=*`, persisted as `token =*`. That
  // shape holds no secret: a hidden separator cannot hide a secret that is not
  // there, and every draft that DOES carry one is caught by the raw screen or by
  // the flattened projection. It stays because it is the form the contract
  // names, because its removal is not measured safe, and because round 2's
  // claim that it DOMINATED the others was disproved in the other direction by
  // round 3 — stated as what was measured, not as strength.
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
