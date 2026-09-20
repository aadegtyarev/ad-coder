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
// one of a pair is a catch-all: an escape that is not one of the longer forms is
// ESC, any number of intermediate bytes, and ONE final byte in 0x30–0x7E
// (ECMA-48), and that final byte is also what opens the longer forms —
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
// The single-byte catch-all covers every Fe/Fs/Fp escape EXCEPT two groups of
// bytes, and both exclusions are load-bearing:
//  - the two assignment operators this screen looks for. A catch-all that eats
//    `ESC =` turns `token<ESC>=hunter2000` into `token hunter2000`, destroying
//    the assignment and keeping the secret -- measured on both paths in round 4,
//    a regression the catch-all itself introduced. Both are unassigned escapes
//    in ECMA-48, so nothing real is lost.
//  - the bytes that OPEN a longer sequence: `[` CSI, `]` OSC, `P` DCS, `X` SOS,
//    `^` PM and `_` APC. Swallowing one of those as a two-byte escape is how an
//    unterminated sequence lost its introducer while its payload stayed as text
//    -- the round-4 finding, and the reason the dangling check below could not
//    see it. Excluded, the introducer SURVIVES the pass and the draft is refused
//    instead.
// The body itself is the standard one: any number of INTERMEDIATE bytes
// (0x20-0x2F) followed by one final byte. Round 6 filed the missing intermediate
// run as a blocker, and it was right: `red<ESC>#8 alert` -- DECALN, a fully
// delimited sequence, nothing unterminated about it -- was REFUSED instead of
// stripped, on both paths, and the contract asks for ANSI sequences to be
// stripped. `\` (0x5C) is a final byte here too: it is the 7-bit string
// terminator, a delimited two-byte escape on its own, and leaving it out refused
// `red<ESC>\alert` for the same non-reason.
//
// The final byte is the one position that needs TWO cases, and the split is
// load-bearing rather than cosmetic. With NO intermediate byte in front of it,
// an opener byte IS the longer form -- `ESC [` is CSI, `ESC ]` is OSC -- so
// swallowing one as a two-byte escape is exactly how an unterminated sequence
// lost its introducer in round 4. AFTER at least one intermediate byte the same
// byte is unambiguously a final: `ESC # [` is a complete unassigned escape that
// introduces nothing, because CSI is `ESC [` and only `ESC [`. Round 7 filed
// the missing half as a blocker -- `ESC # ]`, `ESC # P` and four more spellings
// came back as `New session` on both paths where a delimited sequence must be
// stripped -- and the two cases below are the fix.
//
// The two OPERATOR bytes stay excluded from both cases. Consuming one destroys
// the assignment the screens exist to see (`token<ESC>=hunter2000` -> `token
// hunter2000`, measured in round 4), and unlike an opener a `=` after an
// intermediate is a legal final this code chooses not to take: such a draft is
// REFUSED instead. That is the ONE false refusal this file accepts deliberately,
// and the direction is the safe one -- a refused title reads `New session`, an
// assignment eaten by the strip reads as a name.
const FE_FINAL = "[0-9;<>?@A-OQ-WYZa-z`{|}~\\\\]";
const FE_FINAL_AFTER_INTERMEDIATE = "[0-9;<>?@A-Z\\[\\\\\\]^_`a-z{|}~]";
const FE_BODY = `(?:${FE_FINAL}|[ -/]+${FE_FINAL_AFTER_INTERMEDIATE})`;
// Every alternative below is a sequence whose END the standard defines: CSI up to
// its final byte, OSC to BEL or ST, DCS/PM/APC/SOS to ST, and intermediates plus
// a final byte for the rest. NOTHING ELSE may be matched here, and round 5 is
// why: an earlier version consumed the bytes of an unterminated sequence up to
// the assignment operator, and the reviewer put a second introducer inside that
// payload -- `pre<ESC>]foo sec<ESC>]ret=supersecret` -- which re-split the keyword
// and left `pre =supersecret` on both paths. There is no correct place to stop:
// an unterminated sequence has no end, so whatever follows it is text an attacker
// chose. The rule is therefore strip-what-can-be-delimited, refuse the rest
// (DANGLING_ESCAPE_PATTERN), never guess.
const ANSI_PATTERN = new RegExp(
  `${ESC}(?:` +
    `\\[${CSI_BODY}` + // CSI
    `|\\][^${BEL}]*(?:${BEL}|${ST})` + // OSC, to BEL or to ST
    `|[PX^_][^${ESC}]*${ST}` + // DCS, PM, APC, SOS, each to ST
    `|${FE_BODY}` + // any other Fe/Fs/Fp: ESC plus one byte
    `)` +
    `|${C1_CSI}${CSI_BODY}` + // 8-bit CSI
    `|${C1_OSC}[^${BEL}${C1_ST}]*(?:${BEL}|${ST})` + // 8-bit OSC
    `|[${C1_STRING_OPENERS}][^${ESC}${C1_ST}]*${ST}`, // 8-bit DCS/SOS/PM/APC
  "g",
);
// An introducer byte that SURVIVES the pass above opened a sequence this code
// cannot delimit: an unterminated OSC/DCS/CSI, an `ESC =` or `ESC :` (the two
// operator bytes, deliberately not in FE_BODY), a C1 introducer with no ST. The
// candidate is REFUSED rather than guessed at -- the strip is not allowed to
// decide where such a sequence ends, because the payload of that decision is
// exactly where the secrets of rounds 2 through 5 hid.
const DANGLING_ESCAPE_PATTERN = new RegExp(`[${ESC}${C1_CSI}${C1_OSC}${C1_STRING_OPENERS}]`);
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

