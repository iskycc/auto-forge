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
