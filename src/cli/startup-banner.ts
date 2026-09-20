/**
 * The startup banner is printed ONCE per process, keyed on its CONTENT
 * (issue #501).
 *
 * `resolvePipelineConfig` runs once per role delegation behind one session, and
 * each run printed the whole banner again -- twenty banner printings were
 * measured in one console session. A repeated identical banner is repeated
 * noise, not a milestone (docs/contracts/operator-flow.md), so the memo
 * remembers every banner text this process has already printed and stays
 * silent on a repeat. The key is the banner TEXT itself, never a call count:
 * a genuinely different routing in the same process is a different banner and
 * prints once. The resolved routing data itself is untouched -- only the
 * repeated console print is.
 */

const printed = new Set<string>();

/** Print `text` through `warn` the first time this exact text is printed in this process. */
export function printStartupBannerOnce(text: string, warn: (message: string) => void): void {
  if (printed.has(text)) return;
  printed.add(text);
  warn(text);
}

/** Test seam: forget what this process has already printed. */
export function resetStartupBanners(): void {
  printed.clear();
}
