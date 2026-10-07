import { DomainError } from "./errors";

const CASE_SUITE_NAME_MAX_LENGTH = 120;

export type FailureCaseSuiteName = { sourceName: string; date: string };

export function failureCaseSuiteNameDate(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  return ["year", "month", "day"]
    .map((type) => parts.find((part) => part.type === type)!.value)
    .join("");
}

export function formatFailureCaseSuiteName(
  { sourceName, date }: FailureCaseSuiteName,
  sequence = 0,
): string {
  const suffix = ` Rerun-${date}${sequence ? String(sequence).padStart(2, "0") : ""}`;
  // Keep the complete date/sequence and avoid splitting a UTF-16 surrogate pair.
  const prefix = sourceName
    .slice(0, CASE_SUITE_NAME_MAX_LENGTH - suffix.length)
    .replace(/[\uD800-\uDBFF]$/, "");
  return `${prefix}${suffix}`;
}

/** Scans bounded name pages without retaining the task directory in memory. */
export class FailureCaseSuiteNameSequence {
  private baseOccupied = false;
  private largestSequence = 0;

  constructor(private readonly source: FailureCaseSuiteName) {}

  observe(names: readonly string[]): void {
    const base = formatFailureCaseSuiteName(this.source);
    const marker = ` Rerun-${this.source.date}`;
    for (const name of names) {
      if (name === base) {
        this.baseOccupied = true;
        continue;
      }
      const markerIndex = name.lastIndexOf(marker);
      if (markerIndex < 0) continue;
      const suffix = name.slice(markerIndex + marker.length);
      if (!/^\d{2,}$/.test(suffix)) continue;
      const sequence = Number(suffix);
      if (!Number.isSafeInteger(sequence) || sequence < 1) continue;
      if (name === formatFailureCaseSuiteName(this.source, sequence)) {
        this.largestSequence = Math.max(this.largestSequence, sequence);
      }
    }
  }

  availableName(): string {
    if (!this.baseOccupied) return formatFailureCaseSuiteName(this.source);
    const nextSequence = this.largestSequence + 1;
    if (!Number.isSafeInteger(nextSequence)) {
      throw new DomainError(
        "CASE_SUITE_NAME_EXHAUSTED",
        "当日任务名称序号已用尽，请填写自定义名称。",
      );
    }
    return formatFailureCaseSuiteName(this.source, nextSequence);
  }
}
