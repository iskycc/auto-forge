import { describe, expect, it, vi } from "vitest";
import { DomainError, type AuthenticatedIdentity, type Permission } from "@autoforge/domain";

import { loadCaseDetail } from "./load-case-detail";
import { loadDdtCaseDetail } from "./load-ddt-case-detail";

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

describe("DDT previews without an execution class", () => {
  const scope = { projectId: "project-a", projectVersionId: "version-a", testStageId: "stage-a" };
  function unboundFixture() {
    return {
      ...fixture(),
      ddtCases: {
        getSummary: vi.fn().mockResolvedValue({ id: "ddt-a", caseId: "PAY/001", ...scope }),
        listActivity: vi.fn().mockResolvedValue({ executions: [], analyses: [] }),
        listExecutionHistory: vi.fn().mockResolvedValue({
          items: [{ runId: "earlier-ddt-run" }],
          nextCursor: "older-ddt-runs",
        }),
      },
    };
  }

  it("keeps the DDT history accessible after unlinking, within the selected scope and permission boundaries", async () => {
    const services = unboundFixture();
    const preview = await loadDdtCaseDetail(services, identityWith([]), scope, "PAY/001");
    expect(preview.executionDetail).toBeUndefined();
    expect(preview.historyDetail).toMatchObject({
      executionHistory: { items: [{ runId: "earlier-ddt-run" }], nextCursor: "older-ddt-runs" },
      failureAnalysisHistory: { nextCursor: "earlier-analyses" },
      canRun: false,
      canReadLogs: false,
      canReadAnalysisEvidence: false,
      timeZone: "Asia/Shanghai",
    });
    expect(services.ddtCases.getSummary).toHaveBeenCalledWith(scope, "PAY/001");
    expect(services.ddtCases.listActivity).toHaveBeenCalledWith(scope, "PAY/001", 50);
    expect(services.ddtCases.listExecutionHistory).toHaveBeenCalledWith(scope, "PAY/001", {
      limit: 50,
      includeRunnerNames: false,
    });
    expect(services.failureAnalysis.listCaseHistory).toHaveBeenCalledWith({
      projectId: scope.projectId,
      caseDefinitionId: "ddt-a",
      limit: 20,
    });
    const historyUrl = new URL(
      preview.historyDetail!.historyContext!.executionHistoryUrl,
      "http://localhost",
    );
    expect(historyUrl.pathname).toBe("/api/v1/ddt/cases/PAY%2F001/executions");
    expect(Object.fromEntries(historyUrl.searchParams)).toEqual(scope);
    expect(services.caseDefinitions.get).not.toHaveBeenCalled();
    expect(services.caseDefinitions.listExecutionHistory).not.toHaveBeenCalled();
    const privileged = await loadDdtCaseDetail(
      services,
      identityWith(["run.create", "run.read", "log.read"]),
      scope,
      "PAY/001",
    );
    expect(privileged.historyDetail).toMatchObject({
      canRun: false,
      canReadLogs: true,
      canReadAnalysisEvidence: true,
    });
  });

  it("propagates missing cases and history failures instead of showing empty records", async () => {
    const services = unboundFixture();
    const missing = new DomainError("DDT_CASE_NOT_FOUND", "当前范围内不存在该用例");
    services.ddtCases.getSummary.mockRejectedValueOnce(missing);
    await expect(loadDdtCaseDetail(services, identityWith([]), scope, "PAY/001")).rejects.toBe(
      missing,
    );
    expect(services.ddtCases.listExecutionHistory).not.toHaveBeenCalled();
    const unavailable = new Error("history unavailable");
    services.ddtCases.listExecutionHistory.mockRejectedValueOnce(unavailable);
    await expect(loadDdtCaseDetail(services, identityWith([]), scope, "PAY/001")).rejects.toBe(
      unavailable,
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
