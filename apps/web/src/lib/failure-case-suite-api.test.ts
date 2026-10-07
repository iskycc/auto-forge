import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "@autoforge/domain";

vi.mock("server-only", () => ({}));
const {
  authenticateRequest,
  projectScope,
  authorize,
  getSummary,
  suggestFinalFailureName,
  createFromFinalFailures,
  recordAuthorizedOperation,
} = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  projectScope: vi.fn(),
  authorize: vi.fn(),
  getSummary: vi.fn(),
  suggestFinalFailureName: vi.fn(),
  createFromFinalFailures: vi.fn(),
  recordAuthorizedOperation: vi.fn(),
}));
vi.mock("./auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth")>()),
  authenticateRequest,
}));
vi.mock("./services", () => ({
  getPlatformServices: async () => ({
    runBatches: { getSummary },
    caseSuites: { suggestFinalFailureName, createFromFinalFailures },
    identityAccess: { projectScope, authorize, recordAuthorizedOperation },
  }),
}));
import { GET, POST } from "../app/api/v1/run-batches/[batchId]/failure-case-suite/route";

const context = { params: Promise.resolve({ batchId: "batch" }) };
const endpoint = "http://localhost/api/v1/run-batches/batch/failure-case-suite";
const identity = { user: { id: "creator" } };
const post = (body: unknown = {}) =>
  new Request(endpoint, {
    method: "POST",
    headers: { origin: "http://localhost", "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.resetAllMocks();
  authenticateRequest.mockResolvedValue(identity);
  projectScope.mockReturnValue(["project"]);
  getSummary.mockResolvedValue({ projectId: "project", suiteId: "source" });
  suggestFinalFailureName.mockResolvedValue({ name: "原任务 Rerun-20261007" });
  createFromFinalFailures.mockResolvedValue({
    id: "copy",
    projectId: "project",
    name: "原任务 Rerun-2026100701",
    caseCount: 2,
  });
});

describe("failure task automatic naming API", () => {
  it("authorizes read and management before suggesting a name and disables caching", async () => {
    const response = await GET(new Request(endpoint), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(getSummary).toHaveBeenCalledWith("batch", ["project"]);
    expect(authorize).toHaveBeenCalledWith(identity, "case_suite.manage", "project");
    expect(suggestFinalFailureName).toHaveBeenCalledWith("batch", ["project"]);
  });

  it("reserves automatic names on POST and returns the actual allocated name", async () => {
    const response = await POST(post(), context);
    expect(response.status).toBe(201);
    expect(createFromFinalFailures).toHaveBeenCalledWith("batch", {}, "creator", ["project"]);
    expect((await response.json()).name).toBe("原任务 Rerun-2026100701");
    expect(recordAuthorizedOperation).toHaveBeenCalledTimes(1);
  });

  it("preserves custom names and rejects attempts to control the date or case scope", async () => {
    expect((await POST(post({ name: " 自定义 " }), context)).status).toBe(201);
    expect(createFromFinalFailures).toHaveBeenCalledWith("batch", { name: "自定义" }, "creator", [
      "project",
    ]);
    createFromFinalFailures.mockClear();
    for (const body of [{ date: "20260101" }, { caseIds: ["other"] }, { name: " " }]) {
      expect((await POST(post(body), context)).status).toBe(400);
    }
    expect(createFromFinalFailures).not.toHaveBeenCalled();
  });

  it("rejects anonymous, out-of-scope and read-only requests before name lookup", async () => {
    authenticateRequest.mockRejectedValueOnce(new DomainError("AUTH_REQUIRED", "需要登录。"));
    expect((await GET(new Request(endpoint), context)).status).toBe(401);
    projectScope.mockReturnValue([]);
    getSummary.mockRejectedValueOnce(new DomainError("RUN_BATCH_NOT_FOUND", "批次不存在。"));
    expect((await GET(new Request(endpoint), context)).status).toBe(404);
    expect(getSummary).toHaveBeenLastCalledWith("batch", []);
    authorize.mockImplementationOnce(() => {
      throw new DomainError("AUTH_FORBIDDEN", "无任务管理权限。");
    });
    expect((await GET(new Request(endpoint), context)).status).toBe(403);
    expect(suggestFinalFailureName).not.toHaveBeenCalled();
  });
});
