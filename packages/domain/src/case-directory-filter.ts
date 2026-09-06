import type { CaseDefinitionWithMethods } from "./case-definition";

/** The browser and background projection use the same search fields. */
export function matchesCaseDirectorySearch(
  item: CaseDefinitionWithMethods,
  search: string,
): boolean {
  const normalized = search.trim().toLocaleLowerCase("zh-CN");
  if (!normalized) return true;
  return [
    item.directoryPath,
    item.displayName,
    item.className,
    item.packageName,
    ...item.groups,
    ...item.tags,
    ...item.methods.flatMap((method) => [method.methodName, ...method.groups]),
  ].some((value) => value.toLocaleLowerCase("zh-CN").includes(normalized));
}
