import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BACKGROUND_CONTEXT, MemorySessionRepo } from "@earendil-works/pi-agent-core";
import { branchTip } from "@earendil-works/pi-agent-core/harness/session";
import type { Api, AssistantMessage, Model, Models } from "@earendil-works/pi-ai";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { projectCliError, renderCliError } from "../src/cli";
import {
  resolvePipelineConfig,
  resolveProviderAdmissionController,
} from "../src/cli/resolve-config";
import { parseSettingsConfig } from "../src/config/validate";
import { SUMMARIZATION_PROMPT } from "../src/context/compactor";
import { startConversation } from "../src/conversation/conversation";
import { CostAnomalyDetector, MemoryCostAnomalyStore } from "../src/economics/cost-anomaly";
import { StageLimitController } from "../src/orchestration/stage-limits";
import { buildDefaultProfile } from "../src/profiles/default-profile";
import {
  AdmissionCancelledError,
  admissionScopeKey,
  DEFAULT_PROVIDER_ADMISSION_CONFIG,
  FileProviderAdmissionStore,
  MemoryProviderAdmissionStore,
  ProviderAdmissionController,
  QueueSaturatedError,
} from "../src/provider-admission";
import type { RegistryConfig } from "../src/registry/types";
import { defineRole } from "../src/role";
import { ProviderLimitError } from "../src/runner/errors";
import { runRole } from "../src/runner/runner";
import { SessionLimitController } from "../src/session-limits";

const CONTEXT_WINDOW = 200_000;

/** Placeholder for a parked admit: the test resolves it by hand or never does. */
interface ParkedCall {
  resolve: (value: AssistantMessage) => void;
}

/**
 * Fake Models whose promise methods park on manually-resolved deferreds, so a
 * test decides exactly when an admitted call settles, and `calls` records the
 * order the INNER models were entered — the observable behind "the admission
 * wrapper is applied last, so it is entered first". Local copy of the module
 * battery's fake (test files duplicate helpers by house convention).
 */
function gateModels(calls: string[], holds: ParkedCall[]): Models {
  const park = (name: string): Promise<AssistantMessage> => {
    calls.push(name);
    let resolve!: (value: AssistantMessage) => void;
    const promise = new Promise<AssistantMessage>((res) => {
      resolve = res;
    });
    holds.push({ resolve });
    return promise;
  };
  return {
    complete: () => park("complete"),
    completeSimple: () => park("completeSimple"),
    fetchDeferred: () => park("fetchDeferred"),
    stream: () => park("stream") as unknown as ReturnType<Models["stream"]>,
    streamSimple: () => park("streamSimple") as unknown as ReturnType<Models["stream"]>,
    streamDeferred: () => park("streamDeferred") as unknown as ReturnType<Models["stream"]>,
    cancelDeferred: async () => {
      calls.push("cancelDeferred");
    },
    getProviders: () => [],
    getProvider: () => undefined,
    getModels: () => [],
    getModel: () => undefined,
    refresh: async () => ({ refreshed: [], skipped: [], failed: [] }),
    checkAuth: async () => undefined,
    getAvailable: async () => [],
    getAuth: async () => undefined,
    login: async () => {
      throw new Error("not used");
    },
    logout: async () => {},
  } as unknown as Models;
}

/** Models whose promise method rejects with a structured provider limit. */
function limitRejectingModels(calls: string[], hintMs: number): Models {
  return {
    ...gateModels(calls, []),
    complete: () => {
      calls.push("complete");
      return Promise.reject(new ProviderLimitError(hintMs));
    },
  } as unknown as Models;
}

/**
 * Models whose stream method returns a stream whose ASYNC ITERATION rejects —
 * the path the deferred admission stream's `reactRejection` is wired to (a
 * stream must return synchronously, so a mid-stream provider failure is what
 * the stream seam can observe).
 */
