import type { Model } from "@earendil-works/pi-ai";

/**
 * Capture of what a provider says it ACTUALLY billed for one response, as
 * opposed to what our own price table predicts it should have billed.
 *
 * WHY THIS EXISTS AT ALL. `usage.cost` on a settled message is not a provider
 * fact: pi-ai computes it by multiplying the token counts by the prices in our
 * registry config (`calculateCost` in its `models` module). Anything comparing
 * that number against itself is comparing our config to our config, and can
 * never observe the one event it was built for -- a provider changing its
 * price. The charged amount has to come off the wire.
 *
 * OpenRouter reports it only when the request asks for it, so this module owns
 * both halves: adding the request field, and reading the answer back out.
 */

/** The billed amount for one response, or the absence of one. */
export interface ChargeCapture {
  /** Dollars the provider reported billing. `undefined` means it reported none. */
  chargedUsd?: number;
}

/**
 * Providers that report a billed amount, and the request field that asks for
 * it. Matched on base URL rather than on a provider id, because an operator
 * names their own providers and an OpenRouter account reached under any id
 * still speaks the OpenRouter dialect.
 *
 * Deliberately a allow-list: sending an unknown field to a provider that
 * validates its request body turns every call into a 400, which would be a far
 * worse failure than not measuring the price.
 */
function reportsCharge(model: Model<never> | { baseUrl?: string }): boolean {
  return (model.baseUrl ?? "").includes("openrouter.ai");
}

/**
 * The billed amount inside one parsed `usage` object, or `undefined`.
 *
 * TWO FIELDS, NEVER THEIR SUM. A normal OpenRouter response puts the charge in
 * `cost`. A request served under the operator's OWN upstream key reports
 * `is_byok: true`, sets `cost` to zero -- OpenRouter itself billed nothing --
 * and puts the real money in `cost_details.upstream_inference_cost`. Reading
 * only `cost` would therefore see a BYOK model as free and never price it;
 * adding the two would double every non-BYOK response, because there the same
 * charge appears in both.
 */
export function chargedUsdFromUsage(usage: unknown): number | undefined {
  if (typeof usage !== "object" || usage === null) return undefined;
  const record = usage as {
    cost?: unknown;
    is_byok?: unknown;
    cost_details?: { upstream_inference_cost?: unknown };
  };
  const upstream = record.cost_details?.upstream_inference_cost;
  const charged = record.is_byok === true ? upstream : record.cost;
  if (typeof charged !== "number" || !Number.isFinite(charged) || charged <= 0) return undefined;
  return charged;
}

/** Stop scanning a body this large; the usage block of a real response is nowhere near it. */
const MAX_SCANNED_BODY_BYTES = 1_000_000;

/**
 * Read the billed amount out of a response body without consuming it.
 *
 * The body is TEED rather than cloned: the caller still needs to read every
 * byte, and a clone of a streaming response buffers the whole thing in memory
 * until both branches are drained. Scanning runs on its own branch and its
 * failures are swallowed -- a price this could not read is a measurement we do
 * not get, never a generation that fails.
 */
async function scanForCharge(stream: ReadableStream<Uint8Array>, capture: ChargeCapture) {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffered = "";
  let scannedBytes = 0;
  const consider = (line: string): void => {
    const payload = line.startsWith("data: ") ? line.slice(6).trim() : line.trim();
    if (payload === "" || payload === "[DONE]" || !payload.startsWith("{")) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    const charged = chargedUsdFromUsage((parsed as { usage?: unknown }).usage);
    // Last one wins: a stream reports usage once, at the end, but a retried or
    // multi-part body may carry an earlier partial.
    if (charged !== undefined) capture.chargedUsd = charged;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      scannedBytes += value.byteLength;
      if (scannedBytes > MAX_SCANNED_BODY_BYTES) return;
      buffered += decoder.decode(value, { stream: true });
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        consider(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
      }
    }
    // A non-SSE response is one JSON document with no trailing newline.
    consider(buffered);
  } catch {
    // Unreadable body: no measurement, and nothing else disturbed.
  } finally {
    // CANCEL, never merely unlock. A tee branch that is abandoned while the
    // source still has bytes to give keeps buffering every one of them, so
    // giving up on a huge body by releasing the lock would retain exactly the
    // body the size guard exists to avoid retaining. Cancelling one branch
    // does not disturb the other: the shared source is only cancelled once
    // BOTH branches are, so the caller still receives every byte.
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * Wrap a fetch so responses are scanned for the billed amount on their way
 * through. The returned response is a fresh one over the untouched branch of
 * the teed body, so the adapter reads exactly what the provider sent.
 */
function wrapFetch(inner: typeof fetch, capture: ChargeCapture): typeof fetch {
  return (async (...args: Parameters<typeof fetch>) => {
    const response = await inner(...args);
    if (response.body === null) return response;
    const [forCaller, forScan] = response.body.tee();
    void scanForCharge(forScan, capture);
    return new Response(forCaller, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }) as typeof fetch;
}

/**
 * Per-call request options that ask for the billed amount and capture it.
 *
 * Both halves are chained onto whatever the caller already passed rather than
 * replacing it: another layer's `onPayload` or injected `fetch` keeps working,
 * because a measurement must never be the reason a request behaves differently.
 */
export function instrumentChargedCost(
  options: unknown,
  capture: ChargeCapture,
): Record<string, unknown> {
  const existing = (options ?? {}) as Record<string, unknown>;
  const priorPayload = existing.onPayload as
    | ((payload: unknown, model: unknown) => unknown)
    | undefined;
  const priorFetch = (existing.fetch as typeof fetch | undefined) ?? fetch;
  return {
    ...existing,
    fetch: wrapFetch(priorFetch, capture),
    onPayload: async (payload: unknown, model: Model<never>) => {
      const next = (await priorPayload?.(payload, model)) ?? payload;
      if (!reportsCharge(model)) return next;
      if (typeof next !== "object" || next === null) return next;
      return { ...(next as Record<string, unknown>), usage: { include: true } };
    },
  };
}
