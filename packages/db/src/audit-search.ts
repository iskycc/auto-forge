export function auditSearchPattern(query: string): string {
  return `%${query
    .trim()
    .slice(0, 128)
    .replace(/[\\%_]/gu, "\\$&")}%`;
}
