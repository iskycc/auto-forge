import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "@autoforge/domain";
import { authenticateRequest, authorizedProjectScope, requireSameOrigin } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";
import { GET, PUT } from "./route";
import { POST as trigger } from "./trigger/route";
import { POST as inspect } from "./inspect/route";
import { POST as acknowledge } from "./acknowledge/route";
vi.mock("@/lib/auth", () => ({
  authenticateRequest: vi.fn(),
  authorizedProjectScope: vi.fn(),
  requireSameOrigin: vi.fn(),
  requestId: () => "test-request",
}));
vi.mock("@/lib/services", () => ({ getPlatformServices: vi.fn() }));

const context = { params: Promise.resolve({ projectId: "project", versionId: "version" }) };
const connection = {
  jobUrl: "https://jenkins.test/job/deps/",
  username: "builder",
  apiToken: "secret",
  parameters: [{ name: "VERSION", value: "中文 &+" }],
  expectedRevision: 0,
};
const view = {
  revision: 1,
  buildRevision: 0,
  configuration: {
    jobUrl: connection.jobUrl,
    username: "builder",
    parameters: connection.parameters,
    apiTokenConfigured: true,
  },
};
const service = {
  read: vi.fn(),
  save: vi.fn(),
  trigger: vi.fn(),
  inspect: vi.fn(),
  acknowledge: vi.fn(),
};
const audit = vi.fn();
const request = (method: string, body?: unknown) =>
  new Request("http://localhost/api?refresh=1", {
    method,
    ...(body
      ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } }
      : {}),
  });

describe("version Jenkins API boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(authenticateRequest).mockResolvedValue({
      user: { id: "user", username: "operator" },
    } as Awaited<ReturnType<typeof authenticateRequest>>);
    vi.mocked(getPlatformServices).mockResolvedValue({
      jenkinsDependencyBuilds: service,
      identityAccess: { recordAuthorizedOperation: audit },
    } as unknown as Awaited<ReturnType<typeof getPlatformServices>>);
    service.read.mockResolvedValue(view);
    service.save.mockResolvedValue(view);
    service.trigger.mockResolvedValue(view);
    service.inspect.mockResolvedValue({ name: "deps", buildable: true });
    service.acknowledge.mockResolvedValue(view);
  });
  it("protects reads and writes with scoped management permission and never returns the API token", async () => {
    const saved = await PUT(request("PUT", connection), context);
    expect(saved.status).toBe(200);
    expect(JSON.stringify(await saved.json())).not.toContain("secret");
    expect(requireSameOrigin).toHaveBeenCalled();
    expect(authorizedProjectScope).toHaveBeenCalledWith(
      expect.anything(),
      "project.manage",
      "project",
    );
    expect(audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ details: { parameterCount: 1 } }),
    );
    const read = await GET(request("GET"), context);
    expect(read.headers.get("cache-control")).toBe("private, no-store");
    expect(service.read).toHaveBeenCalledWith("project", "version", true);
  });
  it("denies unauthorized requests before touching configurations or Jenkins", async () => {
    vi.mocked(authorizedProjectScope).mockImplementation(() => {
      throw new DomainError("AUTH_FORBIDDEN", "没有管理项目权限");
    });
    expect((await GET(request("GET"), context)).status).toBe(403);
    expect(
      (
        await trigger(
          request("POST", { requestId: "request", expectedRevision: 1, expectedBuildRevision: 0 }),
          context,
        )
      ).status,
    ).toBe(403);
    expect(service.read).not.toHaveBeenCalled();
    expect(service.trigger).not.toHaveBeenCalled();
  });
  it("rejects duplicate parameter keys and records actor identity on builds", async () => {
    expect(
      (
        await PUT(
          request("PUT", {
            ...connection,
            parameters: [
              { name: "VERSION", value: "1" },
              { name: "VERSION", value: "2" },
            ],
          }),
          context,
        )
      ).status,
    ).toBe(400);
    const body = { requestId: "request-1", expectedRevision: 1, expectedBuildRevision: 0 };
    expect((await trigger(request("POST", body), context)).status).toBe(200);
    expect(service.trigger).toHaveBeenCalledWith("project", "version", body, "operator");
    expect((await inspect(request("POST"), context)).status).toBe(200);
    expect((await acknowledge(request("POST", { buildRevision: 3 }), context)).status).toBe(200);
  });
});
