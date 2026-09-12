import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectStore } from "../project-store/project-store";
import type { ProjectOperationsConfig, VersionedState } from "../project-store/types";
import { ProjectStoreError } from "../project-store/types";
import { ProjectOperationsError } from "./errors";
import { projectBacklogFollowUp, validateFollowUp } from "./follow-ups";
import type { BacklogFollowUp } from "./types";

export const BACKLOG_STATES = [
  "queued",
  "claimed",
  "in_progress",
  "review",
  "blocked",
  "done",
] as const;
export type BacklogState = (typeof BACKLOG_STATES)[number];

export interface BacklogClaim {
  owner: string;
  runId: string;
  branch: string;
  claimedAt: number;
  leaseExpiresAt: number;
}

export interface BacklogItem {
  id: string;
  status: BacklogState;
  candidate: BacklogFollowUp;
  claim?: BacklogClaim;
  createdAt: number;
  updatedAt: number;
}

export interface ClaimInput {
  owner: string;
  runId: string;
  branch: string;
}

export interface BacklogStore {
  create(candidate: unknown, id?: string): VersionedState<BacklogItem>;
  get(id: string): VersionedState<BacklogItem>;
  list(): VersionedState<BacklogItem>[];
  claim(id: string, claim: ClaimInput): VersionedState<BacklogItem>;
  renew(id: string, claim: ClaimInput): VersionedState<BacklogItem>;
  release(id: string, claim: ClaimInput): VersionedState<BacklogItem>;
  transition(id: string, state: BacklogState, claim: ClaimInput): VersionedState<BacklogItem>;
}

const TRANSITIONS: Readonly<Record<BacklogState, readonly BacklogState[]>> = {
  queued: ["claimed"],
  claimed: ["in_progress", "blocked", "queued"],
  in_progress: ["review", "blocked", "queued"],
  review: ["in_progress", "blocked", "done"],
  blocked: ["queued"],
  done: [],
};
const CLAIM_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;

function validateClaim(input: ClaimInput): ClaimInput {
  for (const [name, value] of Object.entries(input)) {
    if (!CLAIM_ID.test(value) || value.includes("..") || value.startsWith("/"))
      throw new ProjectOperationsError("invalid_config", name);
  }
  return { ...input };
}

function sameClaim(left: BacklogClaim | undefined, right: ClaimInput): boolean {
  return left?.owner === right.owner && left.runId === right.runId && left.branch === right.branch;
}

export function requireActiveClaim(
  existing: BacklogClaim | undefined,
  input: ClaimInput,
  now: number,
  id: string,
): BacklogClaim {
  if (existing === undefined || !sameClaim(existing, input))
    throw new ProjectOperationsError("not_claim_holder", id);
  if (existing.leaseExpiresAt > 0 && existing.leaseExpiresAt <= now)
    throw new ProjectOperationsError("claim_conflict", id);
  return existing;
}

function immutableCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class FileBacklogStore implements BacklogStore {
  private readonly leaseMs: number;
  private readonly evidenceLimit: number;
  constructor(
    private readonly store: ProjectStore,
    config: ProjectOperationsConfig = store.projectOperations,
    private readonly now: () => number = Date.now,
  ) {
    this.leaseMs = config.claimLeaseMs ?? 0;
    this.evidenceLimit = config.evidenceLimit ?? 0;
    for (const [name, value] of [
      ["claimLeaseMs", this.leaseMs],
      ["evidenceLimit", this.evidenceLimit],
    ] as const)
      if (!Number.isSafeInteger(value) || value < 0)
        throw new ProjectOperationsError("invalid_config", name);
  }

  private path(id: string): string {
    this.store.validateId(id);
    return path.join(this.store.layout.runs, `backlog-${id}.json`);
  }

  create(value: unknown, id?: string): VersionedState<BacklogItem> {
    const candidate = validateFollowUp(value, { evidenceLimit: this.evidenceLimit });
    if (candidate.kind !== "backlog")
      throw new ProjectOperationsError(
        "invalid_follow_up",
        "BacklogStore accepts backlog candidates only",
      );
    const itemId =
      id ??
      crypto.createHash("sha256").update(JSON.stringify(candidate)).digest("hex").slice(0, 32);
    const time = this.now();
    return this.store.writeVersionedJson(
      this.path(itemId),
      {
        id: itemId,
        status: "queued",
        candidate: immutableCopy(projectBacklogFollowUp(candidate)),
        createdAt: time,
        updatedAt: time,
      },
      0,
    );
  }

  get(id: string): VersionedState<BacklogItem> {
    try {
      return this.store.readVersionedJson<BacklogItem>(this.path(id));
    } catch (error) {
      if (error instanceof ProjectStoreError && error.code === "not_found")
        throw new ProjectOperationsError("not_found", id);
      throw error;
    }
  }

  list(): VersionedState<BacklogItem>[] {
    return fs
      .readdirSync(this.store.layout.runs)
      .filter((name) => /^backlog-[A-Za-z0-9_-]{1,64}\.json$/.test(name))
      .sort()
      .map((name) =>
        this.store.readVersionedJson<BacklogItem>(path.join(this.store.layout.runs, name)),
      );
  }

  private write(
    current: VersionedState<BacklogItem>,
    item: BacklogItem,
  ): VersionedState<BacklogItem> {
    try {
      return this.store.writeVersionedJson(this.path(item.id), item, current.version);
    } catch (error) {
      if (error instanceof ProjectStoreError && error.code === "version_conflict")
        throw new ProjectOperationsError("claim_conflict", item.id);
      throw error;
    }
  }

  claim(id: string, input: ClaimInput): VersionedState<BacklogItem> {
    const claim = validateClaim(input);
    const current = this.get(id);
    const time = this.now();
    const expired =
      current.value.claim !== undefined &&
      current.value.claim.leaseExpiresAt > 0 &&
      current.value.claim.leaseExpiresAt <= time;
    if (current.value.status !== "queued" && !expired)
      throw new ProjectOperationsError("claim_conflict", id);
    return this.write(current, {
      ...current.value,
      status: "claimed",
      claim: {
        ...claim,
        claimedAt: time,
        leaseExpiresAt: this.leaseMs === 0 ? 0 : time + this.leaseMs,
      },
      updatedAt: time,
    });
  }

  renew(id: string, input: ClaimInput): VersionedState<BacklogItem> {
    const claim = validateClaim(input);
    const current = this.get(id);
    const time = this.now();
    const active = requireActiveClaim(current.value.claim, claim, time, id);
    return this.write(current, {
      ...current.value,
      claim: {
        ...active,
        leaseExpiresAt: this.leaseMs === 0 ? 0 : time + this.leaseMs,
      } as BacklogClaim,
      updatedAt: time,
    });
  }

  release(id: string, input: ClaimInput): VersionedState<BacklogItem> {
    return this.transition(id, "queued", input);
  }

  transition(id: string, state: BacklogState, input: ClaimInput): VersionedState<BacklogItem> {
    if (!BACKLOG_STATES.includes(state))
      throw new ProjectOperationsError("invalid_transition", state);
    const claim = validateClaim(input);
    const current = this.get(id);
    const time = this.now();
    requireActiveClaim(current.value.claim, claim, time, id);
    if (!TRANSITIONS[current.value.status].includes(state))
      throw new ProjectOperationsError("invalid_transition", `${current.value.status}:${state}`);
    const keepClaim = state !== "queued" && state !== "done";
    const next: BacklogItem = { ...current.value, status: state, updatedAt: time };
    if (keepClaim) return this.write(current, next);
    const { claim: _claim, ...withoutClaim } = next;
    return this.write(current, withoutClaim);
  }
}
