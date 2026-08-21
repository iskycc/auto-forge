export type SelectableDirectoryCase = {
  id: string;
  projectId: string;
};

export type SelectableDirectory = {
  directories: readonly SelectableDirectory[];
  cases: readonly SelectableDirectoryCase[];
};

export type DirectorySelectionState = "unchecked" | "mixed" | "checked";

export function collectSelectableDirectoryCaseIds(
  directory: SelectableDirectory,
  canSelectProject: (projectId: string) => boolean,
): string[] {
  const ids = directory.cases
    .filter((item) => canSelectProject(item.projectId))
    .map((item) => item.id);
  for (const child of directory.directories) {
    ids.push(...collectSelectableDirectoryCaseIds(child, canSelectProject));
  }
  return ids;
}

export function selectionState(
  selected: ReadonlySet<string>,
  ids: readonly string[],
): DirectorySelectionState {
  if (ids.length === 0) return "unchecked";
  const selectedCount = ids.reduce((count, id) => count + Number(selected.has(id)), 0);
  if (selectedCount === 0) return "unchecked";
  return selectedCount === ids.length ? "checked" : "mixed";
}

export function toggledSelection(
  current: ReadonlySet<string>,
  ids: readonly string[],
): Set<string> {
  const next = new Set(current);
  const clearSelection = ids.length > 0 && ids.every((id) => next.has(id));
  for (const id of ids) {
    if (clearSelection) next.delete(id);
    else next.add(id);
  }
  return next;
}
