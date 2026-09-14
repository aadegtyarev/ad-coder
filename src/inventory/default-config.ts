import { buildDefaultProfile } from "../profiles/default-profile";
import { openaiCodexPreset } from "../registry/presets";
import type { ModelInventoryConfig } from "./types";

export const DEFAULT_INVENTORY_NAME = "openai-codex-default";

/** Seed copied to the user config on first use; afterwards the file is user-owned. */
export function buildInstalledInventoryConfig(): ModelInventoryConfig {
  const profile = buildDefaultProfile({
    strong: "codex-sol",
    mid: "codex-terra",
    cheap: "codex-luna",
  });
  return {
    profiles: [
      {
        name: DEFAULT_INVENTORY_NAME,
        registry: { providers: [openaiCodexPreset()] },
        profile: {
          entries: profile.entries.map((entry) =>
            entry.role === "coder"
              ? { ...entry, model: "codex-sol", thinkingLevel: "medium" }
              : { ...entry, thinkingLevel: "low" },
          ),
        },
      },
    ],
    default: DEFAULT_INVENTORY_NAME,
  };
}
