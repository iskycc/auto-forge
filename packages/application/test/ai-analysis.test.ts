import { describe, it, expect, vi } from "vitest";
import type { AuthenticatedIdentity, Permission } from "@autoforge/domain";
import type { IdentityAccessRepository } from "../src/ports";
import { assertAiPermission, resolveAiActor } from "../src/ai-analysis";
import { aiModelConfigurationSchema } from "@autoforge/contracts";
import type { AiAnalysisRepository, AiGroupWork } from "../src/ai-analysis-ports";
import { AiAnalysisWorker, type AiEvidencePort } from "../src/ai-analysis-worker";
import type { SecretCipherPort } from "../src/ports";
import {
  aiPromptMessages,
  readPreliminaryConclusion,
  renderPreliminaryConclusion,
} from "../src/ai-analysis-prompts";

function actor(permissions: Permission[]): AuthenticatedIdentity {
  return {
    user: {
      id: "actor",
      username: "actor",
      displayName: "Actor",
      source: "local",
      status: "active",
      forcePasswordChange: false,
      failedLoginAttempts: 0,
      createdAt: "2026-11-04T00:00:00Z",
      updatedAt: "2026-11-04T00:00:00Z",
      version: 1,
    },
    sessionId: "test",
    systemPermissions: [],
    projectPermissions: { project: permissions },
  };
}
describe("AI evidence authorization", () => {
  it("keeps manual analysis permissions separate from model disclosure", () => {
    expect(() =>
      assertAiPermission(
        actor(["run.read", "case.read", "log.read", "analysis.manage"]),
        "project",
        true,
      ),
    ).toThrow();
  });
  it("requires both the explicit AI capability and all evidence permissions", () => {
    expect(() =>
      assertAiPermission(actor(["analysis.ai.create", "run.read", "case.read"]), "project", true),
    ).toThrow();
    expect(() =>
      assertAiPermission(
        actor(["analysis.ai.create", "run.read", "case.read", "log.read"]),
        "project",
        true,
      ),
    ).not.toThrow();
  });
  it("does not reuse one project's permission in another project", () => {
    expect(() =>
      assertAiPermission(
        actor(["analysis.ai.read", "run.read", "case.read", "log.read"]),
        "another-project",
      ),
    ).toThrow();
  });
  it("stops a disabled requester before reading role grants", async () => {
    const readRoles = vi.fn();
    const repository = {
      findUser: async () => ({ ...actor([]).user, status: "disabled" as const }),
      listRoles: readRoles,
    } as unknown as IdentityAccessRepository;
    expect(await resolveAiActor(repository, "actor")).toBeNull();
    expect(readRoles).not.toHaveBeenCalled();
  });
});

function groupWorker() {
  const now = new Date("2026-11-04T00:00:00.000Z");
  const work: AiGroupWork = {
    id: "group",
    jobId: "job",
    batchId: "batch",
    projectId: "project",
    requestedBy: "actor",
    leaseToken: "lease",
    cursor: "",
    signature: "stack",
    conclusion: null,
    attempts: 0,
    processed: 0,
    memberCount: 2,
  };
  const configuration = aiModelConfigurationSchema.parse({
    enabled: true,
    baseUrl: "http://model/v1",
    modelId: "test",
    tokensPerMinute: 100000,
  });
  const groupMembers = vi
    .fn()
    .mockResolvedValue([
      { id: "member", displayName: "case", conclusion: "初步建议", reason: null },
    ]);
  const deferGroup = vi.fn();
  const saveStackGroup = vi.fn();
  const reserveModel = vi.fn();
  const repository = {
    configuration: async () => ({ revision: 1, configuration, encryptedKey: null }),
    claimPlanning: async () => null,
    claimWork: async () => null,
    prepareGroups: async () => {},
    claimGroup: async () => work,
    groupMembers,
    deferGroup,
    reserveModel,
    releaseModel: vi.fn(),
    groupEvidence: async () => "manifest.json",
    saveStackGroup,
  } as unknown as AiAnalysisRepository;
  const identities = {
    findUser: async () => actor([]).user,
    listRoles: async () => [
      {
        id: "role",
        active: true,
        permissions: ["analysis.ai.create", "run.read", "case.read", "log.read"],
      },
    ],
    listSystemRoleBindings: async () => [{ roleId: "role" }],
    listUserProjectRoleBindings: async () => [],
  } as unknown as IdentityAccessRepository;
  const canWork = vi.fn().mockReturnValue(true);
  const complete = vi.fn();
  const busy = new Error("database busy");
  const worker = new AiAnalysisWorker(
    repository,
    {
      read: async () => ({
        parts: [{ id: "part-1" }],
        stackParts: [{ id: "stack-1" }],
        limitations: [],
      }),
      part: async () => "java.lang.AssertionError\n at example.Test.run(Test.java:10)",
    } as unknown as AiEvidencePort,
    { complete },
    identities,
    {} as SecretCipherPort,
    { now: () => now },
    { next: () => "token" },
    canWork,
    vi.fn(),
    undefined,
    (error) => error === busy,
  );
  return {
    worker,
    work,
    saveStackGroup,
    groupMembers,
    deferGroup,
    reserveModel,
    complete,
    canWork,
    busy,
    configuration,
  };
}

