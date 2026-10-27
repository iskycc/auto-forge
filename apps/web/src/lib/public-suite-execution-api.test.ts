import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "@autoforge/domain";

vi.mock("server-only", () => ({}));
const f = vi.hoisted(() => ({
  authenticate: vi.fn(),
  sameOrigin: vi.fn(),
  scope: vi.fn(),
  authorize: vi.fn(),
  summary: vi.fn(),
  start: vi.fn(),
  terminate: vi.fn(),
  read: vi.fn(),
  publish: vi.fn(),
  revoke: vi.fn(),
  linkPath: vi.fn(),
  audit: vi.fn(),
  allow: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  authenticateRequest: f.authenticate,
  requireSameOrigin: f.sameOrigin,
  requestId: () => "request-public-task",
}));
vi.mock("@/lib/services", () => ({
  getPlatformServices: async () => ({
    identityAccess: {
      projectScope: f.scope,
      authorize: f.authorize,
      recordAuthorizedOperation: f.audit,
    },
    caseSuites: { getSummary: f.summary },
    publicSuiteExecutions: {
      start: f.start,
      terminate: f.terminate,
      read: f.read,
      publish: f.publish,
      revoke: f.revoke,
      linkPath: f.linkPath,
    },
    runnerRequestLimiter: { allow: f.allow },
    configurationStore: { read: () => ({ web: { publicBaseUrl: "http://localhost" } }) },
  }),
}));

import { POST as start } from "../app/api/v1/public/case-suites/[suiteId]/executions/route";
import { POST as terminate } from "../app/api/v1/public/case-suites/[suiteId]/executions/[batchId]/terminate/route";
import { GET as read } from "../app/api/v1/public/case-suites/[suiteId]/route";
import {
  GET as readLink,
  POST as publish,
  DELETE as revoke,
} from "../app/api/v1/case-suites/[suiteId]/execution-link/route";

const actor = { id: "visitor", username: "visitor-without-project-permissions", source: "local" };
const identity = { user: actor, sessionId: "session" };
const context = { params: Promise.resolve({ suiteId: "suite", batchId: "batch" }) };
const key = "019aa000-0000-7000-8000-000000000001";
function request(method = "POST", body?: unknown) {
  return new Request(
    "http://localhost/api/v1/public/case-suites/suite/executions?PublisherId=owner",
    {
      method,
      ...(body
        ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } }
        : {}),
    },
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  f.authenticate.mockResolvedValue(identity);
  f.allow.mockResolvedValue(true);
  f.start.mockResolvedValue({ batchId: "batch", progressPath: "/Execution?BatchId=batch" });
  f.terminate.mockResolvedValue(1);
  f.summary.mockResolvedValue({ projectId: "project" });
  f.scope.mockReturnValue(["project"]);
  f.publish.mockResolvedValue("/RunTask?SuiteId=suite&PublisherId=visitor");
});

describe("public task execution HTTP boundary", () => {
  it("keeps link ownership on actual users rather than service accounts", async () => {
    f.authenticate.mockResolvedValue({ ...identity, sessionId: "api-token:service" });
    expect((await publish(request(), context)).status).toBe(401);
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.scope).not.toHaveBeenCalled();
  });
  it("requires a login, without consulting project execution permissions", async () => {
    f.scope.mockImplementation(() => {
      throw new Error("Project permission must not be checked here");
    });
    expect((await start(request("POST", { requestKey: key }), context)).status).toBe(201);
    expect(f.start).toHaveBeenCalledWith(
      "suite",
      "owner",
      { requestKey: key, delaySeconds: 0 },
      actor,
    );
    expect(f.scope).not.toHaveBeenCalled();
    expect(f.authorize).not.toHaveBeenCalled();
    expect(f.sameOrigin).toHaveBeenCalled();
  });
  it.each(["AUTH_REQUIRED", "AUTHENTICATION_FAILED"])(
    "rejects unauthenticated/expired sessions: %s",
    async (code) => {
      f.authenticate.mockRejectedValue(new DomainError(code, "请登录"));
      expect((await start(request("POST", { requestKey: key }), context)).status).toBe(401);
      expect(f.start).not.toHaveBeenCalled();
    },
  );
  it("does not turn an API token into a public execution bypass", async () => {
    f.authenticate.mockResolvedValue({ ...identity, sessionId: "api-token:service" });
    expect((await start(request("POST", { requestKey: key }), context)).status).toBe(401);
    expect(f.start).not.toHaveBeenCalled();
  });
  it("rejects actor/task configuration overrides and rate limits actual submissions", async () => {
    expect(
      (
        await start(
          request("POST", { requestKey: key, publisherId: "forged", concurrency: 100 }),
          context,
        )
      ).status,
    ).toBe(400);
    f.allow.mockResolvedValue(false);
    expect((await start(request("POST", { requestKey: key }), context)).status).toBe(429);
    expect(f.start).not.toHaveBeenCalled();
  });
  it("checks same-origin before modifying state", async () => {
    f.sameOrigin.mockImplementation(() => {
      throw new DomainError("AUTH_FORBIDDEN", "跨站请求被拒绝");
    });
    expect((await start(request("POST", { requestKey: key }), context)).status).toBe(403);
    expect(f.start).not.toHaveBeenCalled();
  });
  it("accepts a full 128-address pool without relaxing other task overrides", async () => {
    const environmentAddresses = Array.from(
      { length: 128 },
      (_, index) => `2001:db8:0:1:2:3:4:${index.toString(16)}`,
    );
    expect(
      (await start(request("POST", { requestKey: key, environmentAddresses }), context)).status,
    ).toBe(201);
    expect(f.start).toHaveBeenCalledWith(
      "suite",
      "owner",
      { requestKey: key, delaySeconds: 0, environmentAddresses },
      actor,
    );
    expect(
      (await start(request("POST", { requestKey: key, environmentAddresses: [] }), context)).status,
    ).toBe(400);
  });
  it("uses the authenticated terminator rather than request body attribution", async () => {
    expect((await terminate(request("POST", { actor: { id: "forged" } }), context)).status).toBe(
      200,
    );
    expect(f.terminate).toHaveBeenCalledWith("suite", "owner", "batch", actor);
    expect(f.scope).not.toHaveBeenCalled();
  });
  it("keeps anonymous status reads bounded behind the publication service", async () => {
    f.read.mockResolvedValue({ name: "public projection" });
    const response = await read(request("GET"), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(f.read).toHaveBeenCalledWith("suite", "owner");
    expect(f.authenticate).not.toHaveBeenCalled();
  });
  it("requires both task management scope and execution permission to publish/revoke", async () => {
    expect((await publish(request(), context)).status).toBe(200);
    expect(f.scope).toHaveBeenCalledWith(identity, "case_suite.manage");
    expect(f.authorize).toHaveBeenCalledWith(identity, "run.create", "project");
    expect(f.publish).toHaveBeenCalledWith("suite", "visitor");
    expect((await revoke(request("DELETE"), context)).status).toBe(200);
    expect(f.revoke).toHaveBeenCalledWith("suite", "visitor");
    f.scope.mockImplementation(() => {
      throw new DomainError("AUTH_FORBIDDEN", "无权管理任务");
    });
    f.publish.mockClear();
    expect((await publish(request(), context)).status).toBe(403);
    expect(f.publish).not.toHaveBeenCalled();
  });
  it("can rediscover the owner's existing link without re-enabling a revoked grant", async () => {
    f.linkPath.mockResolvedValue(null);
    expect(await (await readLink(request("GET"), context)).json()).toEqual({ url: null });
    expect(f.publish).not.toHaveBeenCalled();
  });
});
