import type { Context, Session } from "@earendil-works/pi-agent-core";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import type { CompactionPolicy, Summarizer } from "../context/compactor";
import type { LedgerSink } from "../ledger/ledger";
import type { Role } from "../role";
import type { SessionLimitController } from "../session-limits";
import type { RunRoleResult } from "./runner";
import { runRole } from "./runner";
import type { Tool } from "./tool";

/** Per-call overrides a bound RoleRunner accepts; the bound fields are not repeated. */
export interface RunRoleOptions {
  runId?: string;
  step?: string;
  laneName?: string;
  session?: Session;
  ledgerSink?: LedgerSink;
  context?: Context;
  /**
   * Custom tools for THIS turn only, extending the built-in set (see
   * `RunRoleParams.tools`). Per-call rather than bound in `RoleRunnerConfig`
   * because one RoleRunner drives multiple roles and only some need a custom
   * tool (e.g. only a reviewer role needs `submit_verdict`).
   */
  tools?: Tool[];
}

/**
 * A `runRole` bound to a fixed targetDir + models (+ optional summarizer/
 * session). This is what a workflow reaches for: it cannot pick a different
 * targetDir or a different credential source per call, so the two-directory
 * separation and the credential boundary hold for every turn it drives.
 */
export interface RoleRunner {
  runRole(
    role: Role,
    model: Model<Api>,
    prompt: string,
    opts?: RunRoleOptions,
  ): Promise<RunRoleResult>;
}

/** Configuration bound once, then reused for every turn the runner drives. */
export interface RoleRunnerConfig {
  targetDir: string;
  models: Models;
  summarizer?: Summarizer;
  compaction?: CompactionPolicy;
  session?: Session;
  sessionLimitController?: SessionLimitController;
}

/**
 * Bind `targetDir` + `models` (and optional `summarizer`/`session`) and
 * delegate each call to `runRole`. A per-call `opts.session` overrides the
 * bound default; the bound `summarizer` cannot be overridden per call (the
 * compaction strategy is a property of the runner, not the turn).
 */
export function createRoleRunner(config: RoleRunnerConfig): RoleRunner {
  return {
    async runRole(role, model, prompt, opts) {
      const session = opts?.session ?? config.session;
      return runRole({
        role,
        targetDir: config.targetDir,
        models: config.models,
        model,
        prompt,
        // exactOptionalPropertyTypes: spread each optional only when present so
        // an explicit `undefined` is never handed to a field typed without it.
        ...(config.summarizer !== undefined && { summarizer: config.summarizer }),
        ...(config.compaction !== undefined && { compaction: config.compaction }),
        ...(config.sessionLimitController !== undefined && {
          sessionLimitController: config.sessionLimitController,
        }),
        ...(session !== undefined && { session }),
        ...(opts?.runId !== undefined && { runId: opts.runId }),
        ...(opts?.step !== undefined && { step: opts.step }),
        ...(opts?.laneName !== undefined && { laneName: opts.laneName }),
        ...(opts?.ledgerSink !== undefined && { ledgerSink: opts.ledgerSink }),
        ...(opts?.context !== undefined && { context: opts.context }),
        ...(opts?.tools !== undefined && { tools: opts.tools }),
      });
    },
  };
}
