import { expect, test } from "bun:test";
import { isWorkflowModule } from "../src/workflow";

test("isWorkflowModule rejects anything that is not a named module with a run function", () => {
  expect(isWorkflowModule(null)).toBe(false);
  expect(isWorkflowModule(undefined)).toBe(false);
  expect(isWorkflowModule({})).toBe(false);
  expect(isWorkflowModule({ name: "" })).toBe(false);
  expect(isWorkflowModule({ name: "x" })).toBe(false);
  expect(isWorkflowModule({ name: "x", run: 3 })).toBe(false);
  expect(isWorkflowModule({ name: 1, run: () => 1 })).toBe(false);
  expect(isWorkflowModule("x")).toBe(false);
});

test("isWorkflowModule accepts a named module with an async run", () => {
  expect(isWorkflowModule({ name: "x", run: async () => 1 })).toBe(true);
});
