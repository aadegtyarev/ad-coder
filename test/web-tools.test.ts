import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import {
  buildImageInspectionTool,
  buildWebTools,
  extractPage,
  INSPECT_IMAGE_TOOL_NAME,
  WEB_READ_TOOL_NAME,
} from "../src/web/tools";

const lookup = (async () => [{ address: "93.184.216.34", family: 4 }]) as never;
const execute = (
  tool: NonNullable<ReturnType<typeof buildWebTools>[number]>,
  params: Record<string, unknown>,
) =>
  (
    tool.execute as unknown as (
      id: string,
      value: Record<string, unknown>,
    ) => ReturnType<typeof tool.execute>
  )("call", params);
const model = (input: ("text" | "image")[]): Model<Api> =>
  ({
    id: input.join("-"),
    name: "test",
    provider: "test",
    api: "openai-completions",
    baseUrl: "https://example.com",
    reasoning: false,
    input,
    contextWindow: 1000,
    maxTokens: 100,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }) as Model<Api>;

describe("web plugin tools", () => {
  test("web_read keeps navigable links and content images while filtering decoration", async () => {
    const html = `<main><p>Useful article</p><a href="/next">Next page</a><img src="/photo.jpg" alt="diagram" width="800"><img src="/favicon.png" width="32"></main>`;
    const tool = buildWebTools(
      {},
      {
        lookup,
        fetch: (async () =>
          new Response(html, {
            headers: { "content-type": "text/html" },
          })) as unknown as typeof fetch,
      },
    ).find(({ name }) => name === WEB_READ_TOOL_NAME);
    if (tool === undefined) throw new Error("missing web_read");
    const result = await execute(tool, { url: "https://example.com/start" });
    const text = result?.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("https://example.com/next");
    expect(text).toContain("https://example.com/photo.jpg");
    expect(text).not.toContain("favicon.png");
  });

  test("page extraction resolves relative targets and bounds collections", () => {
    const page = extractPage(
      `<a href="/a">A</a><a href="/b">B</a><img src="/large.png" width="500">`,
      "https://example.com/root",
      { maxTextChars: 100, maxLinks: 1, maxImages: 1 },
    );
    expect(page.links).toEqual([{ text: "A", url: "https://example.com/a" }]);
    expect(page.images).toEqual([{ alt: "image", url: "https://example.com/large.png" }]);
  });

  test("page extraction preserves valid unquoted link and image attributes", () => {
    const page = extractPage(
      `<a href=/next>Next</a><img src=/photo.jpg width=800>`,
      "https://example.com/start",
      { maxTextChars: 100, maxLinks: 10, maxImages: 10 },
    );
    expect(page.links).toEqual([{ text: "Next", url: "https://example.com/next" }]);
    expect(page.images).toEqual([{ alt: "image", url: "https://example.com/photo.jpg" }]);
  });

  test("private web targets fail before fetch", async () => {
    let fetched = false;
    const tool = buildWebTools(
      {},
      {
        lookup: (async () => [{ address: "127.0.0.1", family: 4 }]) as never,
        fetch: (async () => {
          fetched = true;
          return new Response("no");
        }) as never,
      },
    )[1];
    if (tool === undefined) throw new Error("missing web_read");
    const result = await execute(tool, { url: "http://internal.example/" });
    expect(fetched).toBe(false);
    expect(result?.content[0]).toEqual({
      type: "text",
      text: "web request failed: private_network_denied",
    });
  });

  test("text-only role routes local image through configured vision model", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ad-coder-image-"));
    try {
      await writeFile(path.join(dir, "sample.png"), Buffer.from([137, 80, 78, 71]));
      let calledModel: Model<Api> | undefined;
      const models = {
        completeSimple: async (selected: Model<Api>) => {
          calledModel = selected;
          return {
            stopReason: "stop",
            content: [{ type: "text", text: "a blue chart" }],
            usage: {
              input: 1,
              output: 2,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 3,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          };
        },
      } as unknown as Models;
      const vision = model(["text", "image"]);
      const tool = buildImageInspectionTool({
        targetDir: dir,
        models,
        activeModel: model(["text"]),
        visionModel: vision,
      });
      expect(tool.name).toBe(INSPECT_IMAGE_TOOL_NAME);
      const result = await execute(tool, { source: "sample.png", question: "What color?" });
      expect(calledModel).toBe(vision);
      expect(result.content[0]).toEqual({
        type: "text",
        text: "image source: sample.png\n\na blue chart",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("text-only role fails clearly when no vision route is configured", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ad-coder-image-"));
    try {
      await writeFile(path.join(dir, "sample.png"), Buffer.from([137, 80, 78, 71]));
      const tool = buildImageInspectionTool({
        targetDir: dir,
        models: {} as Models,
        activeModel: model(["text"]),
      });
      const result = await execute(tool, { source: "sample.png" });
      expect(result.content[0]).toEqual({
        type: "text",
        text: "image inspection failed: vision_model_required",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("remote image buffering cancels as soon as maxImageBytes is exceeded", async () => {
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(4));
          if (pulls >= 3) controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const tool = buildImageInspectionTool({
      targetDir: "/tmp",
      models: {} as Models,
      activeModel: model(["text", "image"]),
      web: { maxImageBytes: 4 },
      dependencies: {
        lookup,
        fetch: (async () =>
          new Response(stream, {
            headers: { "content-type": "image/png" },
          })) as unknown as typeof fetch,
      },
    });
    const result = await execute(tool, { source: "https://example.com/image.png" });
    expect(result.content[0]).toEqual({
      type: "text",
      text: "image inspection failed: image_too_large",
    });
    expect(pulls).toBe(2);
  });
});
