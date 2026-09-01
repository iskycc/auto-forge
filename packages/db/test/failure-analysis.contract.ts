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

        const persisted = await repository.listClaims({
          projectId,
          projectVersionId,
          claimantId: "analyst-a",
          batchId,
          limit: 10,
        });
        expect(persisted.items).toHaveLength(2);
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
        await expect(
          repository.getBatch({ projectId, projectVersionId, batchId }),
        ).resolves.toMatchObject({ claimedRuns: 2, completedRuns: 2 });

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
        expect(failureSorted?.items.filter((item) => item.claim)).toHaveLength(2);
      } finally {
        await harness.dispose();
      }
    });
  });
}
