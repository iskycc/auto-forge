import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "@autoforge/domain";
vi.mock("server-only", () => ({}));
const { authenticateRequest, projectScope, executionExceptions, readToken } = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  projectScope: vi.fn(),
  executionExceptions: vi.fn(),
  readToken: vi.fn(),
}));
vi.mock("./auth", () => ({ authenticateRequest }));
vi.mock("./permanent-share-token", () => ({ readPermanentShareToken: readToken }));
vi.mock("./services", () => ({
  getPlatformServices: async () => ({
    config: { masterKey: "fixture" },
    identityAccess: { projectScope },
    executionExceptions,
  }),
}));
import { GET } from "../app/api/v1/run-batches/[batchId]/exceptions/route";
const context = { params: Promise.resolve({ batchId: "batch" }) };
const request = (query = "") =>
  new Request(`http://localhost/api/v1/run-batches/batch/exceptions${query}`);
beforeEach(() => {
  vi.resetAllMocks();
  authenticateRequest.mockResolvedValue({ user: { id: "reader" } });
  projectScope.mockReturnValue(["project"]);
  executionExceptions.mockResolvedValue({ items: [] });
  readToken.mockReturnValue("batch");
});
describe("execution exception read authorization", () => {
  it("requires run read scope, preserves an empty scope and disables caching", async () => {
    projectScope.mockReturnValue([]);
    const response = await GET(request(), context);
    expect(response.status).toBe(200);
    expect(projectScope).toHaveBeenCalledWith({ user: { id: "reader" } }, "run.read");
    expect(executionExceptions).toHaveBeenCalledWith({
      batchId: "batch",
      limit: 50,
      projectIds: [],
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it("accepts only the requested batch's read-only share token", async () => {
    expect((await GET(request("?access_token=shared"), context)).status).toBe(200);
    expect(authenticateRequest).not.toHaveBeenCalled();
    readToken.mockReturnValue("other");
    executionExceptions.mockClear();
    expect((await GET(request("?access_token=shared"), context)).status).toBe(400);
    expect(executionExceptions).not.toHaveBeenCalled();
  });
  it("validates and forwards the terminal preview filter", async () => {
    expect((await GET(request("?scope=terminal&limit=3"), context)).status).toBe(200);
    expect(executionExceptions).toHaveBeenCalledWith({
      batchId: "batch",
      projectIds: ["project"],
      scope: "terminal",
      limit: 3,
    });
    executionExceptions.mockClear();
    expect((await GET(request("?scope=invalid"), context)).status).toBe(400);
    expect(executionExceptions).not.toHaveBeenCalled();
  });
  it("rejects anonymous reads and oversized pages", async () => {
    authenticateRequest.mockRejectedValue(new DomainError("AUTH_REQUIRED", "需要登录。"));
    expect((await GET(request(), context)).status).toBe(401);
    expect((await GET(request("?limit=101"), context)).status).toBe(400);
    expect(executionExceptions).not.toHaveBeenCalled();
  });
});
