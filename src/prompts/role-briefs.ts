import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export type ResearchPurpose = "model-inventory-bootstrap" | "model-inventory-refresh";
export interface RoleBriefSource {
  id: string;
  version: string;
  path: string;
}
export interface ResolvedRoleBrief {
  id: string;
  version: string;
  sha256: string;
  content: string;
}
export type RoleBriefErrorCode = "invalid_config" | "missing_required_brief";

export class RoleBriefError extends Error {
  override readonly name = "RoleBriefError";
  constructor(
    readonly code: RoleBriefErrorCode,
    readonly detail: string,
    message: string,
  ) {
    super(message);
  }
}

export const MODEL_INVENTORY_RESEARCH_BRIEF = {
  id: "model-inventory-research",
  version: "1",
  path: fileURLToPath(new URL("../../prompts/briefs/model-inventory-research.md", import.meta.url)),
} as const satisfies RoleBriefSource;
const SAFE_METADATA = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

export function resolveResearchRoleBrief(
  purpose: ResearchPurpose | undefined,
  alternative?: RoleBriefSource,
): ResolvedRoleBrief | undefined {
  if (purpose === undefined) {
    if (alternative !== undefined)
      throw new RoleBriefError(
        "invalid_config",
        "researchBrief",
        "researchBrief requires an explicit researchPurpose",
      );
    return undefined;
  }
  if (purpose !== "model-inventory-bootstrap" && purpose !== "model-inventory-refresh")
    throw new RoleBriefError(
      "invalid_config",
      "researchPurpose",
      `unsupported research purpose: ${purpose}`,
    );
  const source = alternative ?? MODEL_INVENTORY_RESEARCH_BRIEF;
  if (
    !SAFE_METADATA.test(source.id) ||
    !SAFE_METADATA.test(source.version) ||
    source.path.trim() === ""
  )
    throw new RoleBriefError(
      "invalid_config",
      "researchBrief",
      "research brief id, version, and path must be non-empty safe values",
    );
  let content: string;
  try {
    content = fs.readFileSync(path.resolve(source.path), "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new RoleBriefError(
      "missing_required_brief",
      source.id,
      `required research brief ${source.id}@${source.version} is unavailable: ${reason}`,
    );
  }
  if (content.length === 0)
    throw new RoleBriefError(
      "missing_required_brief",
      source.id,
      `required research brief ${source.id}@${source.version} is empty`,
    );
  return {
    id: source.id,
    version: source.version,
    sha256: createHash("sha256").update(content).digest("hex"),
    content,
  };
}

export function composeRoleBrief(systemPrompt: string, brief: ResolvedRoleBrief): string {
  return `${systemPrompt}\n\n${brief.content}`;
}
