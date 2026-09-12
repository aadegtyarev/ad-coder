import { expect, test } from "bun:test";
import { resolveWorkflowModules } from "../src/workflows/registry";
import type { OrchestratorWorkflowModule } from "../src/workflows/types";

const module = (name: string): OrchestratorWorkflowModule => ({
  name,
  description: name,
  buildTools: () => [],
});

test("workflow registry selects only explicitly enabled modules in requested order", () => {
  const a = module("a");
  const b = module("b");
  expect(resolveWorkflowModules([a, b], ["b"])).toEqual([b]);
  expect(resolveWorkflowModules([a, b], [])).toEqual([]);
});

test("workflow registry fails loudly on unknown, duplicate, or unsafe names", () => {
  expect(() => resolveWorkflowModules([module("a")], ["missing"])).toThrow(
    "unknown workflow module",
  );
  expect(() => resolveWorkflowModules([module("a"), module("a")], [])).toThrow(
    "duplicate workflow module",
  );
  expect(() => resolveWorkflowModules([module("../bad")], [])).toThrow(
    "invalid workflow module name",
  );
});
