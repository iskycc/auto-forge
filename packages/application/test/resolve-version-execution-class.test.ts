import { describe, expect, it, vi } from "vitest";
import { resolveVersionExecutionClass } from "../src/resolve-version-execution-class";

const version = { projectId: "project", projectVersionId: "version" };
const className = "com.example.CheckoutTest";

describe("version class path resolution", () => {
  it("uses exact scoped lookups and finds a unique class in a later stage", async () => {
    const findCaseDefinitionIdsByClassName = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(["class"]);
    expect(
      await resolveVersionExecutionClass(
        { findCaseDefinitionIdsByClassName },
        version,
        ["empty", "stage"],
        className,
      ),
    ).toEqual({ caseDefinitionId: "class", testStageId: "stage" });
    expect(findCaseDefinitionIdsByClassName.mock.calls).toEqual([
      [{ ...version, testStageId: "empty" }, className],
      [{ ...version, testStageId: "stage" }, className],
    ]);
  });

  it("rejects cross-stage duplicates and stops at the second match", async () => {
    const findCaseDefinitionIdsByClassName = vi.fn().mockResolvedValue(["class"]);
    await expect(
      resolveVersionExecutionClass(
        { findCaseDefinitionIdsByClassName },
        version,
        ["first", "second", "third"],
        className,
      ),
    ).rejects.toMatchObject({
      code: "CASE_CLASS_SCOPE_CONFLICT",
      message: expect.stringContaining("/stages/{stageId}/"),
    });
    expect(findCaseDefinitionIdsByClassName).toHaveBeenCalledTimes(2);
  });

  it("resolves only the URL-selected stage when the class exists elsewhere", async () => {
    const findCaseDefinitionIdsByClassName = vi.fn().mockResolvedValue(["selected-class"]);
    expect(
      await resolveVersionExecutionClass(
        { findCaseDefinitionIdsByClassName },
        version,
        ["selected-stage"],
        className,
      ),
    ).toEqual({ caseDefinitionId: "selected-class", testStageId: "selected-stage" });
    expect(findCaseDefinitionIdsByClassName).toHaveBeenCalledExactlyOnceWith(
      { ...version, testStageId: "selected-stage" },
      className,
    );
  });

  it("rejects duplicate definitions inside one stage without choosing the first", async () => {
    const findCaseDefinitionIdsByClassName = vi.fn().mockResolvedValue(["first", "second"]);
    await expect(
      resolveVersionExecutionClass(
        { findCaseDefinitionIdsByClassName },
        version,
        ["stage"],
        className,
      ),
    ).rejects.toMatchObject({
      code: "CASE_CLASS_SCOPE_CONFLICT",
      message: expect.stringContaining("caseDefinitionId"),
    });
  });

  it("rejects an absent class without attempting a name or substring fallback", async () => {
    const findCaseDefinitionIdsByClassName = vi.fn().mockResolvedValue([]);
    await expect(
      resolveVersionExecutionClass(
        { findCaseDefinitionIdsByClassName },
        version,
        ["stage"],
        className,
      ),
    ).rejects.toMatchObject({ code: "CASE_DEFINITION_NOT_FOUND" });
    expect(findCaseDefinitionIdsByClassName).toHaveBeenCalledExactlyOnceWith(
      { ...version, testStageId: "stage" },
      className,
    );
  });
});
