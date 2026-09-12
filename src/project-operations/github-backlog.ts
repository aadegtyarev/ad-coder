import * as crypto from "node:crypto";
import * as path from "node:path";
import type { ProjectStore } from "../project-store/project-store";
import type { ProjectOperationsConfig, VersionedState } from "../project-store/types";
import { ProjectStoreError } from "../project-store/types";
import type { BacklogClaim, BacklogItem, BacklogState, BacklogStore, ClaimInput } from "./backlog";
import { FileBacklogStore, requireActiveClaim } from "./backlog";
import { ProjectOperationsError } from "./errors";
import { projectBacklogFollowUp, validateFollowUp } from "./follow-ups";
import type { BacklogFollowUp } from "./types";

export interface GitHubCommandRequest {
  argv: string[];
  stdin?: string;
}
export interface GitHubCommandResult {
  exitCode: number;
  stdout: string;
  stderr?: string;
}
export interface GitHubCommandExecutor {
  execute(request: GitHubCommandRequest): GitHubCommandResult;
}
/**
 * A coordination domain shared by every worker that may mutate one GitHub backlog.
 * Implementations must provide cross-process/host exclusion; no local fallback is used.
 */
export interface GitHubClaimCoordinator {
  runExclusive<T>(repository: string, itemId: string, action: () => T): T;
}
export interface GitHubCapability {
  available: boolean;
  repository: string;
  labels: string[];
  openIssueCount: number;
  reason?: "authentication" | "repository" | "transport";
}

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SAFE_LABEL = /^[A-Za-z0-9:_.-]{1,100}$/;
const CLAIM_PART = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;
const DEFAULT_LABELS: Record<BacklogState, string> = {
  queued: "ad-coder:queued",
  claimed: "ad-coder:claimed",
  in_progress: "ad-coder:in-progress",
  review: "ad-coder:review",
  blocked: "ad-coder:blocked",
  done: "ad-coder:done",
};

function validateGitHubClaim(input: ClaimInput): void {
  if (
    Object.values(input).some(
      (value) => !CLAIM_PART.test(value) || value.includes("..") || value.startsWith("/"),
    )
  )
    throw new ProjectOperationsError("invalid_config", "claim");
}

function runJson<T>(executor: GitHubCommandExecutor, request: GitHubCommandRequest): T {
  const result = executor.execute(request);
  if (result.exitCode !== 0)
    throw new ProjectOperationsError("github_unavailable", "command failed");
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new ProjectOperationsError("github_unavailable", "invalid response");
  }
}

export function probeGitHubBacklogCapability(
  executor: GitHubCommandExecutor,
  repository: string,
): GitHubCapability {
  if (!REPOSITORY.test(repository))
    throw new ProjectOperationsError("invalid_config", "github.repository");
  const calls = [
    ["gh", "auth", "status"],
    ["gh", "repo", "view", repository, "--json", "nameWithOwner"],
    ["gh", "label", "list", "--repo", repository, "--json", "name"],
    [
      "gh",
      "issue",
      "list",
      "--repo",
      repository,
      "--state",
      "open",
      "--json",
      "number",
      "--limit",
      "100",
    ],
  ];
  const results: GitHubCommandResult[] = [];
  for (const argv of calls) {
    const result = executor.execute({ argv });
    results.push(result);
    if (result.exitCode !== 0)
      return {
        available: false,
        repository,
        labels: [],
        openIssueCount: 0,
        reason:
          results.length === 1
            ? "authentication"
            : results.length === 2
              ? "repository"
              : "transport",
      };
  }
  try {
    const labels = JSON.parse(results[2]?.stdout ?? "[]") as { name: string }[];
    const issues = JSON.parse(results[3]?.stdout ?? "[]") as unknown[];
    return {
      available: true,
      repository,
      labels: labels.map((entry) => entry.name).sort(),
      openIssueCount: issues.length,
    };
  } catch {
    return { available: false, repository, labels: [], openIssueCount: 0, reason: "transport" };
  }
}

interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  labels: Array<{ name: string }>;
}

interface IssueBody {
  schema: 1;
  revision: number;
  candidate: BacklogFollowUp;
  claim?: BacklogClaim;
  createdAt: number;
  updatedAt: number;
}

export class GitHubBacklogStore implements BacklogStore {
  private readonly repository: string;
  private readonly labels: Record<BacklogState, string>;
  private readonly leaseMs: number;
  private readonly managedLabel: string;

  constructor(
    private readonly store: ProjectStore,
    private readonly executor: GitHubCommandExecutor,
    config: ProjectOperationsConfig,
    private readonly now: () => number = Date.now,
    private readonly coordinator?: GitHubClaimCoordinator,
  ) {
    const repository = config.github?.repository;
    if (repository === undefined || !REPOSITORY.test(repository))
      throw new ProjectOperationsError("invalid_config", "github.repository");
    this.repository = repository;
    this.labels = { ...DEFAULT_LABELS, ...config.github?.stateLabels };
    this.managedLabel = config.github?.managedLabel ?? "ad-coder:managed";
    this.leaseMs = config.claimLeaseMs ?? 0;
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs < 0)
      throw new ProjectOperationsError("invalid_config", "claimLeaseMs");
    if (
      ![this.managedLabel, ...Object.values(this.labels)].every(
        (label) => typeof label === "string" && SAFE_LABEL.test(label),
      )
    )
      throw new ProjectOperationsError("invalid_config", "github.labels");
  }

  private state(issue: GitHubIssue): VersionedState<BacklogItem> {
    let body: IssueBody;
    try {
      body = JSON.parse(issue.body) as IssueBody;
    } catch {
      throw new ProjectOperationsError("github_unavailable", "invalid managed issue");
    }
    const status = (Object.keys(this.labels) as BacklogState[]).find((key) =>
      issue.labels.some((label) => label.name === this.labels[key]),
    );
    if (body.schema !== 1 || status === undefined)
      throw new ProjectOperationsError("github_unavailable", "invalid managed issue");
    const validatedCandidate = validateFollowUp(body.candidate);
    if (validatedCandidate.kind !== "backlog")
      throw new ProjectOperationsError("github_unavailable", "invalid managed issue");
    return {
      version: body.revision,
      value: {
        id: String(issue.number),
        status,
        candidate: projectBacklogFollowUp(validatedCandidate),
        ...(body.claim !== undefined && { claim: body.claim }),
        createdAt: body.createdAt,
        updatedAt: body.updatedAt,
      },
    };
  }

  private read(id: string): GitHubIssue {
    if (!/^[1-9]\d*$/.test(id)) throw new ProjectOperationsError("not_found", id);
    return runJson<GitHubIssue>(this.executor, {
      argv: ["gh", "api", `repos/${this.repository}/issues/${id}`],
    });
  }

  create(value: unknown): VersionedState<BacklogItem> {
    const validated = validateFollowUp(value);
    if (validated.kind !== "backlog")
      throw new ProjectOperationsError(
        "invalid_follow_up",
        "BacklogStore accepts backlog candidates only",
      );
    const time = this.now();
    const candidate = projectBacklogFollowUp(validated);
    const body: IssueBody = { schema: 1, revision: 1, candidate, createdAt: time, updatedAt: time };
    const title = `ad-coder backlog ${crypto.createHash("sha256").update(JSON.stringify(candidate)).digest("hex").slice(0, 12)}`;
    const issue = runJson<GitHubIssue>(this.executor, {
      argv: ["gh", "api", "--method", "POST", `repos/${this.repository}/issues`, "--input", "-"],
      stdin: JSON.stringify({
        title,
        body: JSON.stringify(body),
        labels: [this.labels.queued, this.managedLabel],
      }),
    });
    return this.state(issue);
  }

  get(id: string): VersionedState<BacklogItem> {
    return this.state(this.read(id));
  }

  list(): VersionedState<BacklogItem>[] {
    const issues = runJson<GitHubIssue[]>(this.executor, {
      argv: [
        "gh",
        "api",
        `repos/${this.repository}/issues?state=all&labels=${encodeURIComponent(this.managedLabel)}`,
      ],
    });
    return issues
      .map((issue) => this.state(issue))
      .sort((a, b) => Number(a.value.id) - Number(b.value.id));
  }

  private coordinationPath(id: string): string {
    return path.join(this.store.layout.cache, `github-claim-${id}.json`);
  }

  private acquireMutation(id: string): () => void {
    const destination = this.coordinationPath(id);
    let current: VersionedState<{ pending: boolean; startedAt: number }> = {
      version: 0,
      value: { pending: false, startedAt: 0 },
    };
    try {
      current = this.store.readVersionedJson(destination);
    } catch (error) {
      if (!(error instanceof ProjectStoreError) || error.code !== "not_found") throw error;
    }
    const now = this.now();
    const expired =
      current.value.pending && this.leaseMs > 0 && current.value.startedAt + this.leaseMs <= now;
    if (current.value.pending && !expired) throw new ProjectOperationsError("claim_conflict", id);
    let acquired: VersionedState<{ pending: boolean; startedAt: number }>;
    try {
      acquired = this.store.writeVersionedJson(
        destination,
        { pending: true, startedAt: now },
        current.version,
      );
    } catch (error) {
      if (error instanceof ProjectStoreError && error.code === "version_conflict")
        throw new ProjectOperationsError("claim_conflict", id);
      throw error;
    }
    return () => {
      this.store.writeVersionedJson(
        destination,
        { pending: false, startedAt: 0 },
        acquired.version,
      );
    };
  }

  private updateUncoordinated(
    id: string,
    mutate: (current: VersionedState<BacklogItem>) => BacklogItem,
  ): VersionedState<BacklogItem> {
    const release = this.acquireMutation(id);
    try {
      const current = this.get(id);
      const next = mutate(current);
      const payload: IssueBody = {
        schema: 1,
        revision: current.version + 1,
        candidate: next.candidate,
        ...(next.claim !== undefined && { claim: next.claim }),
        createdAt: next.createdAt,
        updatedAt: next.updatedAt,
      };
      const issue = runJson<GitHubIssue>(this.executor, {
        argv: [
          "gh",
          "api",
          "--method",
          "PATCH",
          `repos/${this.repository}/issues/${id}`,
          "--input",
          "-",
        ],
        stdin: JSON.stringify({
          body: JSON.stringify(payload),
          labels: [this.labels[next.status], this.managedLabel],
          ...(next.status === "done" && { state: "closed" }),
        }),
      });
      return this.state(issue);
    } finally {
      release();
    }
  }

  private update(
    id: string,
    mutate: (current: VersionedState<BacklogItem>) => BacklogItem,
  ): VersionedState<BacklogItem> {
    if (this.coordinator === undefined)
      throw new ProjectOperationsError("claim_conflict", "shared GitHub coordination required");
    return this.coordinator.runExclusive(this.repository, id, () =>
      this.updateUncoordinated(id, mutate),
    );
  }

  claim(id: string, input: ClaimInput): VersionedState<BacklogItem> {
    validateGitHubClaim(input);
    return this.update(id, (current) => {
      const time = this.now();
      const expired =
        current.value.claim !== undefined &&
        current.value.claim.leaseExpiresAt > 0 &&
        current.value.claim.leaseExpiresAt <= time;
      if (current.value.status !== "queued" && !expired)
        throw new ProjectOperationsError("claim_conflict", id);
      return {
        ...current.value,
        status: "claimed",
        claim: {
          ...input,
          claimedAt: time,
          leaseExpiresAt: this.leaseMs === 0 ? 0 : time + this.leaseMs,
        },
        updatedAt: time,
      };
    });
  }

  renew(id: string, input: ClaimInput): VersionedState<BacklogItem> {
    validateGitHubClaim(input);
    return this.update(id, (current) => {
      const time = this.now();
      const active = requireActiveClaim(current.value.claim, input, time, id);
      return {
        ...current.value,
        claim: {
          ...active,
          leaseExpiresAt: this.leaseMs === 0 ? 0 : time + this.leaseMs,
        },
        updatedAt: time,
      };
    });
  }

  release(id: string, input: ClaimInput): VersionedState<BacklogItem> {
    return this.transition(id, "queued", input);
  }

  transition(id: string, state: BacklogState, input: ClaimInput): VersionedState<BacklogItem> {
    validateGitHubClaim(input);
    const allowed: Record<BacklogState, readonly BacklogState[]> = {
      queued: ["claimed"],
      claimed: ["in_progress", "blocked", "queued"],
      in_progress: ["review", "blocked", "queued"],
      review: ["in_progress", "blocked", "done"],
      blocked: ["queued"],
      done: [],
    };
    return this.update(id, (current) => {
      const time = this.now();
      requireActiveClaim(current.value.claim, input, time, id);
      if (!allowed[current.value.status].includes(state))
        throw new ProjectOperationsError("invalid_transition", `${current.value.status}:${state}`);
      const base = { ...current.value, status: state, updatedAt: time };
      if (state === "queued" || state === "done") {
        const { claim: _, ...withoutClaim } = base;
        return withoutClaim;
      }
      return base;
    });
  }
}

