import { describe, it, expect, vi } from "vitest";
import type { AuthenticatedIdentity, Permission } from "@autoforge/domain";
import type { IdentityAccessRepository } from "../src/ports";
import { assertAiPermission, resolveAiActor } from "../src/ai-analysis";
import { aiModelConfigurationSchema } from "@autoforge/contracts";
import type { AiAnalysisRepository, AiGroupWork, AiWork } from "../src/ai-analysis-ports";
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
  const evidence = {
    read: async () => ({
      parts: [{ id: "part-1" }],
      stackParts: [{ id: "stack-1" }],
      limitations: [],
    }),
    part: async () => "java.lang.AssertionError\n at example.Test.run(Test.java:10)",
  } as unknown as AiEvidencePort;
  const worker = new AiAnalysisWorker(
    repository,
    evidence,
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
    repository,
    evidence,
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
  it.each([1, 9])(
    "reads every stdout fragment of every member when the stack group has %i cases",
    async (count) => {
      const fixture = groupWorker();
      Object.assign(fixture.work, {
        strategy: "stack_groups_v2",
        signature: "exact-stack-bundle-v2:shared",
        memberCount: count,
      });
      fixture.groupMembers.mockImplementation(async () => {
        const next = fixture.work.processed;
        return next < count
          ? [{ id: `member-${next}`, displayName: `Case ${next}`, evidenceKey: `manifest-${next}` }]
          : [];
      });
      vi.spyOn(fixture.evidence, "read").mockImplementation(async (key) => ({
        version: 1,
        executionRunId: key,
        attemptId: key,
        signature: fixture.work.signature,
        stdoutComplete: true,
        limitations: [],
        parts: [
          { id: `${key}-stdout-1`, objectKey: `${key}-start`, sizeBytes: 10 },
          { id: `${key}-stdout-2`, objectKey: `${key}-end`, sizeBytes: 10 },
        ],
        stackParts: [{ id: "stack-only", objectKey: "stack", sizeBytes: 10 }],
      }));
      vi.spyOn(fixture.evidence, "part").mockImplementation(
        async (part) => `完整日志片 ${part.objectKey}`,
      );
      fixture.reserveModel.mockResolvedValue(true);
      fixture.complete.mockImplementation(async (input) => ({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "reply",
            type: "function",
            function: {
              name: "submit_ai_conclusion",
              arguments: JSON.stringify({
                recommendation: "rerun_likely",
                reason: "连接瞬断。",
                evidence: "业务日志显示连接重置。",
                evidenceReferences: [JSON.parse(input.messages.at(-1).content).evidenceId],
              }),
            },
          },
        ],
      }));
      fixture.saveStackGroup.mockImplementation(async (_work, progress) => {
        if (fixture.work.partCursor === 0) expect(progress.processed).toBe(fixture.work.processed);
        Object.assign(fixture.work, progress);
      });
      for (let index = 0; index < count * 2; index++)
        await fixture.worker.tick(new AbortController().signal);
      expect(fixture.complete).toHaveBeenCalledTimes(count * 2);
      const text = fixture.complete.mock.calls
        .map(([input]) => JSON.parse(input.messages.at(-1).content).text)
        .join("\n");
      for (let index = 0; index < count; index++) {
        expect(text).toContain(`manifest-${index}-start`);
        expect(text).toContain(`manifest-${index}-end`);
      }
      expect(text).not.toContain("stack-only");
      expect(fixture.saveStackGroup.mock.calls.at(-1)![1]).toMatchObject({
        processed: count,
        partCursor: 0,
        done: true,
      });
    },
  );
  it.each(["single", "small-group", "large-group"] as const)(
    "persists an overlong compatible-model reply in %s analysis without retrying",
    async (mode) => {
      const fixture = groupWorker();
      const saveDraft = vi.fn();
      const defer = vi.fn();
      fixture.repository.saveDraft = saveDraft;
      fixture.repository.defer = defer;
      fixture.repository.renew = async () => true;
      const single: AiWork = {
        id: "single",
        jobId: "job",
        executionRunId: "run",
        attemptId: "attempt",
        displayName: "case",
        status: "running",
        signature: "stack",
        conclusion: null,
        reason: null,
        updatedAt: "2026-11-04T00:00:00Z",
        strategy: "single_full_v2",
        projectId: "project",
        batchId: "batch",
        requestedBy: "actor",
        leaseToken: "lease",
        evidenceKey: "manifest",
        attempts: 0,
        partCursor: 0,
        drafts: [],
      };
      if (mode === "single") fixture.repository.claimWork = async () => single;
      else {
        fixture.work.strategy = "stack_groups_v2";
        fixture.work.memberCount = mode === "small-group" ? 1 : 10;
        fixture.groupMembers.mockResolvedValue(
          Array.from({ length: fixture.work.memberCount }, (_, index) => ({
            id: `member-${index}`,
            displayName: `case-${index}`,
            evidenceKey: "manifest",
          })),
        );
      }
      vi.spyOn(fixture.evidence, "read").mockResolvedValue({
        version: 1,
        executionRunId: "run",
        attemptId: "attempt",
        signature: "stack",
        parts: [{ id: "stdout", objectKey: "stdout", sizeBytes: 10 }],
        stackParts: [{ id: "stack", objectKey: "stack", sizeBytes: 10 }],
        stdoutComplete: true,
        limitations: [],
      });
      fixture.reserveModel.mockResolvedValue(true);
      fixture.complete.mockImplementation(async (input) => ({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "reply",
            type: "function",
            function: {
              name: "submit_ai_conclusion",
              arguments: JSON.stringify({
                recommendation: "rerun_likely",
                reason: "连接瞬断。".repeat(80),
                evidence: "业务日志显示连接重置。".repeat(80),
                evidenceReferences: [JSON.parse(input.messages.at(-1).content).evidenceId],
              }),
            },
          },
        ],
      }));
      await fixture.worker.tick(new AbortController().signal);
      expect(fixture.complete).toHaveBeenCalledTimes(1);
      expect(defer).not.toHaveBeenCalled();
      expect(fixture.deferGroup).not.toHaveBeenCalled();
      const rendered =
        mode === "single"
          ? saveDraft.mock.calls[0]![3]
          : fixture.saveStackGroup.mock.calls[0]![1].conclusion;
      expect(rendered.split("\n")).toHaveLength(3);
      expect(rendered).toContain("可能重跑通过");
      expect(rendered.split("\n")[1].length).toBeLessThanOrEqual(163);
      expect(rendered.split("\n")[2].length).toBeLessThanOrEqual(203);
      expect(rendered).toMatch(/…$/u);
    },
  );
  it("does not label incomplete stdout in a small group as a full-log analysis", async () => {
    const fixture = groupWorker();
    fixture.work.strategy = "stack_groups_v2";
    fixture.groupMembers.mockResolvedValue([
      { id: "member", displayName: "case", evidenceKey: "manifest" },
    ]);
    vi.spyOn(fixture.evidence, "read").mockResolvedValue({
      version: 1,
      executionRunId: "r",
      attemptId: "a",
      signature: "s",
      parts: [],
      limitations: ["stdout 日志超过配置的采集空间预算"],
      stdoutComplete: false,
    });
    await fixture.worker.tick(new AbortController().signal);
    expect(fixture.complete).not.toHaveBeenCalled();
    expect(fixture.deferGroup).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("stdout 日志超过配置的采集空间预算"),
      expect.any(String),
      true,
      expect.any(String),
    );
  });
  it("sends equal-stack members together and saves one concise group suggestion", async () => {
    const fixture = groupWorker();
    fixture.work.strategy = "stack_groups_v2";
    fixture.work.signature = "exact-stack-bundle-v1:test";
    fixture.work.memberCount = 10;
    fixture.configuration.referencePrompts = [
      { title: "参考", content: "环境依赖波动优先核对重跑。" },
    ];
    fixture.groupMembers.mockResolvedValue(
      Array.from({ length: 10 }, (_, index) => ({
        id: `member-${index}`,
        displayName: `Case ${index}`,
      })),
    );
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
    expect(payload.members).toHaveLength(10);
    expect(fixture.saveStackGroup).toHaveBeenCalledWith(
      fixture.work,
      expect.objectContaining({
        processed: 10,
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
