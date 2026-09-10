import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  Context,
  HookHandler,
  HookInvocation,
  Hooks,
  SettledAssistantMessage,
} from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { FileLedgerSink, Ledger, LEDGER_BASE_DIR, MemoryLedgerSink } from "../src/ledger/ledger";
import type { LedgerSink } from "../src/ledger/ledger";
import type { LedgerRecord } from "../src/ledger/types";

const scratchDirs: string[] = [];

afterAll(() => {
  for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** A fresh subdirectory of the ledger base, so permission tests cannot collide. */
function scratchDir(label: string): string {
  const dir = path.resolve(LEDGER_BASE_DIR, `test-${label}-${Math.random().toString(36).slice(2, 10)}`);
  scratchDirs.push(dir);
  return dir;
}

function usage(input: number, total: number, cost: number): Usage {
  return {
    input,
    output: 10,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: total,
    cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

function settled(u: Usage): SettledAssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    usage: u,
    stopReason: "stop",
    timestamp: 1_757_000_000_000,
  };
}

function event(u: Usage, status?: number): HookInvocation<"after_response"> {
  return {
    runId: "run-1",
    lane: "main",
    message: settled(u),
    // A real event may carry a headers map; the ledger must never copy it out.
    headers: { "x-request-id": "abc", authorization: "Bearer secret" },
    ...(status !== undefined && { status }),
  };
}

interface Registration {
  name: string;
  id: string | undefined;
  handler: HookHandler<"after_response">;
}

function fakeHooks(): { hooks: Hooks; registered: Registration[] } {
  const registered: Registration[] = [];
  const hooks: Hooks = {
    on(name, handler, options) {
      const entry: Registration = {
        name,
        id: options?.id,
        handler: handler as unknown as HookHandler<"after_response">,
      };
      registered.push(entry);
      return () => {
        const index = registered.indexOf(entry);
        if (index >= 0) registered.splice(index, 1);
      };
    },
  };
  return { hooks, registered };
}

const FAKE_CONTEXT = {} as Context;

function collectKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (value === null || typeof value !== "object") return into;
  for (const [key, nested] of Object.entries(value)) {
    into.add(key);
    collectKeys(nested, into);
  }
  return into;
}

test("runId is rejected unless it is safe as a file name", () => {
  for (const runId of ["../escape", "run/1", "run 1", "", "a".repeat(65), "run;rm"]) {
    expect(() => new Ledger({ runId, role: "r", step: "s" })).toThrow(/runId/);
  }
  const ok = new Ledger({ runId: "run_1-A", role: "r", step: "s", sink: new MemoryLedgerSink() });
  expect(ok.runId).toBe("run_1-A");
});

test("an explicit filePath outside the ledger base directory is rejected", () => {
  expect(() => new Ledger({ runId: "run1", role: "r", step: "s", filePath: "/tmp/evil.jsonl" })).toThrow(
    /must resolve inside/,
  );
  expect(
    () =>
      new Ledger({
        runId: "run1",
        role: "r",
        step: "s",
        filePath: `${LEDGER_BASE_DIR}/../../escape.jsonl`,
      }),
  ).toThrow(/must resolve inside/);
});

test("sink and filePath together are rejected as ambiguous", () => {
  expect(
    () =>
      new Ledger({
        runId: "run1",
        role: "r",
        step: "s",
        filePath: `${LEDGER_BASE_DIR}/x.jsonl`,
        sink: new MemoryLedgerSink(),
      }),
  ).toThrow(/not both/);
});

test("attach registers exactly one after_response handler and returns its unsubscribe", () => {
  const { hooks, registered } = fakeHooks();
  const ledger = new Ledger({ runId: "run1", role: "r", step: "s", sink: new MemoryLedgerSink() });

  const off = ledger.attach(hooks);
  expect(registered).toHaveLength(1);
  expect(registered[0]?.name).toBe("after_response");
  expect(registered[0]?.id).toBe("ad-coder/ledger");

  off();
  expect(registered).toHaveLength(0);
});

test("two settled messages yield two records whose deltas are pairwise differences", async () => {
  const sink = new MemoryLedgerSink();
  const { hooks, registered } = fakeHooks();
  const ledger = new Ledger({ runId: "run1", role: "planner", step: "plan", sink });
  ledger.attach(hooks);
  const handler = registered[0]?.handler;
  if (handler === undefined) throw new Error("handler was not registered");

  expect(await handler(event(usage(100, 110, 0.01), 200), FAKE_CONTEXT)).toBeUndefined();
  expect(await handler(event(usage(250, 270, 0.025), 200), FAKE_CONTEXT)).toBeUndefined();

  const records = sink.records();
  expect(records).toHaveLength(2);
  expect(records[0]?.delta.input).toBe(100);
  expect(records[1]?.delta.input).toBe(150);
  expect(records[1]?.delta.cost.total).toBeCloseTo(0.015, 10);
  expect(records[0]?.role).toBe("planner");
  expect(records[0]?.step).toBe("plan");
  expect(records[0]?.runId).toBe("run-1");
  expect(records[0]?.lane).toBe("main");
  expect(records[0]?.status).toBe(200);
  expect(records[0]?.provider).toBe("anthropic");
  expect(records[0]?.stopReason).toBe("stop");
});

test("no record key can hold prompt, message body or header data", async () => {
  const sink = new MemoryLedgerSink();
  const { hooks, registered } = fakeHooks();
  new Ledger({ runId: "run1", role: "r", step: "s", sink }).attach(hooks);
  const handler = registered[0]?.handler;
  if (handler === undefined) throw new Error("handler was not registered");

  await handler(event(usage(100, 110, 0.01), 200), FAKE_CONTEXT);

  for (const key of collectKeys(sink.records()[0])) {
    expect(key).not.toMatch(/prompt|content|text|header|authorization/i);
  }
  expect(JSON.stringify(sink.records()[0])).not.toContain("Bearer");
});

test("status is omitted rather than emitted as null when the event has none", async () => {
  const sink = new MemoryLedgerSink();
  const { hooks, registered } = fakeHooks();
  new Ledger({ runId: "run1", role: "r", step: "s", sink }).attach(hooks);
  const handler = registered[0]?.handler;
  if (handler === undefined) throw new Error("handler was not registered");

  await handler(event(usage(100, 110, 0.01)), FAKE_CONTEXT);
  expect("status" in (sink.records()[0] as LedgerRecord)).toBe(false);
});

test("the file sink writes one 0600 line per turn and no header data", async () => {
  const dir = scratchDir("write");
  const filePath = path.join(dir, "run1.jsonl");
  const { hooks, registered } = fakeHooks();
  const ledger = new Ledger({ runId: "run1", role: "r", step: "s", filePath });
  ledger.attach(hooks);
  const handler = registered[0]?.handler;
  if (handler === undefined) throw new Error("handler was not registered");

  await handler(event(usage(100, 110, 0.01), 200), FAKE_CONTEXT);
  await handler(event(usage(250, 270, 0.025), 200), FAKE_CONTEXT);
  ledger.close();

  expect(ledger.droppedRecords).toBe(0);
  const lines = fs.readFileSync(filePath, "utf8").trimEnd().split("\n");
  expect(lines).toHaveLength(2);
  const parsed = lines.map((line) => JSON.parse(line) as LedgerRecord);
  expect(parsed[0]?.delta.input).toBe(100);
  expect(parsed[1]?.delta.input).toBe(150);
  expect(fs.readFileSync(filePath, "utf8")).not.toMatch(/header|authorization/i);
  expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
  expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
});

test("a pre-existing world-open directory is tightened before the first write", () => {
  const dir = scratchDir("loosedir");
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o777);

  const sink = new FileLedgerSink(path.join(dir, "run1.jsonl"));
  sink.write(record());
  sink.close();

  expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
});

