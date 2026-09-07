import { describe, expect, it, vi } from "vitest";
import { AuthorizationDeniedError, type AuthenticatedIdentity } from "@autoforge/domain";
import { apiErrorResponse } from "./api-response";

const { recordAccessDenial } = vi.hoisted(() => ({ recordAccessDenial: vi.fn() }));
vi.mock("./services", () => ({
  getPlatformServices: async () => ({ identityAccess: { recordAccessDenial } }),
}));
const identity: AuthenticatedIdentity = {
  user: {
    id: "user",
    username: "viewer",
    displayName: "观察者",
    source: "local",
    status: "active",
    version: 1,
    forcePasswordChange: false,
    failedLoginAttempts: 0,
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z",
  },
  sessionId: "session",
  systemPermissions: [],
  projectPermissions: {},
};

describe("access rejection audit boundary", () => {
  it("waits for a single audit write before returning a safe forbidden response", async () => {
    recordAccessDenial.mockResolvedValueOnce(undefined);
    const response = await apiErrorResponse(
      new AuthorizationDeniedError(identity, "case.manage", "project-a"),
      "request-a",
    );
    expect(recordAccessDenial).toHaveBeenLastCalledWith(
      {
        actorId: "user",
        actorName: "观察者 · viewer",
        permission: "case.manage",
        projectId: "project-a",
      },
      "request-a",
    );
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe("AUTH_FORBIDDEN");
    expect(JSON.stringify(body)).not.toMatch(/case\.manage|观察者|project-a/u);
  });

  it("reports audit storage failure without exposing database errors", async () => {
    recordAccessDenial.mockRejectedValueOnce(new Error("private-database-failure"));
    const response = await apiErrorResponse(
      new AuthorizationDeniedError(identity, "user.manage"),
      "request-b",
    );
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("private-database-failure");
  });
});
