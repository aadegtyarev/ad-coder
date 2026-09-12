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
  authorizedRoot: string;
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
        `  - ${entry.path ?? "project"}${entry.line === undefined ? "" : `:${entry.line}`}${entry.sha256 === undefined ? "" : ` [sha256:${entry.sha256}]`}`,
    )
    .join("\n");
  return `- Recorded ${item.kind} follow-up\n  - provenance: ${provenance(item)}\n${evidence}\n`;
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
    relative =
      configured !== undefined
        ? path.extname(configured) === ".md"
          ? configured
          : path.join(configured, "candidates.md")
        : fs.existsSync(existing)
          ? path.relative(targetDir, existing)
          : path.join("docs", "notes", "candidates.md");
  } else {
    relative = followUp.document;
  }
  const destination = assertSafeDestination(targetDir, relative);
  let authorizedRoot: string;
  if (followUp.kind === "contract") {
    authorizedRoot = assertSafeDestination(
      targetDir,
      config.documentation?.contracts ?? "docs/contracts",
    );
  } else {
    const configuredRoot = assertSafeDestination(targetDir, config.documentation?.root ?? "docs");
    const documentationRoot = fs.existsSync(configuredRoot)
      ? fs.realpathSync(configuredRoot)
      : configuredRoot;
    if (
      path.extname(destination) !== ".md" ||
      !destination.startsWith(`${documentationRoot}${path.sep}`) ||
      destination.startsWith(`${path.join(documentationRoot, "contracts")}${path.sep}`)
    )
      throw new ProjectOperationsError("unsafe_destination", relative);
    authorizedRoot = documentationRoot;
  }
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
  return {
    kind: followUp.kind,
    destination,
    content: render(followUp),
    followUp,
    authorizedRoot,
  };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function acquireDocumentationLock(lock: string, effectId: string): () => void {
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number;
    try {
      fd = fs.openSync(
        lock,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_NOFOLLOW,
        0o600,
      );
      fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid })}\n`);
      fs.fsyncSync(fd);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let holder: unknown;
      try {
        const stat = fs.lstatSync(lock);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
          throw new ProjectOperationsError("unsafe_destination", effectId);
        holder = (JSON.parse(fs.readFileSync(lock, "utf8")) as { pid?: unknown }).pid;
      } catch (readError) {
        if (readError instanceof ProjectOperationsError) throw readError;
        throw new ProjectOperationsError("checkpoint_conflict", effectId);
      }
      if (typeof holder !== "number" || !Number.isSafeInteger(holder) || holder <= 0)
        throw new ProjectOperationsError("checkpoint_conflict", effectId);
      if (processIsAlive(holder)) throw new ProjectOperationsError("checkpoint_conflict", effectId);
      fs.unlinkSync(lock);
      continue;
    }
    return () => {
      fs.closeSync(fd);
      try {
        fs.unlinkSync(lock);
      } catch {
        throw new ProjectOperationsError("checkpoint_conflict", effectId);
      }
    };
  }
  throw new ProjectOperationsError("checkpoint_conflict", effectId);
}

/** Append a generated block once, reading and writing one no-follow descriptor under a lock. */
export function appendDocumentationProposal(
  proposal: DocumentationProposal,
  effectId: string,
): boolean {
  const marker = `<!-- ad-coder:${effectId} -->`;
  fs.mkdirSync(path.dirname(proposal.destination), { recursive: true });
  const lock = `${proposal.destination}.ad-coder-lock`;
  const release = acquireDocumentationLock(lock, effectId);
  let fd: number | undefined;
  try {
    try {
      fd = fs.openSync(
        proposal.destination,
        fs.constants.O_RDWR |
          fs.constants.O_APPEND |
          fs.constants.O_CREAT |
          fs.constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if (["ELOOP", "EISDIR"].includes((error as NodeJS.ErrnoException).code ?? ""))
        throw new ProjectOperationsError("unsafe_destination", effectId);
      throw error;
    }
    const stat = fs.fstatSync(fd);
    const opened = fs.realpathSync(`/proc/self/fd/${fd}`);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (opened !== proposal.authorizedRoot &&
        !opened.startsWith(`${proposal.authorizedRoot}${path.sep}`))
    )
      throw new ProjectOperationsError("unsafe_destination", effectId);
    const current = fs.readFileSync(fd, "utf8");
    if (current.includes(marker)) return false;
    fs.writeSync(
      fd,
      `${current.endsWith("\n") || current === "" ? "" : "\n"}${marker}\n${proposal.content}`,
    );
    fs.fsyncSync(fd);
    return true;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    release();
  }
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
