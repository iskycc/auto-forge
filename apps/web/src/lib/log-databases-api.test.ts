import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "@autoforge/domain";

const access = vi.hoisted(() => ({
  authorize: vi.fn(),
  sameOrigin: vi.fn(),
  register: vi.fn(),
  select: vi.fn(),
  check: vi.fn(),
  update: vi.fn(),
  list: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  authorizeRequest: access.authorize,
  requireSameOrigin: access.sameOrigin,
  requestId: () => "log-db-test",
}));
vi.mock("@/lib/log-databases", () => ({
  requireLogDatabases: async () => ({
    logDatabases: {
      register: access.register,
      select: access.select,
      check: access.check,
      updateConnection: access.update,
      list: access.list,
    },
    services: {
      identityAccess: { recordAuthorizedOperation: access.audit },
      clock: { now: () => new Date("2026-10-27T00:00:00.000Z") },
    },
  }),
}));
import { GET, POST } from "../app/api/v1/settings/log-databases/route";
import { PUT } from "../app/api/v1/settings/log-databases/active/route";
import { PATCH } from "../app/api/v1/settings/log-databases/[databaseId]/route";
import { POST as check } from "../app/api/v1/settings/log-databases/[databaseId]/check/route";

const id = "019a25a1-0000-7000-8000-000000000001";
const context = { params: Promise.resolve({ databaseId: id }) };
const registration = {
  name: "日志库",
  host: "logs",
  port: 5432,
  username: "postgres",
  password: "private-password",
  maintenanceDatabase: "postgres",
  databasePrefix: "autoforge_logs",
  sslMode: "disable",
};
function request(method: string, body?: unknown) {
  return new Request("http://localhost/api/v1/settings/log-databases", {
    method,
    ...(body
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  access.authorize.mockResolvedValue({ id: "admin" });
  access.sameOrigin.mockImplementation(() => {});
});
describe("log database HTTP authorization and secret handling", () => {
  it.each(["register", "select", "check", "update", "list"] as const)(
    "rejects unauthorized %s before accessing any log database",
    async (operation) => {
      access.authorize.mockRejectedValue(new DomainError("AUTH_FORBIDDEN", "无权限"));
      const response = await {
        register: () => POST(request("POST", registration)),
        select: () => PUT(request("PUT", { databaseId: id, revision: 1 })),
        check: () => check(request("POST"), context),
        update: () => PATCH(request("PATCH", registration), context),
        list: () => GET(request("GET")),
      }[operation]();
      expect(response.status).toBe(403);
      expect(access[operation]).not.toHaveBeenCalled();
    },
  );
  it("registers with settings.manage, keeps credentials out of responses and audit details", async () => {
    access.register.mockResolvedValue({
      id,
      name: "日志库",
      address: "logs:5432/logs",
      active: false,
      batchCount: 0,
      storedBytes: 0,
      createdAt: "2026-10-27T00:00:00Z",
    });
    const response = await POST(request("POST", registration));
    expect(response.status).toBe(201);
    expect(access.authorize).toHaveBeenCalledWith(
      expect.any(Request),
      "settings.manage",
      undefined,
    );
    expect(JSON.stringify(await response.json())).not.toContain("private-password");
    expect(JSON.stringify(access.audit.mock.calls)).not.toContain("private-password");
  });
  it("enforces same-origin protection before a write", async () => {
    access.sameOrigin.mockImplementation(() => {
      throw new DomainError("CSRF_REJECTED", "来源错误");
    });
    expect((await PUT(request("PUT", { databaseId: id, revision: 1 }))).status).toBe(403);
    expect(access.select).not.toHaveBeenCalled();
  });
});
