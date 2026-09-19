/**
 * Unit tests for the typed startup acquisition refusal (issue #428): the
 * defensive guard in `startConversation` that fires when a caller passes no
 * `session` and the project store still returns no session throws
 * `SessionNotAcquiredError`, not a plain `Error`.
 *
 * The guard is unreachable with a real store (`openOrCreateSession` always
 * resolves a session), so these tests mock the `ProjectStore` export with a
 * facade class that behaves identically EXCEPT under a per-test flag.
 */
import { expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import type { ProjectStoreConfig } from "../src/project-store/types";
import type { Role } from "../src/role";

// Capture the REAL store before the mock replaces the registry entry.
const realStoreModule = await import("../src/project-store/project-store");
const RealProjectStore = realStoreModule.ProjectStore;
type RealStore = InstanceType<typeof RealProjectStore>;

/** Facade: identical to the real store unless `forceNotAcquired` is set. */
class TestProjectStore extends RealProjectStore {
  static forceNotAcquired = false;
  override async openOrCreateSession(
    id: Parameters<RealStore["openOrCreateSession"]>[0],
    context: Parameters<RealStore["openOrCreateSession"]>[1],
  ): ReturnType<RealStore["openOrCreateSession"]> {
    if (TestProjectStore.forceNotAcquired) return undefined as never;
    return super.openOrCreateSession(id, context);
  }
}

mock.module("../src/project-store/project-store", () => ({
  ...realStoreModule,
  ProjectStore: TestProjectStore,
}));

const { SessionNotAcquiredError, startConversation } = await import(
  "../src/conversation/conversation"
);

const CONTEXT_WINDOW = 200_000;
let targetDir = "";

test("a conversation whose durable session cannot be seated throws the typed SessionNotAcquiredError", async () => {
  targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "428-acquire-"));
  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "faux-1", contextWindow: CONTEXT_WINDOW }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel() as Model<Api>;
  const role: Role = {
    name: "coder",
    provider: "faux",
    modelId: model.id,
    systemPrompt: "You code.",
    activeToolNames: ["bash", "read", "write", "edit"],
    contextBudget: { maxTokens: 100_000, reserveTokens: 10_000, keepRecentTokens: 20_000 },
    cacheRetention: "none",
  } as Role;
  TestProjectStore.forceNotAcquired = true;
  try {
    await expect(
      startConversation({
        role,
        targetDir,
        models,
        model,
        runId: "acquire_428",
      }),
    ).rejects.toBeInstanceOf(SessionNotAcquiredError);
    // The class projects its own stable code, an authored message, and the
    // run id -- the fields the CLI front projects (tested in test/cli.test.ts).
    const cause = await startConversation({
      role,
      targetDir,
      models,
      model,
      runId: "acquire_428_again",
    }).catch((error) => error);
    expect((cause as { code: string }).code).toBe("session_not_acquired");
    expect((cause as { runId: string }).runId).toBe("acquire_428_again");
    expect((cause as Error).message).toBe(
      "conversation failed to open or resume its durable session",
    );
    expect((cause as Error).name).toBe("SessionNotAcquiredError");
  } finally {
    TestProjectStore.forceNotAcquired = false;
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
});

test("with the real behavior behind the facade a conversation still seats its session normally", async () => {
  targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "428-acquire-ok-"));
  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "faux-1", contextWindow: CONTEXT_WINDOW }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel() as Model<Api>;
  const role: Role = {
    name: "coder",
    provider: "faux",
    modelId: model.id,
    systemPrompt: "You code.",
    activeToolNames: ["bash", "read", "write", "edit"],
    contextBudget: { maxTokens: 100_000, reserveTokens: 10_000, keepRecentTokens: 20_000 },
    cacheRetention: "none",
  } as Role;
  try {
    const conversation = await startConversation({
      role,
      targetDir,
      models,
      model,
      runId: "acquire_428_ok",
    });
    await conversation.close();
  } finally {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
});
