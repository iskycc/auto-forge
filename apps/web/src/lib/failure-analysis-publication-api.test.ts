import { describe, expect, it, vi } from "vitest";
import { DomainError } from "@autoforge/domain";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), batch: vi.fn() }));
vi.mock("./auth", () => ({
  authenticateRequest: mocks.authenticate,
  authorizedProjectScope: vi.fn(),
  requireSameOrigin: vi.fn(),
  requestId: () => "publication-request",
}));
vi.mock("./services", () => ({
  getPlatformServices: async () => ({ analysisPublications: { requireBatch: mocks.batch } }),
}));
import {
  GET,
  POST,
  DELETE,
} from "../app/api/v1/failure-analysis/batches/[batchId]/publication/route";

describe("failure analysis publication authentication", () => {
  it.each([
    ["GET", GET],
    ["POST", POST],
    ["DELETE", DELETE],
  ] as const)("authenticates %s before querying a missing batch", async (method, handler) => {
    mocks.batch.mockClear();
    mocks.authenticate.mockRejectedValue(new DomainError("AUTH_REQUIRED", "请先登录。"));
    const response = await handler(
      new Request("http://localhost/api/v1/failure-analysis/batches/missing/publication", {
        method,
      }),
      {
        params: Promise.resolve({ batchId: "missing" }),
      },
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "AUTH_REQUIRED" } });
    expect(mocks.batch).not.toHaveBeenCalled();
  });
});
