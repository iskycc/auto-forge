// 用例来源（JAR）之间的目录对比与删除清理的领域模型与纯函数。

export type CaseSourceSnapshotEntry = {
  className: string;
  caseDefinitionId?: string;
  // 用例内容的规范化签名（由应用层对版本快照做哈希），签名不同即内容变化。
  signature: string;
};

export type CaseSourceComparisonDiff = {
  added: CaseSourceSnapshotEntry[];
  changed: CaseSourceSnapshotEntry[];
  removed: CaseSourceSnapshotEntry[];
  // 任一侧内部出现重复 className 时无法一一对应，整组计入冲突。
  conflicts: CaseSourceSnapshotEntry[];
  // 任一名单达到上限被截断时为 true，完整数量不可知。
  truncated: boolean;
};

export const CASE_SOURCE_COMPARISON_ENTRY_LIMIT = 5_000;

// 按 className 对齐两侧用例目录；每类名单独立截断，避免无界结果。
export function compareCaseSourceSnapshots(input: {
  current: readonly CaseSourceSnapshotEntry[];
  candidate: readonly CaseSourceSnapshotEntry[];
  entryLimit?: number;
}): CaseSourceComparisonDiff {
  const limit = input.entryLimit ?? CASE_SOURCE_COMPARISON_ENTRY_LIMIT;
  const currentByClass = groupByClassName(input.current);
  const candidateByClass = groupByClassName(input.candidate);
  const added: CaseSourceSnapshotEntry[] = [];
  const changed: CaseSourceSnapshotEntry[] = [];
  const removed: CaseSourceSnapshotEntry[] = [];
  const conflicts: CaseSourceSnapshotEntry[] = [];

  for (const group of currentByClass.values()) {
    if (group.length > 1) conflicts.push(...group);
  }
  for (const group of candidateByClass.values()) {
    if (group.length > 1) conflicts.push(...group);
  }
  for (const [className, candidateGroup] of candidateByClass) {
    const currentGroup = currentByClass.get(className);
    if (candidateGroup.length > 1 || (currentGroup?.length ?? 0) > 1) continue;
    const candidate = candidateGroup[0];
    if (!candidate) continue;
    const current = currentGroup?.[0];
    if (!current) {
      added.push(candidate);
    } else if (current.signature !== candidate.signature) {
      changed.push(candidate);
    }
  }
  for (const [className, currentGroup] of currentByClass) {
    if (currentGroup.length > 1) continue;
    const current = currentGroup[0];
    if (current && !candidateByClass.has(className)) removed.push(current);
  }

  sortEntries(added);
  sortEntries(changed);
  sortEntries(removed);
  sortEntries(conflicts);
  const truncated =
    added.length > limit ||
    changed.length > limit ||
    removed.length > limit ||
    conflicts.length > limit;
  return {
    added: added.slice(0, limit),
    changed: changed.slice(0, limit),
    removed: removed.slice(0, limit),
    conflicts: conflicts.slice(0, limit),
    truncated,
  };
}

function groupByClassName(
  entries: readonly CaseSourceSnapshotEntry[],
): Map<string, CaseSourceSnapshotEntry[]> {
  const groups = new Map<string, CaseSourceSnapshotEntry[]>();
  for (const entry of entries) {
    const group = groups.get(entry.className);
    if (group) group.push(entry);
    else groups.set(entry.className, [entry]);
  }
  return groups;
}

function sortEntries(entries: CaseSourceSnapshotEntry[]): void {
  entries.sort((left, right) => left.className.localeCompare(right.className));
}

export type CaseSourceComparison = {
  id: string;
  projectId: string;
  currentSourceId?: string;
  candidateSourceId: string;
  added: CaseSourceSnapshotEntry[];
  changed: CaseSourceSnapshotEntry[];
  removed: CaseSourceSnapshotEntry[];
  conflicts: CaseSourceSnapshotEntry[];
  truncated: boolean;
  createdBy?: string;
  createdAt: string;
};

export type CleanupJob = {
  id: string;
  category: string;
  resourceType: string;
  resourceId: string;
  objectKey?: string;
  status: "pending" | "leased" | "succeeded" | "failed" | "dead_letter";
  attemptCount: number;
  availableAt: string;
  errorSummary?: string;
  createdAt: string;
  updatedAt: string;
};
