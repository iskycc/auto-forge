import { describe, expect, it, vi } from "vitest";

import { FailureAnalysisService } from "../src/manage-failure-analysis";
import type { FailureAnalysisRepository, JarObjectStorePort } from "../src/ports";

const NOW = new Date("2026-09-01T02:00:00.000Z");

describe("FailureAnalysisService", () => {
  it("deduplicates claims, records actor identity and reports competing claims", async () => {
    let sequence = 0;
    const claim = vi.fn(async (input) => ({
      claims: [
        {
          id: input.claims[0]!.id,
          projectId: input.projectId,
          batchId: input.batchId,
          executionRunId: "run-a",
          caseDefinitionId: "case-a",
          attemptId: "attempt-a",
          caseName: "失败用例 A",
          className: "example.FailedTest",
          attemptNumber: 1,
          failureSummary: "AssertionError",
          status: "claimed" as const,
          claimantId: input.claimantId,
          claimantUsername: input.claimantUsername,
          claimantDisplayName: input.claimantDisplayName,
          claimedAt: input.claimedAt,
          updatedAt: input.claimedAt,
        },
        {
          id: "existing-analysis",
          projectId: input.projectId,
          batchId: input.batchId,
          executionRunId: "run-b",
          caseDefinitionId: "case-b",
          attemptId: "attempt-b",
          caseName: "失败用例 B",
          className: "example.OtherTest",
          attemptNumber: 1,
          failureSummary: "Other assertion",
          status: "claimed" as const,
          claimantId: "another-user",
          claimantUsername: "c20002",
          claimantDisplayName: "其他分析员",
          claimedAt: input.claimedAt,
          updatedAt: input.claimedAt,
        },
      ],
      unavailableExecutionRunIds: ["run-b"],
    }));
    const service = createService({ claim }, () => `analysis-${++sequence}`);

    const result = await service.claim({
      projectId: "project-a",
      projectVersionId: "version-a",
      batchId: "batch-a",
      executionRunIds: ["run-a", "run-a", "run-b"],
      claimant: { id: "analyst", username: "c10001", displayName: "分析员" },
    });

    expect(claim).toHaveBeenCalledWith(
      expect.objectContaining({
        executionRunIds: ["run-a", "run-b"],
        projectVersionId: "version-a",
        claimantId: "analyst",
        claimantUsername: "c10001",
        claimantDisplayName: "分析员",
        claimedAt: NOW.toISOString(),
      }),
    );
    expect(result.claimed).toHaveLength(1);
    expect(result.conflicts).toEqual([
      { executionRunId: "run-b", claimantDisplayName: "其他分析员" },
    ]);
  });

  it("rejects an empty claim and a start that is not owned by the actor", async () => {
    const service = createService({ start: vi.fn(async () => null) });
    await expect(
      service.claim({
        projectId: "project-a",
        projectVersionId: "version-a",
        batchId: "batch-a",
        executionRunIds: [],
        claimant: { id: "analyst", username: "analyst", displayName: "分析员" },
      }),
    ).rejects.toMatchObject({ code: "FAILURE_ANALYSIS_CLAIM_SIZE_INVALID" });
    await expect(
      service.start({
        analysisId: "analysis-a",
        projectId: "project-a",
        claimantId: "analyst",
        category: "rerun_passed",
      }),
    ).rejects.toMatchObject({ code: "FAILURE_ANALYSIS_NOT_FOUND" });
  });

  it("enforces category-specific fields and the explicit case issue confirmation", async () => {
    const ownedClaim = failureAnalysisClaim();
    const service = createService({ findOwnedClaims: vi.fn(async () => [ownedClaim]) });

    await expect(
      service.complete({
        analysisIds: [ownedClaim.id],
        projectId: ownedClaim.projectId,
        claimant: { id: ownedClaim.claimantId, username: ownedClaim.claimantUsername },
        category: "case_fixed",
        issueDescription: "断言使用了过期字段",
        caseFixEvidence: "commit abc123",
        caseIssueConfirmed: false,
      }),
    ).rejects.toMatchObject({ code: "FAILURE_ANALYSIS_CASE_CONFIRMATION_REQUIRED" });

    await expect(
      service.complete({
        analysisIds: [ownedClaim.id],
        projectId: ownedClaim.projectId,
        claimant: { id: ownedClaim.claimantId, username: ownedClaim.claimantUsername },
        category: "code_issue_filed",
        issueDescription: "服务端返回值错误",
        caseIssueConfirmed: false,
      }),
    ).rejects.toMatchObject({ code: "FAILURE_ANALYSIS_CODE_FIELDS_REQUIRED" });
  });

  it("uses a successful public-log rerun as the permanent rerun proof", async () => {
    const ownedClaim = failureAnalysisClaim();
    const complete = vi.fn(async () => [ownedClaim]);
    const ensureSharesForAttempts = vi.fn(
      async () => new Map([["successful-rerun-attempt", "permanent-token"]]),
    );
    const service = createService(
      {
        findOwnedClaims: vi.fn(async () => [ownedClaim]),
        findSuccessfulManualRerunAttempts: vi.fn(
          async () => new Map([[ownedClaim.id, "successful-rerun-attempt"]]),
        ),
        complete,
      },
      undefined,
      undefined,
      { ensureSharesForAttempts },
    );

    await service.complete({
      analysisIds: [ownedClaim.id],
      projectId: ownedClaim.projectId,
      claimant: { id: ownedClaim.claimantId, username: ownedClaim.claimantUsername },
      category: "rerun_passed",
      remark: "环境恢复后通过",
      caseIssueConfirmed: false,
    });

    expect(ensureSharesForAttempts).toHaveBeenCalledWith(
      ["successful-rerun-attempt"],
      ownedClaim.claimantId,
    );
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "rerun_passed",
        rerunProofs: new Map([
          [
            ownedClaim.id,
            {
              attemptId: "successful-rerun-attempt",
              url: "/share/attempt-log/permanent-token",
            },
          ],
        ]),
      }),
    );
  });

  it("stores a pasted screenshot through the configured object store for every selected claim", async () => {
    const first = failureAnalysisClaim();
    const second = failureAnalysisClaim({ id: "analysis-b", executionRunId: "run-b" });
    const putObject = vi.fn(async (input: { objectKey: string }) => ({
      objectKey: input.objectKey,
      created: true,
    }));
    const attachScreenshot = vi.fn(async (input) =>
      [first, second].map((claim) => ({ ...claim, screenshot: input.screenshot })),
    );
    const service = createService(
      { findOwnedClaims: vi.fn(async () => [first, second]), attachScreenshot },
      () => "evidence-id",
      { putObject, read: vi.fn(), delete: vi.fn(async () => undefined) },
    );
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);

    const result = await service.uploadScreenshot({
      analysisIds: [first.id, second.id],
      projectId: first.projectId,
      claimantId: first.claimantId,
      fileName: "通过截图.png",
      mediaType: "image/png",
      content: png,
    });

    expect(putObject).toHaveBeenCalledWith(
      expect.objectContaining({
        objectKey: expect.stringContaining("projects/project-a/failure-analysis/batch-a/"),
        mediaType: "image/png",
        sizeBytes: png.byteLength,
      }),
    );
    expect(attachScreenshot).toHaveBeenCalledWith(
      expect.objectContaining({ analysisIds: [first.id, second.id] }),
    );
    expect(result.every((claim) => claim.screenshot?.mediaType === "image/png")).toBe(true);
  });
});

