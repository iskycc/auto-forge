import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedIdentity, Permission } from "@autoforge/domain";

vi.mock("server-only", () => ({}));
const { authenticateRequest, readRecentExecutions } = vi.hoisted(() => ({
  authenticateRequest: vi.fn<() => Promise<AuthenticatedIdentity>>(),
  readRecentExecutions: vi.fn().mockResolvedValue({ items: [] }),
}));
vi.mock("./services", () => ({ getPlatformServices: vi.fn() }));
vi.mock("@/lib/services", () => ({
  getPlatformServices: async () => ({ caseSuiteActivity: { readRecentExecutions } }),
}));
vi.mock("@/lib/auth", async () => ({
  authenticateRequest,
  authorizedProjectScope: (await import("./auth")).authorizedProjectScope,
}));
vi.mock("@/lib/api-response", () => import("./api-response"));

import { GET } from "../app/api/v1/case-suites/[suiteId]/executions/route";

const context = { params: Promise.resolve({ suiteId: "suite-a" }) };
const url =
  "http://localhost/api/v1/case-suites/suite-a/executions?projectId=project-a&projectVersionId=version-a";

beforeEach(() => vi.clearAllMocks());

describe("case suite recent executions API", () => {
  it("allows a reader with both permissions in the requested project", async () => {
    authenticateRequest.mockResolvedValue(identityWith(["case_suite.read", "run.read"]));
    expect((await GET(new Request(url), context)).status).toBe(200);
    expect(readRecentExecutions).toHaveBeenCalledWith("suite-a", {
      projectId: "project-a",
      projectVersionId: "version-a",
    });
  });

  it.each<Permission[]>([["case_suite.read"], ["run.read"]])(
    "rejects incomplete permission set %s before reading executions",
    async (...permissions) => {
      authenticateRequest.mockResolvedValue(identityWith(permissions));
      const response = await GET(new Request(url), context);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "AUTH_FORBIDDEN" } });
      expect(readRecentExecutions).not.toHaveBeenCalled();
    },
  );

  it("rejects guessed IDs in a different project", async () => {
    const identity = identityWith(["case_suite.read", "run.read"]);
    identity.projectPermissions = { "project-b": ["case_suite.read", "run.read"] };
    authenticateRequest.mockResolvedValue(identity);
    expect((await GET(new Request(url), context)).status).toBe(403);
    expect(readRecentExecutions).not.toHaveBeenCalled();
  });

  it("requires an explicit project version instead of loading unscoped history", async () => {
    authenticateRequest.mockResolvedValue(identityWith(["case_suite.read", "run.read"]));
    expect(
      (await GET(new Request(url.replace("&projectVersionId=version-a", "")), context)).status,
    ).toBe(400);
    expect(readRecentExecutions).not.toHaveBeenCalled();
  });
});

function identityWith(permissions: Permission[]): AuthenticatedIdentity {
  return {
    user: {
      id: "reader",
      username: "reader",
      displayName: "Reader",
      source: "local",
      status: "active",
      forcePasswordChange: false,
      failedLoginAttempts: 0,
      version: 1,
      createdAt: "2026-09-05T00:00:00.000Z",
      updatedAt: "2026-09-05T00:00:00.000Z",
    },
    sessionId: "test-session",
    systemPermissions: [],
    projectPermissions: { "project-a": permissions },
  };
}
