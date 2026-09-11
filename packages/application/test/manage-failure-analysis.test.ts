import { createHash } from "node:crypto";
import type { FailureAnalysisClaim } from "@autoforge/domain";
import { describe, expect, it, vi } from "vitest";

import { FailureAnalysisService } from "../src/manage-failure-analysis";
import type { FailureAnalysisRepository, JarObjectStorePort } from "../src/ports";

const NOW = new Date("2026-09-01T02:00:00.000Z");

describe("FailureAnalysisService", () => {
  it("anchors previous executions to the claim in the authorized project", async () => {
    const getClaim = vi.fn(async () => failureAnalysisClaim());
    const listPreviousExecutions = vi.fn(async () => []);
    const service = createService({ getClaim, listPreviousExecutions });

    await expect(
      service.listPreviousExecutions({ projectId: "project-a", analysisId: "analysis-a" }),
    ).resolves.toEqual({ items: [] });
    expect(getClaim).toHaveBeenCalledWith("analysis-a", "project-a");
    expect(listPreviousExecutions).toHaveBeenCalledWith({
      projectId: "project-a",
      batchId: "batch-a",
      caseDefinitionId: "case-a",
      limit: 5,
    });
  });

  it("rejects missing or cross-project analysis anchors before reading execution history", async () => {
    const listPreviousExecutions = vi.fn(async () => []);
    const service = createService({ getClaim: vi.fn(async () => null), listPreviousExecutions });
    await expect(
      service.listPreviousExecutions({ projectId: "project-b", analysisId: "analysis-a" }),
    ).rejects.toMatchObject({ code: "FAILURE_ANALYSIS_NOT_FOUND" });
    expect(listPreviousExecutions).not.toHaveBeenCalled();
  });

  it("normalizes and bounds candidate and personal analysis search queries", async () => {
    const listCandidates = vi.fn(async () => ({ items: [] }));
    const listClaims = vi.fn(async () => ({ items: [] }));
    const service = createService({ listCandidates, listClaims });
    const oversizedQuery = `  ${"failure".repeat(50)}  `;

    await service.listCandidates({
      projectId: "project-a",
      projectVersionId: "version-a",
      batchId: "batch-a",
      query: oversizedQuery,
      limit: 500,
    });
    await service.listMyClaims({
      projectId: "project-a",
      projectVersionId: "version-a",
      claimantId: "analyst-a",
      batchId: "batch-a",
      query: oversizedQuery,
      limit: 500,
    });

    const expectedQuery = "failure".repeat(50).slice(0, 240);
    expect(listCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ query: expectedQuery, limit: 100 }),
    );
    expect(listClaims).toHaveBeenCalledWith(
      expect.objectContaining({ query: expectedQuery, limit: 100 }),
    );
  });

  it("marks personal claims when one of the five recent task executions succeeded", async () => {
    const claim = failureAnalysisClaim();
    const listClaims = vi.fn(async () => ({ items: [claim] }));
    const listRecentSuccessfulExecutions = vi.fn(async () => [
      {
        referenceId: claim.id,
        batchId: "successful-batch",
        batchSequenceNumber: 78,
        createdAt: "2026-08-31T02:00:00.000Z",
      },
    ]);
    const service = createService({ listClaims, listRecentSuccessfulExecutions });

    await expect(
      service.listMyClaims({
        projectId: claim.projectId,
        claimantId: claim.claimantId,
        batchId: claim.batchId,
      }),
    ).resolves.toEqual({
      items: [
        {
          ...claim,
          recentSuccessfulExecution: {
            batchId: "successful-batch",
            batchSequenceNumber: 78,
            createdAt: "2026-08-31T02:00:00.000Z",
          },
        },
      ],
    });
    expect(listRecentSuccessfulExecutions).toHaveBeenCalledWith({
      projectId: claim.projectId,
      anchors: [
        {
          referenceId: claim.id,
          batchId: claim.batchId,
          caseDefinitionId: claim.caseDefinitionId,
        },
      ],
      limitPerCase: 5,
    });
  });

  it("marks claim candidates when one of the five recent task executions succeeded", async () => {
    const candidate = {
      executionRunId: "run-a",
      caseDefinitionId: "case-a",
      attemptId: "attempt-a",
      caseName: "失败用例 A",
      className: "example.FailedTest",
      attemptNumber: 2,
      failureSummary: "AssertionError",
    };
    const listCandidates = vi.fn(async () => ({ items: [candidate] }));
    const listRecentSuccessfulExecutions = vi.fn(async () => [
      {
        referenceId: candidate.executionRunId,
        batchId: "successful-batch",
        batchSequenceNumber: 78,
        createdAt: "2026-08-31T02:00:00.000Z",
      },
    ]);
    const service = createService({ listCandidates, listRecentSuccessfulExecutions });

    await expect(
      service.listCandidates({
        projectId: "project-a",
        projectVersionId: "version-a",
        batchId: "batch-a",
      }),
    ).resolves.toEqual({
      items: [
        {
          ...candidate,
          recentSuccessfulExecution: {
            batchId: "successful-batch",
            batchSequenceNumber: 78,
            createdAt: "2026-08-31T02:00:00.000Z",
          },
        },
      ],
    });
    expect(listRecentSuccessfulExecutions).toHaveBeenCalledWith({
      projectId: "project-a",
      anchors: [
        {
          referenceId: candidate.executionRunId,
          batchId: "batch-a",
          caseDefinitionId: candidate.caseDefinitionId,
        },
      ],
      limitPerCase: 5,
    });
  });

  it("loads export claims by indexed execution run ids and deduplicates the query", async () => {
    const requestedExecutionRunIds: string[][] = [];
    const findClaimsByExecutionRunIds = vi.fn(
      async (input: Parameters<FailureAnalysisRepository["findClaimsByExecutionRunIds"]>[0]) => {
        requestedExecutionRunIds.push([...input.executionRunIds]);
        return [];
      },
    );
    const service = createService({ findClaimsByExecutionRunIds });

    await service.listExportClaims({
      projectId: "project-a",
      batchId: "batch-a",
      executionRunIds: ["run-a", "run-b", "run-a"],
    });

    expect(findClaimsByExecutionRunIds).toHaveBeenCalledTimes(1);
    expect(requestedExecutionRunIds[0]).toEqual(["run-a", "run-b"]);
  });

  it.each(["same_case", "task_recent_batches"] as const)(
    "carries the %s conclusion scope into the transactional completion check",
    async (inheritanceScope) => {
      const claim = failureAnalysisClaim();
      const complete = vi.fn(async () => [claim]);
      const service = createService({ findOwnedClaims: vi.fn(async () => [claim]), complete });
      await service.complete({
        analysisIds: [claim.id],
        projectId: claim.projectId,
        claimant: { id: claim.claimantId, username: claim.claimantUsername },
        inheritedFromAnalysisId: "same-task-case-history",
        inheritanceScope,
        category: "code_issue_filed",
        issueDescription: "Same root cause",
        ticketReference: "BUG-1",
        caseIssueConfirmed: false,
      });
      expect(complete).toHaveBeenCalledWith(
        expect.objectContaining({
          inheritedFromAnalysisId: "same-task-case-history",
          inheritanceScope,
          analysisIds: [claim.id],
        }),
      );
    },
  );

  it("preserves the explicit task batch scope when searching conclusions", async () => {
    const listCompletedConclusions = vi.fn(async () => ({ items: [] }));
    const service = createService({ listCompletedConclusions });
    await service.listCompletedConclusions({
      projectId: "project-a",
      batchId: "batch-a",
      caseDefinitionId: "case-a",
      scope: "task_recent_batches",
      query: " BUG-1 ",
      limit: 500,
    });
    expect(listCompletedConclusions).toHaveBeenCalledWith({
      projectId: "project-a",
      batchId: "batch-a",
      caseDefinitionId: "case-a",
      scope: "task_recent_batches",
      query: "BUG-1",
      limit: 100,
    });
  });

  it("pages unique task cases and only loads the selected case history within the task window", async () => {
    const listTaskConclusionCases = vi.fn(async () => ({ items: [] }));
    const listCompletedConclusions = vi.fn(async () => ({ items: [] }));
    const service = createService({ listTaskConclusionCases, listCompletedConclusions });
    await service.listTaskConclusionCases({
      projectId: "project-a",
      batchId: "batch-a",
      query: `  ${"query".repeat(100)}  `,
      limit: 500,
      cursor: "cursor-a",
    });
    expect(listTaskConclusionCases).toHaveBeenCalledWith({
      projectId: "project-a",
      batchId: "batch-a",
      query: "query".repeat(40),
      limit: 100,
      cursor: "cursor-a",
    });
    await service.listTaskCaseConclusionHistory({
      projectId: "project-a",
      batchId: "batch-a",
      caseDefinitionId: "case-b",
    });
    expect(listCompletedConclusions).toHaveBeenCalledWith({
      projectId: "project-a",
      batchId: "batch-a",
      caseDefinitionId: "case-b",
      caseDefinitionFilter: "case-b",
      scope: "task_recent_batches",
      limit: 5,
    });
  });

  it("bounds and deduplicates historical analysis queries", async () => {
    const listCaseHistory = vi.fn(async () => ({ items: [] }));
    const listRecentCaseHistories = vi.fn(async () => []);
    const listCompletedConclusions = vi.fn(async () => ({ items: [] }));
    const service = createService({
      listCaseHistory,
      listRecentCaseHistories,
      listCompletedConclusions,
    });

    await service.listCaseHistory({
      projectId: "project-a",
      caseDefinitionId: "case-a",
      limit: 500,
    });
    await service.listRecentCaseHistories({
      projectId: "project-a",
      batchId: "batch-a",
      caseDefinitionIds: ["case-a", "case-b", "case-a"],
      limitPerCase: 50,
    });
    await service.listCompletedConclusions({
      projectId: "project-a",
      batchId: "batch-a",
      caseDefinitionId: "case-a",
      query: `  ${"根因".repeat(120)}  `,
      limit: 500,
    });

    expect(listCaseHistory).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-a", caseDefinitionId: "case-a", limit: 100 }),
    );
    expect(listRecentCaseHistories).toHaveBeenCalledWith({
      projectId: "project-a",
      batchId: "batch-a",
      caseDefinitionIds: ["case-a", "case-b"],
      limitPerCase: 10,
    });
    expect(listCompletedConclusions).toHaveBeenCalledWith({
      projectId: "project-a",
      batchId: "batch-a",
      caseDefinitionId: "case-a",
      query: "根因".repeat(100),
      limit: 100,
    });
    expect(() =>
      service.listRecentCaseHistories({
        projectId: "project-a",
        batchId: "batch-a",
        caseDefinitionIds: [],
      }),
    ).toThrowError(expect.objectContaining({ code: "FAILURE_ANALYSIS_HISTORY_SELECTION_INVALID" }));
  });

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

  it("requires a reason and only releases a claim owned by the actor", async () => {
    const release = vi.fn(async (input) => ({
      id: input.id,
      analysisId: input.analysisId,
      projectId: input.projectId,
      batchId: "batch-a",
      executionRunId: "run-a",
      caseDefinitionId: "case-a",
      claimantId: input.claimantId,
      claimantUsername: "c10001",
      claimantDisplayName: "分析员",
      reason: input.reason,
      claimedAt: "2026-09-01T01:00:00.000Z",
      releasedAt: input.releasedAt,
    }));
    const service = createService({ release }, () => "release-a");

    await expect(
      service.releaseClaim({
        analysisId: "analysis-a",
        projectId: "project-a",
        claimantId: "analyst",
        reason: "   ",
      }),
    ).rejects.toMatchObject({ code: "FAILURE_ANALYSIS_RELEASE_REASON_REQUIRED" });

    await expect(
      service.releaseClaim({
        analysisId: "analysis-a",
        projectId: "project-a",
        claimantId: "analyst",
        reason: "  误领，需要交接  ",
      }),
    ).resolves.toMatchObject({
      id: "release-a",
      reason: "误领，需要交接",
      releasedAt: NOW.toISOString(),
    });
    expect(release).toHaveBeenCalledWith({
      id: "release-a",
      analysisId: "analysis-a",
      projectId: "project-a",
      claimantId: "analyst",
      reason: "误领，需要交接",
      releasedAt: NOW.toISOString(),
    });

    const rejectedService = createService({ release: vi.fn(async () => null) });
    await expect(
      rejectedService.releaseClaim({
        analysisId: "analysis-a",
        projectId: "project-a",
        claimantId: "another-user",
        reason: "尝试取消他人的认领",
      }),
    ).rejects.toMatchObject({ code: "FAILURE_ANALYSIS_RELEASE_NOT_ALLOWED" });
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

  it("looks up successful rerun proofs before completion and reports missing cases", async () => {
    const first = failureAnalysisClaim();
    const second = failureAnalysisClaim({
      id: "analysis-b",
      executionRunId: "run-b",
      caseDefinitionId: "case-b",
      caseName: "失败用例 B",
    });
    const ensureSharesForAttempts = vi.fn(
      async () => new Map([["successful-rerun-attempt", "permanent-token"]]),
    );
    const service = createService(
      {
        findOwnedClaims: vi.fn(async () => [first, second]),
        findSuccessfulManualRerunAttempts: vi.fn(
          async () => new Map([[first.id, "successful-rerun-attempt"]]),
        ),
      },
      undefined,
      undefined,
      { ensureSharesForAttempts },
    );

    await expect(
      service.lookupRerunProofs({
        analysisIds: [first.id, second.id],
        projectId: first.projectId,
        claimantId: first.claimantId,
      }),
    ).resolves.toEqual([
      {
        analysisId: first.id,
        status: "found",
        attemptId: "successful-rerun-attempt",
        url: "/share/attempt-log/permanent-token",
      },
      { analysisId: second.id, status: "missing" },
    ]);
    expect(ensureSharesForAttempts).toHaveBeenCalledWith(
      ["successful-rerun-attempt"],
      first.claimantId,
    );
  });

  it("rejects rerun completion when lookup is missing and no screenshot was submitted", async () => {
    const ownedClaim = failureAnalysisClaim();
    const complete = vi.fn(async () => [ownedClaim]);
    const service = createService({
      findOwnedClaims: vi.fn(async () => [ownedClaim]),
      findSuccessfulManualRerunAttempts: vi.fn(async () => new Map()),
      complete,
    });

    await expect(
      service.complete({
        analysisIds: [ownedClaim.id],
        projectId: ownedClaim.projectId,
        claimant: { id: ownedClaim.claimantId, username: ownedClaim.claimantUsername },
        category: "rerun_passed",
        caseIssueConfirmed: false,
      }),
    ).rejects.toMatchObject({ code: "FAILURE_ANALYSIS_RERUN_PROOF_REQUIRED" });
    expect(complete).not.toHaveBeenCalled();
  });

  it("accepts a screenshot when no successful rerun record exists", async () => {
    const ownedClaim = {
      ...failureAnalysisClaim(),
      screenshot: {
        objectKey: "projects/project-a/failure-analysis/batch-a/proof.png",
        fileName: "通过截图.png",
        mediaType: "image/png" as const,
        sizeBytes: 128,
        sha256: "a".repeat(64),
      },
    };
    const complete = vi.fn(async () => [ownedClaim]);
    const service = createService({
      findOwnedClaims: vi.fn(async () => [ownedClaim]),
      findSuccessfulManualRerunAttempts: vi.fn(async () => new Map()),
      complete,
    });

    await expect(
      service.complete({
        analysisIds: [ownedClaim.id],
        projectId: ownedClaim.projectId,
        claimant: { id: ownedClaim.claimantId, username: ownedClaim.claimantUsername },
        category: "rerun_passed",
        caseIssueConfirmed: false,
      }),
    ).resolves.toEqual([ownedClaim]);
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ rerunProofs: new Map() }));
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

  it("saves remark images once for a batch and keeps them separate from rerun proof", async () => {
    const claim = failureAnalysisClaim();
    const complete = vi.fn<FailureAnalysisRepository["complete"]>(async () => [claim]);
    const putObject = vi.fn(async (input: { objectKey: string }) => ({
      objectKey: input.objectKey,
      created: true,
    }));
    const service = createService(
      { findOwnedClaims: vi.fn(async () => [claim]), complete },
      () => "remark-image",
      { putObject, read: vi.fn(), delete: vi.fn() },
    );
    await service.complete(remarkCompletionInput());
    expect(putObject).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        remark: "排查截图",
        remarkImages: [expect.objectContaining({ id: "remark-image", fileName: "remark.png" })],
        rerunProofs: new Map(),
      }),
    );
    expect(complete.mock.calls[0]?.[0]).not.toHaveProperty("screenshot");
  });

  it("validates every remark image before uploading or completing any claim", async () => {
    const complete = vi.fn();
    const putObject = vi.fn();
    const service = createService(
      { findOwnedClaims: vi.fn(async () => [failureAnalysisClaim()]), complete },
      undefined,
      { putObject, read: vi.fn(), delete: vi.fn() },
    );
    const input = remarkCompletionInput();
    await expect(
      service.complete({
        ...input,
        remarkImages: [
          ...input.remarkImages,
          { fileName: "fake.png", mediaType: "image/png", content: new Uint8Array([1, 2, 3]) },
        ],
      }),
    ).rejects.toMatchObject({ code: "FAILURE_ANALYSIS_SCREENSHOT_CONTENT_INVALID" });
    await expect(
      service.complete({ ...input, remarkImages: Array(9).fill(input.remarkImages[0]) }),
    ).rejects.toMatchObject({ code: "FAILURE_ANALYSIS_REMARK_IMAGES_LIMIT" });
    expect(putObject).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("removes uploaded remark objects when the completion transaction fails", async () => {
    const persistenceError = new Error("analysis changed while uploading");
    const remove = vi.fn(async () => undefined);
    const service = createService(
      {
        findOwnedClaims: vi.fn(async () => [failureAnalysisClaim()]),
        complete: vi.fn(async () => {
          throw persistenceError;
        }),
      },
      () => "remark-image",
      {
        putObject: vi.fn(async (input: { objectKey: string }) => ({
          objectKey: input.objectKey,
          created: true,
        })),
        read: vi.fn(),
        delete: remove,
      },
    );
    await expect(service.complete(remarkCompletionInput())).rejects.toBe(persistenceError);
    expect(remove).toHaveBeenCalledWith(expect.stringContaining("remark-image"));
  });

  it("does not accept a remark image as proof of a successful rerun", async () => {
    const putObject = vi.fn();
    const service = createService(
      {
        findOwnedClaims: vi.fn(async () => [failureAnalysisClaim()]),
        findSuccessfulManualRerunAttempts: vi.fn(async () => new Map()),
      },
      undefined,
      { putObject, read: vi.fn(), delete: vi.fn() },
    );
    await expect(
      service.complete({ ...remarkCompletionInput(), category: "rerun_passed" }),
    ).rejects.toMatchObject({ code: "FAILURE_ANALYSIS_RERUN_PROOF_REQUIRED" });
    expect(putObject).not.toHaveBeenCalled();
  });

  it("preserves remark objects if a failed commit acknowledgement actually saved their references", async () => {
    let claim: FailureAnalysisClaim = failureAnalysisClaim();
    const remove = vi.fn();
    const commitError = new Error("connection lost after commit");
    const service = createService(
      {
        findOwnedClaims: vi.fn(async () => [claim]),
        complete: vi.fn(async (input) => {
          claim = { ...claim, status: "completed", remarkImages: input.remarkImages ?? [] };
          throw commitError;
        }),
      },
      () => "remark-image",
      {
        putObject: vi.fn(async (input) => ({ objectKey: input.objectKey, created: true })),
        read: vi.fn(),
        delete: remove,
      },
    );
    await expect(service.complete(remarkCompletionInput())).rejects.toBe(commitError);
    expect(remove).not.toHaveBeenCalled();
    expect(claim.remarkImages).toHaveLength(1);
  });

  it("reads remark images only through an authorized claim and verifies stored bytes", async () => {
    const content = remarkCompletionInput().remarkImages[0]!.content;
    const image = {
      id: "remark-image",
      objectKey: "private/remark.png",
      fileName: "remark.png",
      mediaType: "image/png" as const,
      sizeBytes: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
    const getClaim = vi.fn(async (_id: string, projectId: string) =>
      projectId === "project-a" ? { ...failureAnalysisClaim(), remarkImages: [image] } : null,
    );
    const read = vi.fn(async () => content);
    const service = createService({ getClaim }, undefined, {
      putObject: vi.fn(),
      read,
      delete: vi.fn(),
    });
    expect(await service.readRemarkImage("analysis-a", "another-project", image.id)).toBeNull();
    expect(await service.readRemarkImage("analysis-a", "project-a", "missing-image")).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(await service.readRemarkImage("analysis-a", "project-a", image.id)).toMatchObject({
      ...image,
      content,
    });
    read.mockResolvedValueOnce(new Uint8Array(content.byteLength));
    await expect(
      service.readRemarkImage("analysis-a", "project-a", image.id),
    ).rejects.toMatchObject({ code: "FAILURE_ANALYSIS_EVIDENCE_CORRUPT" });
  });
});

function remarkCompletionInput() {
  return {
    projectId: "project-a",
    analysisIds: ["analysis-a"],
    claimant: { id: "analyst", username: "c10001" },
    category: "code_issue_filed" as const,
    issueDescription: "代码错误",
    ticketReference: "BUG-2048",
    remark: "排查截图",
    caseIssueConfirmed: false,
    remarkImages: [
      {
        fileName: "remark.png",
        mediaType: "image/png",
        content: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]),
      },
    ],
  };
}

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
