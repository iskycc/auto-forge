import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PROJECT_ID, DomainError } from "@autoforge/domain";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  authorize: vi.fn(),
  rename: vi.fn(),
  uninstall: vi.fn(),
  audit: vi.fn(),
  limit: vi.fn(),
}));
vi.mock("./auth", async (original) => ({
  ...(await original<typeof import("./auth")>()),
  authenticateRequest: mocks.authenticate,
  authorizeRequest: mocks.authorize,
}));
vi.mock("./services", () => ({
  getPlatformServices: async () => ({
    identityAccess: { renameProject: mocks.rename, recordAuthorizedOperation: mocks.audit },
    runnerRequestLimiter: { allow: mocks.limit },
  }),
}));
vi.mock("./runner-agent-uninstall", () => ({ uninstallRunnerAgent: mocks.uninstall }));

import { PATCH } from "../app/api/v1/projects/[projectId]/route";
import { POST } from "../app/api/v1/runners/[runnerId]/uninstall/route";

const actor = { user: { id: "operator" } };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.authenticate.mockResolvedValue(actor);
  mocks.authorize.mockResolvedValue(actor);
  mocks.limit.mockResolvedValue(true);
  mocks.rename.mockResolvedValue({ id: DEFAULT_PROJECT_ID, name: "新的项目名称" });
  mocks.uninstall.mockResolvedValue({
    uninstalled: true,
    dataDirectory: "/var/lib/autoforge-agent",
    dataDirectoryRetained: false,
  });
});
function request(path: string, method: string, body: unknown, origin = "http://localhost") {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json", origin, "x-request-id": "management-test" },
    body: JSON.stringify(body),
  });
}
const projectContext = { params: Promise.resolve({ projectId: DEFAULT_PROJECT_ID }) };
const runnerContext = { params: Promise.resolve({ runnerId: "runner-one" }) };

describe("project rename HTTP boundary", () => {
  it("passes only the normalized name and actual authenticated operator", async () => {
    expect(
      (
        await PATCH(
          request(`/api/v1/projects/${DEFAULT_PROJECT_ID}`, "PATCH", { name: "  新的项目名称  " }),
          projectContext,
        )
      ).status,
    ).toBe(200);
    expect(mocks.rename).toHaveBeenCalledWith(
      actor,
      DEFAULT_PROJECT_ID,
      { name: "新的项目名称" },
      "management-test",
    );
  });
  it.each([{ name: " " }, { name: "Changed", slug: "new-slug" }])(
    "rejects invalid input before writing: %j",
    async (body) => {
      expect(
        (
          await PATCH(
            request(`/api/v1/projects/${DEFAULT_PROJECT_ID}`, "PATCH", body),
            projectContext,
          )
        ).status,
      ).toBe(400);
      expect(mocks.rename).not.toHaveBeenCalled();
    },
  );
  it("rejects cross-origin changes and preserves authorization errors", async () => {
    expect(
      (
        await PATCH(
          request(
            `/api/v1/projects/${DEFAULT_PROJECT_ID}`,
            "PATCH",
            { name: "Changed" },
            "https://outside.example",
          ),
          projectContext,
        )
      ).status,
    ).toBe(403);
    expect(mocks.authenticate).not.toHaveBeenCalled();
    mocks.rename.mockRejectedValueOnce(new DomainError("AUTH_FORBIDDEN", "没有项目管理权限。"));
    expect(
      (
        await PATCH(
          request(`/api/v1/projects/${DEFAULT_PROJECT_ID}`, "PATCH", { name: "Changed" }),
          projectContext,
        )
      ).status,
    ).toBe(403);
  });
});
describe("Agent uninstall HTTP boundary", () => {
  it("requires runner management, rate-limits and audits completed cleanup", async () => {
    expect(
      (
        await POST(
          request("/api/v1/runners/runner-one/uninstall", "POST", {
            profileId: "profile",
            confirm: true,
          }),
          runnerContext,
        )
      ).status,
    ).toBe(200);
    expect(mocks.authorize).toHaveBeenCalledWith(
      expect.any(Request),
      "runner.manage",
      DEFAULT_PROJECT_ID,
    );
    expect(mocks.limit).toHaveBeenCalledOnce();
    expect(mocks.audit).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({
        action: "runner.uninstall.complete",
        resourceId: "runner-one",
        requestId: "management-test",
      }),
    );
  });
  it("rejects missing consent and read-only callers without running cleanup", async () => {
    expect(
      (
        await POST(
          request("/api/v1/runners/runner-one/uninstall", "POST", { profileId: "profile" }),
          runnerContext,
        )
      ).status,
    ).toBe(400);
    mocks.authorize.mockRejectedValueOnce(
      new DomainError("AUTH_FORBIDDEN", "没有执行机管理权限。"),
    );
    expect(
      (
        await POST(
          request("/api/v1/runners/runner-one/uninstall", "POST", {
            profileId: "profile",
            confirm: true,
          }),
          runnerContext,
        )
      ).status,
    ).toBe(403);
    expect(mocks.uninstall).not.toHaveBeenCalled();
  });
  it("does not uninstall or emit a success audit on rate-limit or remote failure", async () => {
    mocks.limit.mockResolvedValueOnce(false);
    expect(
      (
        await POST(
          request("/api/v1/runners/runner-one/uninstall", "POST", {
            profileId: "profile",
            confirm: true,
          }),
          runnerContext,
        )
      ).status,
    ).toBe(429);
    expect(mocks.uninstall).not.toHaveBeenCalled();
    mocks.uninstall.mockRejectedValueOnce(
      new DomainError("RUNNER_INSTALLATION_FAILED", "远端磁盘清理失败，请重试。"),
    );
    const response = await POST(
      request("/api/v1/runners/runner-one/uninstall", "POST", {
        profileId: "profile",
        confirm: true,
      }),
      runnerContext,
    );
    expect(response.status).toBe(502);
    expect((await response.json()).error).toMatchObject({
      message: "远端磁盘清理失败，请重试。",
      requestId: "management-test",
    });
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
