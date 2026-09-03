import type { FailureAnalysisRepository } from "@autoforge/application";
import { describe, expect, it } from "vitest";

export type FailureAnalysisHarness = {
  repository: FailureAnalysisRepository;
  projectId: string;
  projectVersionId: string;
  batchId: string;
  activeBatchId: string;
  excludedBatchIds: [string, string];
  runIds: [string, string, string];
  readClaimReleaseReason(analysisId: string): Promise<string | undefined>;
  seedSuccessfulManualRerun(sourceExecutionRunId: string): Promise<string>;
  dispose(): Promise<void>;
};

export function failureAnalysisContract(
  name: string,
  createHarness: () => Promise<FailureAnalysisHarness>,
): void {
  describe(name, () => {
    it("persists exclusive claims and their selected analysis category", async () => {
      const harness = await createHarness();
      const {
        repository,
        projectId,
        projectVersionId,
        batchId,
        activeBatchId,
        excludedBatchIds,
        runIds,
      } = harness;
      try {
        const batches = await repository.listBatches({
          projectId,
          projectVersionId,
          limit: 10,
        });
        expect(batches.items).toEqual([
          expect.objectContaining({ id: batchId, failedRuns: 3, suiteName: "失败分析任务" }),
        ]);
        await expect(
          repository.listCandidates({
            projectId,
            projectVersionId,
            batchId: activeBatchId,
            sort: "class_path",
            direction: "asc",
            limit: 10,
          }),
        ).resolves.toBeNull();
        for (const excludedBatchId of excludedBatchIds) {
          await expect(
            repository.listCandidates({
              projectId,
              projectVersionId,
              batchId: excludedBatchId,
              sort: "class_path",
              direction: "asc",
              limit: 10,
            }),
          ).resolves.toBeNull();
        }
        await expect(
          repository.listCandidates({
            projectId,
            projectVersionId: "another-version",
            batchId,
            sort: "class_path",
            direction: "asc",
            limit: 10,
          }),
        ).resolves.toBeNull();

        const wrongVersionClaim = await repository.claim({
          projectId,
          projectVersionId: "another-version",
          batchId,
          executionRunIds: [runIds[2]],
          claims: [{ id: "wrong-version-analysis", executionRunId: runIds[2] }],
          claimantId: "analyst-a",
          claimantUsername: "c10001",
          claimantDisplayName: "分析员 A",
          claimedAt: "2026-09-01T00:59:00.000Z",
        });
        expect(wrongVersionClaim.claims).toEqual([]);
        expect(wrongVersionClaim.unavailableExecutionRunIds).toEqual([runIds[2]]);

        const firstPage = await repository.listCandidates({
          projectId,
          projectVersionId,
          batchId,
          sort: "class_path",
          direction: "asc",
          limit: 2,
        });
        expect(firstPage?.items.map((item) => item.className)).toEqual([
          "example.AlphaTest",
          "example.MiddleTest",
        ]);
        expect(firstPage?.nextCursor).toBeTruthy();
        const secondPage = await repository.listCandidates({
          projectId,
          projectVersionId,
          batchId,
          sort: "class_path",
          direction: "asc",
          cursor: firstPage!.nextCursor!,
          limit: 2,
        });
        expect(secondPage?.items.map((item) => item.className)).toEqual(["example.ZetaTest"]);

        const claimedAt = "2026-09-01T01:00:00.000Z";
        const firstClaim = await repository.claim({
          projectId,
          projectVersionId,
          batchId,
          executionRunIds: [runIds[0], runIds[1]],
          claims: [
            { id: "analysis-a", executionRunId: runIds[0] },
            { id: "analysis-b", executionRunId: runIds[1] },
          ],
          claimantId: "analyst-a",
          claimantUsername: "c10001",
          claimantDisplayName: "分析员 A",
          claimedAt,
        });
        expect(firstClaim.unavailableExecutionRunIds).toEqual([]);
        expect(firstClaim.claims).toHaveLength(2);

        const hiddenAcrossVersions = await repository.claim({
          projectId,
          projectVersionId: "another-version",
          batchId,
          executionRunIds: [runIds[0]],
          claims: [{ id: "cross-version-analysis", executionRunId: runIds[0] }],
          claimantId: "analyst-a",
          claimantUsername: "c10001",
          claimantDisplayName: "分析员 A",
          claimedAt: "2026-09-01T01:00:30.000Z",
        });
        expect(hiddenAcrossVersions.claims).toEqual([]);
        expect(hiddenAcrossVersions.unavailableExecutionRunIds).toEqual([runIds[0]]);

        const competingClaim = await repository.claim({
          projectId,
          projectVersionId,
          batchId,
          executionRunIds: [runIds[0]],
          claims: [{ id: "analysis-conflict", executionRunId: runIds[0] }],
          claimantId: "analyst-b",
          claimantUsername: "c10002",
          claimantDisplayName: "分析员 B",
          claimedAt: "2026-09-01T01:01:00.000Z",
        });
        expect(competingClaim.unavailableExecutionRunIds).toEqual([runIds[0]]);
        expect(competingClaim.claims[0]?.claimantId).toBe("analyst-a");
        await expect(
          repository.countClaims({
            projectId,
            projectVersionId,
            claimantId: "analyst-a",
            batchId,
          }),
        ).resolves.toBe(2);

        const rankedAfterClaim = await repository.listCandidates({
          projectId,
          projectVersionId,
          batchId,
          sort: "class_path",
          direction: "asc",
          limit: 10,
        });
        expect(rankedAfterClaim?.items.map((item) => item.className)).toEqual([
          "example.MiddleTest",
          "example.AlphaTest",
          "example.ZetaTest",
        ]);
        expect(rankedAfterClaim?.items.map((item) => Boolean(item.claim))).toEqual([
          false,
          true,
          true,
        ]);
        const rankedAfterClaimDescending = await repository.listCandidates({
          projectId,
          projectVersionId,
          batchId,
          sort: "failure_summary",
          direction: "desc",
          limit: 10,
        });
        expect(rankedAfterClaimDescending?.items.map((item) => Boolean(item.claim))).toEqual([
          false,
          true,
          true,
        ]);
        const unclaimedFirstPage = await repository.listCandidates({
          projectId,
          projectVersionId,
          batchId,
          sort: "class_path",
          direction: "asc",
          limit: 1,
        });
        expect(unclaimedFirstPage?.items[0]?.className).toBe("example.MiddleTest");
        const claimedSecondPage = await repository.listCandidates({
          projectId,
          projectVersionId,
          batchId,
          sort: "class_path",
          direction: "asc",
          cursor: unclaimedFirstPage!.nextCursor!,
          limit: 1,
        });
        expect(claimedSecondPage?.items[0]).toMatchObject({
          className: "example.AlphaTest",
          claim: expect.any(Object),
        });

        const released = await repository.release({
          id: "release-analysis-a",
          analysisId: "analysis-a",
          projectId,
          claimantId: "analyst-a",
          reason: "误领，需要交由环境负责人分析",
          releasedAt: "2026-09-01T01:01:30.000Z",
        });
        expect(released).toMatchObject({
          analysisId: "analysis-a",
          executionRunId: runIds[0],
          reason: "误领，需要交由环境负责人分析",
        });
        await expect(harness.readClaimReleaseReason("analysis-a")).resolves.toBe(
          "误领，需要交由环境负责人分析",
        );
        await expect(
          repository.countClaims({
            projectId,
            projectVersionId,
            claimantId: "analyst-a",
            batchId,
          }),
        ).resolves.toBe(1);
        await expect(
          repository.release({
            id: "release-completed-or-foreign",
            analysisId: "analysis-b",
            projectId,
            claimantId: "analyst-b",
            reason: "不应成功",
            releasedAt: "2026-09-01T01:01:31.000Z",
          }),
        ).resolves.toBeNull();
        const rankedAfterRelease = await repository.listCandidates({
          projectId,
          projectVersionId,
          batchId,
          sort: "class_path",
          direction: "asc",
          limit: 10,
        });
        expect(rankedAfterRelease?.items.map((item) => item.className)).toEqual([
          "example.MiddleTest",
          "example.ZetaTest",
          "example.AlphaTest",
        ]);
        expect(rankedAfterRelease?.items.map((item) => Boolean(item.claim))).toEqual([
          false,
          false,
          true,
        ]);
        const reclaimed = await repository.claim({
          projectId,
          projectVersionId,
          batchId,
          executionRunIds: [runIds[0]],
          claims: [{ id: "analysis-a-reclaimed", executionRunId: runIds[0] }],
          claimantId: "analyst-a",
          claimantUsername: "c10001",
          claimantDisplayName: "分析员 A",
          claimedAt: "2026-09-01T01:01:45.000Z",
        });
        expect(reclaimed.unavailableExecutionRunIds).toEqual([]);
        expect(reclaimed.claims[0]).toMatchObject({
          id: "analysis-a-reclaimed",
          executionRunId: runIds[0],
        });
        await expect(
          repository.countClaims({
            projectId,
            projectVersionId,
            claimantId: "analyst-a",
            batchId,
          }),
        ).resolves.toBe(2);

        const persisted = await repository.listClaims({
          projectId,
          projectVersionId,
          claimantId: "analyst-a",
          batchId,
          sort: "class_path",
          direction: "asc",
          limit: 10,
        });
        expect(persisted.items).toHaveLength(2);
        expect(persisted.items.map((claim) => claim.className)).toEqual([
          "example.AlphaTest",
          "example.ZetaTest",
        ]);
        const reverseFailureOrder = await repository.listClaims({
          projectId,
          projectVersionId,
          claimantId: "analyst-a",
          batchId,
          sort: "failure_summary",
          direction: "desc",
          limit: 1,
        });
        expect(reverseFailureOrder.items[0]?.failureSummary).toBe("Assertion zeta");
        const reverseFailureSecondPage = await repository.listClaims({
          projectId,
          projectVersionId,
          claimantId: "analyst-a",
          batchId,
          sort: "failure_summary",
          direction: "desc",
          cursor: reverseFailureOrder.nextCursor!,
          limit: 1,
        });
        expect(reverseFailureSecondPage.items[0]?.failureSummary).toBe("Assertion alpha");
        const sameStatusFirstPage = await repository.listClaims({
          projectId,
          projectVersionId,
          claimantId: "analyst-a",
          batchId,
          sort: "claim_status",
          direction: "asc",
          limit: 1,
        });
        const sameStatusSecondPage = await repository.listClaims({
          projectId,
          projectVersionId,
          claimantId: "analyst-a",
          batchId,
          sort: "claim_status",
          direction: "asc",
          cursor: sameStatusFirstPage.nextCursor!,
          limit: 1,
        });
        expect(
          [...sameStatusFirstPage.items, ...sameStatusSecondPage.items]
            .map((claim) => claim.id)
            .sort(),
        ).toEqual(["analysis-a-reclaimed", "analysis-b"]);
        const successfulRerunAttemptId = await harness.seedSuccessfulManualRerun(runIds[0]);
        const firstRunClaim = persisted.items.find((claim) => claim.executionRunId === runIds[0])!;
        await expect(
          repository.findSuccessfulManualRerunAttempts({
            analysisIds: persisted.items.map((claim) => claim.id),
            projectId,
            claimantId: "analyst-a",
          }),
        ).resolves.toEqual(new Map([[firstRunClaim.id, successfulRerunAttemptId]]));
        const started = await repository.start({
          analysisId: persisted.items[0]!.id,
          projectId,
          claimantId: "analyst-a",
          category: "code_issue_filed",
          startedAt: "2026-09-01T01:02:00.000Z",
        });
        expect(started).toMatchObject({
          status: "analyzing",
          category: "code_issue_filed",
          analysisStartedAt: "2026-09-01T01:02:00.000Z",
        });
        await expect(
          repository.start({
            analysisId: persisted.items[0]!.id,
            projectId,
            claimantId: "analyst-b",
            category: "rerun_passed",
            startedAt: "2026-09-01T01:03:00.000Z",
          }),
        ).resolves.toBeNull();

        const screenshot = {
          objectKey: "projects/project-a/failure-analysis/batch/proof.png",
          fileName: "重跑通过.png",
          mediaType: "image/png" as const,
          sizeBytes: 128,
          sha256: "a".repeat(64),
        };
        const withScreenshot = await repository.attachScreenshot({
          analysisIds: persisted.items.map((claim) => claim.id),
          projectId,
          claimantId: "analyst-a",
          screenshot,
          updatedAt: "2026-09-01T01:04:00.000Z",
        });
        expect(withScreenshot).toHaveLength(2);
        expect(
          withScreenshot.every((claim) => claim.screenshot?.objectKey === screenshot.objectKey),
        ).toBe(true);

        const completed = await repository.complete({
          analysisIds: persisted.items.map((claim) => claim.id),
          projectId,
          claimantId: "analyst-a",
          category: "case_fixed",
          issueDescription: "测试数据问题",
          caseFixEvidence: "commit abc123",
          remark: "批量完成",
          rerunProofs: new Map(),
          completedAt: "2026-09-01T01:05:00.000Z",
        });
        expect(completed).toHaveLength(2);
        expect(completed.every((claim) => claim.status === "completed")).toBe(true);
        expect(completed[0]).toMatchObject({
          category: "case_fixed",
          issueDescription: "测试数据问题",
          caseFixEvidence: "commit abc123",
          remark: "批量完成",
          completedAt: "2026-09-01T01:05:00.000Z",
        });
        const pendingClaim = await repository.claim({
          projectId,
          projectVersionId,
          batchId,
          executionRunIds: [runIds[2]],
          claims: [{ id: "analysis-c", executionRunId: runIds[2] }],
          claimantId: "analyst-a",
          claimantUsername: "c10001",
          claimantDisplayName: "分析员 A",
          claimedAt: "2026-09-01T01:06:00.000Z",
        });
        expect(pendingClaim.claims).toHaveLength(1);
        const pendingFirst = await repository.listClaims({
          projectId,
          projectVersionId,
          claimantId: "analyst-a",
          batchId,
          sort: "class_path",
          direction: "asc",
          completionOrder: "pending_first",
          limit: 10,
        });
        expect(pendingFirst.items.map((claim) => claim.status)).toEqual([
          "claimed",
          "completed",
          "completed",
        ]);
        const completedFirstPage = await repository.listClaims({
          projectId,
          projectVersionId,
          claimantId: "analyst-a",
          batchId,
          sort: "class_path",
          direction: "asc",
          completionOrder: "completed_first",
          limit: 2,
        });
        const completedFirstSecondPage = await repository.listClaims({
          projectId,
          projectVersionId,
          claimantId: "analyst-a",
          batchId,
          sort: "class_path",
          direction: "asc",
          completionOrder: "completed_first",
          cursor: completedFirstPage.nextCursor!,
          limit: 2,
        });
        expect(
          [...completedFirstPage.items, ...completedFirstSecondPage.items].map(
            (claim) => claim.status,
          ),
        ).toEqual(["completed", "completed", "claimed"]);
        const unfinishedOnly = await repository.listClaims({
          projectId,
          projectVersionId,
          claimantId: "analyst-a",
          batchId,
          sort: "class_path",
          direction: "asc",
          includeCompleted: false,
          limit: 10,
        });
        expect(unfinishedOnly.items).toEqual([
          expect.objectContaining({ id: "analysis-c", status: "claimed" }),
        ]);
        const exportedClaims = await repository.findClaimsByExecutionRunIds({
          projectId,
          batchId,
          executionRunIds: [runIds[0], runIds[1], "missing-run"],
        });
        expect(exportedClaims).toHaveLength(2);
        expect(exportedClaims.every((claim) => claim.status === "completed")).toBe(true);
        const firstCaseHistory = await repository.listCaseHistory({
          projectId,
          caseDefinitionId: completed[0]!.caseDefinitionId,
          limit: 10,
        });
        expect(firstCaseHistory.items).toEqual([
          expect.objectContaining({
            batchName: "失败分析任务",
            batchSequenceNumber: expect.any(Number),
            claim: expect.objectContaining({ id: completed[0]!.id, status: "completed" }),
          }),
        ]);
        expect(firstCaseHistory.nextCursor).toBeUndefined();
        await expect(
          repository.listCaseHistory({
            projectId: "another-project",
            caseDefinitionId: completed[0]!.caseDefinitionId,
            limit: 10,
          }),
        ).resolves.toEqual({ items: [] });
        const recentHistories = await repository.listRecentCaseHistories({
          projectId,
          caseDefinitionIds: completed.map((claim) => claim.caseDefinitionId),
          limitPerCase: 1,
        });
        expect(recentHistories).toHaveLength(2);
        expect(recentHistories.map((item) => item.claim.id).sort()).toEqual(
          completed.map((claim) => claim.id).sort(),
        );
        const searchableConclusions = await repository.listCompletedConclusions({
          projectId,
          query: "alpha",
          limit: 10,
        });
        expect(searchableConclusions.items).toEqual([
          expect.objectContaining({
            claim: expect.objectContaining({
              caseName: "Alpha",
              status: "completed",
            }),
          }),
        ]);
        const firstConclusionPage = await repository.listCompletedConclusions({
          projectId,
          limit: 1,
        });
        const secondConclusionPage = await repository.listCompletedConclusions({
          projectId,
          cursor: firstConclusionPage.nextCursor!,
          limit: 1,
        });
        expect(firstConclusionPage.nextCursor).toBeTruthy();
        expect(secondConclusionPage.items).toHaveLength(1);
        expect(secondConclusionPage.items[0]!.claim.id).not.toBe(
          firstConclusionPage.items[0]!.claim.id,
        );
        await expect(
          repository.listCompletedConclusions({
            projectId: "another-project",
            limit: 10,
          }),
        ).resolves.toEqual({ items: [] });
        await expect(
          repository.findClaimsByExecutionRunIds({
            projectId: "another-project",
            batchId,
            executionRunIds: [runIds[0]],
          }),
        ).resolves.toEqual([]);
        await expect(
          repository.getBatch({ projectId, projectVersionId, batchId }),
        ).resolves.toMatchObject({ claimedRuns: 3, completedRuns: 2 });

        const failureSorted = await repository.listCandidates({
          projectId,
          projectVersionId,
          batchId,
          sort: "failure_summary",
          direction: "asc",
          limit: 10,
        });
        expect(failureSorted?.items.map((item) => item.failureSummary)).toEqual([
          "Assertion alpha",
          "Assertion middle",
          "Assertion zeta",
        ]);
        expect(failureSorted?.items.filter((item) => item.claim)).toHaveLength(3);
      } finally {
        await harness.dispose();
      }
    });
  });
}
