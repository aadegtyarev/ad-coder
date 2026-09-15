import { CostAnomalyDetector, FileCostAnomalyStore } from "./src/economics/cost-anomaly";
const dir = process.argv[2]!;
const d = new CostAnomalyDetector({}, new FileCostAnomalyStore(dir));
for (let i = 0; i < 8; i += 1)
  d.observe({ provider: "faux", model: "faux-1", costUsd: 0.001, totalTokens: 1000 });
for (let i = 0; i < 3; i += 1)
  d.observe({ provider: "faux", model: "faux-1", costUsd: 0.5, totalTokens: 1000 });
console.log("blocked:", d.blocked().map((b) => `${b.provider}/${b.model}`).join(",") || "(none)");
