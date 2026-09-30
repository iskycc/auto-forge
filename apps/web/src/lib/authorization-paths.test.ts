import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthorizationDeniedError,
  DEFAULT_PROJECT_ID,
  builtInRoleDefinitions,
  hasPermission,
  type AuthenticatedIdentity,
  type Permission,
} from "@autoforge/domain";

vi.mock("server-only", () => ({}));
const runtime = vi.hoisted(() => ({
  identity: undefined as AuthenticatedIdentity | undefined,
  listRunners: vi.fn(async () => []),
  listGroups: vi.fn(async () => []),
  telemetry: vi.fn(async () => ({ samples: [] })),
  diagnostics: vi.fn(async () => ({ generatedAt: "2026-09-30T00:00:00Z" })),
  rerun: vi.fn(async () => ({ id: "rerun-batch" })),
}));
vi.mock("./services", () => ({
  getPlatformServices: async () => ({
    identityAccess: {
      authenticateSession: async () => runtime.identity,
      authorize(identity: AuthenticatedIdentity, permission: Permission, projectId?: string) {
        if (!hasPermission(identity, permission, projectId))
          throw new AuthorizationDeniedError(identity, permission, projectId);
      },
      recordAccessDenial: async () => {},
      recordAuthorizedOperation: async () => {},
    },
    runnerControl: { list: runtime.listRunners, telemetry: runtime.telemetry },
    runnerGroups: { list: runtime.listGroups, get: async () => ({ id: "group" }) },
    diagnostics: { read: runtime.diagnostics },
    runBatches: {
      getAttemptRerunContext: async () => ({ projectId: "project-operator" }),
      rerunCaseFromAttempt: runtime.rerun,
      getCaseLogRerunLogTarget: async () => ({ batchStatus: "queued", attempt: null }),
    },
  }),
}));

import { GET as runners } from "../app/api/v1/runners/route";
import { GET as groups } from "../app/api/v1/runner-groups/route";
import { GET as group } from "../app/api/v1/runner-groups/[groupId]/route";
import { GET as telemetry } from "../app/api/v1/runners/[runnerId]/telemetry/route";
import { GET as diagnostics } from "../app/api/v1/settings/diagnostics/route";
import { POST as terminalSession } from "../app/api/v1/terminal-sessions/route";
import { POST as rerunAttempt } from "../app/api/v1/run-attempts/[attemptId]/rerun/route";
import { authenticateRequest, authorizeRequest } from "./auth";

const projectId = "project-operator";
const readRoutes = [
  ["runners", runners],
  ["runner groups", groups],
  [
    "runner group",
    (request: Request) => group(request, { params: Promise.resolve({ groupId: "group" }) }),
  ],
  [
    "telemetry",
    (request: Request) => telemetry(request, { params: Promise.resolve({ runnerId: "runner" }) }),
  ],
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  runtime.identity = identityFor("execution-operator", projectId);
});

describe("project role execution resource access", () => {
  it.each([
    { permissions: ["log.read", "run.retry"] as Permission[], project: projectId, status: 201 },
    { permissions: ["log.read", "run.create"] as Permission[], project: projectId, status: 403 },
    {
      permissions: ["log.read", "run.retry"] as Permission[],
      project: "other-project",
      status: 403,
    },
  ])(
    "authorizes log reruns with run.retry in the attempt's own project: $project $permissions",
    async ({ permissions, project, status }) => {
      runtime.identity = {
        ...identityFor("execution-operator", projectId),
        projectPermissions: { [project]: permissions },
      };
      const response = await rerunAttempt(
        new Request("http://localhost/api/v1/run-attempts/attempt/rerun", {
          method: "POST",
          headers: { origin: "http://localhost", cookie: "autoforge_session=session" },
        }),
        { params: Promise.resolve({ attemptId: "attempt" }) },
      );
      expect(response.status).toBe(status);
      expect(runtime.rerun).toHaveBeenCalledTimes(status === 201 ? 1 : 0);
    },
  );
  it("does not allow an API token to open a personal terminal even with a terminal permission", async () => {
    runtime.identity = {
      ...identityFor("execution-operator", projectId),
      sessionId: "api-token:token",
      systemPermissions: ["runner.terminal"],
    };
    const response = await terminalSession(
      new Request("http://localhost/api/v1/terminal-sessions", {
        method: "POST",
        headers: { origin: "http://localhost", cookie: "autoforge_session=session" },
      }),
    );
    expect(response.status).toBe(403);
  });
  it.each(readRoutes)(
    "allows a non-default project's operator to read %s",
    async (_name, route) => {
      expect((await route(request())).status).toBe(200);
    },
  );

  it.each(readRoutes)(
    "rejects %s when the requested project is not granted",
    async (_name, route) => {
      expect((await route(request("?projectId=another-project"))).status).toBe(403);
    },
  );

  it.each(readRoutes)(
    "rejects %s before querying when no runner read permission exists",
    async (_name, route) => {
      runtime.identity = identityFor("auditor", projectId);
      expect((await route(request())).status).toBe(403);
      expect(runtime.listRunners).not.toHaveBeenCalled();
      expect(runtime.listGroups).not.toHaveBeenCalled();
      expect(runtime.telemetry).not.toHaveBeenCalled();
    },
  );
});

describe("explicit authorization boundaries", () => {
  it("does not treat undefined system scope as the default project", async () => {
    runtime.identity = identityFor("viewer", DEFAULT_PROJECT_ID);
    runtime.identity.projectPermissions[DEFAULT_PROJECT_ID]!.push("settings.read");
    await expect(authorizeRequest(request(), "settings.read", undefined)).rejects.toMatchObject({
      code: "AUTH_FORBIDDEN",
    });
    expect((await diagnostics(request())).status).toBe(403);
    expect(runtime.diagnostics).not.toHaveBeenCalled();
  });

  it("never falls back to a browser session when an explicit unsupported token is supplied", async () => {
    const explicit = request();
    explicit.headers.set("authorization", "Bearer invalid-token");
    await expect(authenticateRequest(explicit)).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
    });
  });
});

function request(query = "") {
  return new Request(`http://autoforge.test/api/v1/resource${query}`, {
    headers: { cookie: "autoforge_session=test-session" },
  });
}

function identityFor(roleKey: string, project: string): AuthenticatedIdentity {
  const role = builtInRoleDefinitions.find((item) => item.key === roleKey)!;
  return {
    user: {
      id: "operator",
      username: "operator",
      displayName: "Operator",
      source: "local",
      status: "active",
      forcePasswordChange: false,
      failedLoginAttempts: 0,
      createdAt: "2026-09-30T00:00:00Z",
      updatedAt: "2026-09-30T00:00:00Z",
      version: 1,
    },
    sessionId: "session",
    systemPermissions: role.scope === "system" ? [...role.permissions] : [],
    projectPermissions: role.scope === "project" ? { [project]: [...role.permissions] } : {},
  };
}
