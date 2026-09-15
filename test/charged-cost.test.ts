import { expect, test } from "bun:test";
import {
  type ChargeCapture,
  chargedUsdFromUsage,
  instrumentChargedCost,
} from "../src/economics/charged-cost";

const OPENROUTER = { baseUrl: "https://openrouter.ai/api/v1" } as never;
const OPENCODE = { baseUrl: "https://opencode.ai/zen/go/v1" } as never;

/**
 * Drive the instrumented options the way pi-ai's adapter does.
 *
 * A fetch is ALWAYS supplied, so a test can never fall through to the network
 * and pass or fail on something outside this repository.
 */
async function run(
  options: Record<string, unknown>,
  body: string,
  model: unknown = OPENROUTER,
): Promise<{ capture: ChargeCapture; payload: unknown; received: string }> {
  const capture: ChargeCapture = {};
  const instrumented = instrumentChargedCost({ fetch: serving(body), ...options }, capture);
  const onPayload = instrumented.onPayload as (p: unknown, m: unknown) => Promise<unknown>;
  const payload = await onPayload({ model: "x", messages: [] }, model);
  const fetchImpl = instrumented.fetch as typeof fetch;
  const response = await fetchImpl("https://example.test");
  const received = await response.text();
  // The scan runs on its own branch of the teed body; give it a turn to finish.
  await new Promise((resolve) => setTimeout(resolve, 5));
  return { capture, payload, received };
}

function sse(...chunks: object[]): string {
  return `${chunks.map((c) => `data: ${JSON.stringify(c)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
}

/** A fetch that never leaves the process. `preconnect` satisfies the DOM type. */
function stubFetch(handler: () => Promise<Response>): typeof fetch {
  return Object.assign(handler, { preconnect: () => undefined }) as unknown as typeof fetch;
}

function serving(body: string): typeof fetch {
  return stubFetch(
    async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
  );
}

test("a normal OpenRouter response reports its charge in `cost`", () => {
  expect(chargedUsdFromUsage({ cost: 0.00000765, is_byok: false })).toBeCloseTo(0.00000765, 12);
});

test("a BYOK response reports zero in `cost` and the real money upstream", () => {
  // THE TRAP. Under the operator's own upstream key OpenRouter bills nothing
  // and says so; a detector reading only `cost` would conclude the model is
  // free and never price it at all.
  const usage = {
    cost: 0,
    is_byok: true,
    cost_details: { upstream_inference_cost: 0.00042 },
  };
  expect(chargedUsdFromUsage(usage)).toBeCloseTo(0.00042, 12);
});

test("the two cost fields are one charge shown twice, never added together", () => {
  // A non-BYOK response carries the SAME amount in both places. Summing them
  // would double every charge and report a 2x overcharge on correct billing.
  const usage = {
    cost: 0.0005,
    is_byok: false,
    cost_details: { upstream_inference_cost: 0.0005 },
  };
  expect(chargedUsdFromUsage(usage)).toBeCloseTo(0.0005, 12);
});

test("a response with no charge reports none rather than zero", () => {
  // OpenCode Zen returns token counts and nothing else. `undefined` is what
  // keeps that scope unmeasured; a 0 would read as a charge of nothing.
  expect(chargedUsdFromUsage({ prompt_tokens: 14, completion_tokens: 5 })).toBeUndefined();
  expect(chargedUsdFromUsage({ cost: 0, is_byok: false })).toBeUndefined();
  expect(chargedUsdFromUsage({ cost: "0.5" })).toBeUndefined();
  expect(chargedUsdFromUsage({ cost: Number.NaN })).toBeUndefined();
  expect(chargedUsdFromUsage(undefined)).toBeUndefined();
  expect(chargedUsdFromUsage(null)).toBeUndefined();
});

test("the request asks a reporting provider for its charge", async () => {
  const { payload } = await run({}, sse({ usage: { cost: 0.001 } }));
  expect(payload).toMatchObject({ usage: { include: true } });
});

test("a provider that does not report charges is asked for nothing extra", async () => {
  // An unknown field sent to a provider that validates its request body turns
  // every call into a 400 -- a far worse failure than not measuring a price.
  const { payload } = await run({}, sse({ usage: {} }), OPENCODE);
  expect(payload).not.toHaveProperty("usage");
});

test("the charge is read off a streaming response, which is the path runs take", async () => {
  const body = sse(
    { choices: [{ delta: { content: "hi" } }] },
    { choices: [{ delta: {} }], usage: { cost: 0.00000765, is_byok: false } },
  );
  const { capture } = await run({ fetch: serving(body) }, body);
  expect(capture.chargedUsd).toBeCloseTo(0.00000765, 12);
});

test("the caller still receives the response body byte for byte", async () => {
  // The body is TEED, not consumed: a measurement that swallowed the stream
  // would break every generation it measured.
  const body = sse({ choices: [{ delta: { content: "hello" } }] }, { usage: { cost: 0.002 } });
  const { received, capture } = await run({ fetch: serving(body) }, body);
  expect(received).toBe(body);
  expect(capture.chargedUsd).toBeCloseTo(0.002, 12);
});

test("a non-streaming response body is read too", async () => {
  const body = JSON.stringify({ choices: [], usage: { cost: 0.003, is_byok: false } });
  const { capture } = await run({ fetch: serving(body) }, body);
  expect(capture.chargedUsd).toBeCloseTo(0.003, 12);
});

test("an existing onPayload and fetch are chained, never replaced", async () => {
  // Another layer's transform must keep working: a measurement is never a
  // reason for a request to behave differently.
  const seen: string[] = [];
  const priorFetch = Object.assign(
    async () => {
      seen.push("fetch");
      return new Response(sse({ usage: { cost: 0.004 } }));
    },
    { preconnect: () => undefined },
  ) as unknown as typeof fetch;
  const { capture, payload } = await run(
    {
      fetch: priorFetch,
      onPayload: (p: unknown) => ({ ...(p as object), marker: "kept" }),
    },
    "",
  );
  expect(payload).toMatchObject({ marker: "kept", usage: { include: true } });
  expect(seen).toEqual(["fetch"]);
  expect(capture.chargedUsd).toBeCloseTo(0.004, 12);
});

test("an unreadable body costs the measurement and nothing else", async () => {
  const failing = Object.assign(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("connection reset"));
          },
        }),
      ),
    { preconnect: () => undefined },
  ) as unknown as typeof fetch;
  const capture: ChargeCapture = {};
  const instrumented = instrumentChargedCost({ fetch: failing }, capture);
  const response = await (instrumented.fetch as typeof fetch)("https://example.test");
  expect(response.status).toBe(200);
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(capture.chargedUsd).toBeUndefined();
});

