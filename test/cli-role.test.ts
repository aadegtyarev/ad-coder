import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { runRoleStandalone } from "../src/cli";
import { MemoryLedgerSink } from "../src/ledger/ledger";
import { defineRole } from "../src/role";
import type { Role } from "../src/role";

const CONTEXT_WINDOW = 200_000;
const BUDGET = { maxTokens: 100_000, reserveTokens: 10_000, keepRecentTokens: 20_000 } as const;

let targetDir: string;

beforeAll(() => {
  targetDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-cli-role-")));
});

afterAll(() => {
  fs.rmSync(targetDir, { recursive: true, force: true });
});

/** A faux-backed reviewer: no network, no key, one queued assistant message. */
function fixture() {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: CONTEXT_WINDOW }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel() as Model<Api>;
  const role: Role = defineRole(
    {
      name: "reviewer",
      provider: "faux",
      modelId: model.id,
      systemPrompt: "You review.",
      activeToolNames: ["read", "bash"],
      cacheRetention: "none",
      contextBudget: { ...BUDGET },
    },
    model,
  );
  return { faux, models, model, role };
}

test("runRoleStandalone drives one faux turn and returns the assistant text plus a numeric cost", async () => {
  const { faux, models, model, role } = fixture();
  faux.setResponses([fauxAssistantMessage("looks good to me")]);
  const ledgerSink = new MemoryLedgerSink();

  const { text, cost } = await runRoleStandalone({
    role,
    model,
    models,
    targetDir,
    task: "review the change",
    ledgerSink,
  });

  expect(text).toContain("looks good to me");
  expect(typeof cost).toBe("number");
  expect(cost).toBeGreaterThanOrEqual(0);
  // The ledger recorded the turn, and the cost is summed from it.
  expect(ledgerSink.records().length).toBeGreaterThan(0);
});
