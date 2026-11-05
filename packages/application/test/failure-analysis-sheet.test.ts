import { describe, expect, it, vi } from "vitest";
import {
  FailureAnalysisSheetService,
  FailureAnalysisPublicationService,
  type FailureAnalysisSheetScope,
  type FailureAnalysisPublicationRepository,
} from "../src/failure-analysis-sheet";
import type { FailureAnalysisClaim } from "@autoforge/domain";

const now = "2026-11-05T06:00:00.000Z";
const scope: FailureAnalysisSheetScope = {
  batchId: "batch-a",
  projectId: "project",
  projectVersionId: "version",
  suiteName: "task",
  sequenceNumber: 1,
};
const claim: FailureAnalysisClaim = {
  id: "analysis-a",
  projectId: "project",
  batchId: "batch-a",
  executionRunId: "run",
  caseDefinitionId: "case",
  attemptId: "attempt",
  caseName: "用例",
  className: "example.Test",
  attemptNumber: 1,
  failureSummary: "failed",
  status: "claimed",
  claimantId: "owner",
  claimantUsername: "owner",
  claimantDisplayName: "Owner",
  claimedAt: now,
  updatedAt: now,
};
const input = {
  analysisIds: [claim.id],
  category: "code_issue_filed" as const,
  issueDescription: "问题",
  ticketReference: "BUG-1",
  caseIssueConfirmed: false,
  expectedUpdatedAt: now,
};
function harness(records = [claim]) {
  const analysis = {
    listMyClaims: vi.fn(async () => ({ items: records })),
    listCandidates: vi.fn(async () => ({ items: [{ ...claim, claim: undefined }] })),
    listExportClaims: vi.fn(async () => records),
    complete: vi.fn(async () => records),
  };
  const repository = {
    findOwnedClaims: vi.fn(async () => records),
    getClaim: vi.fn(async () => records[0] ?? null),
  };
  return { service: new FailureAnalysisSheetService(analysis, repository), analysis, repository };
}
describe("analysis sheet scope and existing conclusion rules", () => {
  it("enriches only the bounded visible page and delegates completion to the existing workflow", async () => {
    const h = harness();
    const page = await h.service.read(scope, {
      view: "all",
      sort: "class_path",
      direction: "asc",
      limit: 50,
    });
    expect(page.items[0]?.analysis?.claimantId).toBe("owner");
    expect(h.analysis.listExportClaims).toHaveBeenCalledWith({
      projectId: "project",
      batchId: "batch-a",
      executionRunIds: ["run"],
    });
    await h.service.complete(scope, input, { id: "owner", username: "owner" });
    expect(h.analysis.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project",
        analysisIds: [claim.id],
        caseIssueConfirmed: false,
      }),
    );
  });
  it("requires a login for my claims and retains the authenticated claimant filter", async () => {
    const h = harness();
    await expect(
      h.service.read(scope, { view: "mine", sort: "class_path", direction: "asc", limit: 50 }),
    ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    await h.service.read(
      scope,
      { view: "mine", sort: "class_path", direction: "asc", limit: 50 },
      "owner",
    );
    expect(h.analysis.listMyClaims).toHaveBeenCalledWith(
      expect.objectContaining({ claimantId: "owner", batchId: "batch-a" }),
    );
  });
  it("rejects cross-batch claims, missing ownership, archived tasks and stale revisions before writing", async () => {
    for (const records of [[], [{ ...claim, batchId: "other" }]]) {
      const h = harness(records);
      await expect(
        h.service.complete(scope, input, { id: "owner", username: "owner" }),
      ).rejects.toMatchObject({ code: "FAILURE_ANALYSIS_NOT_FOUND" });
      expect(h.analysis.complete).not.toHaveBeenCalled();
    }
    const h = harness();
    await expect(
      h.service.complete({ ...scope, archivedAt: now }, input, { id: "owner", username: "owner" }),
    ).rejects.toMatchObject({ code: "FAILURE_ANALYSIS_ARCHIVED_CONFLICT" });
    await expect(
      h.service.complete(
        scope,
        { ...input, expectedUpdatedAt: "2026-11-04T06:00:00.000Z" },
        { id: "owner", username: "owner" },
      ),
    ).rejects.toMatchObject({ code: "FAILURE_ANALYSIS_EDIT_CONFLICT" });
    expect(h.analysis.complete).not.toHaveBeenCalled();
    await expect(
      h.service.requireClaim({ ...scope, batchId: "other" }, claim.id),
    ).rejects.toMatchObject({ code: "FAILURE_ANALYSIS_NOT_FOUND" });
  });
  it("replays only the identical completed conclusion after a lost acknowledgement", async () => {
    const h = harness([
      {
        ...claim,
        status: "completed",
        category: input.category,
        issueDescription: "问题",
        ticketReference: "BUG-1",
      },
    ]);
    await expect(
      h.service.complete(scope, input, { id: "owner", username: "owner" }),
    ).resolves.toHaveLength(1);
    expect(h.analysis.complete).not.toHaveBeenCalled();
    await h.service.complete(
      scope,
      { ...input, ticketReference: "BUG-2" },
      { id: "owner", username: "owner" },
    );
    expect(h.analysis.complete).toHaveBeenCalled();
  });
});
describe("analysis publication", () => {
  it("requires an explicit grant and returns business-ID links without publishing execution access", async () => {
    const repository: FailureAnalysisPublicationRepository = {
      batch: vi.fn(async () => scope),
      read: vi.fn(async () => null),
      publish: vi.fn(async () => {}),
      revoke: vi.fn(async () => {}),
      failureAttempt: vi.fn(async () => null),
    };
    const service = new FailureAnalysisPublicationService(repository, { now: () => new Date(now) });
    await expect(service.requirePublic(scope.batchId)).rejects.toMatchObject({
      code: "FAILURE_ANALYSIS_PUBLIC_NOT_FOUND",
    });
    await expect(service.publish(scope.batchId, "owner")).resolves.toBe(
      "/CaseAnalysis?BatchId=batch-a",
    );
    expect(repository.publish).toHaveBeenCalledWith(scope.batchId, "owner", now);
    await service.revoke(scope.batchId);
    expect(repository.revoke).toHaveBeenCalledWith(scope.batchId, now);
    await expect(service.requireFailureAttempt(scope, "other-run")).rejects.toMatchObject({
      code: "RUN_ATTEMPT_NOT_FOUND",
    });
  });
});
