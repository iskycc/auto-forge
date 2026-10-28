import { beforeEach, expect, it, vi } from "vitest";
import { DomainError } from "@autoforge/domain";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  origin: vi.fn(),
  dispatch: vi.fn(),
  audit: vi.fn(),
  invalidate: vi.fn(),
  groups: vi.fn(),
}));
vi.mock("./auth", () => ({
  authenticateRequest: async () => ({ user: { id: "operator" } }),
  requestId: () => "recycle-request",
  requireSameOrigin: mocks.origin,
}));
vi.mock("./ddt-api", () => ({ authorizeDdtScope: mocks.authorize, ddtScopeQuery: vi.fn() }));
vi.mock("./work-runtime", () => ({
  workDispatcher: () => ({ purgeDdtRecyclePage: mocks.dispatch }),
}));
import { DELETE, GET } from "../app/api/v1/ddt/[...path]/route";
const scope = { projectId: "p", projectVersionId: "v", testStageId: "s" };
const cutoff = "2026-10-28T00:00:00.000Z";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.origin.mockImplementation(() => undefined);
  mocks.authorize.mockResolvedValue({
    scope,
    services: {
      identityAccess: { recordAuthorizedOperation: mocks.audit },
      readModels: { invalidate: mocks.invalidate },
      ddtCases: { deletedGroups: mocks.groups },
    },
    labels: { version: "v", stage: "s" },
  });
  mocks.groups.mockResolvedValue({
    items: [{ srNum: "Wallet", count: 210 }],
    totalCases: 210,
    totalGroups: 1,
  });
  mocks.dispatch.mockResolvedValue({ deletedCount: 200, hasMore: true, deletedBefore: cutoff });
});
function request(body: unknown = {}) {
  return new Request(`http://localhost/api/v1/ddt/recycle?${new URLSearchParams(scope)}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const context = { params: Promise.resolve({ path: ["recycle"] }) };
it("authorizes the complete hierarchy and delegates a bounded clear page away from Web", async () => {
  const input = request({ deletedBefore: cutoff });
  const response = await DELETE(input, context);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    deletedCount: 200,
    hasMore: true,
    deletedBefore: cutoff,
  });
  expect(mocks.authorize).toHaveBeenCalledWith(expect.anything(), "case.manage", expect.any(URL));
  expect(mocks.origin).toHaveBeenCalledWith(input);
  expect(mocks.dispatch).toHaveBeenCalledWith(
    { scope, input: { deletedBefore: cutoff } },
    input.signal,
  );
  expect(mocks.audit).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      action: "ddt_case.recycle_clear",
      details: expect.objectContaining({
        deletedCount: 200,
        deletedBefore: cutoff,
        projectVersionId: "v",
        testStageId: "s",
      }),
    }),
  );
});
it.each([{ deletedBefore: "bad" }, { projectId: "other" }, { limit: 100000 }])(
  "rejects malformed or overridable clear input %j before dispatch",
  async (body) => {
    expect((await DELETE(request(body), context)).status).toBe(400);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  },
);
it("preserves a worker rejection and request ID without falling back to a Web write", async () => {
  mocks.dispatch.mockRejectedValue(new DomainError("PLATFORM_BUSY", "清空服务繁忙"));
  const response = await DELETE(request(), context);
  expect(response.status).toBe(503);
  expect((await response.json()).error).toMatchObject({
    code: "PLATFORM_BUSY",
    message: "清空服务繁忙",
    requestId: "recycle-request",
  });
  expect(mocks.audit).not.toHaveBeenCalled();
});
it("requires management permission even when the caller can read the recycle bin", async () => {
  mocks.authorize.mockRejectedValue(new DomainError("AUTH_FORBIDDEN", "没有管理权限"));
  expect((await DELETE(request(), context)).status).toBe(403);
  expect(mocks.dispatch).not.toHaveBeenCalled();
});
it("rejects a foreign-origin request before authorization and dispatch", async () => {
  mocks.origin.mockImplementation(() => {
    throw new DomainError("CSRF_REJECTED", "来源无效");
  });
  expect((await DELETE(request(), context)).status).toBe(403);
  expect(mocks.authorize).not.toHaveBeenCalled();
  expect(mocks.dispatch).not.toHaveBeenCalled();
});

it("returns scoped SR folder counts without full case payloads or writes", async () => {
  const response = await GET(
    new Request(`http://localhost/api/v1/ddt/recycle/groups?${new URLSearchParams(scope)}`),
    { params: Promise.resolve({ path: ["recycle", "groups"] }) },
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(await response.json()).toEqual({
    items: [{ srNum: "Wallet", count: 210 }],
    totalCases: 210,
    totalGroups: 1,
  });
  expect(mocks.authorize).toHaveBeenCalledWith(expect.anything(), "case.read", expect.any(URL));
  expect(mocks.groups).toHaveBeenCalledWith({ ...scope, limit: 30 });
  expect(mocks.dispatch).not.toHaveBeenCalled();
});
