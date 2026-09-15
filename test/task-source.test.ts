import { describe, expect, test } from "bun:test";
import { assertTaskSource } from "../evals/runner/task-source";

const original = { url: "original", license: "n/a", note: "shape invented here" };
const borrowed = {
  url: "https://github.com/jkoppel/QuixBugs",
  license: "MIT",
  note: "single-line defect form",
};

describe("calibration task provenance", () => {
  test("accepts an original shape and a licensed borrowed one", () => {
    expect(assertTaskSource("t", original)).toBe(original);
    expect(assertTaskSource("t", borrowed)).toBe(borrowed);
  });

  test("refuses a task that declares no provenance at all", () => {
    // Required of EVERY task, not only new ones: a grandfather list rots, and an
    // absent field then reads the same as an oversight.
    expect(() => assertTaskSource("t", undefined)).toThrow("must declare source");
    expect(() => assertTaskSource("t", { ...borrowed, url: "" })).toThrow("must declare source");
    expect(() => assertTaskSource("t", { ...borrowed, license: "" })).toThrow(
      "must declare source",
    );
    expect(() => assertTaskSource("t", { ...borrowed, note: "" })).toThrow("must declare source");
  });

  test("ties the empty licence to the original url in both directions", () => {
    // The corpus draws on sources as restrictive as GPL-2.0 and takes only the
    // FORM of a problem. `n/a` on a real link would erase the licence that makes
    // that claim auditable; a real licence on `original` claims a borrowing that
    // never happened. Both are wrong, so both throw.
    expect(() => assertTaskSource("t", { ...borrowed, license: "n/a" })).toThrow(
      'only valid for url "original"',
    );
    expect(() => assertTaskSource("t", { ...original, license: "MIT" })).toThrow(
      'only valid for url "original"',
    );
  });
});