describe("concise stack-first analysis", () => {
  it("sends equal-stack members together and saves one concise group suggestion", async () => {
    const fixture = groupWorker();
    fixture.work.strategy = "stack_groups_v2";
    fixture.work.signature = "exact-stack-bundle-v1:test";
    fixture.configuration.referencePrompts = [
      { title: "参考", content: "环境依赖波动优先核对重跑。" },
    ];
    fixture.groupMembers.mockResolvedValue([
      { id: "a", displayName: "A" },
      { id: "b", displayName: "B" },
    ]);
    fixture.reserveModel.mockResolvedValue(true);
    // The fake must expose the same lifecycle boundary as a real model admission.
    const conclusion = {
      recommendation: "rerun_likely",
      reason: "连接瞬断。",
      evidence: "日志出现连接重置。",
      evidenceReferences: ["stack-1"],
    };
    fixture.complete.mockResolvedValue({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call",
          type: "function",
          function: { name: "submit_ai_conclusion", arguments: JSON.stringify(conclusion) },
        },
      ],
    });
    await fixture.worker.tick(new AbortController().signal);
    expect(fixture.complete).toHaveBeenCalledTimes(1);
    const input = fixture.complete.mock.calls[0]![0];
    expect(JSON.stringify(input.messages)).toContain("环境依赖波动");
    const payload = JSON.parse(input.messages.at(-1).content);
    expect(payload.members).toEqual([
      { id: "a", displayName: "A" },
      { id: "b", displayName: "B" },
    ]);
    expect(fixture.saveStackGroup).toHaveBeenCalledWith(
      fixture.work,
      expect.objectContaining({
        processed: 2,
        done: true,
        partCursor: 1,
        conclusion: "可能重跑通过（待人工确认）\n原因：连接瞬断。\n依据：日志出现连接重置。",
      }),
      expect.any(String),
    );
  });
  it("limits suggestions to one category, reason and evidence and rejects invented references", () => {
    const conclusion = {
      recommendation: "business_issue_likely" as const,
      reason: "状态不符。",
      evidence: "响应返回了错误业务状态。",
      evidenceReferences: ["stack"],
    };
    expect(renderPreliminaryConclusion(conclusion).split("\n")).toHaveLength(3);
    expect(
      aiPromptMessages(
        aiModelConfigurationSchema.parse({
          baseUrl: "http://model/v1",
          modelId: "test",
          referencePrompts: [{ title: "业务规则", content: "核对交易状态。" }],
        }),
      ),
    ).toHaveLength(2);
    expect(() =>
      readPreliminaryConclusion(
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call",
              type: "function",
              function: { name: "submit_ai_conclusion", arguments: JSON.stringify(conclusion) },
            },
          ],
        },
        ["other"],
      ),
    ).toThrow("未读取");
  });
});

describe("AI group reduction admission", () => {
  it("defers without charging a retry when platform pressure rises before inference", async () => {
    const fixture = groupWorker();
    fixture.canWork.mockReturnValueOnce(true).mockReturnValue(false);
    expect(await fixture.worker.tick(new AbortController().signal)).toBe(true);
    expect(fixture.reserveModel).not.toHaveBeenCalled();
    expect(fixture.complete).not.toHaveBeenCalled();
    expect(fixture.deferGroup).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("退避"),
      expect.any(String),
      false,
      expect.any(String),
      false,
    );
  });
  it("reports an impossible per-request TPM budget instead of waiting indefinitely", async () => {
    const fixture = groupWorker();
    fixture.configuration.tokensPerMinute = 4096;
    fixture.groupMembers.mockResolvedValue([{ id: "member", conclusion: "x".repeat(6000) }]);
    await fixture.worker.tick(new AbortController().signal);
    expect(fixture.reserveModel).not.toHaveBeenCalled();
    expect(fixture.deferGroup).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("TPM"),
      expect.any(String),
      true,
      expect.any(String),
    );
  });
  it("treats temporary database contention as a resource wait", async () => {
    const fixture = groupWorker();
    fixture.groupMembers.mockRejectedValue(fixture.busy);
    await fixture.worker.tick(new AbortController().signal);
    expect(fixture.deferGroup).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("退避"),
      expect.any(String),
      false,
      expect.any(String),
      false,
    );
  });
});
