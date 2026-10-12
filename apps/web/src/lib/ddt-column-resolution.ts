import type { DdtImportColumnConflict, DdtImportColumnResolution } from "@autoforge/contracts";

export type LocatedColumnConflict = DdtImportColumnConflict & {
  uploadIndex: number;
  uploadName: string;
};

type ColumnIdentity = Pick<
  DdtImportColumnResolution,
  "uploadIndex" | "archiveEntryName" | "sheetName" | "columnIndex"
>;

export function columnResolutionIdentity(
  conflict: LocatedColumnConflict,
  columnIndex: number,
): ColumnIdentity {
  return {
    uploadIndex: conflict.uploadIndex,
    ...(conflict.archiveEntryName ? { archiveEntryName: conflict.archiveEntryName } : {}),
    sheetName: conflict.sheetName,
    columnIndex,
  };
}

export function columnResolutionKey(resolution: ColumnIdentity): string {
  return [
    resolution.uploadIndex,
    resolution.archiveEntryName ?? "",
    resolution.sheetName,
    resolution.columnIndex,
  ].join("\u0000");
}

export function requiredConflictColumnName(normalizedName: string): string | undefined {
  if (normalizedName === "caseid") return "CaseID";
  if (normalizedName === "srnum") return "srNum";
  return undefined;
}

export function planBlankConflictColumnDeletion(
  resolutions: readonly DdtImportColumnResolution[],
  conflicts: readonly LocatedColumnConflict[],
): { resolutions: DdtImportColumnResolution[]; deletedColumnCount: number } {
  const byColumn = new Map(
    resolutions.map((resolution) => [columnResolutionKey(resolution), resolution]),
  );
  let deletedColumnCount = 0;
  for (const conflict of conflicts) {
    const retained = conflict.columns.filter(
      (column) =>
        !byColumn.get(columnResolutionKey(columnResolutionIdentity(conflict, column.columnIndex)))
          ?.deleteColumn,
    );
    const hasContent = retained.some((column) => column.nonEmptyCount > 0);
    // Retain one column even when the entire duplicate group is blank.
    const preservedBlankIndex = hasContent ? undefined : retained[0]?.columnIndex;
    const toDelete = retained.filter(
      (column) => column.nonEmptyCount === 0 && column.columnIndex !== preservedBlankIndex,
    );
    if (toDelete.length === 0) continue;
    const deletedIndexes = new Set(toDelete.map((column) => column.columnIndex));
    for (const column of toDelete) {
      const identity = columnResolutionIdentity(conflict, column.columnIndex);
      const key = columnResolutionKey(identity);
      byColumn.set(key, {
        ...identity,
        resolvedName: byColumn.get(key)?.resolvedName ?? column.suggestedName,
        deleteColumn: true,
      });
    }
    deletedColumnCount += toDelete.length;
    const remaining = retained.filter((column) => !deletedIndexes.has(column.columnIndex));
    const requiredName = requiredConflictColumnName(conflict.normalizedName);
    const hasRequiredName = remaining.some((column) => {
      const key = columnResolutionKey(columnResolutionIdentity(conflict, column.columnIndex));
      return (byColumn.get(key)?.resolvedName ?? column.suggestedName).trim() === requiredName;
    });
    const survivor = remaining[0]!;
    const survivorIdentity = columnResolutionIdentity(conflict, survivor.columnIndex);
    const survivorKey = columnResolutionKey(survivorIdentity);
    const resolvedName = byColumn.get(survivorKey)?.resolvedName ?? survivor.suggestedName;
    // Move the required identity name off a deleted column. Drop only an automatically
    // suggested suffix when one ordinary column remains; retain manually edited names.
    const retainedName = requiredName
      ? hasRequiredName
        ? resolvedName
        : requiredName
      : remaining.length === 1 && resolvedName === survivor.suggestedName
        ? survivor.currentName
        : resolvedName;
    byColumn.set(survivorKey, { ...survivorIdentity, resolvedName: retainedName });
  }
  return { resolutions: [...byColumn.values()], deletedColumnCount };
}
