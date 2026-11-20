import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "@autoforge/domain";
import { GET } from "../app/api/v1/run-batches/[batchId]/concurrency-diagnostics/route";

vi.mock("server-only", () => ({}));
const calls = vi.hoisted(() => ({
  authenticate: vi.fn(),
  scope: vi.fn(),
  metadata: vi.fn(),
  authorize: vi.fn(),
  read: vi.fn(),
  isBatchPublic: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ authenticateRequest: calls.authenticate }));
vi.mock("@/lib/services", () => ({
  getPlatformServices: async () => ({
    identityAccess: { projectScope: calls.scope, authorize: calls.authorize },
    runBatches: { getMetadata: calls.metadata },
    concurrencyDiagnostics: { read: calls.read },
    config: { masterKey: "a".repeat(64) },
    publicExecutionAccess: { isBatchPublic: calls.isBatchPublic },
  }),
}));
beforeEach(() => {
  vi.clearAllMocks();
  calls.authenticate.mockReset().mockResolvedValue({ user: { id: "user" } });
  calls.scope.mockReset().mockReturnValue(["project"]);
  calls.metadata.mockReset().mockResolvedValue({ id: "batch", projectId: "project" });
  calls.authorize.mockReset();
  calls.read.mockReset().mockResolvedValue({ batchId: "batch", runningRuns: 5 });
  calls.isBatchPublic.mockReset().mockResolvedValue(false);
});
const request = () =>
  new Request("http://localhost/api/v1/run-batches/batch/concurrency-diagnostics");
const context = { params: Promise.resolve({ batchId: "batch" }) };
describe("private concurrency diagnostic access", () => {
  it("checks project and node read permissions before reading diagnostics and disables caching", async () => {
    const response = await GET(request(), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(calls.scope).toHaveBeenCalledWith({ user: { id: "user" } }, "run.read");
    expect(calls.metadata).toHaveBeenCalledWith("batch", ["project"]);
    expect(calls.authorize).toHaveBeenCalledWith(
      { user: { id: "user" } },
      "runner.read",
      "project",
    );
    expect(calls.read).toHaveBeenCalledWith("batch", ["project"]);
  });
  it("only reads anonymous diagnostics for the published batch", async () => {
    calls.authenticate.mockRejectedValue(new DomainError("AUTH_REQUIRED", "Login required"));
    const sharedRequest = new Request(request().url + "?public=1");
    expect((await GET(sharedRequest, context)).ok).toBe(false);
    expect(calls.read).not.toHaveBeenCalled();
    calls.isBatchPublic.mockResolvedValue(true);
    expect((await GET(sharedRequest, context)).status).toBe(200);
    expect(calls.read).toHaveBeenCalledWith("batch", undefined);
    expect(calls.authenticate).not.toHaveBeenCalled();
  });
  it("rejects a foreign batch before reading infrastructure data", async () => {
    calls.metadata.mockRejectedValue(new DomainError("RUN_BATCH_NOT_FOUND", "Not found"));
    expect((await GET(request(), context)).status).toBe(404);
    expect(calls.authorize).not.toHaveBeenCalled();
    expect(calls.read).not.toHaveBeenCalled();
  });
  it("requires node read permission even when the batch is readable", async () => {
    calls.authorize.mockImplementation(() => {
      throw new DomainError("AUTH_FORBIDDEN", "Forbidden");
    });
    expect((await GET(request(), context)).status).toBe(403);
    expect(calls.read).not.toHaveBeenCalled();
  });
});
