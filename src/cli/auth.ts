import * as readline from "node:readline/promises";
import { Writable } from "node:stream";
import type { AuthEvent, AuthInteraction, AuthPrompt, Models } from "@earendil-works/pi-ai";
import {
  assertCredentialPathOutsideProject,
  defaultCredentialPath,
  FileCredentialStore,
} from "../auth/credential-store";
import {
  type DeclaredProviderSource,
  resolveDeclaredProviderRegistry,
} from "../auth/declared-provider";
import { getAuthStatus, login, logout } from "../auth/operations";
import { openaiCodexPreset, openrouterPreset } from "../registry/presets";
import { resolveRegistry } from "../registry/resolve";
import type { RegistryConfig } from "../registry/types";

export type CodexLoginMethod = "browser" | "device_code";

export interface AuthCommandOptions {
  action: string;
  credentialPath?: string;
  targetDir: string;
  json?: boolean;
  method?: CodexLoginMethod;
  interaction?: AuthInteraction;
  /** Test/embedder seam; normal CLI resolution always uses the persistent registry models. */
  models?: Models;
  providerId?: string;
  provider?: string;
  /**
   * The declared-provider source for a non-built-in `--provider` id: the
   * operator's `models.yaml`. Injectable so tests never read the real home
   * config; it defaults to the XDG config home.
   */
  modelsConfigPath?: string;
  write?: (text: string) => void;
}

export function renderAuthEvent(event: AuthEvent, write: (text: string) => void): void {
  if (event.type === "auth_url")
    write(`Authorize in your browser: ${event.url}\n${event.instructions ?? ""}\n`);
  else if (event.type === "device_code")
    write(`Open ${event.verificationUri} and enter code ${event.userCode}\n`);
  else if (event.type === "info") {
    write(`${event.message}\n`);
    for (const link of event.links ?? []) write(`${link.label ?? "Open"}: ${link.url}\n`);
  } else write(`${event.message}\n`);
}

interface CloseableAuthInteraction extends AuthInteraction {
  close(): void;
}

function terminalInteraction(
  method: CodexLoginMethod | undefined,
  write: (text: string) => void,
): CloseableAuthInteraction {
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stderr.write(chunk);
      callback();
    },
  });
  const rl = readline.createInterface({
    input: process.stdin,
    output,
    terminal: process.stdin.isTTY === true,
  });
  return {
    async prompt(prompt: AuthPrompt): Promise<string> {
      if (prompt.type === "select" && method !== undefined) return method;
      if (prompt.type === "select") {
        const answer = await rl.question(`${prompt.message} [browser/device_code]: `);
        return answer.trim() || "browser";
      }
      if (prompt.type !== "secret")
        return rl.question(`${prompt.message} `, { signal: prompt.signal });
      write(`${prompt.message} `);
      muted = true;
      try {
        return await rl.question("", { signal: prompt.signal });
      } finally {
        muted = false;
        write("\n");
      }
    },
    notify: (event) => renderAuthEvent(event, write),
    close: () => rl.close(),
  };
}

export async function runAuthCommand(options: AuthCommandOptions): Promise<void> {
  const write = options.write ?? ((text: string) => void process.stdout.write(text));
  const credentialPath = options.credentialPath ?? defaultCredentialPath();
  assertCredentialPathOutsideProject(credentialPath, options.targetDir);
  const credentials = new FileCredentialStore({ path: credentialPath });
  const provider = options.provider ?? "openai-codex";
  const providerId = options.providerId ?? provider;
  const source: DeclaredProviderSource = {
    ...(options.modelsConfigPath !== undefined && { modelsConfigPath: options.modelsConfigPath }),
  };
  // Built-in providers resolve from their shipped preset; any other id is a
  // DECLARED env-var provider resolved from models.yaml (issue #101 item 2).
  // A declared env-var provider's login type is api_key.
  const isBuiltIn = provider === "openai-codex" || provider === "openrouter";
  const configured: RegistryConfig = isBuiltIn
    ? { providers: [provider === "openrouter" ? openrouterPreset() : openaiCodexPreset()] }
    : resolveDeclaredProviderRegistry(provider, source);
  const loginType = provider === "openai-codex" ? "oauth" : "api_key";
  // This registry exists to MANAGE one provider's credential (status/login/
  // logout), so a missing key is the command's subject, not a preflight
  // failure: declare knowledge of exactly this id and let status report
  // "not authenticated" instead of crashing with missing_credential.
  const registry = resolveRegistry(configured, {
    credentials,
    storedCredentialIds: new Set([providerId]),
  });
  const models = options.models ?? registry.models;
  if (options.action === "status") {
    const result = await getAuthStatus(models, providerId);
    write(
      options.json
        ? `${JSON.stringify(result)}\n`
        : `${providerId}: ${result.authenticated ? `authenticated (${result.type ?? "configured"})` : "not authenticated"}\n`,
    );
    return;
  }
  if (options.action === "logout") {
    const result = await logout(models, providerId);
    write(options.json ? `${JSON.stringify(result)}\n` : `${providerId}: logged out\n`);
    return;
  }
  if (options.action === "login") {
    const ownedInteraction =
      options.interaction === undefined
        ? terminalInteraction(options.method, (text) => void process.stderr.write(text))
        : undefined;
    try {
      const supplied = options.interaction;
      const selectedInteraction =
        supplied !== undefined && options.method !== undefined
          ? {
              prompt: async (prompt: AuthPrompt) =>
                prompt.type === "select"
                  ? (options.method as CodexLoginMethod)
                  : supplied.prompt(prompt),
              notify: (event: AuthEvent) => supplied.notify(event),
            }
          : supplied;
      const baseInteraction = selectedInteraction ?? (ownedInteraction as CloseableAuthInteraction);
      // Every api_key login (openrouter AND any declared env-var provider) gets
      // the same guards: an empty key is refused before it is stored, and the
      // post-login read proves the key actually persisted rather than the
      // command claiming success on a store that dropped it.
      const interaction: AuthInteraction =
        loginType === "api_key"
          ? {
              prompt: async (prompt) => {
                const answer = await baseInteraction.prompt(prompt);
                if (prompt.type === "secret" && answer.trim().length === 0)
                  throw new Error("API key cannot be empty");
                return answer;
              },
              notify: (event) => baseInteraction.notify(event),
            }
          : baseInteraction;
      const result = await login(models, providerId, loginType, interaction);
      if (loginType === "api_key") {
        const retained = await credentials.read(providerId);
        if (
          retained?.type !== "api_key" ||
          retained.key === undefined ||
          retained.key.trim().length === 0
        )
          throw new Error("API key was not retained; retry login");
      }
      write(options.json ? `${JSON.stringify(result)}\n` : `${providerId}: authenticated\n`);
    } finally {
      ownedInteraction?.close();
    }
    return;
  }
  throw new Error(`unknown auth action: ${options.action}`);
}
