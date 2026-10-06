import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError, type AuthenticatedIdentity } from "@autoforge/domain";

vi.mock("server-only", () => ({}));
const { authenticateRequest, projectScope, setPinned } = vi.hoisted(() => ({
  authenticateRequest: vi.fn<() => Promise<AuthenticatedIdentity>>(),
  projectScope: vi.fn(),
  setPinned: vi.fn(),
}));
vi.mock("@/lib/services", () => ({
  getPlatformServices: async () => ({
    caseSuites: { setPinned },
    identityAccess: { projectScope },
  }),
}));
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth")>()),
  authenticateRequest,
}));

import { PUT } from "../app/api/v1/case-suites/[suiteId]/pin/route";

const identity: AuthenticatedIdentity = {
  user: {
    id: "reader",
    username: "reader",
    displayName: "Reader",
    source: "local",
    status: "active",
    forcePasswordChange: false,
    failedLoginAttempts: 0,
    version: 1,
    createdAt: "2026-10-06T00:00:00.000Z",
    updatedAt: "2026-10-06T00:00:00.000Z",
  },
  sessionId: "personal-session",
  systemPermissions: [],
  projectPermissions: { project: ["case_suite.read"] },
};
const context = { params: Promise.resolve({ suiteId: "suite" }) };
function request(input: unknown = { pinned: true }, origin = "http://localhost") {
  return new Request("http://localhost/api/v1/case-suites/suite/pin", {
    method: "PUT",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(input),
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  authenticateRequest.mockResolvedValue(identity);
  projectScope.mockReturnValue(["project"]);
  setPinned.mockResolvedValue({ suiteId: "suite", pinned: true });
});

describe("personal task pin API", () => {
  it("uses the signed-in reader's identity and read scope instead of requiring task management", async () => {
    const response = await PUT(request(), context);
    expect(response.status).toBe(200);
    expect(projectScope).toHaveBeenCalledWith(identity, "case_suite.read");
    expect(setPinned).toHaveBeenCalledWith("suite", { pinned: true }, "reader", ["project"]);
    expect(await response.json()).toEqual({ suiteId: "suite", pinned: true });
  });
  it("rejects service account preferences without writing a synthetic user FK", async () => {
    authenticateRequest.mockResolvedValue({ ...identity, sessionId: "api-token:token" });
    expect((await PUT(request(), context)).status).toBe(403);
    expect(setPinned).not.toHaveBeenCalled();
  });
  it("rejects cross-origin writes before authentication or persistence", async () => {
    expect((await PUT(request(undefined, "https://outside.example"), context)).status).toBe(403);
    expect(authenticateRequest).not.toHaveBeenCalled();
    expect(setPinned).not.toHaveBeenCalled();
  });
  it("rejects a client-selected user and non-boolean state", async () => {
    for (const input of [{ pinned: true, userId: "another-reader" }, { pinned: "true" }])
      expect((await PUT(request(input), context)).status).toBe(400);
    expect(setPinned).not.toHaveBeenCalled();
  });
  it("requires authentication and keeps missing-task errors distinct", async () => {
    authenticateRequest.mockRejectedValueOnce(new DomainError("AUTH_REQUIRED", "需要登录。"));
    expect((await PUT(request(), context)).status).toBe(401);
    setPinned.mockRejectedValueOnce(new DomainError("CASE_SUITE_NOT_FOUND", "任务不存在。"));
    expect((await PUT(request(), context)).status).toBe(404);
  });
});