export interface MigrationSuggestion {
  from: "files";
  to: "github";
  itemCount: number;
}

export interface BacklogMigrationProbe {
  capability: GitHubCapability;
  suggestion?: MigrationSuggestion;
}

export function suggestBacklogMigrationOnce(
  store: ProjectStore,
  fileItemCount: number,
  capability: GitHubCapability,
): MigrationSuggestion | undefined {
  if (fileItemCount <= 0 || !capability.available) return undefined;
  const destination = path.join(store.layout.cache, "backlog-migration-suggestion.json");
  try {
    store.readVersionedJson(destination);
    return undefined;
  } catch (error) {
    if (!(error instanceof ProjectStoreError) || error.code !== "not_found") throw error;
  }
  const suggestion: MigrationSuggestion = { from: "files", to: "github", itemCount: fileItemCount };
  try {
    store.writeVersionedJson(destination, suggestion, 0);
    return suggestion;
  } catch (error) {
    if (error instanceof ProjectStoreError && error.code === "version_conflict") return undefined;
    throw error;
  }
}

export function probeBacklogMigration(
  store: ProjectStore,
  executor: GitHubCommandExecutor,
  config: ProjectOperationsConfig = store.projectOperations,
): BacklogMigrationProbe {
  const repository = config.github?.repository;
  if (repository === undefined)
    throw new ProjectOperationsError("invalid_config", "github.repository");
  const capability = probeGitHubBacklogCapability(executor, repository);
  const suggestion = suggestBacklogMigrationOnce(
    store,
    new FileBacklogStore(store, config).list().length,
    capability,
  );
  return { capability, ...(suggestion !== undefined && { suggestion }) };
}

export function createBacklogStore(
  store: ProjectStore,
  config: ProjectOperationsConfig = store.projectOperations,
  executor?: GitHubCommandExecutor,
): BacklogStore {
  if ((config.backlogBackend ?? "files") === "files") return new FileBacklogStore(store, config);
  if (config.backlogBackend !== "github")
    throw new ProjectOperationsError("invalid_config", "backlogBackend");
  if (executor === undefined) throw new ProjectOperationsError("invalid_config", "github.executor");
  return new GitHubBacklogStore(store, executor, config);
}
