import { describe, expect, it, vi } from "vitest";
import { DomainError, type AuthenticatedIdentity, type Permission } from "@autoforge/domain";

import { loadCaseDetail } from "./load-case-detail";

describe("shared case detail loading", () => {
  it("uses the DDT identity for histories while keeping class metadata separate", async () => {
    const services = fixture();
    const activity = vi.fn().mockResolvedValue({ executions: [], analyses: [] });
    const executions = vi.fn().mockResolvedValue({ items: [], nextCursor: "ddt-older" });
    const context = {
      caseDefinitionId: "ddt-case-a",
      executionHistoryUrl: "/api/v1/ddt/cases/A/executions?projectId=project-a",
      analysisHistoryUrl: "/api/v1/ddt/cases/A/failure-analyses?projectId=project-a",
    };
    const detail = await loadCaseDetail(services, identityWith([]), "case-a", ["project-a"], {
      ...context,
      activity,
      executions,
    });
    expect(services.caseDefinitions.listActivity).not.toHaveBeenCalled();
    expect(services.caseDefinitions.listExecutionHistory).not.toHaveBeenCalled();
    expect(services.failureAnalysis.listCaseHistory).toHaveBeenCalledWith({
      projectId: "project-a",
      caseDefinitionId: "ddt-case-a",
      limit: 20,
    });
    expect(executions).toHaveBeenCalledWith({ limit: 50, includeRunnerNames: false });
    expect(detail.definition.id).toBe("case-a");
    expect(detail.executionHistory.nextCursor).toBe("ddt-older");
    expect(detail.historyContext).toEqual(context);
  });
  it("keeps histories bounded and preserves cursors for both entrypoints", async () => {
    const services = fixture();
    const detail = await loadCaseDetail(services, identityWith([]), "case-a", ["project-a"]);
    expect(services.caseDefinitions.get).toHaveBeenCalledWith("case-a", ["project-a"]);
    expect(services.caseDefinitions.listExecutionHistory).toHaveBeenCalledWith(
      "case-a",
      ["project-a"],
      {
        limit: 50,
        includeRunnerNames: false,
      },
    );
    expect(services.caseDefinitions.listActivity).toHaveBeenCalledWith("case-a", ["project-a"], 50);
    expect(services.failureAnalysis.listCaseHistory).toHaveBeenCalledWith({
      projectId: "project-a",
      caseDefinitionId: "case-a",
      limit: 20,
    });
    expect(detail.executionHistory.nextCursor).toBe("earlier-executions");
    expect(detail.failureAnalysisHistory.nextCursor).toBe("earlier-analyses");
    expect(detail).toMatchObject({
      projectVersionName: "Release A",
      testStageName: "回归",
      timeZone: "Asia/Shanghai",
      canManage: false,
      canRun: false,
      canReadLogs: false,
      canReadSource: false,
      canReadAnalysisEvidence: false,
    });
  });

  it("derives actions from permissions in the case project", async () => {
    const identity = identityWith([
      "case.manage",
      "run.create",
      "log.read",
      "case_source.read",
      "run.read",
    ]);
    const services = fixture();
    expect(await loadCaseDetail(services, identity, "case-a", ["project-a"])).toMatchObject({
      canManage: true,
      canRun: true,
      canReadLogs: true,
      canReadSource: true,
      canReadAnalysisEvidence: true,
    });
    identity.projectPermissions = { "project-b": identity.projectPermissions["project-a"]! };
    expect(await loadCaseDetail(services, identity, "case-a", ["project-a"])).toMatchObject({
      canManage: false,
      canRun: false,
      canReadLogs: false,
      canReadSource: false,
      canReadAnalysisEvidence: false,
    });
  });

  it("does not read histories when the scoped definition is unavailable", async () => {
    const services = fixture();
    services.caseDefinitions.get.mockRejectedValue(
      new DomainError("CASE_DEFINITION_NOT_FOUND", "不存在"),
    );
    await expect(
      loadCaseDetail(services, identityWith([]), "case-a", ["project-b"]),
    ).rejects.toMatchObject({
      code: "CASE_DEFINITION_NOT_FOUND",
    });
    expect(services.caseDefinitions.listExecutionHistory).not.toHaveBeenCalled();
    expect(services.failureAnalysis.listCaseHistory).not.toHaveBeenCalled();
    expect(services.caseSources.executable).not.toHaveBeenCalled();
  });

  it("propagates history failures instead of presenting an empty success", async () => {
    const services = fixture();
    const failure = new Error("history temporarily unavailable");
    services.caseDefinitions.listExecutionHistory.mockRejectedValue(failure);
    await expect(loadCaseDetail(services, identityWith([]), "case-a", ["project-a"])).rejects.toBe(
      failure,
    );
  });
});

function fixture() {
  return {
    caseDefinitions: {
      get: vi.fn().mockResolvedValue({
        id: "case-a",
        projectId: "project-a",
        projectVersionId: "version-a",
        testStageId: "stage-a",
        sourceId: "source-a",
      }),
      listVersions: vi.fn().mockResolvedValue([]),
      listActivity: vi.fn().mockResolvedValue({ executions: [], analyses: [] }),
      listExecutionHistory: vi
        .fn()
        .mockResolvedValue({ items: [], nextCursor: "earlier-executions" }),
    },
    caseSources: { executable: vi.fn().mockResolvedValue(true) },
    projectStructures: {
      list: vi.fn().mockResolvedValue({
        versions: [
          { id: "version-a", name: "Release A", stages: [{ id: "stage-a", name: "回归" }] },
        ],
      }),
    },
    failureAnalysis: {
      listCaseHistory: vi.fn().mockResolvedValue({ items: [], nextCursor: "earlier-analyses" }),
    },
    configurationStore: { read: vi.fn().mockReturnValue({ web: { timeZone: "Asia/Shanghai" } }) },
  };
}

function identityWith(permissions: Permission[]): AuthenticatedIdentity {
  return {
    user: {
      id: "reader",
      username: "reader",
      displayName: "Reader",
      source: "local",
      status: "active",
      forcePasswordChange: false,
      failedLoginAttempts: 0,
      version: 1,
      createdAt: "2026-09-06T00:00:00.000Z",
      updatedAt: "2026-09-06T00:00:00.000Z",
    },
    sessionId: "test-session",
    systemPermissions: [],
    projectPermissions: { "project-a": permissions },
  };
}
