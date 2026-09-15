import type { Api, Model } from "@earendil-works/pi-ai";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { CostAnomalyDetector, FileCostAnomalyStore } from "./src/economics/cost-anomaly";
import { startConversation } from "./src/conversation/conversation";
import { runRoleStandalone } from "./src/cli";
import { defineRole } from "./src/role";

const dir = "/tmp/tmp.NGOkYbYimX";
const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200000 }] });
faux.setResponses([() => ({ role: "assistant", content: [{ type: "text", text: "SHOULD NOT RUN" }] })]);
const models = createModels();
models.setProvider(faux.provider);
const model = faux.getModel() as Model<Api>;
const role = defineRole({ name: "coder", provider: "faux", modelId: model.id, systemPrompt: "You code.", activeToolNames: [], cacheRetention: "none", contextBudget: { maxTokens: 100000, reserveTokens: 10000, keepRecentTokens: 20000 } }, model);
const detector = () => new CostAnomalyDetector({}, new FileCostAnomalyStore(dir));
console.log("block on disk:", detector().blocked().map(b => b.provider + "/" + b.model).join(",") || "(none)");

// 1. console / run_role path
try {
  const c = await startConversation({ role, targetDir: dir, models, model, costAnomalyDetector: detector() });
  await c.step("hello");
  console.log("console  => RAN UNBLOCKED (bad)");
} catch (e) { console.log("console  => REFUSED:", (e as Error).constructor.name, "--", (e as Error).message.slice(0,160)); }

// 2. standalone role path
try {
  await runRoleStandalone({ role, model, models, targetDir: dir, task: "t", costAnomalyDetector: detector() });
  console.log("role     => RAN UNBLOCKED (bad)");
} catch (e) { console.log("role     => REFUSED:", (e as Error).constructor.name); }
