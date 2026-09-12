import { ProjectOperationsError } from "./errors";
import type {
  BacklogFollowUp,
  FollowUp,
  FollowUpEvidence,
  FollowUpProvenance,
  FollowUpValidationOptions,
} from "./types";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const FORBIDDEN =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|gh[opusr]_[A-Za-z0-9_]{20,}|(?:api[_-]?key|token|password|secret)\s*[:=]\s*\S+|<!--\s*(?:BEGIN|END)|^\s*#\s*(?:CONTRACT|LDO)\b)/im;
const KINDS = new Set(["contract", "note", "design-doc-drift", "backlog"]);

function fail(detail: string): never {
  throw new ProjectOperationsError("invalid_follow_up", detail);
}

function plain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exact(object: Record<string, unknown>, allowed: readonly string[], name: string): void {
  if (Object.keys(object).some((key) => !allowed.includes(key)))
    fail(`${name} has an unknown field`);
}

function safeText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${name} must be non-empty`);
  if (value.includes("\0") || /[\r\n]/.test(value) || FORBIDDEN.test(value))
    fail(`${name} contains forbidden content`);
  return value.trim();
}

function safeIdentifier(value: unknown, name: string): string {
  const text = safeText(value, name);
  if (!IDENTIFIER.test(text) || text.includes("..") || text.startsWith("/"))
    fail(`${name} is unsafe`);
  return text;
}

function validateProvenance(value: unknown): FollowUpProvenance {
  if (!plain(value)) fail("provenance must be an object");
  exact(value, ["producer", "runId", "branch"], "provenance");
  const producer = safeIdentifier(value.producer, "producer");
  const runId = safeIdentifier(value.runId, "runId");
  return {
    producer,
    runId,
    ...(value.branch !== undefined && { branch: safeIdentifier(value.branch, "branch") }),
  };
}

function validateEvidence(value: unknown): FollowUpEvidence {
  if (!plain(value)) fail("evidence must be an object");
  exact(value, ["summary", "path", "line", "sha256"], "evidence");
  const summary = safeText(value.summary, "evidence.summary");
  const result: FollowUpEvidence = { summary };
  if (value.path !== undefined) result.path = safeIdentifier(value.path, "evidence.path");
  if (value.line !== undefined) {
    if (!Number.isSafeInteger(value.line) || (value.line as number) <= 0)
      fail("evidence.line is invalid");
    result.line = value.line as number;
  }
  if (value.sha256 !== undefined) {
    if (typeof value.sha256 !== "string" || !SHA256.test(value.sha256))
      fail("evidence.sha256 is invalid");
    result.sha256 = value.sha256;
  }
  return result;
}

function limit(value: number | undefined, name: string): number {
  const resolved = value ?? 0;
  if (!Number.isSafeInteger(resolved) || resolved < 0)
    throw new ProjectOperationsError("invalid_config", name);
  return resolved;
}

export function validateFollowUp(
  value: unknown,
  options: FollowUpValidationOptions = {},
): FollowUp {
  if (!plain(value)) fail("follow-up must be an object");
  if (typeof value.kind !== "string" || !KINDS.has(value.kind)) fail("kind is unsupported");
  const allowed = ["kind", "title", "evidence", "provenance"];
  if (value.kind === "contract") allowed.push("contract");
  if (value.kind === "design-doc-drift") allowed.push("document");
  if (value.kind === "backlog") allowed.push("priority");
  exact(value, allowed, "follow-up");
  const title = safeText(value.title, "title");
  if (!Array.isArray(value.evidence) || value.evidence.length === 0)
    fail("evidence must be non-empty");
  if (!Array.isArray(value.provenance) || value.provenance.length === 0)
    fail("provenance must be non-empty");
  const evidence = value.evidence.map(validateEvidence);
  const evidenceLimit = limit(options.evidenceLimit, "evidenceLimit");
  if (evidenceLimit > 0 && Buffer.byteLength(JSON.stringify(evidence)) > evidenceLimit)
    throw new ProjectOperationsError("resource_limit", "evidenceLimit");
  const provenance = value.provenance.map(validateProvenance);
  if (value.kind === "contract")
    return {
      kind: value.kind,
      title,
      evidence,
      provenance,
      ...(value.contract !== undefined && { contract: safeIdentifier(value.contract, "contract") }),
    };
  if (value.kind === "note") return { kind: value.kind, title, evidence, provenance };
  if (value.kind === "design-doc-drift")
    return {
      kind: value.kind,
      title,
      evidence,
      provenance,
      document: safeIdentifier(value.document, "document"),
    };
  if (value.priority !== undefined && !["low", "medium", "high"].includes(value.priority as string))
    fail("priority is invalid");
  return {
    kind: "backlog",
    title,
    evidence,
    provenance,
    ...(value.priority !== undefined && { priority: value.priority as "low" | "medium" | "high" }),
  };
}

/**
 * Persistence deliberately keeps only structural evidence metadata. Candidate
 * prose originates in model/project input and cannot be proven free of novel
 * credential or private-data formats by pattern matching.
 */
export function projectBacklogFollowUp(candidate: BacklogFollowUp): BacklogFollowUp {
  return {
    ...candidate,
    title: "Redacted backlog candidate",
    evidence: candidate.evidence.map((evidence) => ({
      summary: "Evidence metadata",
      ...(evidence.path !== undefined && { path: evidence.path }),
      ...(evidence.line !== undefined && { line: evidence.line }),
      ...(evidence.sha256 !== undefined && { sha256: evidence.sha256 }),
    })),
  };
}

function semanticKey(item: FollowUp): string {
  const destination =
    item.kind === "contract"
      ? (item.contract ?? "")
      : item.kind === "design-doc-drift"
        ? item.document
        : item.kind === "backlog"
          ? (item.priority ?? "")
          : "";
  return JSON.stringify([item.kind, item.title.trim().toLowerCase(), destination]);
}

export function aggregateFollowUps(
  values: readonly unknown[],
  options: FollowUpValidationOptions = {},
): FollowUp[] {
  const aggregationLimit = limit(options.aggregationLimit, "aggregationLimit");
  const map = new Map<string, FollowUp>();
  for (const value of values) {
    const item = validateFollowUp(value, options);
    const key = semanticKey(item);
    const current = map.get(key);
    if (current === undefined) map.set(key, item);
    else {
      current.evidence = [...current.evidence, ...item.evidence].filter(
        (entry, index, all) =>
          all.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(entry)) ===
          index,
      );
      current.provenance = [...current.provenance, ...item.provenance].filter(
        (entry, index, all) =>
          all.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(entry)) ===
          index,
      );
    }
  }
  const result = [...map.values()]
    .map((item) => ({
      ...item,
      evidence: [...item.evidence].sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b)),
      ),
      provenance: [...item.provenance].sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b)),
      ),
    }))
    .sort((a, b) => semanticKey(a).localeCompare(semanticKey(b)));
  if (aggregationLimit > 0 && result.length > aggregationLimit)
    throw new ProjectOperationsError("resource_limit", "aggregationLimit");
  return result;
}
