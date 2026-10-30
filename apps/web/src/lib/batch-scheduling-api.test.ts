import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "@autoforge/domain";
vi.mock("server-only", () => ({}));
const fixture = vi.hoisted(() => ({
  authenticate: vi.fn(),
  sameOrigin: vi.fn(),
  scope: vi.fn(),
  summary: vi.fn(),
  change: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  authenticateRequest: fixture.authenticate,
  requireSameOrigin: fixture.sameOrigin,
  requestId: () => "pause-request",
}));
vi.mock("@/lib/services", () => ({
  getPlatformServices: async () => ({
    identityAccess: { projectScope: fixture.scope, recordAuthorizedOperation: fixture.audit },
    runBatches: { getSummary: fixture.summary },
    executionControl: { changeBatchScheduling: fixture.change },
  }),
}));
import { POST } from "../app/api/v1/run-batches/[batchId]/scheduling/route";
const context = { params: Promise.resolve({ batchId: "batch" }) };
const request = (body: unknown) =>
  new Request("http://localhost/api/v1/run-batches/batch/scheduling", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.resetAllMocks();
  fixture.authenticate.mockResolvedValue({ user: { id: "operator" } });
  fixture.scope.mockReturnValue(["project"]);
  fixture.summary.mockResolvedValue({ id: "batch", projectId: "project" });
  fixture.change.mockResolvedValue(true);
});
describe("batch scheduling API", () => {
  it.each(["pause", "resume"])(
    "authorizes and audits %s against the batch project",
    async (action) => {
      expect((await POST(request({ action }), context)).status).toBe(200);
      expect(fixture.scope).toHaveBeenCalledWith(expect.anything(), "run.cancel");
      expect(fixture.summary).toHaveBeenCalledWith("batch", ["project"]);
      expect(fixture.change).toHaveBeenCalledWith("operator", "batch", action);
      expect(fixture.audit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: `run_batch.${action}`,
          projectId: "project",
          requestId: "pause-request",
        }),
      );
    },
  );
  it("rejects invalid control actions before mutation", async () => {
    expect((await POST(request({ action: "restart" }), context)).status).toBe(400);
    expect(fixture.change).not.toHaveBeenCalled();
  });
  it("does not reveal or modify a batch outside the caller's project scope", async () => {
    fixture.summary.mockRejectedValue(new DomainError("RUN_BATCH_NOT_FOUND", "不存在"));
    expect((await POST(request({ action: "pause" }), context)).status).toBe(404);
    expect(fixture.change).not.toHaveBeenCalled();
  });
  it("returns a conflict when completion or termination wins the race", async () => {
    fixture.change.mockRejectedValue(new DomainError("RUN_BATCH_NOT_ACTIVE", "已结束"));
    const response = await POST(request({ action: "resume" }), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "RUN_BATCH_NOT_ACTIVE", requestId: "pause-request" },
    });
  });
  it("requires login and same-origin protection", async () => {
    fixture.authenticate.mockRejectedValue(new DomainError("AUTH_REQUIRED", "请登录"));
    expect((await POST(request({ action: "pause" }), context)).status).toBe(401);
    expect(fixture.change).not.toHaveBeenCalled();
    expect(fixture.sameOrigin).toHaveBeenCalled();
  });
});