test("a symlink at the record path is refused", () => {
  const dir = scratchDir("symlink");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, "target.jsonl");
  fs.writeFileSync(target, "", { mode: 0o600 });
  const linkPath = path.join(dir, "run1.jsonl");
  fs.symlinkSync(target, linkPath);

  const sink = new FileLedgerSink(linkPath);
  expect(() => sink.write(record())).toThrow();
  expect(fs.readFileSync(target, "utf8")).toBe("");
});

test("a pre-existing group-readable record file is refused", () => {
  const dir = scratchDir("loosefile");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = path.join(dir, "run1.jsonl");
  fs.writeFileSync(filePath, "", { mode: 0o600 });
  fs.chmodSync(filePath, 0o644);

  const sink = new FileLedgerSink(filePath);
  expect(() => sink.write(record())).toThrow(/beyond its owner/);
});

test("a value holding a newline cannot forge an extra ledger line", async () => {
  const dir = scratchDir("inject");
  const filePath = path.join(dir, "run1.jsonl");
  const forged = 'evil\n{"runId":"forged"}';
  const { hooks, registered } = fakeHooks();
  const ledger = new Ledger({ runId: "run1", role: forged, step: "s", filePath });
  ledger.attach(hooks);
  const handler = registered[0]?.handler;
  if (handler === undefined) throw new Error("handler was not registered");

  await handler(event(usage(100, 110, 0.01), 200), FAKE_CONTEXT);
  ledger.close();

  const lines = fs.readFileSync(filePath, "utf8").trimEnd().split("\n");
  expect(lines).toHaveLength(1);
  expect((JSON.parse(lines[0] as string) as LedgerRecord).role).toBe(forged);
});

test("a failing sink drops the record loudly instead of throwing into the harness", async () => {
  const failing: LedgerSink = {
    write() {
      throw new Error("ENOSPC: no space left on device");
    },
  };
  const { hooks, registered } = fakeHooks();
  const ledger = new Ledger({ runId: "run1", role: "r", step: "s", sink: failing });
  ledger.attach(hooks);
  const handler = registered[0]?.handler;
  if (handler === undefined) throw new Error("handler was not registered");

  const warnings: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    warnings.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    expect(await handler(event(usage(100, 110, 0.01), 200), FAKE_CONTEXT)).toBeUndefined();
    expect(await handler(event(usage(250, 270, 0.025), 200), FAKE_CONTEXT)).toBeUndefined();
  } finally {
    process.stderr.write = originalWrite;
  }

  expect(ledger.droppedRecords).toBe(2);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toMatch(/ledger write failed/);
});

test("forgetStream resets a finished stream's baseline", async () => {
  const sink = new MemoryLedgerSink();
  const { hooks, registered } = fakeHooks();
  const ledger = new Ledger({ runId: "run1", role: "r", step: "s", sink });
  ledger.attach(hooks);
  const handler = registered[0]?.handler;
  if (handler === undefined) throw new Error("handler was not registered");

  await handler(event(usage(100, 110, 0.01), 200), FAKE_CONTEXT);
  ledger.forgetStream("run-1", "main");
  await handler(event(usage(250, 270, 0.025), 200), FAKE_CONTEXT);

  expect(sink.records()[1]?.delta.input).toBe(250);
});

function record(): LedgerRecord {
  return {
    ts: 1,
    runId: "run1",
    lane: "main",
    role: "r",
    step: "s",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    stopReason: "stop",
    delta: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
