import { beforeEach, expect, it, vi } from "vitest";
import { DomainError } from "@autoforge/domain";
vi.mock("server-only", () => ({}));
const calls = vi.hoisted(() => ({
  authorize: vi.fn(),
  permission: vi.fn(),
  origin: vi.fn(),
  dispatch: vi.fn(),
}));
const scope = { projectId: "project", projectVersionId: "version", testStageId: "stage" };
const cutoff = "2026-10-31T00:00:00.000Z";
vi.mock("./auth", () => ({
  authenticateRequest: async () => ({ user: { id: "actor" }, sessionId: "session" }),
  authorizedProjectScope: calls.permission,
  requireSameOrigin: calls.origin,
  requestId: () => "clear-request",
}));
vi.mock("./ddt-api", () => ({ authorizeDdtScope: calls.authorize, ddtScopeQuery: vi.fn() }));
vi.mock("./work-runtime", () => ({ workDispatcher: () => ({ clearDdtScope: calls.dispatch }) }));
import { DELETE, GET } from "../app/api/v1/ddt/[...path]/route";
const context = { params: Promise.resolve({ path: ["clear"] }) };
const result = {
  phase: "cases",
  removedMembers: 0,
  deletedHistory: 0,
  deletedCases: 100,
  deletedRecycled: 0,
  hasMore: true,
};
beforeEach(() => {
  vi.resetAllMocks();
  calls.authorize.mockResolvedValue({ scope, services: {}, labels: {} });
  calls.dispatch.mockResolvedValue(result);
});
function request(body: unknown = { clearedBefore: cutoff, confirmation: "清空DDT用例" }) {
  return new Request(`http://localhost/api/v1/ddt/clear?${new URLSearchParams(scope)}`, {
    method: "DELETE",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}
it("requires case and task management and dispatches only trusted scoped actor context", async () => {
  const input = request();
  const response = await DELETE(input, context);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(result);
  expect(calls.authorize).toHaveBeenCalledWith(expect.anything(), "case.manage", expect.any(URL));
  expect(calls.permission).toHaveBeenCalledWith(expect.anything(), "case_suite.manage", "project");
  expect(calls.dispatch).toHaveBeenCalledWith(
    {
      operation: "clear",
      scope,
      input: { clearedBefore: cutoff, confirmation: "清空DDT用例" },
      actor: { userId: "actor", principalId: "actor" },
      requestId: "clear-request",
    },
    input.signal,
  );
});
it.each([
  { clearedBefore: cutoff, confirmation: "delete" },
  { clearedBefore: "bad", confirmation: "清空DDT用例" },
  { clearedBefore: cutoff, confirmation: "清空DDT用例", actorId: "other" },
])("rejects malformed or injected clear input %j", async (body) => {
  expect((await DELETE(request(body), context)).status).toBe(400);
  expect(calls.dispatch).not.toHaveBeenCalled();
});
it("rejects missing task permission and foreign origins before mutation", async () => {
  calls.permission.mockImplementation(() => {
    throw new DomainError("AUTH_FORBIDDEN", "无任务管理权限");
  });
  expect((await DELETE(request(), context)).status).toBe(403);
  expect(calls.dispatch).not.toHaveBeenCalled();
  calls.origin.mockImplementation(() => {
    throw new DomainError("CSRF_REJECTED", "来源无效");
  });
  expect((await DELETE(request(), context)).status).toBe(403);
});
it("keeps worker contention visible without attempting an inline write", async () => {
  calls.dispatch.mockRejectedValue(new DomainError("PLATFORM_BUSY", "清理服务繁忙"));
  const response = await DELETE(request(), context);
  expect(response.status).toBe(503);
  expect((await response.json()).error).toMatchObject({
    code: "PLATFORM_BUSY",
    requestId: "clear-request",
  });
});
it("returns an authoritative preview without caching or deleting data", async () => {
  const preview = {
    clearedBefore: cutoff,
    activeCases: 8100,
    recycledCases: 2,
    suiteMembers: 16,
    affectedSuites: 3,
  };
  calls.dispatch.mockResolvedValue(preview);
  const response = await GET(
    new Request(`http://localhost/api/v1/ddt/clear?${new URLSearchParams(scope)}`),
    context,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(await response.json()).toEqual(preview);
  expect(calls.permission).toHaveBeenCalledWith(expect.anything(), "case.manage", "project");
  expect(calls.permission).toHaveBeenCalledWith(expect.anything(), "case_suite.manage", "project");
  expect(calls.dispatch).toHaveBeenCalledWith(
    { operation: "preview", scope },
    expect.any(AbortSignal),
  );
});
