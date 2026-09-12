import * as readline from "node:readline/promises";
import type { AuthEvent, AuthInteraction, AuthPrompt, Models } from "@earendil-works/pi-ai";
import {
  assertCredentialPathOutsideProject,
  defaultCredentialPath,
  FileCredentialStore,
} from "../auth/credential-store";
import { getAuthStatus, login, logout } from "../auth/operations";
import { openaiCodexPreset } from "../registry/presets";
import { resolveRegistry } from "../registry/resolve";

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
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return {
    async prompt(prompt: AuthPrompt): Promise<string> {
      if (prompt.type === "select" && method !== undefined) return method;
      if (prompt.type === "select") {
        const answer = await rl.question(`${prompt.message} [browser/device_code]: `);
        return answer.trim() || "browser";
      }
      return rl.question(`${prompt.message} `, { signal: prompt.signal });
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
  const registry = resolveRegistry({ providers: [openaiCodexPreset()] }, { credentials });
  const models = options.models ?? registry.models;
  const providerId = options.providerId ?? registry.getModel("codex-gpt-5.5").provider;
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
      const interaction =
        supplied !== undefined && options.method !== undefined
          ? {
              prompt: async (prompt: AuthPrompt) =>
                prompt.type === "select"
                  ? (options.method as CodexLoginMethod)
                  : supplied.prompt(prompt),
              notify: (event: AuthEvent) => supplied.notify(event),
            }
          : supplied;
      const result = await login(
        models,
        providerId,
        "oauth",
        interaction ?? (ownedInteraction as CloseableAuthInteraction),
      );
      write(options.json ? `${JSON.stringify(result)}\n` : `${providerId}: authenticated\n`);
    } finally {
      ownedInteraction?.close();
    }
    return;
  }
  throw new Error(`unknown auth action: ${options.action}`);
}
