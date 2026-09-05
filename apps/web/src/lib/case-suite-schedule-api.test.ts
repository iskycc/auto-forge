import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "@autoforge/domain";
import type { CaseSuiteSchedule } from "@autoforge/contracts";

vi.mock("server-only", () => ({}));
const { authenticateRequest, projectScope, getSummary, readSuiteSchedule } = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  projectScope: vi.fn(),
  getSummary: vi.fn(),
  readSuiteSchedule: vi.fn(),
}));
vi.mock("@/lib/services", () => ({
  getPlatformServices: async () => ({
    identityAccess: { projectScope },
    caseSuites: { getSummary },
    platformOperations: { readSuiteSchedule },
  }),
}));
vi.mock("@/lib/auth", () => ({
  authenticateRequest,
  requestId: () => "request-1",
  requireSameOrigin: vi.fn(),
}));
vi.mock("@/lib/api-response", () => import("./api-response"));

import { GET } from "../app/api/v1/case-suites/[suiteId]/schedule/route";

const context = { params: Promise.resolve({ suiteId: "suite-1" }) };
const suite = { id: "suite-1", projectId: "project-1" };
const reader = { user: { id: "reader" } };
const request = () => new Request("http://localhost/api/v1/case-suites/suite-1/schedule");

beforeEach(() => {
  vi.resetAllMocks();
  authenticateRequest.mockResolvedValue(reader);
  projectScope.mockReturnValue(["project-1"]);
  getSummary.mockResolvedValue(suite);
  readSuiteSchedule.mockResolvedValue(null);
});

describe("task schedule query API", () => {
  it("returns an explicit empty plan using a scoped summary without loading suite members", async () => {
    const response = await GET(request(), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toBeNull();
    expect(projectScope).toHaveBeenCalledWith(reader, "case_suite.read");
    expect(getSummary).toHaveBeenCalledWith("suite-1", ["project-1"]);
    expect(readSuiteSchedule).toHaveBeenCalledWith(reader, suite);
  });

  it("returns last and next trigger details for the requested suite", async () => {
    const schedule: CaseSuiteSchedule = {
      id: "schedule-1",
      suiteId: suite.id,
      projectId: suite.projectId,
      cronExpression: "0 9 * * *",
      timeZone: "Asia/Shanghai",
      missedRunPolicy: "skip",
      enabled: true,
      nextTriggerAt: "2026-09-06T01:00:00.000Z",
      lastTriggerAt: "2026-09-05T01:00:00.000Z",
      lastTriggerStatus: "created",
      lastBatchId: "batch-1",
      revision: 2,
      createdAt: "2026-09-04T00:00:00.000Z",
      updatedAt: "2026-09-05T01:00:00.000Z",
    };
    readSuiteSchedule.mockResolvedValue(schedule);
    expect(await (await GET(request(), context)).json()).toEqual(schedule);
  });

  it("rejects missing permission before querying a suite or its plan", async () => {
    projectScope.mockImplementation(() => {
      throw new DomainError("AUTH_FORBIDDEN", "无权访问任务。");
    });
    expect((await GET(request(), context)).status).toBe(403);
    expect(getSummary).not.toHaveBeenCalled();
    expect(readSuiteSchedule).not.toHaveBeenCalled();
  });

  it("does not read the plan of a suite outside the authorized project scope", async () => {
    getSummary.mockRejectedValue(new DomainError("CASE_SUITE_NOT_FOUND", "任务不存在。"));
    expect((await GET(request(), context)).status).toBe(404);
    expect(readSuiteSchedule).not.toHaveBeenCalled();
  });
});
