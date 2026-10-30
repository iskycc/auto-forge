import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "@autoforge/domain";
const calls = vi.hoisted(() => ({
  authorize: vi.fn(),
  check: vi.fn(),
  sameOrigin: vi.fn(),
  allow: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  requireSameOrigin: calls.sameOrigin,
  clientAddress: () => "local",
  requestId: () => "setup-check",
}));
vi.mock("@/lib/services", () => ({
  getPlatformServices: async () => ({
    identityAccess: { authorizeBootstrapConfiguration: calls.authorize },
    infrastructureCheck: calls.check,
    runnerRequestLimiter: { allow: calls.allow },
  }),
}));
import { POST } from "../app/api/v1/auth/setup-platform/check/route";
const request = () =>
  new Request("http://localhost/api/v1/auth/setup-platform/check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bootstrapToken: "a".repeat(32),
      target: { component: "redis", connection: { host: "127.0.0.1", password: "secret" } },
    }),
  });
beforeEach(() => {
  vi.clearAllMocks();
  calls.allow.mockResolvedValue(true);
  calls.check.mockResolvedValue({ ok: true, message: "连接成功", durationMs: 1 });
});
describe("initialization connection check authorization", () => {
  it("checks the current unsaved form without returning credentials", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(calls.authorize).toHaveBeenCalledBefore(calls.check);
    expect(calls.check).toHaveBeenCalledWith(
      expect.objectContaining({
        component: "redis",
        connection: expect.objectContaining({ password: "secret" }),
      }),
    );
    expect(JSON.stringify(await response.json())).not.toContain("secret");
  });
  it("rejects an invalid or consumed bootstrap token before probing", async () => {
    calls.authorize.mockRejectedValue(new DomainError("AUTH_FORBIDDEN", "初始化已结束"));
    expect((await POST(request())).status).toBe(403);
    expect(calls.check).not.toHaveBeenCalled();
  });
  it("rejects cross-origin probes before authorization or network access", async () => {
    calls.sameOrigin.mockImplementation(() => {
      throw new DomainError("CSRF_REJECTED", "来源错误");
    });
    expect((await POST(request())).status).toBe(403);
    expect(calls.authorize).not.toHaveBeenCalled();
    expect(calls.check).not.toHaveBeenCalled();
  });
});
