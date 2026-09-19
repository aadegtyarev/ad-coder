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
import { fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { LedgerSink } from "../src/ledger/ledger";
import { FileLedgerSink, LEDGER_BASE_DIR, Ledger, MemoryLedgerSink } from "../src/ledger/ledger";
import type { LedgerRecord, UsageAmounts } from "../src/ledger/types";

const scratchDirs: string[] = [];

afterAll(() => {
  for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** A fresh subdirectory of the ledger base, so permission tests cannot collide. */
function scratchDir(label: string): string {
  const dir = path.resolve(
    LEDGER_BASE_DIR,
    `test-${label}-${Math.random().toString(36).slice(2, 10)}`,
  );
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

function settled(
  u: Usage,
  content: SettledAssistantMessage["content"] = [],
): SettledAssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    usage: u,
    stopReason: "stop",
    timestamp: 1_757_000_000_000,
  };
}

function event(
  u: Usage,
  status?: number,
  content?: SettledAssistantMessage["content"],
): HookInvocation<"after_response"> {
  return {
    runId: "run-1",
    lane: "main",
    message: settled(u, content),
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
  expect(
    () => new Ledger({ runId: "run1", role: "r", step: "s", filePath: "/tmp/evil.jsonl" }),
  ).toThrow(/must resolve inside/);
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

test("two settled messages yield two records carrying each response's own numbers", async () => {
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
  expect(records[0]?.usage.input).toBe(100);
  expect(records[1]?.usage.input).toBe(250);
  expect(records[1]?.usage.cost.total).toBeCloseTo(0.025, 10);
  expect(records[0]?.role).toBe("planner");
  expect(records[0]?.step).toBe("plan");
  expect(records[0]?.runId).toBe("run-1");
  expect(records[0]?.lane).toBe("main");
  expect(records[0]?.status).toBe(200);
  expect(records[0]?.provider).toBe("anthropic");
  expect(records[0]?.stopReason).toBe("stop");
});

test("a response's tool calls are recorded as name-to-count, arguments excluded", async () => {
  const sink = new MemoryLedgerSink();
  const { hooks, registered } = fakeHooks();
  new Ledger({ runId: "run1", role: "coder", step: "code", sink }).attach(hooks);
  const handler = registered[0]?.handler;
  if (handler === undefined) throw new Error("handler was not registered");

  await handler(
    event(usage(100, 110, 0.01), 200, [
      fauxToolCall("bash", { command: "rm -rf /secret-payload" }),
    ]),
    FAKE_CONTEXT,
  );

  expect(sink.records()[0]?.toolCalls).toEqual({ bash: 1 });
  // Names and counts only: an argument value must never reach the ledger.
  expect(JSON.stringify(sink.records()[0])).not.toContain("secret-payload");
});

test("an error-stopped response carries a bounded providerError, never the body (issue #418)", async () => {
  const sink = new MemoryLedgerSink();
  const { hooks, registered } = fakeHooks();
  new Ledger({ runId: "run1", role: "coder", step: "code", sink }).attach(hooks);
  const handler = registered[0]?.handler;
  if (handler === undefined) throw new Error("handler was not registered");

  // The #418 incident shape: an OpenRouter-style billing refusal whose exact
  // body pi-agent-core attaches to the error-stopped settled message. Without
  // the bounded projection the row says only stopReason=error and the cause
  // is lost -- every surface downstream then says "verify authentication".
  const failedMessage = settled(usage(0, 0, 0));
  failedMessage.stopReason = "error";
  failedMessage.errorMessage =
    '402: {"error":{"code":"insufficient_credits","message":"prompt-echo PROBE never-publish-me"}}';
  await handler({ runId: "run-1", lane: "main", message: failedMessage }, FAKE_CONTEXT);

  const row = sink.records()[0];
  // Both bounded values of the pair survive, so an operator reading the ledger
  // alone can answer "all presets fail with 402 / insufficient_credits".
  expect(row?.providerError).toEqual({ status: 402, code: "insufficient_credits" });
  // The uncontrolled body -- and anything that could echo the request with it
  // -- never crosses into a durable artifact.
  expect(JSON.stringify(row)).not.toContain("never-publish-me");
  expect(JSON.stringify(row)).not.toContain("prompt-echo");
  expect(JSON.stringify(row)).not.toContain("errorMessage");
});

test("a settled response with no provider error carries no providerError key", async () => {
  const sink = new MemoryLedgerSink();
  const { hooks, registered } = fakeHooks();
  new Ledger({ runId: "run1", role: "r", step: "s", sink }).attach(hooks);
  const handler = registered[0]?.handler;
  if (handler === undefined) throw new Error("handler was not registered");

  await handler(event(usage(100, 110, 0.01), 200), FAKE_CONTEXT);

  expect("providerError" in (sink.records()[0] as LedgerRecord)).toBe(false);
});

test("a text-only response omits the toolCalls key rather than writing an empty map", async () => {
  const sink = new MemoryLedgerSink();
  const { hooks, registered } = fakeHooks();
  new Ledger({ runId: "run1", role: "r", step: "s", sink }).attach(hooks);
  const handler = registered[0]?.handler;
  if (handler === undefined) throw new Error("handler was not registered");

  await handler(event(usage(100, 110, 0.01), 200), FAKE_CONTEXT);

  expect("toolCalls" in (sink.records()[0] as LedgerRecord)).toBe(false);
});

test("repeated calls to the same tool in one response sum into that tool's count", async () => {
  const sink = new MemoryLedgerSink();
  const { hooks, registered } = fakeHooks();
  new Ledger({ runId: "run1", role: "r", step: "s", sink }).attach(hooks);
  const handler = registered[0]?.handler;
  if (handler === undefined) throw new Error("handler was not registered");

  await handler(
    event(usage(100, 110, 0.01), 200, [
      fauxToolCall("bash", { command: "ls" }),
      fauxToolCall("bash", { command: "pwd" }),
    ]),
    FAKE_CONTEXT,
  );

  expect(sink.records()[0]?.toolCalls).toEqual({ bash: 2 });
});

test("tool names colliding with Object.prototype members are counted, not corrupted", async () => {
  const sink = new MemoryLedgerSink();
  const { hooks, registered } = fakeHooks();
  new Ledger({ runId: "run1", role: "r", step: "s", sink }).attach(hooks);
  const handler = registered[0]?.handler;
  if (handler === undefined) throw new Error("handler was not registered");

  // Names that shadow inherited members (`hasOwnProperty`, `toString`) or hit the
  // `__proto__` bracket-assignment special case must each yield a real integer
  // count, never a concatenated function string or a dropped entry.
  await handler(
    event(usage(100, 110, 0.01), 200, [
      fauxToolCall("hasOwnProperty", {}),
      fauxToolCall("hasOwnProperty", {}),
      fauxToolCall("toString", {}),
      fauxToolCall("__proto__", {}),
    ]),
    FAKE_CONTEXT,
  );

  // Built via fromEntries so `__proto__` is an OWN key on the expected side too;
  // a `{ __proto__: 1 }` literal would set the prototype instead and never match.
  const expected = Object.fromEntries([
    ["hasOwnProperty", 2],
    ["toString", 1],
    ["__proto__", 1],
  ]);
  expect(sink.records()[0]?.toolCalls).toEqual(expected);
});

test("a tool call whose name did not arrive is recorded under the explicit <unnamed> sentinel, not the empty string (issue #251)", async () => {
  const sink = new MemoryLedgerSink();
  const { hooks, registered } = fakeHooks();
  new Ledger({ runId: "run1", role: "r", step: "s", sink }).attach(hooks);
  const handler = registered[0]?.handler;
  if (handler === undefined) throw new Error("handler was not registered");

  await handler(event(usage(100, 110, 0.01), 200, [fauxToolCall("", {})]), FAKE_CONTEXT);

  expect(sink.records()[0]?.toolCalls).toEqual({ "<unnamed>": 1 });
  // The shape of the trouble stays on the same record: a reader diagnosing an
  // <unnamed> count reads this row's stopReason (error/truncated beside it is
  // the truncated-response signature; stop means an isolated provider quirk).
  expect(typeof sink.records()[0]?.stopReason).toBe("string");
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
  expect(parsed[0]?.usage.input).toBe(100);
  expect(parsed[1]?.usage.input).toBe(250);
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

test("a configured record limit rejects an oversized ledger line before publication", () => {
  const dir = scratchDir("record-limit");
  const filePath = path.join(dir, "run1.jsonl");
  const sink = new FileLedgerSink(filePath, 8);
  expect(() => sink.write(record())).toThrow(/byte limit/);
  expect(fs.existsSync(filePath)).toBe(false);
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

test("a sequence of per-response readings sums to what the harness would total", async () => {
  const sink = new MemoryLedgerSink();
  const { hooks, registered } = fakeHooks();
  const ledger = new Ledger({ runId: "run1", role: "r", step: "s", sink });
  ledger.attach(hooks);
  const handler = registered[0]?.handler;
  if (handler === undefined) throw new Error("handler was not registered");

  const readings = [usage(100, 110, 0.01), usage(250, 270, 0.025), usage(400, 430, 0.04)];
  for (const reading of readings) await handler(event(reading, 200), FAKE_CONTEXT);

  const records = sink.records();
  expect(records).toHaveLength(3);
  for (const [index, reading] of readings.entries()) {
    expect(records[index]?.usage).toEqual(reading);
    // A retained record must not alias the provider object: mutating the
    // reading afterwards would otherwise rewrite an already-written line.
    expect(records[index]?.usage).not.toBe(reading);
  }

  const recorded = records.map((r) => r.usage).reduce((total, next) => addUsage(total, next));
  expect(recorded).toEqual(readings.reduce((total, next) => addUsage(total, next)));
  expect(recorded.input).toBe(750);
  expect(recorded.cost.total).toBeCloseTo(0.075, 10);
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
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

/**
 * Mirrors pi-agent-core's own `addUsage`
 * (dist/harness/utils/usage.js), which the harness applies to each persisted
 * row to build the session totals. Mirrored rather than imported because the
 * package's export map has no `./harness/utils/usage` subpath, so a deep
 * import fails resolution. A provider-optional field absent on both sides
 * stays absent, so "not reported" never becomes "reported as 0".
 */
function addUsage(a: UsageAmounts, b: UsageAmounts): UsageAmounts {
  const optional = (key: "cacheWrite1h" | "reasoning"): { [k: string]: number } | undefined => {
    if (a[key] === undefined && b[key] === undefined) return undefined;
    return { [key]: (a[key] ?? 0) + (b[key] ?? 0) };
  };
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    ...optional("cacheWrite1h"),
    ...optional("reasoning"),
    totalTokens: a.totalTokens + b.totalTokens,
    cost: {
      input: a.cost.input + b.cost.input,
      output: a.cost.output + b.cost.output,
      cacheRead: a.cost.cacheRead + b.cost.cacheRead,
      cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
      total: a.cost.total + b.cost.total,
    },
  };
}

test("a mirrored memory sink keeps the records AND writes the durable file", () => {
  const dir = scratchDir("mirror");
  const file = path.join(dir, "run.jsonl");
  const sink = new MemoryLedgerSink(new FileLedgerSink(file));
  const ledger = new Ledger({ runId: "run-1", role: "coder", step: "implement", sink });
  const off = ledger.attach(fakeHooks().hooks);
  off();
  sink.write({
    ts: 1,
    runId: "run-1",
    lane: "main",
    role: "coder",
    step: "implement",
    provider: "anthropic",
    model: "m",
    stopReason: "stop",
    usage: {
      input: 1,
      output: 1,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
    },
  } as LedgerRecord);
  sink.close();

  expect(sink.records()).toHaveLength(1);
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  expect(lines).toHaveLength(1);
  expect((JSON.parse(lines[0] as string) as LedgerRecord).step).toBe("implement");
});

test("a failing mirror does not cost the caller the records it reads back", () => {
  const failing: LedgerSink = {
    write() {
      throw new Error("disk full");
    },
  };
  const sink = new MemoryLedgerSink(failing);
  const record = {
    ts: 1,
    runId: "run-1",
    lane: "main",
    role: "coder",
    step: "implement",
    provider: "anthropic",
    model: "m",
    stopReason: "stop",
    usage: {
      input: 1,
      output: 1,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
    },
  } as LedgerRecord;
  expect(() => sink.write(record)).toThrow(/disk full/);
  expect(sink.records()).toHaveLength(1);
});

test("request part sizes are written onto every row, and omitted when not supplied", async () => {
  // The stage metrics that carry requestBytes travel in the pipeline result,
  // which a hung run never returns (#315), and a session transcript keeps only
  // streamed assistant frames. So without this on the row, "the role received no
  // system prompt" and "the role behaved oddly" are indistinguishable after the
  // fact (#317).
  const sink = new MemoryLedgerSink();
  const { hooks, registered } = fakeHooks();
  const ledger = new Ledger({
    runId: "run-1",
    role: "coder",
    step: "code:1",
    sink,
    requestBytes: { systemPrompt: 4096, prompt: 128, toolDefinitions: 512, total: 4736 },
  });
  ledger.attach(hooks);
  const handler = registered[0]?.handler;
  if (handler === undefined) throw new Error("ledger did not register a handler");
  await handler(event(usage(10, 20, 0.01)), FAKE_CONTEXT);
  await handler(event(usage(11, 21, 0.01)), FAKE_CONTEXT);

  // Every row, not just the first: a ledger is read row by row, so a size
  // recorded once is a size that does not answer the question.
  expect(sink.records().map((row) => row.requestBytes)).toEqual([
    { systemPrompt: 4096, prompt: 128, toolDefinitions: 512, total: 4736 },
    { systemPrompt: 4096, prompt: 128, toolDefinitions: 512, total: 4736 },
  ]);

  const bare = new MemoryLedgerSink();
  const { hooks: hooks2, registered: registered2 } = fakeHooks();
  new Ledger({ runId: "run-1", role: "coder", step: "code:1", sink: bare }).attach(hooks2);
  const handler2 = registered2[0]?.handler;
  if (handler2 === undefined) throw new Error("ledger did not register a handler");
  await handler2(event(usage(10, 20, 0.01)), FAKE_CONTEXT);
  expect(bare.records()[0]).not.toHaveProperty("requestBytes");
});
