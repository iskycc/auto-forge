import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "@autoforge/domain";
const calls = vi.hoisted(() => ({
  authorize: vi.fn(),
  check: vi.fn(),
  sameOrigin: vi.fn(),
  allow: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  authorizeRequest: calls.authorize,
  requireSameOrigin: calls.sameOrigin,
  clientAddress: () => "local",
  requestId: () => "settings-check",
}));
vi.mock("@/lib/services", () => ({
  getPlatformServices: async () => ({
    infrastructureCheck: calls.check,
    runnerRequestLimiter: { allow: calls.allow },
    identityAccess: { recordAuthorizedOperation: calls.audit },
  }),
}));
import { POST } from "../app/api/v1/settings/platform/check/route";
const request = () =>
  new Request("http://localhost/api/v1/settings/platform/check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      component: "redis",
      connection: { host: "127.0.0.1", password: "secret" },
    }),
  });
beforeEach(() => {
  vi.clearAllMocks();
  calls.sameOrigin.mockImplementation(() => {});
  calls.authorize.mockResolvedValue({ user: { id: "admin" } });
  calls.allow.mockResolvedValue(true);
  calls.check.mockResolvedValue({ ok: true, message: "连接成功", durationMs: 1 });
});
describe("settings infrastructure checks", () => {
  it("checks unsaved fields only after settings.manage authorization", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(calls.authorize).toHaveBeenCalledWith(expect.any(Request), "settings.manage", undefined);
    expect(calls.authorize).toHaveBeenCalledBefore(calls.check);
    expect(JSON.stringify(await response.json())).not.toContain("secret");
    expect(JSON.stringify(calls.audit.mock.calls)).not.toContain("secret");
  });
  it("rejects a viewer before any probe", async () => {
    calls.authorize.mockRejectedValue(new DomainError("AUTH_FORBIDDEN", "只读"));
    expect((await POST(request())).status).toBe(403);
    expect(calls.check).not.toHaveBeenCalled();
  });
  it("rejects cross-origin requests before authentication", async () => {
    calls.sameOrigin.mockImplementation(() => {
      throw new DomainError("CSRF_REJECTED", "来源错误");
    });
    expect((await POST(request())).status).toBe(403);
    expect(calls.authorize).not.toHaveBeenCalled();
    expect(calls.check).not.toHaveBeenCalled();
  });
});
