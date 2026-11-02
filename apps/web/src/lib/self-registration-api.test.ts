import { beforeEach, expect, it, vi } from "vitest";
import { DomainError } from "@autoforge/domain";

const mocks = vi.hoisted(() => ({
  origin: vi.fn(),
  allow: vi.fn(),
  register: vi.fn(),
  availability: vi.fn(),
}));
vi.mock("./auth", () => ({
  requireSameOrigin: mocks.origin,
  requestId: () => "register-request",
  clientAddress: () => "fixture-client",
  sessionCookie: (token: string) => ({
    name: "autoforge_session",
    value: token,
    httpOnly: true,
    sameSite: "strict",
    path: "/",
  }),
}));
vi.mock("./services", () => ({
  getPlatformServices: async () => ({
    runnerRequestLimiter: { allow: mocks.allow },
    identityAccess: { register: mocks.register, registrationAvailability: mocks.availability },
    clock: { now: () => new Date("2026-11-02T00:00:00Z") },
  }),
}));
import { GET, POST } from "../app/api/v1/auth/register/route";

const registration = {
  username: "lan-user",
  displayName: "内网用户",
  password: "Registration!Password123",
  confirmPassword: "Registration!Password123",
};
const request = (body: unknown = registration) =>
  new Request("http://localhost/api/v1/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.allow.mockResolvedValue(true);
  mocks.availability.mockResolvedValue({ enabled: false, reason: "ldap_enabled" });
  mocks.register.mockResolvedValue({
    token: "opaque-token",
    userId: "new-user",
    expiresAt: "2026-11-03T00:00:00Z",
  });
});

it("publishes only registration availability, without directory credentials", async () => {
  const response = await GET();
  expect(await response.json()).toEqual({ enabled: false, reason: "ldap_enabled" });
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});

it("registers anonymously, sets a private session cookie and never returns credentials", async () => {
  const response = await POST(request());
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ userId: "new-user" });
  expect(response.headers.get("set-cookie")).toMatch(
    /autoforge_session=opaque-token.*HttpOnly.*SameSite=strict/i,
  );
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(mocks.allow).toHaveBeenCalledWith("auth:register:v1:fixture-client", 10, 900000);
});

it("rejects cross-origin requests, managed fields and throttled callers before persistence", async () => {
  mocks.origin.mockImplementationOnce(() => {
    throw new DomainError("CSRF_REJECTED", "请从平台页面提交。");
  });
  expect((await POST(request())).status).toBe(403);
  expect((await POST(request({ ...registration, forcePasswordChange: false }))).status).toBe(400);
  mocks.allow.mockResolvedValueOnce(false);
  expect((await POST(request())).status).toBe(429);
  expect(mocks.register).not.toHaveBeenCalled();
});

it("reports duplicate usernames and unavailable initialization without issuing sessions", async () => {
  for (const [code, status] of [
    ["USER_CONFLICT", 409],
    ["AUTH_REGISTRATION_UNAVAILABLE", 403],
  ] as const) {
    mocks.register.mockRejectedValueOnce(new DomainError(code, "注册不可用"));
    const response = await POST(request());
    expect(response.status).toBe(status);
    expect(response.headers.has("set-cookie")).toBe(false);
  }
});
