import { beforeEach, expect, it, vi } from "vitest";
import { DomainError } from "@autoforge/domain";
const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  origin: vi.fn(),
  read: vi.fn(),
  save: vi.fn(),
  check: vi.fn(),
  audit: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock("./auth", () => ({
  authorizeRequest: mocks.authorize,
  requireSameOrigin: mocks.origin,
  requestId: () => "monitor-request",
}));
vi.mock("./services", () => ({
  getPlatformServices: async () => ({
    storageMonitoring: { read: mocks.read, save: mocks.save, check: mocks.check },
    identityAccess: { recordAuthorizedOperation: mocks.audit },
    logDatabases: { invalidateCapacity: mocks.invalidate },
  }),
}));
import { GET, PUT } from "../app/api/v1/settings/storage-monitoring/route";
import { POST } from "../app/api/v1/settings/storage-monitoring/check/route";
const configuration = { target: { kind: "primary" }, source: null, revision: 2 };
const write = () =>
  new Request("http://localhost/monitoring", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(configuration),
  });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorize.mockResolvedValue({});
  mocks.read.mockResolvedValue(configuration);
  mocks.save.mockResolvedValue(configuration);
  mocks.check.mockResolvedValue({ status: "not_configured", detail: "not configured" });
});
it("requires system read/manage permissions and rejects cross-origin changes", async () => {
  mocks.authorize.mockRejectedValueOnce(new DomainError("AUTH_FORBIDDEN", "无权查看"));
  expect((await GET(new Request("http://localhost/monitoring?kind=primary"))).status).toBe(403);
  expect(mocks.read).not.toHaveBeenCalled();
  mocks.origin.mockImplementationOnce(() => {
    throw new DomainError("AUTH_FORBIDDEN", "无权修改");
  });
  expect((await PUT(write())).status).toBe(403);
  expect(mocks.save).not.toHaveBeenCalled();
});
it("validates target identifiers and returns private uncached configuration", async () => {
  expect(
    (await GET(new Request("http://localhost/monitoring?kind=logs&databaseId=invalid"))).status,
  ).toBe(400);
  expect(mocks.read).not.toHaveBeenCalled();
  const result = await GET(new Request("http://localhost/monitoring?kind=primary"));
  expect(result.status).toBe(200);
  expect(result.headers.get("cache-control")).toBe("private, no-store");
  expect(mocks.authorize).toHaveBeenCalledWith(expect.any(Request), "settings.read", undefined);
});
it("audits only persisted updates and invalidates old capacity snapshots", async () => {
  expect((await PUT(write())).status).toBe(200);
  expect(mocks.invalidate).toHaveBeenCalledOnce();
  expect(mocks.audit).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      action: "storage_monitoring.update",
      resourceId: "primary",
      details: { enabled: false },
    }),
  );
  mocks.save.mockRejectedValueOnce(new DomainError("REVISION_CONFLICT", "请刷新"));
  expect((await PUT(write())).status).toBe(409);
  expect(mocks.audit).toHaveBeenCalledTimes(1);
  expect((await POST(write())).status).toBe(200);
  expect(mocks.authorize).toHaveBeenLastCalledWith(
    expect.any(Request),
    "settings.manage",
    undefined,
  );
});
