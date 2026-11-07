import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "@autoforge/domain";
const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  authorize: vi.fn(),
  origin: vi.fn(),
  scope: vi.fn(),
  batch: vi.fn(),
  read: vi.fn(),
  claim: vi.fn(),
  complete: vi.fn(),
  owned: vi.fn(),
  proof: vi.fn(),
  writable: vi.fn(),
  logs: vi.fn(),
  attempt: vi.fn(),
  getClaim: vi.fn(),
  image: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("./auth", () => ({
  authenticateRequest: mocks.authenticate,
  authorizedProjectScope: mocks.authorize,
  requireSameOrigin: mocks.origin,
  requestId: () => "sheet-request",
}));
vi.mock("./services", () => ({
  getPlatformServices: async () => ({
    analysisPublications: {
      requirePublic: mocks.scope,
      requireBatch: mocks.batch,
      requireFailureAttempt: mocks.attempt,
    },
    analysisSheet: {
      read: mocks.read,
      complete: mocks.complete,
      requireOwned: mocks.owned,
      requireWritable: mocks.writable,
      requireClaim: mocks.getClaim,
    },
    failureAnalysis: { claim: mocks.claim, readScreenshot: mocks.image },
    executionControl: { listLogs: mocks.logs },
    identityAccess: { recordAuthorizedOperation: mocks.audit },
  }),
}));
import {
  changeAnalysisSheet,
  readAnalysisSheet,
  readAnalysisSheetResource,
} from "./failure-analysis-sheet-http";
const scope = {
  projectId: "project",
  projectVersionId: "version",
  batchId: "batch",
  suiteName: "task",
  sequenceNumber: 1,
};
const actor = {
  sessionId: "session",
  user: { id: "viewer", username: "viewer", displayName: "Viewer" },
};
function request(body?: unknown, query = "") {
  return new Request(
    `http://localhost/api${query}`,
    body
      ? {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://localhost" },
          body: JSON.stringify(body),
        }
      : undefined,
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.scope.mockResolvedValue(scope);
  mocks.batch.mockResolvedValue(scope);
  mocks.authenticate.mockResolvedValue(actor);
  mocks.authorize.mockResolvedValue(actor);
  mocks.read.mockResolvedValue({ items: [] });
  mocks.claim.mockResolvedValue({ claimed: [], conflicts: [] });
});
describe("public analysis HTTP boundary", () => {
  it("authenticates private reads and all writes before looking up any batch", async () => {
    mocks.authenticate.mockRejectedValue(new DomainError("AUTH_REQUIRED", "请先登录"));
    mocks.batch.mockRejectedValue(new DomainError("FAILURE_ANALYSIS_NOT_FOUND", "不存在"));
    mocks.scope.mockRejectedValue(new DomainError("FAILURE_ANALYSIS_PUBLIC_NOT_FOUND", "不存在"));
    expect((await readAnalysisSheet(request(), "missing", "project")).status).toBe(401);
    expect((await readAnalysisSheetResource(request(), "missing", "logs", "project")).status).toBe(
      401,
    );
    for (const access of ["project", "published"] as const)
      expect((await changeAnalysisSheet(request({}), "missing", "claim", access)).status).toBe(401);
    expect(mocks.batch).not.toHaveBeenCalled();
    expect(mocks.scope).not.toHaveBeenCalled();
  });

  it("lets anonymous visitors read only an explicitly published scope", async () => {
    expect((await readAnalysisSheet(request(), "batch", "published")).status).toBe(200);
    expect(mocks.authenticate).not.toHaveBeenCalled();
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.read).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ limit: 50 }),
      undefined,
    );
    mocks.scope.mockRejectedValue(
      new DomainError("FAILURE_ANALYSIS_PUBLIC_NOT_FOUND", "链接已撤销"),
    );
    expect((await readAnalysisSheet(request(), "batch", "published")).status).toBe(404);
    expect(mocks.read).toHaveBeenCalledTimes(1);
  });
  it("requires login for every write and personal-claim query, and rejects service tokens", async () => {
    mocks.authenticate.mockRejectedValue(new DomainError("AUTH_REQUIRED", "请登录"));
    for (const action of ["claim", "complete", "proof", "release", "rerun-proofs"])
      expect(
        (
          await changeAnalysisSheet(
            request({ executionRunIds: ["run"] }),
            "batch",
            action,
            "published",
          )
        ).status,
      ).toBe(401);
    expect(
      (await readAnalysisSheet(request(undefined, "?view=mine"), "batch", "published")).status,
    ).toBe(401);
    mocks.authenticate.mockResolvedValue({ ...actor, sessionId: "api-token:narrow" });
    expect(
      (
        await changeAnalysisSheet(
          request({ executionRunIds: ["run"] }),
          "batch",
          "claim",
          "published",
        )
      ).status,
    ).toBe(401);
    expect(mocks.claim).not.toHaveBeenCalled();
  });
  it("keeps private APIs protected and takes public write identity and scope only from the server", async () => {
    expect(
      (
        await changeAnalysisSheet(
          request({ executionRunIds: ["run"] }),
          "batch",
          "claim",
          "project",
        )
      ).status,
    ).toBe(200);
    expect(mocks.authorize).toHaveBeenCalledWith(actor, "analysis.manage", "project");
    mocks.authorize.mockClear();
    expect(
      (
        await changeAnalysisSheet(
          request({ executionRunIds: ["run"] }),
          "batch",
          "claim",
          "published",
        )
      ).status,
    ).toBe(200);
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.claim).toHaveBeenLastCalledWith(
      expect.objectContaining({ ...scope, claimant: actor.user }),
    );
    expect(
      (
        await changeAnalysisSheet(
          request({ executionRunIds: ["run"], projectId: "other", claimantId: "admin" }),
          "batch",
          "claim",
          "published",
        )
      ).status,
    ).toBe(400);
  });
  it("rejects cross-origin, oversized pages, unlisted operations and revoked links before mutation", async () => {
    expect(
      (await readAnalysisSheet(request(undefined, "?limit=1000"), "batch", "published")).status,
    ).toBe(400);
    expect((await changeAnalysisSheet(request({}), "batch", "assign", "published")).status).toBe(
      404,
    );
    mocks.origin.mockImplementationOnce(() => {
      throw new DomainError("CSRF_REJECTED", "来源无效");
    });
    expect(
      (
        await changeAnalysisSheet(
          request({ executionRunIds: ["run"] }),
          "batch",
          "claim",
          "published",
        )
      ).status,
    ).toBe(403);
    mocks.scope.mockRejectedValue(new DomainError("FAILURE_ANALYSIS_PUBLIC_NOT_FOUND", "已撤销"));
    expect(
      (
        await changeAnalysisSheet(
          request({ executionRunIds: ["run"] }),
          "batch",
          "claim",
          "published",
        )
      ).status,
    ).toBe(404);
    expect(mocks.claim).not.toHaveBeenCalled();
  });
  it("bounds logs to a final failure in this batch and rejects cross-batch evidence", async () => {
    mocks.attempt.mockResolvedValue("attempt");
    mocks.logs.mockResolvedValue({ items: [], truncated: false });
    expect(
      (
        await readAnalysisSheetResource(
          request(undefined, "?executionRunId=run&stream=stdout"),
          "batch",
          "logs",
          "published",
        )
      ).status,
    ).toBe(200);
    expect(mocks.logs).toHaveBeenCalledWith(
      expect.objectContaining({ attemptId: "attempt", projectIds: ["project"], limit: 200 }),
    );
    mocks.attempt.mockRejectedValue(new DomainError("RUN_ATTEMPT_NOT_FOUND", "不在本任务"));
    expect(
      (
        await readAnalysisSheetResource(
          request(undefined, "?executionRunId=other"),
          "batch",
          "logs",
          "published",
        )
      ).status,
    ).toBe(404);
    mocks.getClaim.mockRejectedValue(new DomainError("FAILURE_ANALYSIS_NOT_FOUND", "不在本任务"));
    expect(
      (
        await readAnalysisSheetResource(
          request(undefined, "?analysisId=other"),
          "batch",
          "evidence",
          "published",
        )
      ).status,
    ).toBe(404);
    expect(mocks.image).not.toHaveBeenCalled();
  });
});
