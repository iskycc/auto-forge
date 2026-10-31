import { beforeEach, expect, it, vi } from "vitest";
import { DomainError } from "@autoforge/domain";
const mocks = vi.hoisted(() => ({ authorize: vi.fn(), read: vi.fn() }));
vi.mock("./auth", () => ({ authorizeRequest: mocks.authorize, requestId: () => "usage-request" }));
vi.mock("./services", () => ({
  getPlatformServices: async () => ({ infrastructureUsage: { read: mocks.read } }),
}));
import { GET } from "../app/api/v1/settings/diagnostics/usage/route";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorize.mockResolvedValue({});
  mocks.read.mockResolvedValue({
    dependency: "cache",
    provider: "Redis",
    sampledAt: "2026-10-31T00:00:00Z",
    status: "ready",
    metrics: [],
    notes: [],
  });
});
it("authorizes detailed usage independently from normal dashboard access", async () => {
  mocks.authorize.mockRejectedValueOnce(new DomainError("AUTH_FORBIDDEN", "无权限"));
  expect((await GET(new Request("http://localhost/usage?dependency=cache"))).status).toBe(403);
  expect(mocks.read).not.toHaveBeenCalled();
});
it("validates dependency and uses private uncached responses", async () => {
  expect((await GET(new Request("http://localhost/usage?dependency=secret"))).status).toBe(400);
  expect(mocks.read).not.toHaveBeenCalled();
  const response = await GET(new Request("http://localhost/usage?dependency=cache&refresh=1"));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(mocks.read).toHaveBeenCalledWith("cache", true);
  expect(mocks.authorize).toHaveBeenCalledWith(expect.any(Request), "settings.read", undefined);
});
