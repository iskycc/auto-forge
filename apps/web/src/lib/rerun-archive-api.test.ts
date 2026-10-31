import { beforeEach, expect, it, vi } from "vitest";
import { DomainError } from "@autoforge/domain";
vi.mock("server-only", () => ({}));
const calls = vi.hoisted(() => ({
  archive: vi.fn(),
  authenticate: vi.fn(),
  authorize: vi.fn(),
  origin: vi.fn(),
}));
vi.mock("./auth", () => ({
  authenticateRequest: calls.authenticate,
  authorizedProjectScope: calls.authorize,
  requireSameOrigin: calls.origin,
  requestId: () => "archive-request",
}));
vi.mock("./services", () => ({
  getPlatformServices: async () => ({ caseSuites: { archiveReruns: calls.archive } }),
}));
import { POST } from "../app/api/v1/case-suites/archive-reruns/route";
beforeEach(() => {
  vi.resetAllMocks();
  calls.authenticate.mockResolvedValue({ user: { id: "actor" } });
  calls.archive.mockResolvedValue({ archivedIds: ["suite"], hasMore: false, skippedActive: 1 });
});
function request(body: unknown = { projectId: "project", projectVersionId: "version" }) {
  return new Request("http://localhost/api/v1/case-suites/archive-reruns", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
it("requires project management permission and uses the authenticated actor", async () => {
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect(calls.authorize).toHaveBeenCalledWith(
    { user: { id: "actor" } },
    "case_suite.manage",
    "project",
  );
  expect(calls.archive).toHaveBeenCalledWith("project", "version", "actor", "archive-request");
});
it("rejects an unauthorized caller before mutation", async () => {
  calls.authorize.mockImplementation(() => {
    throw new DomainError("AUTH_FORBIDDEN", "无权限");
  });
  const response = await POST(request());
  expect(response.status).toBe(403);
  expect(calls.archive).not.toHaveBeenCalled();
});
it("rejects requests without an explicit version or with an injected actor", async () => {
  expect((await POST(request({ projectId: "project" }))).status).toBe(400);
  expect(
    (
      await POST(
        request({ projectId: "project", projectVersionId: "version", actorId: "someone-else" }),
      )
    ).status,
  ).toBe(400);
  expect(calls.archive).not.toHaveBeenCalled();
});