test("a response with no body passes through untouched", async () => {
  const empty = Object.assign(async () => new Response(null, { status: 204 }), {
    preconnect: () => undefined,
  }) as unknown as typeof fetch;
  const capture: ChargeCapture = {};
  const instrumented = instrumentChargedCost({ fetch: empty }, capture);
  const response = await (instrumented.fetch as typeof fetch)("https://example.test");
  expect(response.status).toBe(204);
  expect(capture.chargedUsd).toBeUndefined();
});

test("a body too large to scan is released, not left buffering behind the caller", async () => {
  // A body well past the scan ceiling, fed in chunks so the source is still
  // producing when the scan gives up. `pulled` counts what the source was
  // asked for: if the abandoned branch kept buffering, it would be asked for
  // every remaining chunk even though nobody reads them.
  const CHUNKS = 400;
  const CHUNK = new Uint8Array(16_384);
  let pulled = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= CHUNKS) {
        controller.close();
        return;
      }
      pulled += 1;
      controller.enqueue(CHUNK);
    },
    cancel() {
      cancelled = true;
    },
  });

  const capture: ChargeCapture = {};
  const instrumented = instrumentChargedCost(
    { fetch: stubFetch(async () => new Response(stream)) },
    capture,
  );
  const response = await (instrumented.fetch as typeof fetch)("https://example.test");

  // The caller abandons the response too -- a timed-out or errored generation.
  // Nothing reads either branch from here on.
  await response.body?.cancel();
  await new Promise((resolve) => setTimeout(resolve, 20));

  // Both branches are gone, so the shared source is released rather than
  // drained into a buffer nobody will read. Without the scan branch being
  // CANCELLED, it stays a live reader and the source keeps being pulled.
  expect(cancelled).toBe(true);
  expect(pulled).toBeLessThan(CHUNKS);
});