/**
 * The GLUED projection: the draft with every surface the strip removes DELETED
 * rather than replaced by a space. The strip replaces, because a display wants
 * `red<ESC>[31m alert` to read `red alert` and not `redalert` -- but that same
 * replacement is a way to hide an assignment: ONE stripped byte inside a keyword
 * splits it into two words, and `sec<ESC>]x<BEL>ret=supersecret` is then an
 * assignment no pattern can see, because `sec ret` is not the keyword. Round 5
 * measured eleven such drafts, including both the reviewer's nested repro and
 * every family this strip already knew how to remove; the glued form catches all
 * of them, because it is the draft with nothing injected. Screened, never
 * persisted.
 */
function glue(raw: string): string {
  return raw
    .replace(ANSI_PATTERN, "")
    .replace(ZERO_WIDTH_PATTERN, "")
    .replace(CONTROL_PATTERN, "")
    .replace(MARKDOWN_PATTERN, "");
}

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
  const withoutSequences = raw.replace(ANSI_PATTERN, " ");
  // Refuse a draft whose escape sequences cannot be delimited (round 5), and
  // screen the GLUED projection, where no stripped byte can split a keyword
  // (round 5).
  if (DANGLING_ESCAPE_PATTERN.test(withoutSequences))
    return { value: SESSION_FALLBACK_NAME, nameSource: "generated", fellBack: true };
  if (SECRET_SCREEN_PATTERNS.some((pattern) => pattern.test(glue(raw))))
    return { value: SESSION_FALLBACK_NAME, nameSource: "generated", fellBack: true };
  const stripped = withoutSequences
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
  const withoutSequences = raw.replace(ANSI_PATTERN, " ");
  // A sequence this code cannot delimit is not stripped, it is REFUSED: where an
  // unterminated sequence ends is not a decision the strip may make (round 5).
  if (DANGLING_ESCAPE_PATTERN.test(withoutSequences)) return SESSION_FALLBACK_NAME;
  // And the GLUED projection, because the space this strip inserts in place of a
  // sequence is itself a place to hide: one stripped byte inside the keyword
  // makes `sec ret=supersecret` out of `secret=supersecret` (round 5).
  if (SECRET_SCREEN_PATTERNS.some((pattern) => pattern.test(glue(raw))))
    return SESSION_FALLBACK_NAME;
  const value = withoutSequences
    .replace(/[^\p{L}\p{N}\p{Zs}\p{P}\p{S}]/gu, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (value.length === 0)
    throw new RangeError("a manual name must contain at least one visible character");
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
