import { followUpSemanticId, validateFollowUp } from "./follow-ups";
import type { FollowUp, FollowUpValidationOptions } from "./types";

/**
 * Consolidates small, adjacent follow-ups into one entry so a run's own
 * scattered-but-related follow-ups surface as a single operator decision
 * instead of a pile of near-duplicates.
 *
 * ADJACENCY is computed only from fields that are actually stored on a
 * `FollowUp`:
 * - `kind` (always);
 * - the kind destination: `contract` for contract follow-ups, `document` for
 *   design-doc-drift follow-ups, `priority` for backlog follow-ups. A note
 *   follow-up stores no destination field (`NoteFollowUp` in types.ts), so all
 *   notes share the empty destination and are grouped by kind plus evidence
 *   paths alone;
 * - `evidence[].path` (the optional path string). Two members are adjacent when
 *   an evidence path in one equals an evidence path in the other, or when their
 *   directory prefixes (everything before the final `/`) are equal. Evidence
 *   entries without a `path` never create adjacency.
 *
 * Groups are the connected components of that pairwise adjacency relation.
 * A group is merged only when it has 2..5 members and every member carries at
 * most 2 distinct evidence paths. A group that fails either test is left
 * exactly as it was -- no partial merges, no merging of a subset. The merged
 * item keeps the group's kind and destination, unions evidence and provenance
 * with the same JSON-stringify dedupe-and-sort discipline `aggregateFollowUps`
 * uses, and is re-run through `validateFollowUp` with the caller's validation
 * options; if that rejects it (for example a forbidden title, or a merged
 * evidence set exceeding a configured `evidenceLimit`), the group is left
 * unconsolidated.
 */
export function consolidateFollowUps(
  items: readonly FollowUp[],
  options: FollowUpValidationOptions = {},
): FollowUp[] {
  if (items.length < 2) return [...items];

  const sorted = items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const byKey = followUpSemanticId(a.item).localeCompare(followUpSemanticId(b.item));
      return byKey !== 0 ? byKey : a.index - b.index;
    });

  const parent = Array.from({ length: sorted.length }, (_, index) => index);
  const find = (index: number): number => {
    while (parent[index] !== index) {
      const grandparent = parent[index];
      if (grandparent === undefined) return index;
      parent[index] = parent[grandparent] ?? grandparent;
      index = grandparent;
    }
    return index;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[leftRoot] = rightRoot;
  };

  const pathKeys = sorted.map(({ item }) => evidencePathKeys(item));
  for (let left = 0; left < sorted.length; left += 1) {
    const leftEntry = sorted[left];
    const leftKeys = pathKeys[left];
    if (leftEntry === undefined || leftKeys === undefined) continue;
    for (let right = left + 1; right < sorted.length; right += 1) {
      const rightEntry = sorted[right];
      const rightKeys = pathKeys[right];
      if (rightEntry === undefined || rightKeys === undefined) continue;
      if (sameDestination(leftEntry.item, rightEntry.item) && intersects(leftKeys, rightKeys)) {
        union(left, right);
      }
    }
  }

  const groups = new Map<number, number[]>();
  const groupOrder: number[] = [];
  for (let index = 0; index < sorted.length; index += 1) {
    const root = find(index);
    const group = groups.get(root);
    if (group === undefined) {
      groups.set(root, [index]);
      groupOrder.push(root);
    } else {
      group.push(index);
    }
  }

  const result: FollowUp[] = [];
  for (const root of groupOrder) {
    const group = groups.get(root);
    if (group === undefined) continue;
    const members: FollowUp[] = [];
    for (const index of group) {
      const entry = sorted[index];
      if (entry !== undefined) members.push(entry.item);
    }
    if (canMerge(members)) {
      const merged = mergeGroup(members, options);
      if (merged !== undefined) {
        result.push(merged);
        continue;
      }
    }
    result.push(...members);
  }
  return result;
}

function destination(item: FollowUp): string {
  switch (item.kind) {
    case "contract":
      return item.contract ?? "";
    case "design-doc-drift":
      return item.document;
    case "backlog":
      return item.priority ?? "";
    case "note":
      return "";
  }
}

function sameDestination(left: FollowUp, right: FollowUp): boolean {
  if (left.kind !== right.kind) return false;
  return destination(left) === destination(right);
}

function evidencePaths(item: FollowUp): string[] {
  return item.evidence
    .map((entry) => entry.path)
    .filter((path): path is string => path !== undefined);
}

function evidencePathKeys(item: FollowUp): Set<string> {
  const keys = new Set<string>();
  for (const path of evidencePaths(item)) {
    keys.add(`path:${path}`);
    keys.add(`dir:${directoryPrefix(path)}`);
  }
  return keys;
}

function directoryPrefix(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator === -1 ? "" : path.slice(0, separator);
}

function intersects(left: Set<string>, right: Set<string>): boolean {
  for (const value of left) {
    if (right.has(value)) return true;
  }
  return false;
}

function distinctPathCount(item: FollowUp): number {
  return new Set(evidencePaths(item)).size;
}

function canMerge(members: readonly FollowUp[]): boolean {
  if (members.length < 2 || members.length > 5) return false;
  return members.every((member) => distinctPathCount(member) <= 2);
}

function mergeGroup(
  members: readonly FollowUp[],
  options: FollowUpValidationOptions,
): FollowUp | undefined {
  const first = members[0];
  if (first === undefined) return undefined;
  const evidence = union(members.map((member) => member.evidence));
  const provenance = union(members.map((member) => member.provenance));
  const titles = members.map((member) => `"${member.title.trim()}"`).join(", ");
  const title = `Consolidated ${members.length} ${first.kind} follow-ups: ${titles}`;
  try {
    // Re-validate the joined item against the same options the save path will
    // use: if the title, the merged arrays, or a configured `evidenceLimit` is
    // violated, the caller leaves the group unconsolidated.
    return validateFollowUp({ ...first, title, evidence, provenance }, options);
  } catch {
    return undefined;
  }
}

function union<T>(groups: readonly (readonly T[])[]): T[] {
  return groups
    .flat()
    .filter(
      (entry, index, all) =>
        all.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(entry)) === index,
    )
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}
