import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "@autoforge/domain";
vi.mock("server-only", () => ({}));
const {
  authenticateRequest,
  projectScope,
  listSources,
  inspect,
  getSummary,
  recordAuthorizedOperation,
} = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  projectScope: vi.fn(),
  listSources: vi.fn(),
  inspect: vi.fn(),
  getSummary: vi.fn(),
  recordAuthorizedOperation: vi.fn(),
}));
vi.mock("./auth", async (original) => ({
  ...(await original<typeof import("./auth")>()),
  authenticateRequest,
}));
vi.mock("./services", () => ({
  getPlatformServices: async () => ({
    caseSuites: { listRoundRecoveryCredentialSources: listSources, getSummary },
    roundRecoveryConfigurationInspector: { inspect },
    identityAccess: { projectScope, recordAuthorizedOperation },
  }),
}));
import { GET } from "../app/api/v1/case-suites/[suiteId]/round-recovery/credentials/route";
import { POST } from "../app/api/v1/case-suites/[suiteId]/round-recovery/inspect/route";
const context = { params: Promise.resolve({ suiteId: "target" }) };
const endpoint = "http://localhost/api/v1/case-suites/target/round-recovery";
beforeEach(() => {
  vi.resetAllMocks();
  authenticateRequest.mockResolvedValue({ user: { id: "manager" } });
  projectScope.mockReturnValue(["managed"]);
  listSources.mockResolvedValue({ items: [] });
  getSummary.mockResolvedValue({ id: "target", projectId: "managed" });
  inspect.mockResolvedValue({
    name: "reset",
    url: "https://jenkins.internal/job/reset/",
    buildable: true,
    inQueue: false,
  });
});
describe("reusable Jenkins credential API", () => {
  it("lists only management-scoped metadata, keeps empty scope and disables caching", async () => {
    projectScope.mockReturnValue([]);
    const response = await GET(new Request(`${endpoint}/credentials?query=Smoke`), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(projectScope).toHaveBeenCalledWith({ user: { id: "manager" } }, "case_suite.manage");
    expect(listSources).toHaveBeenCalledWith("target", { query: "Smoke" }, []);
    expect(await response.json()).toEqual({ items: [] });
  });
  it("preserves source management scope during a read-only inspection and audits no key", async () => {
    const input = {
      ruleId: "step",
      jenkinsJobUrl: "https://jenkins.internal/job/reset/",
      apiKeySource: { suiteId: "source", ruleId: "stored" },
    };
    const response = await POST(
      new Request(`${endpoint}/inspect`, {
        method: "POST",
        headers: { origin: "http://localhost", "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
      context,
    );
    expect(response.status).toBe(200);
    expect(getSummary).toHaveBeenCalledWith("target", ["managed"]);
    expect(inspect).toHaveBeenCalledWith({ id: "target", projectId: "managed" }, input, [
      "managed",
    ]);
    expect(JSON.stringify(recordAuthorizedOperation.mock.calls)).not.toContain("apiKey");
  });
  it("rejects anonymous requests, unavailable sources and oversized queries", async () => {
    authenticateRequest.mockRejectedValueOnce(new DomainError("AUTH_REQUIRED", "需要登录。"));
    expect((await GET(new Request(`${endpoint}/credentials`), context)).status).toBe(401);
    listSources.mockRejectedValueOnce(new DomainError("CASE_SUITE_NOT_FOUND", "无管理权限。"));
    expect((await GET(new Request(`${endpoint}/credentials`), context)).status).toBe(404);
    listSources.mockClear();
    expect(
      (await GET(new Request(`${endpoint}/credentials?query=${"x".repeat(121)}`), context)).status,
    ).toBe(400);
    expect(listSources).not.toHaveBeenCalled();
  });
});
