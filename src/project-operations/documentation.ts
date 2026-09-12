import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectOperationsConfig } from "../project-store/types";
import { ProjectOperationsError } from "./errors";
import { validateFollowUp } from "./follow-ups";
import type { FollowUp } from "./types";

export interface DocumentationProposal {
  kind: Exclude<FollowUp["kind"], "backlog">;
  destination: string;
  content: string;
  followUp: FollowUp;
}

function assertSafeDestination(targetDir: string, destination: string): string {
  const root = fs.realpathSync(targetDir);
  const absolute = path.resolve(root, destination);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`))
    throw new ProjectOperationsError("unsafe_destination", destination);
  let cursor = root;
  for (const component of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    if (!fs.existsSync(cursor)) continue;
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new ProjectOperationsError("unsafe_destination", destination);
  }
  return absolute;
}

function provenance(item: FollowUp): string {
  return item.provenance
    .map(
      (entry) =>
        `${entry.producer} run=${entry.runId}${entry.branch === undefined ? "" : ` branch=${entry.branch}`}`,
    )
    .join("; ");
}

function render(item: FollowUp): string {
  const evidence = item.evidence
    .map(
      (entry) =>
        `  - ${entry.path ?? "project"}${entry.line === undefined ? "" : `:${entry.line}`}: ${entry.summary}${entry.sha256 === undefined ? "" : ` [sha256:${entry.sha256}]`}`,
    )
    .join("\n");
  return `- ${item.title}\n  - provenance: ${provenance(item)}\n${evidence}\n`;
}

export function routeDocumentationFollowUp(
  targetDir: string,
  value: unknown,
  config: ProjectOperationsConfig = {},
): DocumentationProposal {
  const followUp = validateFollowUp(value, {
    ...(config.evidenceLimit !== undefined && { evidenceLimit: config.evidenceLimit }),
  });
  if (followUp.kind === "backlog")
    throw new ProjectOperationsError(
      "unsafe_destination",
      "backlog candidates require BacklogStore",
    );
  let relative: string;
  if (followUp.kind === "contract") {
    const configured = config.documentation?.contracts ?? "docs/contracts";
    relative =
      followUp.contract === undefined
        ? path.join(configured, "candidates.md")
        : path.join(configured, `${followUp.contract}.md`);
  } else if (followUp.kind === "note") {
    const existing = path.join(targetDir, "docs", "NOTES.md");
    const configured = config.documentation?.notes;
    relative = fs.existsSync(existing)
      ? path.relative(targetDir, existing)
      : configured === undefined
        ? path.join("docs", "notes", "candidates.md")
        : path.extname(configured) === ".md"
          ? configured
          : path.join(configured, "candidates.md");
  } else {
    relative = followUp.document;
  }
  const destination = assertSafeDestination(targetDir, relative);
  if (followUp.kind === "design-doc-drift") {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(destination);
    } catch {
      throw new ProjectOperationsError("unsafe_destination", relative);
    }
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new ProjectOperationsError("unsafe_destination", relative);
  }
  if (followUp.kind === "design-doc-drift") {
    if (!fs.existsSync(destination) || !fs.lstatSync(destination).isFile())
      throw new ProjectOperationsError("unsafe_destination", relative);
  }
  return { kind: followUp.kind, destination, content: render(followUp), followUp };
}

export class DocumentationRouter {
  constructor(
    private readonly targetDir: string,
    private readonly config: ProjectOperationsConfig = {},
  ) {}

  route(value: unknown): DocumentationProposal {
    return routeDocumentationFollowUp(this.targetDir, value, this.config);
  }
}
