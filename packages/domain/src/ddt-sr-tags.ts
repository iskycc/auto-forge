/** SR identifiers and tag names share the existing version-scoped, case-insensitive identity rule. */
export function normalizeDdtSrTagKey(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}
