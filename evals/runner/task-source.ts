/** Where a task's SHAPE came from, and the licence that governs reusing it. */
export interface TaskSource {
  /** A URL, or the literal `"original"` for a shape invented here. */
  url: string;
  /** SPDX id or the licence's own name; `"n/a"` only alongside `url: "original"`. */
  license: string;
  /** What was taken -- always a form, never content. */
  note: string;
}

/**
 * Rejects a task whose provenance is missing or self-contradictory.
 *
 * Lives here rather than inline in the corpus runner so it can be tested
 * without executing the runner, which loads and validates the whole manifest
 * at import time.
 */
export function assertTaskSource(id: string, source: TaskSource | undefined): TaskSource {
  if (
    typeof source?.url !== "string" ||
    !source.url ||
    typeof source.license !== "string" ||
    !source.license ||
    typeof source.note !== "string" ||
    !source.note
  )
    throw new Error(`task must declare source (url, license, note): ${id}`);
  // `n/a` is the licence of nothing, so it is only honest next to a shape this
  // project invented. Anywhere else it would silently launder a real licence --
  // and the corpus deliberately draws on sources as restrictive as GPL-2.0, from
  // which it takes only the FORM of a problem. The link and the licence name are
  // what make that claim auditable, so neither may be dropped.
  if ((source.license === "n/a") !== (source.url === "original"))
    throw new Error(`source license "n/a" is only valid for url "original": ${id}`);
  return source;
}