function streamLimitRejectingModels(calls: string[], hintMs: number): Models {
  const base = gateModels(calls, []);
  return {
    ...base,
    stream: () => {
      calls.push("stream");
      return {
        [Symbol.asyncIterator]() {
          return { next: () => Promise.reject(new ProviderLimitError(hintMs)) };
        },
        result: async () => {
          throw new Error("iteration rejected before result()");
        },
      };
    },
  } as unknown as Models;
}

/** A faux provider + models pair and the role validated against its window. */
function harnessFixture() {
  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "faux-1", contextWindow: CONTEXT_WINDOW }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel() as Model<Api>;
  const role = defineRole(
    {
      name: "coder",
      provider: "faux",
      modelId: model.id,
      systemPrompt: "You code.",
      activeToolNames: ["bash", "read", "write", "edit"],
      cacheRetention: "none",
      contextBudget: { maxTokens: 100_000, reserveTokens: 10_000, keepRecentTokens: 20_000 },
    },
    model,
  );
  return { faux, models, model, role };
}

/** A fake env accessor over a plain record; nothing touches the real process.env. */
function fakeEnv(vars: Record<string, string>): (name: string) => string | undefined {
  return (name: string) => vars[name];
}

/** Swallow the resolver's stderr notices so tests stay quiet. */
const silent = () => {};

/**
 * A controller scope primed to saturation: one call admitted and parked, one
 * queued. `maxConcurrentPerScope: 1` + `queueCapacityPerScope: 1` means the
 * NEXT admission attempt is refused with the typed `queue_saturated` failure.
 * The priming probes enter the gate fake, NOT the caller's inner models, so a
 * later run through the same scope must add nothing to `calls`.
 */
async function saturatedScope(calls: string[], holds: ParkedCall[]) {
  const controller = new ProviderAdmissionController({
    maxConcurrentPerScope: 1,
    queueCapacityPerScope: 1,
  });
  const primingCalls: string[] = [];
  const primingHolds: ParkedCall[] = [];
  const wrapped = controller.wrap(gateModels(primingCalls, primingHolds), "faux", "faux");
  const admitted = wrapped.complete({} as never, {} as never);
  const queued = wrapped.complete({} as never, {} as never);
  void admitted.catch(() => undefined);
  void queued.catch(() => undefined);
  // The probes enter the fake on microtasks; settle them before asserting.
  await flush();
  const key = admissionScopeKey("faux", "faux");
  holds.push(...primingHolds);
  calls.push(...primingCalls);
  return { controller, wrapped, key };
}

