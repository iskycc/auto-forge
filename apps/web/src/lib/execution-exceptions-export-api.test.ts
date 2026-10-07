import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "@autoforge/domain";
vi.mock("server-only", () => ({}));
const { authenticateRequest, projectScope, executionExceptionExport, readToken } = vi.hoisted(
  () => ({
    authenticateRequest: vi.fn(),
    projectScope: vi.fn(),
    executionExceptionExport: vi.fn(),
    readToken: vi.fn(),
  }),
);
vi.mock("./auth", () => ({ authenticateRequest }));
vi.mock("./permanent-share-token", () => ({ readPermanentShareToken: readToken }));
vi.mock("./services", () => ({
  getPlatformServices: async () => ({
    config: { masterKey: "fixture" },
    identityAccess: { projectScope },
    executionExceptionExport,
  }),
}));
import { GET } from "../app/api/v1/run-batches/[batchId]/exceptions/export/route";
const context = { params: Promise.resolve({ batchId: "batch" }) };
const request = (query = "") =>
  new Request(`http://localhost/api/v1/run-batches/batch/exceptions/export${query}`);
beforeEach(() => {
  vi.resetAllMocks();
  authenticateRequest.mockResolvedValue({ user: { id: "reader" } });
  projectScope.mockReturnValue(["project"]);
  readToken.mockReturnValue("batch");
  const firstPage = {
    batchId: "batch",
    status: "failed",
    expectedStatus: "failed",
    consistent: true,
    abnormalRuns: 0,
    items: [],
  };
  executionExceptionExport.mockImplementation(async () => ({
    firstPage,
    pages: (async function* () {
      yield firstPage;
    })(),
  }));
});
describe("execution exception export authorization", () => {
  it("preserves empty read scopes, downloads XLSX and prohibits caching", async () => {
    projectScope.mockReturnValue([]);
    const response = await GET(request("?time_zone=Asia%2FShanghai"), context);
    expect(response.status).toBe(200);
    expect(projectScope).toHaveBeenCalledWith({ user: { id: "reader" } }, "run.read");
    expect(executionExceptionExport).toHaveBeenCalledWith({ batchId: "batch", projectIds: [] });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-type")).toContain("spreadsheetml.sheet");
    expect(response.headers.get("content-disposition")).toContain("exceptions.xlsx");
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(100);
  });
  it("accepts the batch share token without granting cross-batch access", async () => {
    const response = await GET(request("?access_token=share"), context);
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    expect(authenticateRequest).not.toHaveBeenCalled();
    expect(executionExceptionExport).toHaveBeenCalledWith({ batchId: "batch" });
    executionExceptionExport.mockClear();
    readToken.mockReturnValue("other");
    expect((await GET(request("?access_token=share"), context)).status).toBe(400);
    expect(executionExceptionExport).not.toHaveBeenCalled();
  });
  it("rejects anonymous, cross-project and unknown batches before starting a stream", async () => {
    authenticateRequest.mockRejectedValueOnce(new DomainError("AUTH_REQUIRED", "需要登录。"));
    expect((await GET(request(), context)).status).toBe(401);
    expect(executionExceptionExport).not.toHaveBeenCalled();
    executionExceptionExport.mockRejectedValueOnce(
      new DomainError("RUN_BATCH_NOT_FOUND", "无权访问。"),
    );
    expect((await GET(request(), context)).status).toBe(404);
  });
  it.each(["?time_zone=invalid-zone", "?cursor=page-two", "?access_token="])(
    "rejects invalid export queries %s",
    async (query) => {
      expect((await GET(request(query), context)).status).toBe(400);
      expect(executionExceptionExport).not.toHaveBeenCalled();
    },
  );
});
