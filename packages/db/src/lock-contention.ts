export function isSqliteLockContentionError(error: unknown): boolean {
  return hasErrorCode(error, (code) => /^(?:SQLITE_BUSY|SQLITE_LOCKED)(?:_|$)/u.test(code));
}

export function isDatabaseLockContentionError(error: unknown): boolean {
  return (
    isSqliteLockContentionError(error) ||
    hasErrorCode(error, (code) => ["55P03", "40P01", "40001"].includes(code))
  );
}

function hasErrorCode(error: unknown, matches: (code: string) => boolean): boolean {
  const pending: unknown[] = [error];
  const visited = new Set<object>();
  while (pending.length > 0 && visited.size < 16) {
    const candidate = pending.shift();
    if (!candidate || typeof candidate !== "object" || visited.has(candidate)) continue;
    visited.add(candidate);
    const code = "code" in candidate ? candidate.code : undefined;
    if (typeof code === "string" && matches(code)) {
      return true;
    }
    if ("cause" in candidate) pending.push(candidate.cause);
    if (candidate instanceof AggregateError) pending.push(...candidate.errors);
  }
  return false;
}
