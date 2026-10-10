import { DomainError } from "@autoforge/domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const runtime = vi.hoisted(() => ({
  authenticate: vi.fn(),
  authorize: vi.fn(),
  authorizeDdtScope: vi.fn(),
  create: vi.fn(),
  createSingleCase: vi.fn(),
  createSingleDdtCase: vi.fn(),
  createDebugCase: vi.fn(),
  publishBatch: vi.fn(),
}));
vi.mock("./auth", () => ({
  authenticateRequest: runtime.authenticate,
  requestId: () => "initiator-request",
  requireSameOrigin: () => {},
}));
vi.mock("./ddt-api", () => ({
  authorizeDdtScope: runtime.authorizeDdtScope,
  ddtScopeQuery: () => "",
}));
vi.mock("./services", () => ({ getPlatformServices: async () => services }));

import { POST as createBatch } from "../app/api/v1/run-batches/route";
import { POST as createJenkinsBatch } from "../app/api/v1/jenkins/runs/route";
import { POST as createSingleCase } from "../app/api/v1/case-definitions/[caseDefinitionId]/execute/route";
import { POST as createSingleDdtCase } from "../app/api/v1/ddt/[...path]/route";
import { POST as createDebugCase } from "../app/api/v1/case-debug/runs/route";

const scope = { projectId: "project", projectVersionId: "version", testStageId: "stage" };
const services = {
  identityAccess: {
    authorize: runtime.authorize,
    projectScope: () => [scope.projectId],
    recordAuthorizedOperation: async () => {},
  },
  caseSuites: { getSummary: async () => ({ id: "suite", projectId: scope.projectId }) },
  caseDefinitions: { get: async () => ({ id: "case", projectId: scope.projectId }) },
  runBatches: {
    create: runtime.create,
    createSingleCase: runtime.createSingleCase,
    createSingleDdtCase: runtime.createSingleDdtCase,
    createDebugCase: runtime.createDebugCase,
  },
  publicExecutionAccess: { publishBatch: runtime.publishBatch },
  clock: { now: () => new Date("2026-10-08T00:00:00Z") },
  config: { masterKey: "1".repeat(64) },
  configurationStore: { read: () => ({ web: { publicBaseUrl: "http://localhost" } }) },
};
const entries = [
  { name: "task", invoke: createBatch, body: { suiteId: "suite" }, create: runtime.create },
  {
    name: "Jenkins",
    invoke: createJenkinsBatch,
    body: { suiteId: "suite" },
    create: runtime.create,
  },
  {
    name: "single TestNG case",
    invoke: (request: Request) =>
      createSingleCase(request, { params: Promise.resolve({ caseDefinitionId: "case" }) }),
    body: { runnerIds: ["runner"] },
    create: runtime.createSingleCase,
  },
  {
    name: "single DDT case",
    invoke: (request: Request) =>
      createSingleDdtCase(request, {
        params: Promise.resolve({ path: ["cases", "case", "execute"] }),
      }),
    body: { runnerIds: ["runner"] },
    create: runtime.createSingleDdtCase,
  },
  {
    name: "debug case",
    invoke: createDebugCase,
    body: {
      ...scope,
      kind: "testng",
      caseDefinitionId: "case",
      execution: { runnerIds: ["runner"] },
    },
    create: runtime.createDebugCase,
  },
];

beforeEach(() => {
  vi.resetAllMocks();
  runtime.publishBatch.mockResolvedValue("/Execution?BatchId=batch");
  runtime.authenticate.mockResolvedValue({
    user: { id: "launcher-id", username: "actual-launcher", source: "local" },
    sessionId: "session",
  });
  runtime.authorizeDdtScope.mockImplementation(async (identity, permission) => {
    runtime.authorize(identity, permission, scope.projectId);
    return { scope, services, labels: { version: "Version", stage: "Stage" } };
  });
  for (const entry of entries)
    entry.create.mockResolvedValue({ id: "batch", projectId: scope.projectId, totalRuns: 1 });
});

describe.each(entries)("$name execution initiator", (entry) => {
  it.each(["local", "ldap"])(
    "takes the %s username from the authenticated account",
    async (source) => {
      runtime.authenticate.mockResolvedValue({
        user: { id: "launcher-id", username: "actual-launcher", source },
        sessionId: "session",
      });
      const response = await entry.invoke(request(entry.body));
      expect(response.status).toBe(201);
      if (entry.name === "Jenkins") {
        const payload = await response.json();
        expect(payload.resultUrl).toBe("http://localhost/Execution?BatchId=batch");
        expect(payload.progressUrl).toBe(payload.resultUrl);
        expect(runtime.publishBatch).toHaveBeenCalledWith("batch", "launcher-id", [
          scope.projectId,
        ]);
      }
      expect(entry.create.mock.calls[0]?.at(-1)).toEqual({ username: "actual-launcher", source });
    },
  );

  it("rejects an unauthenticated request before creating a batch", async () => {
    runtime.authenticate.mockRejectedValue(new DomainError("AUTH_REQUIRED", "请先登录。"));
    const response = await entry.invoke(request(entry.body));
    expect(response.status).toBe(401);
    expect(entry.create).not.toHaveBeenCalled();
  });

  it("rejects a request without project execution permission", async () => {
    runtime.authorize.mockImplementation(() => {
      throw new DomainError("AUTH_FORBIDDEN", "没有项目执行权限。");
    });
    const response = await entry.invoke(request(entry.body));
    expect(response.status).toBe(403);
    expect(entry.create).not.toHaveBeenCalled();
  });

  it("does not accept a forged initiator in the request body", async () => {
    const response = await entry.invoke(
      request({ ...entry.body, requestedBy: { username: "forged", source: "ldap" } }),
    );
    expect(response.status).toBe(400);
    expect(entry.create).not.toHaveBeenCalled();
  });
});

function request(body: object): Request {
  return new Request(`http://localhost/api/v1/execution?${new URLSearchParams(scope)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: "http://localhost" },
    body: JSON.stringify(body),
  });
}
