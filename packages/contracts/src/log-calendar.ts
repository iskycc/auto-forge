const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/** The log date is stable across retries, even if upload resumes after midnight. */
export function beijingLogDay(recordedAt: string): string {
  const timestamp = Date.parse(recordedAt);
  if (!Number.isFinite(timestamp)) throw new Error("Invalid log timestamp.");
  return new Date(timestamp + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

export function dailyLogDatabaseName(prefix: string, namespace: string, day: string): string {
  if (
    !/^[a-z][a-z0-9_]{0,31}$/.test(prefix) ||
    !/^[a-f0-9]{8}$/.test(namespace) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    beijingLogDay(`${day}T00:00:00+08:00`) !== day
  )
    throw new Error("Invalid daily log database identity.");
  return `${prefix}_${namespace}_${day.replaceAll("-", "")}`;
}
