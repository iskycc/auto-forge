import { describe, expect, it, vi } from "vitest";
import { inheritDdtCases } from "../src/inherit-ddt-cases";
import { inheritDdtCasesInputSchema } from "@autoforge/contracts";

const target = { projectId: "project", projectVersionId: "new", testStageId: "new-stage" };
const input = { sourceProjectVersionId: "old", sourceTestStageId: "old-stage" };
const clock = { now: () => new Date("2026-09-22T00:00:00Z") };

describe("DDT version inheritance", () => {
  it("rejects the current version before any read or write", async () => {
    const inheritCasesPage = vi.fn();
    await expect(
      inheritDdtCases(
        { inheritCasesPage },
        clock,
        { next: () => "id" },
        target,
        { ...input, sourceProjectVersionId: "new" },
        "source",
      ),
    ).rejects.toMatchObject({ code: "DDT_INHERITANCE_SELF_REFERENCE" });
    expect(inheritCasesPage).not.toHaveBeenCalled();
  });

  it("copies only one bounded window and preserves the recovery cursor", async () => {
    let sequence = 0;
    const result = { inheritedCount: 2, skippedCount: 1, nextCursor: "case-3" };
    const inheritCasesPage = vi.fn().mockResolvedValue(result);
    await expect(
      inheritDdtCases(
        { inheritCasesPage },
        clock,
        { next: () => `new-${++sequence}` },
        target,
        { ...input, cursor: "case-0" },
        "版本一 / 测试",
        "actor",
      ),
    ).resolves.toEqual(result);
    expect(inheritCasesPage).toHaveBeenCalledExactlyOnceWith({
      source: { projectId: "project", projectVersionId: "old", testStageId: "old-stage" },
      target,
      targetIds: Array.from({ length: 64 }, (_, index) => `new-${index + 1}`),
      cursor: "case-0",
      sourceName: "版本一 / 测试",
      actorId: "actor",
      inheritedAt: clock.now().toISOString(),
    });
  });

  it("rejects empty source IDs and oversized cursors at the boundary", () => {
    expect(inheritDdtCasesInputSchema.safeParse({ ...input, sourceTestStageId: "" }).success).toBe(
      false,
    );
    expect(
      inheritDdtCasesInputSchema.safeParse({ ...input, cursor: "x".repeat(1025) }).success,
    ).toBe(false);
  });
});
