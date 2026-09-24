import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createTimerWaitAdapter,
  ProjectStore,
  WaitAdapterValidationError,
  WaitService,
  WaitServiceError,
} from "../src";

test("timer adapter observes numeric deadline without scheduling", async () => {
  let now = 100;
  const adapter = createTimerWaitAdapter({ now: () => now });
  const input = {
    waitId: "w",
    operationId: "o",
    source: { adapter: "timer", version: 1, target: { kind: "timer", id: "alarm" } },
    condition: { kind: "at", at: 200 },
  } as const;
  expect(await adapter.reconcile(input)).toEqual({ lifecycle: "pending" });
  now = 200;
  expect(await adapter.reconcile(input)).toEqual({
    lifecycle: "satisfied",
    evidence: "condition_met",
  });
});

test("timer validation rejects missing numeric threshold with a typed error", () => {
  const adapter = createTimerWaitAdapter();
  expect(() => adapter.validate({ kind: "timer", id: "alarm" }, { kind: "at" })).toThrowError(
    new WaitAdapterValidationError("invalid_condition", "timer"),
  );
});

test("WaitService rejects a durable adapter version before invoking it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wait-timer-service-"));
  let invoked = false;
  try {
    const store = new ProjectStore(root);
    const service = new WaitService(store, [
      {
        id: "timer",
        version: 1,
        validate() {},
        reconcile() {
          invoked = true;
          return { lifecycle: "satisfied" as const, evidence: "condition_met" as const };
        },
      },
    ]);
    expect(() =>
      service.create({
        source: { adapter: "timer", version: 2, target: { kind: "timer", id: "alarm" } },
        condition: { kind: "at", at: 200 },
        owner: { kind: "operator", id: "operator" },
        policy: { delivery: "events" },
        recovery: "inspect",
      }),
    ).toThrowError(new WaitServiceError("invalid_adapter"));
    expect(invoked).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
