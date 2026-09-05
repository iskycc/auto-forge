import { describe, expect, it, vi } from "vitest";
import { defaultCaseSuiteExecutionPolicy, type CaseSuite } from "@autoforge/domain";

import { CaseSuiteActivityService } from "../src/read-case-suite-activity";
import type { RunBatchListPage } from "../src/ports";

const scope = { projectId: "project-a", projectVersionId: "version-a" };
const now = "2026-09-05T12:00:00.000Z";

function fixture(suite: CaseSuite | null = null) {
  const activity = { readStatistics: vi.fn().mockResolvedValue([]) };
  const suites = { getSummary: vi.fn().mockResolvedValue(suite) };
  const batches = {
    listPage: vi.fn<() => Promise<RunBatchListPage>>().mockResolvedValue({ items: [] }),
  };
  return {
    activity,
    suites,
    batches,
    service: new CaseSuiteActivityService(activity, suites, batches, { now: () => new Date(now) }),
  };
}

describe("case suite execution activity", () => {
  it("uses a fixed seven-day window, deduplicates suites, and distinguishes missing averages from zero", async () => {
    const { service, activity } = fixture();
    const summary = await service.readSummary(scope, ["suite-a", "suite-a", "suite-b"]);
    expect(activity.readStatistics).toHaveBeenCalledWith({
      ...scope,
      suiteIds: ["suite-a", "suite-b"],
      windowStartedAt: "2026-08-29T12:00:00.000Z",
      generatedAt: now,
    });
    expect(summary.items).toEqual(
      ["suite-a", "suite-b"].map((suiteId) => ({
        suiteId,
        executionCount: 0,
        completedExecutionCount: 0,
        averagePassRate: null,
        averagePassedCases: null,
      })),
    );
  });

  it("does not query empty selections and rejects oversized selections before database access", async () => {
    const { service, activity } = fixture();
    expect((await service.readSummary(scope, [])).items).toEqual([]);
    await expect(
      service.readSummary(
        scope,
        Array.from({ length: 201 }, (_, index) => `suite-${index}`),
      ),
    ).rejects.toMatchObject({ code: "CASE_SUITE_SELECTION_INVALID" });
    expect(activity.readStatistics).not.toHaveBeenCalled();
  });

  it("rejects a missing or differently scoped suite before loading execution history", async () => {
    const { service, suites, batches } = fixture();
    await expect(service.readRecentExecutions("suite-a", scope)).rejects.toMatchObject({
      code: "CASE_SUITE_NOT_FOUND",
    });
    expect(suites.getSummary).toHaveBeenCalledWith("suite-a", [scope.projectId]);
    suites.getSummary.mockResolvedValue({ policy: { projectVersionId: "version-b" } });
    await expect(service.readRecentExecutions("suite-a", scope)).rejects.toMatchObject({
      code: "CASE_SUITE_NOT_FOUND",
    });
    expect(batches.listPage).not.toHaveBeenCalled();
  });

  it("bounds history at ten records and keeps the selected project version", async () => {
    const { service, batches } = fixture({
      id: "suite-a",
      projectId: scope.projectId,
      name: "Suite",
      caseCount: 0,
      enabled: true,
      status: "active",
      version: 1,
      revision: 1,
      policy: { ...defaultCaseSuiteExecutionPolicy, projectVersionId: scope.projectVersionId },
      createdAt: now,
      updatedAt: now,
    });
    expect(await service.readRecentExecutions("suite-a", scope)).toEqual({ items: [] });
    expect(batches.listPage).toHaveBeenCalledWith({ ...scope, suiteId: "suite-a", limit: 10 });
    batches.listPage.mockResolvedValue({ items: [], nextCursor: "next-page" });
    expect(
      await service.readRecentExecutions("suite-a", { ...scope, cursor: "older-page" }),
    ).toEqual({
      items: [],
      nextCursor: "next-page",
    });
    expect(batches.listPage).toHaveBeenLastCalledWith({
      ...scope,
      suiteId: "suite-a",
      limit: 10,
      cursor: "older-page",
    });
  });
});
