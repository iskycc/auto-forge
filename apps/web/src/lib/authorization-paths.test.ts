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
  rerunConfiguration: vi.fn(async () => ({ adapterEnabled: true, environmentIp: "10.0.0.21" })),
  versionCase: vi.fn(async () => ({ id: "single-batch", sequenceNumber: 1, status: "queued" })),
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
      createVersionCaseExecution: runtime.versionCase,
      getAttemptRerunContext: async () => ({ projectId: "project-operator" }),
      rerunCaseFromAttempt: runtime.rerun,
      getCaseLogRerunConfiguration: runtime.rerunConfiguration,
      getCaseLogRerunLogTarget: async () => ({ batchStatus: "queued", attempt: null }),
    },
    projectStructures: {
      list: async () => ({
        versions: [
          { id: "version", status: "active", stages: [{ id: "stage", status: "active" }] },
        ],
      }),
    },
  }),
}));

import { GET as runners } from "../app/api/v1/runners/route";
import { GET as groups } from "../app/api/v1/runner-groups/route";
import { GET as group } from "../app/api/v1/runner-groups/[groupId]/route";
import { GET as telemetry } from "../app/api/v1/runners/[runnerId]/telemetry/route";
import { GET as diagnostics } from "../app/api/v1/settings/diagnostics/route";
import { POST as terminalSession } from "../app/api/v1/terminal-sessions/route";
import {
  POST as rerunAttempt,
  GET as readRerunConfiguration,
} from "../app/api/v1/run-attempts/[attemptId]/rerun/route";
import { POST as executeVersionCase } from "../app/api/v1/projects/[projectId]/versions/[versionId]/case-executions/route";
import { POST as executeStageCase } from "../app/api/v1/projects/[projectId]/versions/[versionId]/stages/[stageId]/case-executions/route";
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
    { project: "project-operator", version: "version", status: 201 },
    { project: "other-project", version: "version", status: 403 },
    { project: "project-operator", version: "other-version", status: 404 },
  ])(
    "authorizes version execution within $project / $version",
    async ({ project, version, status }) => {
      const response = await executeVersionCase(
        new Request("http://localhost/api/v1/projects/project/versions/version/case-executions", {
          method: "POST",
          headers: {
            origin: "http://localhost",
            cookie: "autoforge_session=session",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            className: "com.example.Test",
            environmentIp: "10.0.0.21",
          }),
        }),
        { params: Promise.resolve({ projectId: project, versionId: version }) },
      );
      expect(response.status).toBe(status);
      expect(runtime.versionCase).toHaveBeenCalledTimes(status === 201 ? 1 : 0);
      if (status === 201)
        expect(runtime.versionCase).toHaveBeenCalledWith(project, version, expect.anything(), {
          username: "operator",
          source: "local",
        });
    },
  );
  it.each([
    { stageId: "stage", status: 201 },
    { stageId: "other-stage", status: 404 },
  ])("validates the stage from the URL: $stageId", async ({ stageId, status }) => {
    const response = await executeStageCase(
      new Request("http://localhost/api/v1/execute", {
        method: "POST",
        headers: {
          origin: "http://localhost",
          cookie: "autoforge_session=session",
          "content-type": "application/json",
        },
        body: JSON.stringify({ className: "com.example.Test", environmentIp: "10.0.0.21" }),
      }),
      { params: Promise.resolve({ projectId, versionId: "version", stageId }) },
    );
    expect(response.status).toBe(status);
    if (status === 201)
      expect(runtime.versionCase).toHaveBeenCalledWith(
        projectId,
        "version",
        expect.objectContaining({ environmentIp: "10.0.0.21" }),
        expect.objectContaining({ username: runtime.identity!.user.username }),
        { testStageId: stageId },
      );
    else expect(runtime.versionCase).not.toHaveBeenCalled();
  });
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
  it.each([
    { permissions: ["log.read", "run.retry"] as Permission[], status: 200 },
    { permissions: ["log.read"] as Permission[], status: 403 },
    { permissions: ["run.retry"] as Permission[], status: 403 },
  ])(
    "authorizes the rerun environment preview before loading it: $permissions",
    async ({ permissions, status }) => {
      runtime.identity = {
        ...identityFor("execution-operator", projectId),
        projectPermissions: { [projectId]: permissions },
      };
      const response = await readRerunConfiguration(request(), {
        params: Promise.resolve({ attemptId: "attempt" }),
      });
      expect(response.status).toBe(status);
      expect(runtime.rerunConfiguration).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
      if (status === 200) {
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.json()).toEqual({ adapterEnabled: true, environmentIp: "10.0.0.21" });
      }
    },
  );
  it.each([
    { input: { environmentIp: "10.0.0.99" }, status: 201 },
    { input: { environmentIp: "2001:db8::99" }, status: 201 },
    { input: { environmentIp: "10.0.0.999" }, status: 400 },
    { input: { environmentIp: "10.0.0.99", suiteId: "other" }, status: 400 },
  ])("validates the one-off rerun IP at the HTTP boundary: $input", async ({ input, status }) => {
    runtime.identity = {
      ...identityFor("execution-operator", projectId),
      projectPermissions: { [projectId]: ["log.read", "run.retry"] },
    };
    const response = await rerunAttempt(
      new Request("http://localhost/api/v1/run-attempts/attempt/rerun", {
        method: "POST",
        headers: {
          origin: "http://localhost",
          cookie: "autoforge_session=session",
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
      }),
      { params: Promise.resolve({ attemptId: "attempt" }) },
    );
    expect(response.status).toBe(status);
    expect(runtime.rerun).toHaveBeenCalledTimes(status === 201 ? 1 : 0);
    if (status === 201)
      expect(runtime.rerun).toHaveBeenCalledWith(
        "attempt",
        expect.objectContaining({ username: runtime.identity.user.username }),
        input,
      );
  });

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