async function flush(ticks = 5): Promise<void> {
  for (let i = 0; i < ticks; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

let targetDir: string;

beforeAll(() => {
  targetDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-admission-wiring-")));
});

afterAll(() => {
  fs.rmSync(targetDir, { recursive: true, force: true });
});

test("provider admission wiring: runRole enters admission first, ahead of every inner reserve", async () => {
  const { faux, models, model, role } = harnessFixture();
  faux.setResponses([fauxAssistantMessage("must never dispatch")]);
  const calls: string[] = [];
  const holds: ParkedCall[] = [];
  const { controller } = await saturatedScope(calls, holds);
  const sessionController = new SessionLimitController({ maxTurns: 5 });
  const stageController = new StageLimitController({ maxModelTurns: 5 });
  const detector = new CostAnomalyDetector({}, new MemoryCostAnomalyStore());

  const error = await runRole({
    role,
    targetDir,
    models,
    model,
    prompt: "any prompt",
    providerAdmissionController: controller,
    sessionLimitController: sessionController,
    stageLimitController: stageController,
    costAnomalyDetector: detector,
  }).catch((cause) => cause);

  // The typed refusal, not a generic empty-turn projection: the saturated
  // scope is retryable, and "verify authentication" would misdirect.
  expect(error).toBeInstanceOf(QueueSaturatedError);
  expect((error as QueueSaturatedError).code).toBe("queue_saturated");
  expect((error as QueueSaturatedError).retryable).toBe(true);
  // Entered FIRST: the provider was never probed and no inner controller
  // reserved anything for a request that was refused. `calls` holds exactly
  // the two priming probes — the refused run added no inner entry.
  expect(faux.state.callCount).toBe(0);
  expect(calls).toEqual(["complete"]);
  expect(sessionController.snapshot().admittedTurns).toBe(0);
  expect(stageController.snapshot().modelTurns).toBe(0);
});

test("provider admission wiring: startConversation enters admission first, ahead of every inner reserve", async () => {
  const { faux, models, model, role } = harnessFixture();
  faux.setResponses([fauxAssistantMessage("must never dispatch")]);
  const calls: string[] = [];
  const holds: ParkedCall[] = [];
  const { controller } = await saturatedScope(calls, holds);
  const sessionController = new SessionLimitController({ maxTurns: 5 });
  const detector = new CostAnomalyDetector({}, new MemoryCostAnomalyStore());
  const session = await new MemorySessionRepo().create({}, BACKGROUND_CONTEXT);

  const conversation = await startConversation({
    role,
    targetDir,
    models,
    model,
    session,
    providerAdmissionController: controller,
    sessionLimitController: sessionController,
    costAnomalyDetector: detector,
  });
  try {
    await expect(conversation.step("hello")).rejects.toBeInstanceOf(QueueSaturatedError);
  } finally {
    await conversation.close();
  }
  expect(faux.state.callCount).toBe(0);
  expect(calls).toEqual(["complete"]);
  expect(sessionController.snapshot().admittedTurns).toBe(0);
});

test("provider admission wiring: a healthy chain still runs with every controller wrapped", async () => {
  const { faux, models, model, role } = harnessFixture();
  faux.setResponses([fauxAssistantMessage("done")]);
  const controller = new ProviderAdmissionController({ maxConcurrentPerScope: 2 });

  const result = await runRole({
    role,
    targetDir,
    models,
    model,
    prompt: "real work",
    providerAdmissionController: controller,
    sessionLimitController: new SessionLimitController({ maxTurns: 5 }),
    stageLimitController: new StageLimitController({ maxModelTurns: 5 }),
    costAnomalyDetector: new CostAnomalyDetector({}, new MemoryCostAnomalyStore()),
  });
  expect(result.result.status).toBe("completed");
  expect(faux.state.callCount).toBe(1);
  // The permit was released exactly once: the scope is empty again.
  const key = admissionScopeKey("faux", "faux");
  const snapshot = controller.snapshot();
  expect(snapshot.scopes[key]?.concurrent ?? 0).toBe(0);
});

test("provider admission wiring: a provider_limit rejection in a generation path opens the shared cooldown", async () => {
  // Promise path: `complete` rejects, the wrap seam opens the scope cooldown.
  const promiseCalls: string[] = [];
  const promiseController = new ProviderAdmissionController();
  const promiseModels = promiseController.wrap(
    limitRejectingModels(promiseCalls, 4_000),
    "faux",
    "promise",
  );
  await promiseModels.complete({} as never, {} as never).catch(() => undefined);
  await flush();
  const promiseKey = admissionScopeKey("faux", "promise");
  const promiseSnapshot = promiseController.snapshot();
  expect(promiseSnapshot.scopes[promiseKey]?.cooldownUntil).toBeDefined();
  expect(promiseSnapshot.scopes[promiseKey]?.concurrent).toBe(0);

  // Stream path: the deferred admission stream forwards the mid-stream
  // provider limit to `reactRejection` before releasing the permit.
  const streamCalls: string[] = [];
  const streamController = new ProviderAdmissionController();
  const streamModels = streamController.wrap(
    streamLimitRejectingModels(streamCalls, 1_234),
    "faux",
    "stream",
  );
  void streamModels.stream({} as never, {} as never);
  await flush();
  const streamKey = admissionScopeKey("faux", "stream");
  const streamSnapshot = streamController.snapshot();
  expect(streamSnapshot.scopes[streamKey]?.cooldownUntil).toBeDefined();
  expect(streamSnapshot.scopes[streamKey]?.concurrent).toBe(0);
});

test(
  "provider admission wiring: the compaction summarizer rides admission in startConversation, " +
    "not the pre-admission chain",
  async () => {
    // The regression this guards (review finding 1, issue #365 layer 1b):
    // `resolveCompactionPolicy` was fed `limitedModels` — the chain WITHOUT the
    // admission wrapper — so a compaction summarizer could dispatch to a
    // provider whose scope was saturated or standing down. THE OBSERVABLE: a
    // scope saturated by one held probe, with the conversation's FIRST turn
    // already over budget so the summarizer fires BEFORE the turn's own
    // (admitted) provider call inside that step. Wired right, the summarizer
    // is refused at admission and the provider is never probed (callCount 0);
    // wired to `limitedModels`, the summary dispatch succeeds first and the
    // provider count is 1.
    const { faux, models, model } = harnessFixture();
    faux.setResponses(
      Array.from(
        { length: 4 },
        () => (request: { systemPrompt?: string }) =>
          fauxAssistantMessage(
            request.systemPrompt === SUMMARIZATION_PROMPT ? "safe historical briefing" : "reply",
          ),
      ),
    );
    const role = defineRole(
      {
        name: "coder",
        provider: model.provider,
        modelId: model.id,
        systemPrompt: "You code.",
        activeToolNames: [],
        cacheRetention: "none",
        // Small budget: the PRELOADED history below is over threshold, so the
        // FIRST step attempts compaction, while the still-recent tail stays
        // inside the preflight ceiling (the irreducible case would refuse the
        // turn before any provider path was reached).
        contextBudget: { maxTokens: 1100, reserveTokens: 100, keepRecentTokens: 250 },
      },
      model,
    );
    const calls: string[] = [];
    const holds: ParkedCall[] = [];
    const { controller } = await saturatedScope(calls, holds);
    const sessionController = new SessionLimitController({ maxTurns: 8 });
    // A durable session carried over from a restart: its history is already
    // over the compaction threshold, so the FIRST step must compact BEFORE it
    // can dispatch — the resumed-history scenario the contract's restore
    // rules serve. The lane tip is moved to the preloaded tail via the same
    // `pi.branch.tip` value the harness reads when it re-opens a lane, so
    // history is on the lane like a resumed durable session's.
    const repo = new MemorySessionRepo();
    const session = await repo.create({}, BACKGROUND_CONTEXT);
    const seeded = await session.createBranch("default", null, BACKGROUND_CONTEXT);
    // History then a still-open question. The lane tip is moved to the newest
    // entry via the same `pi.branch.tip` value the harness reads when it
    // re-opens a lane, so history is on the lane like a resumed durable
    // session's: oversized head (assistant history), small tail (the question).
    await seeded.appendMessage(
      {
        role: "assistant",
        content: [{ type: "text", text: `history:${"x".repeat(4800)}` }],
        timestamp: 3,
      } as never,
      BACKGROUND_CONTEXT,
    );
    const question = await seeded.appendMessage(
      { role: "user", content: [{ type: "text", text: "continue" }], timestamp: 2 } as never,
      BACKGROUND_CONTEXT,
    );
    await session.setValue(branchTip("main"), question, BACKGROUND_CONTEXT);

    const conversation = await startConversation({
      role,
      targetDir,
      models,
      model,
      session,
      providerAdmissionController: controller,
      sessionLimitController: sessionController,
      costAnomalyDetector: new CostAnomalyDetector({}, new MemoryCostAnomalyStore()),
    });
    try {
      // Over budget from the preloaded history: compaction is attempted before
      // the turn dispatches. The saturated scope refuses the summarizer; the
      // turn's own admission-wrapped dispatch is refused right after — the
      // typed failure reaches the caller.
      await expect(conversation.step("continue")).rejects.toBeInstanceOf(QueueSaturatedError);
    } finally {
      await conversation.close();
    }
    // THE WIRING PROBE: the provider was never reached — neither by the
    // summarizer nor by anything else. Under the old wiring this is 1: the
    // summary request rode the pre-admission chain and dispatched.
    expect(faux.state.callCount).toBe(0);
    // Only the priming probe entered the inner chain; the summarizer added no
    // `completeSimple` entry.
    expect(calls).toEqual(["complete"]);
    // The refusal is the shared scope's, not a private reproduction of the
    // session limits: the session controller reserved nothing for the refusals.
    expect(sessionController.snapshot().admittedTurns).toBe(0);
  },
);

test("provider admission wiring: cancelDeferred passes through the admission proxy unchanged", async () => {
  const calls: string[] = [];
  const holds: ParkedCall[] = [];
  const controller = new ProviderAdmissionController();
  const wrapped = controller.wrap(gateModels(calls, holds), "faux", "faux");

  await wrapped.cancelDeferred({} as never, {} as never);
  // The non-generation method reached the inner models untouched...
  expect(calls).toEqual(["cancelDeferred"]);
  // ...and admission kept no scope state for it: cancellation is not a
  // generation call and reserves nothing.
  expect(controller.snapshot().scopes).toEqual({});
});

test("provider admission wiring: the configured 0 disable sentinel yields pass-through, never a controller", () => {
  // The disable gate lives in the WIRING layer: the module's constructor
  // refuses `maxConcurrentPerScope: 0`, so a configured 0 must never reach it.
  expect(resolveProviderAdmissionController({ maxConcurrentPerScope: 0 })).toBeUndefined();
  // Enabled with module defaults when nothing is configured.
  const defaults = resolveProviderAdmissionController(undefined);
  expect(defaults).toBeInstanceOf(ProviderAdmissionController);
  expect(defaults?.config.maxConcurrentPerScope).toBe(
    DEFAULT_PROVIDER_ADMISSION_CONFIG.maxConcurrentPerScope,
  );
  // Enabled with overrides; unset settings keep the module's finite defaults.
  const enabled = resolveProviderAdmissionController({
    maxConcurrentPerScope: 3,
    queueCapacityPerScope: 2,
  });
  expect(enabled?.config.maxConcurrentPerScope).toBe(3);
  expect(enabled?.config.queueCapacityPerScope).toBe(2);
  expect(enabled?.config.maxWaitMs).toBe(DEFAULT_PROVIDER_ADMISSION_CONFIG.maxWaitMs);
  // Nonsense fails loud with the module's TypeError, never a silent default.
  expect(() => resolveProviderAdmissionController({ queueCapacityPerScope: 0 })).toThrow(TypeError);
  expect(() => resolveProviderAdmissionController({ maxWaitMs: -1 })).toThrow(TypeError);
});

test("provider admission wiring: the resolved config reports admission state and source, never silent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-admission-config-"));
  try {
    const base = {
      task: "x",
      targetDir: dir,
      registryConfig: mixedRegistry(),
      profile: buildDefaultProfile({ strong: "small", mid: "small", cheap: "small" }),
      env: fakeEnv({ LOCAL_KEY: "k" }),
      warn: silent,
    };
    // Ships ENABLED by default, sourced to the built-in default.
    const shipped = resolvePipelineConfig({ ...base });
    expect(shipped.providerAdmissionController).toBeInstanceOf(ProviderAdmissionController);
    expect(shipped.effectiveConfig?.["providerAdmission.enabled"]).toEqual({
      value: true,
      source: "built-in-default",
    });
    expect(shipped.effectiveConfig?.["providerAdmission.maxConcurrentPerScope"]).toEqual({
      value: DEFAULT_PROVIDER_ADMISSION_CONFIG.maxConcurrentPerScope,
      source: "built-in-default",
    });

    // The configured 0 disables: no controller on the config, and the resolved
    // state says so with the layer that set it.
    const disabled = resolvePipelineConfig({
      ...base,
      providerAdmissionSettings: { maxConcurrentPerScope: 0 },
    });
    expect(disabled.providerAdmissionController).toBeUndefined();
    expect(disabled.effectiveConfig?.["providerAdmission.enabled"]).toEqual({
      value: false,
      source: "caller",
    });
    expect(disabled.effectiveConfig?.["providerAdmission.maxConcurrentPerScope"]).toEqual({
      value: 0,
      source: "caller",
    });

    // A positive configuration enables with overrides and names its source.
    const enabled = resolvePipelineConfig({
      ...base,
      providerAdmissionSettings: { maxConcurrentPerScope: 2, retryDelayMs: 250 },
      providerAdmissionSettingsSource: "settings",
    });
    expect(enabled.providerAdmissionController?.config.maxConcurrentPerScope).toBe(2);
    expect(enabled.providerAdmissionController?.config.retryDelayMs).toBe(250);
    expect(enabled.effectiveConfig?.["providerAdmission.enabled"]).toEqual({
      value: true,
      source: "settings",
    });
    expect(enabled.effectiveConfig?.["providerAdmission.maxConcurrentPerScope"]).toEqual({
      value: 2,
      source: "settings",
    });
    expect(enabled.effectiveConfig?.["providerAdmission.queueCapacityPerScope"]).toEqual({
      value: DEFAULT_PROVIDER_ADMISSION_CONFIG.queueCapacityPerScope,
      source: "built-in-default",
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("provider admission wiring: settings.yaml gains the provider-admission vocabulary", () => {
  // Absent section: the enabled default, nothing to override.
  expect(parseSettingsConfig({ review: {} }).providerAdmission).toEqual({});
  // Present section: non-negative integers kept verbatim (the 0 disable gate
  // is a wiring decision, not a parse one).
  expect(
    parseSettingsConfig({
      review: {},
      "provider-admission": {
        "max-concurrent-per-scope": 0,
        "queue-capacity-per-scope": 4,
        "max-wait-ms": 30_000,
        "retry-delay-ms": 500,
        "cooldown-max-ms": 3_600_000,
      },
    }).providerAdmission,
  ).toEqual({
    maxConcurrentPerScope: 0,
    queueCapacityPerScope: 4,
    maxWaitMs: 30_000,
    retryDelayMs: 500,
    cooldownMaxMs: 3_600_000,
  });
  // Unknown keys are refused, never silently inert.
  expect(() =>
    parseSettingsConfig({ review: {}, "provider-admission": { concurrency: 2 } }),
  ).toThrow(/unknown provider-admission key/);
  // Negative and fractional values are refused.
  expect(() =>
    parseSettingsConfig({ review: {}, "provider-admission": { "max-wait-ms": -5 } }),
  ).toThrow(/non-negative integer/);
  expect(() =>
    parseSettingsConfig({ review: {}, "provider-admission": { "retry-delay-ms": 1.5 } }),
  ).toThrow(/non-negative integer/);
  // A non-map section is refused.
  expect(() => parseSettingsConfig({ review: {}, "provider-admission": 3 })).toThrow(
    /must be a map/,
  );
});

test("provider admission wiring: the resolver hands the supplied store to the controller", async () => {
  const calls: string[] = [];
  const holds: ParkedCall[] = [];
  const store = new MemoryProviderAdmissionStore();
  const controller = resolveProviderAdmissionController({ maxConcurrentPerScope: 2 }, store);
  expect(controller).toBeInstanceOf(ProviderAdmissionController);
  const wrapped = controller?.wrap(gateModels(calls, holds), "faux", "faux");
  const admit = wrapped?.complete({} as never, {} as never);
  void admit?.catch(() => undefined);
  await flush();
  // The controller SAVED through the supplied store: a snapshot is there.
  const key = admissionScopeKey("faux", "faux");
  expect(store.load()?.scopes[key]?.concurrent).toBe(1);
  // A controller built on the same store RESTORES from it — the durability the
  // durable headless paths get from the file store.
  const restored = resolveProviderAdmissionController({ maxConcurrentPerScope: 2 }, store);
  expect(restored?.snapshot().scopes[key]?.concurrent).toBe(1);
});

test("provider admission wiring: the resolved pipeline stores admission state in the durable run store", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-admission-durable-"));
  try {
    const resolved = resolvePipelineConfig({
      task: "x",
      targetDir: dir,
      registryConfig: mixedRegistry(),
      profile: buildDefaultProfile({ strong: "small", mid: "small", cheap: "small" }),
      env: fakeEnv({ LOCAL_KEY: "k" }),
      warn: silent,
    });
    const controller = resolved.providerAdmissionController;
    expect(controller).toBeInstanceOf(ProviderAdmissionController);

    // Durable activity through the resolved controller: one call admitted
    // and parked while its permit is live, as a durable run's in-flight
    // request would be.
    const calls: string[] = [];
    const holds: ParkedCall[] = [];
    const wrapped = controller?.wrap(gateModels(calls, holds), "local", "local");
    const admit = wrapped?.complete({} as never, {} as never);
    void admit?.catch(() => undefined);
    await flush();

    // The state file sits BESIDE the durable run records under .ad-coder/runs.
    const file = path.join(dir, ".ad-coder", "runs", "provider-admission.json");
    const persisted = JSON.parse(fs.readFileSync(file, "utf8")) as {
      version: number;
      scopes: Record<string, { concurrent: number }>;
    };
    expect(persisted.version).toBe(1);
    const key = admissionScopeKey("local", "local");
    expect(persisted.scopes[key]?.concurrent).toBe(1);

    // A restarted controller re-reading the SAME durable run store restores
    // the in-flight permit (re-armed, still occupying its slot).
    const restarted = new ProviderAdmissionController({}, new FileProviderAdmissionStore(dir));
    expect(restarted.snapshot().scopes[key]?.concurrent).toBe(1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("provider admission wiring: the CLI projects the two admission errors with their typed actions", () => {
  const saturated = new QueueSaturatedError("work-openrouter", 3);
  expect(projectCliError(saturated)).toEqual({
    code: "queue_saturated",
    text: saturated.message,
    retryable: true,
    nextAction: "retry later, or raise queueCapacityPerScope",
  });
  expect(renderCliError(saturated)).toBe(
    `ad-coder: ${saturated.message}; retry later, or raise queueCapacityPerScope\n`,
  );

  const cancelled = new AdmissionCancelledError("work-openrouter");
  expect(projectCliError(cancelled)).toEqual({
    code: "cancelled",
    text: cancelled.message,
    retryable: false,
    nextAction: "start a new request if one is still wanted",
  });
  expect(renderCliError(cancelled)).toBe(
    `ad-coder: ${cancelled.message}; start a new request if one is still wanted\n`,
  );

  // Machine shape stays safe: stable code and authored text only — no scope
  // digest, model id, or prompt content anywhere in the record.
  for (const error of [saturated, cancelled]) {
    const projected = JSON.stringify(projectCliError(error));
    expect(projected).not.toMatch(/[0-9a-f]{64}/);
    expect(projected).not.toContain("faux-1");
  }
});

/** A fake registry over a local provider; nothing touches the network. */
function mixedRegistry(): RegistryConfig {
  const make = (name: string, contextWindow: number) => ({
    name,
    modelId: name,
    contextWindow,
    maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  return {
    providers: [
      {
        id: "local",
        api: "openai-completions",
        baseUrl: "https://localhost.example/v1",
        credential: { kind: "env-var", envVar: "LOCAL_KEY" },
        models: [make("small", 32000), make("large", 200000)],
      },
    ],
  };
}
