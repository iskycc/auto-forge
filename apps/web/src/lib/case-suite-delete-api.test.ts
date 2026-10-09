import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError, type AuthenticatedIdentity } from "@autoforge/domain";

vi.mock("server-only", () => ({}));
const { authenticateRequest, projectScope, deleteSuite, recordAuthorizedOperation } = vi.hoisted(
  () => ({
    authenticateRequest: vi.fn<() => Promise<AuthenticatedIdentity>>(),
    projectScope: vi.fn(),
    deleteSuite: vi.fn(),
    recordAuthorizedOperation: vi.fn(),
  }),
);
vi.mock("@/lib/services", () => ({
  getPlatformServices: async () => ({
    caseSuites: { delete: deleteSuite },
    identityAccess: { projectScope, recordAuthorizedOperation },
  }),
}));
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth")>()),
  authenticateRequest,
}));

import { DELETE } from "../app/api/v1/case-suites/[suiteId]/route";

const identity: AuthenticatedIdentity = {
  user: {
    id: "manager",
    username: "manager",
    displayName: "Manager",
    source: "local",
    status: "active",
    forcePasswordChange: false,
    failedLoginAttempts: 0,
    version: 1,
    createdAt: "2026-10-08T00:00:00.000Z",
    updatedAt: "2026-10-08T00:00:00.000Z",
  },
  sessionId: "manager-session",
  systemPermissions: [],
  projectPermissions: { project: ["case_suite.manage"] },
};
const context = { params: Promise.resolve({ suiteId: "suite" }) };
function request(input: unknown = { expectedRevision: 3 }, origin = "http://localhost") {
  return new Request("http://localhost/api/v1/case-suites/suite", {
    method: "DELETE",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(input),
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  authenticateRequest.mockResolvedValue(identity);
  projectScope.mockReturnValue(["project"]);
  deleteSuite.mockResolvedValue({
    id: "suite",
    projectId: "project",
    name: "Task",
    version: 2,
    revision: 3,
  });
});

describe("task deletion API", () => {
  it("uses the manager's project scope and audits only a successful deletion", async () => {
    const response = await DELETE(request(), context);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(projectScope).toHaveBeenCalledWith(identity, "case_suite.manage");
    expect(deleteSuite).toHaveBeenCalledWith("suite", { expectedRevision: 3 }, ["project"]);
    expect(recordAuthorizedOperation).toHaveBeenCalledWith(
      identity,
      expect.objectContaining({
        action: "case_suite.delete",
        resourceId: "suite",
        projectId: "project",
        details: { name: "Task", version: 2, revision: 3 },
      }),
    );
  });
  it("rejects cross-origin deletion before authentication", async () => {
    expect((await DELETE(request(undefined, "https://outside.example"), context)).status).toBe(403);
    expect(authenticateRequest).not.toHaveBeenCalled();
    expect(deleteSuite).not.toHaveBeenCalled();
  });
  it("requires authentication and management permission", async () => {
    authenticateRequest.mockRejectedValueOnce(new DomainError("AUTH_REQUIRED", "需要登录。"));
    expect((await DELETE(request(), context)).status).toBe(401);
    projectScope.mockImplementation(() => {
      throw new DomainError("AUTH_FORBIDDEN", "无权限。");
    });
    expect((await DELETE(request(), context)).status).toBe(403);
    expect(deleteSuite).not.toHaveBeenCalled();
  });
  it.each([
    {},
    { expectedRevision: 0 },
    { expectedRevision: "3" },
    { expectedRevision: 1.5 },
    { expectedRevision: 3, deleteExecutions: true },
  ])("rejects invalid deletion input %j", async (input) => {
    expect((await DELETE(request(input), context)).status).toBe(400);
    expect(deleteSuite).not.toHaveBeenCalled();
  });
  it.each([
    ["CASE_SUITE_NOT_FOUND", 404],
    ["CASE_SUITE_REVISION_CONFLICT", 409],
  ] as const)(
    "keeps %s distinct and does not audit an unsuccessful deletion",
    async (code, status) => {
      deleteSuite.mockRejectedValue(new DomainError(code, "请刷新后重试。"));
      const response = await DELETE(request(), context);
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error: { code } });
      expect(recordAuthorizedOperation).not.toHaveBeenCalled();
    },
  );
});
