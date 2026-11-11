import type { Runner } from "@autoforge/domain";

const nameOrder = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

/** Inventory order must not follow the timing of Runner heartbeats. */
export function orderRunnersByName<T extends Pick<Runner, "id" | "name">>(
  runners: readonly T[],
): T[] {
  return [...runners].sort(
    (left, right) =>
      nameOrder.compare(left.name, right.name) || left.id.localeCompare(right.id, "en"),
  );
}
