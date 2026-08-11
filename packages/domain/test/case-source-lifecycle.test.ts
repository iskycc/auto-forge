import { describe, expect, it } from "vitest";

import {
  CASE_SOURCE_COMPARISON_ENTRY_LIMIT,
  compareCaseSourceSnapshots,
  type CaseSourceSnapshotEntry,
} from "../src/case-source-lifecycle";

function entry(className: string, signature = "sig"): CaseSourceSnapshotEntry {
  return { className, signature };
}

describe("compareCaseSourceSnapshots", () => {
  it("classifies added, changed and removed entries by className and signature", () => {
    const diff = compareCaseSourceSnapshots({
      current: [entry("com.example.Kept", "v1"), entry("com.example.Removed", "v1")],
      candidate: [entry("com.example.Kept", "v2"), entry("com.example.Added", "v1")],
    });

    expect(diff.added.map((item) => item.className)).toEqual(["com.example.Added"]);
    expect(diff.changed.map((item) => item.className)).toEqual(["com.example.Kept"]);
    expect(diff.removed.map((item) => item.className)).toEqual(["com.example.Removed"]);
    expect(diff.conflicts).toEqual([]);
    expect(diff.truncated).toBe(false);
  });

  it("keeps identical entries out of the diff", () => {
    const diff = compareCaseSourceSnapshots({
      current: [entry("com.example.Same", "v1")],
      candidate: [entry("com.example.Same", "v1")],
    });

    expect(diff).toMatchObject({ added: [], changed: [], removed: [], conflicts: [] });
  });

  it("routes duplicate classNames on either side to conflicts instead of pairing them", () => {
    const diff = compareCaseSourceSnapshots({
      current: [entry("com.example.Dup", "v1"), entry("com.example.Dup", "v1")],
      candidate: [entry("com.example.Dup", "v2"), entry("com.example.Solo", "v1")],
    });

    expect(diff.conflicts.map((item) => item.className)).toEqual([
      "com.example.Dup",
      "com.example.Dup",
    ]);
    expect(diff.added.map((item) => item.className)).toEqual(["com.example.Solo"]);
    expect(diff.changed).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  it("sorts each list by className", () => {
    const diff = compareCaseSourceSnapshots({
      current: [],
      candidate: [entry("com.example.B"), entry("com.example.A")],
    });

    expect(diff.added.map((item) => item.className)).toEqual(["com.example.A", "com.example.B"]);
  });

  it("truncates each list at the entry limit and flags the result", () => {
    const candidate = Array.from({ length: 5 }, (_, index) => entry(`com.example.Added${index}`));
    const diff = compareCaseSourceSnapshots({ current: [], candidate, entryLimit: 3 });

    expect(diff.truncated).toBe(true);
    expect(diff.added).toHaveLength(3);
    expect(diff.added.map((item) => item.className)).toEqual([
      "com.example.Added0",
      "com.example.Added1",
      "com.example.Added2",
    ]);
  });

  it("does not flag truncation at or below the limit", () => {
    const candidate = Array.from({ length: 3 }, (_, index) => entry(`com.example.Added${index}`));
    const diff = compareCaseSourceSnapshots({ current: [], candidate, entryLimit: 3 });

    expect(diff.truncated).toBe(false);
    expect(diff.added).toHaveLength(3);
  });

  it("exposes a bounded default entry limit", () => {
    expect(CASE_SOURCE_COMPARISON_ENTRY_LIMIT).toBeGreaterThan(0);
    expect(Number.isInteger(CASE_SOURCE_COMPARISON_ENTRY_LIMIT)).toBe(true);
  });
});