function createService(
  repository: Partial<FailureAnalysisRepository>,
  nextId: (() => string) | undefined = () => "analysis-a",
  objectStore?: Pick<JarObjectStorePort, "putObject" | "read" | "delete">,
  attemptLogShares?: {
    ensureSharesForAttempts: (
      attemptIds: readonly string[],
      actorId: string,
    ) => Promise<Map<string, string>>;
  },
): FailureAnalysisService {
  return new FailureAnalysisService(
    repository as FailureAnalysisRepository,
    { now: () => new Date(NOW.getTime()) },
    { next: nextId ?? (() => "analysis-a") },
    objectStore,
    attemptLogShares,
  );
}

function failureAnalysisClaim(
  overrides: Partial<ReturnType<typeof failureAnalysisClaimShape>> = {},
) {
  return { ...failureAnalysisClaimShape(), ...overrides };
}

function failureAnalysisClaimShape() {
  return {
    id: "analysis-a",
    projectId: "project-a",
    batchId: "batch-a",
    executionRunId: "run-a",
    caseDefinitionId: "case-a",
    attemptId: "attempt-a",
    caseName: "失败用例 A",
    className: "example.FailedTest",
    attemptNumber: 2,
    failureSummary: "AssertionError",
    status: "claimed" as const,
    claimantId: "analyst",
    claimantUsername: "c10001",
    claimantDisplayName: "分析员",
    claimedAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}
