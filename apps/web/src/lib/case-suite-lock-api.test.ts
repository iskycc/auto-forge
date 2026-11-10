import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "@autoforge/domain";

const { authenticateRequest, projectScope, setLock, recordAuthorizedOperation } = vi.hoisted(
  () => ({
    authenticateRequest: vi.fn(),
    projectScope: vi.fn(),
    setLock: vi.fn(),
    recordAuthorizedOperation: vi.fn(),
  }),
);
vi.mock("@/lib/auth", () => ({
  authenticateRequest,
  requestId: () => "lock-request",
  requireSameOrigin: () => undefined,
}));
vi.mock("@/lib/services", () => ({
  getPlatformServices: async () => ({
    caseSuites: { setLock },
    identityAccess: { projectScope, recordAuthorizedOperation },
  }),
}));
import { PUT } from "@/app/api/v1/case-suites/[suiteId]/lock/route";

const identity = { user: { id: "actor", username: "operator" } };
function request(body: unknown) {
  return new Request("http://localhost/api/v1/case-suites/suite/lock", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const context = { params: Promise.resolve({ suiteId: "suite" }) };
beforeEach(() => {
  vi.clearAllMocks();
  authenticateRequest.mockResolvedValue(identity);
  projectScope.mockReturnValue(["project"]);
  setLock.mockResolvedValue({ id: "suite", projectId: "project", lockedBy: "actor", revision: 4 });
});
describe("task lock API", () => {
  it("uses the authenticated user as owner and audits only a committed change", async () => {
    expect((await PUT(request({ locked: true, expectedRevision: 3 }), context)).status).toBe(200);
    expect(projectScope).toHaveBeenCalledWith(identity, "case_suite.manage");
    expect(setLock).toHaveBeenCalledWith(
      "suite",
      { locked: true, expectedRevision: 3 },
      identity.user,
      ["project"],
    );
    expect(recordAuthorizedOperation).toHaveBeenCalledWith(
      identity,
      expect.objectContaining({ action: "case_suite.lock" }),
    );
  });
  it("rejects forged owner fields", async () => {
    expect(
      (await PUT(request({ locked: true, expectedRevision: 3, actorId: "someone" }), context))
        .status,
    ).toBe(400);
    expect(setLock).not.toHaveBeenCalled();
  });
  it.each([
    ["AUTH_REQUIRED", 401],
    ["AUTH_FORBIDDEN", 403],
    ["CASE_SUITE_LOCKED", 403],
    ["CASE_SUITE_REVISION_CONFLICT", 409],
  ] as const)("preserves %s and does not audit rejected writes", async (code, status) => {
    if (code === "AUTH_REQUIRED")
      authenticateRequest.mockRejectedValue(new DomainError(code, "请先登录"));
    else setLock.mockRejectedValue(new DomainError(code, "拒绝操作"));
    expect((await PUT(request({ locked: false, expectedRevision: 3 }), context)).status).toBe(
      status,
    );
    expect(recordAuthorizedOperation).not.toHaveBeenCalled();
  });
});
