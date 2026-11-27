import { AI_ISSUE_SUBJECT_LIMIT, aiModelConfigurationSchema } from "@autoforge/contracts";
import { expect, it, vi } from "vitest";
import type {
  AiEvidencePort,
  AiGroupWork,
  AiIssueCandidate,
  AiIssueClassificationRepository,
  AiIssueSynthesis,
} from "../src";
import { AiIssueClassifier, estimateAiIssueTokens } from "../src/ai-issue-classifier";

function issueRepository(
  overrides: Partial<AiIssueClassificationRepository>,
): AiIssueClassificationRepository {
  return {
    claimBatch: vi.fn(),
    advanceBatch: vi.fn(),
    stacks: vi.fn(),
    saveInitialClassification: vi.fn(),
    deferBatch: vi.fn(),
    categories: vi.fn(),
    saveRefinement: vi.fn(),
    assignCategory: vi.fn(),
    skipMember: vi.fn(),
    releaseSmallCategories: vi.fn(),
    nextSynthesis: vi.fn(),
    synthesisFindings: vi.fn(),
    saveSynthesis: vi.fn(),
    ...overrides,
  };
}

function evidenceRepository(stackLine?: string): AiEvidencePort {
  return {
    collect: vi.fn(),
    read: async () => ({
      version: 1,
      executionRunId: "run",
      attemptId: "attempt",
      signature: "stack",
      stdoutComplete: true,
      limitations: [],
      parts: [{ id: "stdout-1", objectKey: "stdout", sizeBytes: 32 }],
      ...(stackLine ? { stackLine } : {}),
    }),
    part: async () => "待复核的业务日志",
  };
}

it("carries an existing match across candidate pages and preserves its conclusion", async () => {
  const conclusion = {
    recommendation: "business_issue_likely" as const,
    reason: "已有类别的证据同时解释了所有成员。",
    evidence: "业务接口没有返回结果。",
    evidenceReferences: ["stdout-1"],
  };
  const candidates: AiIssueCandidate[] = Array.from({ length: 27 }, (_, index) => ({
    id: `cause-${String(index).padStart(2, "0")}`,
    summary: `原因 ${index}`,
    conclusion,
  }));
  const work: AiGroupWork = {
    id: "group",
    jobId: "job",
    batchId: "batch",
    projectId: "project",
    requestedBy: "actor",
    leaseToken: "worker-1",
    cursor: "",
    signature: "stack",
    conclusion: null,
    attempts: 0,
    processed: 27,
    memberCount: 28,
  };
  const issues = issueRepository({
    categories: async (_work, after, limit) =>
      candidates.filter(({ id }) => id > after).slice(0, limit),
    saveRefinement: vi.fn(async (_work, progress) => {
      work.refinement = progress.state;
    }),
  });
  const comparisons: string[][] = [];
  const classifier = new AiIssueClassifier(
    {
      issues,
      groupMembers: async () => [
        {
          id: "member",
          displayName: "用例",
          conclusion: null,
          reason: null,
          evidenceKey: "evidence",
        },
      ],
    },
    evidenceRepository(),
    aiModelConfigurationSchema.parse({ baseUrl: "http://model/v1", modelId: "test" }),
    async (messages, tool) => {
      const { existingCategories } = JSON.parse(
        messages.find(({ role }) => role === "user")!.content!,
      );
      comparisons.push(existingCategories.map(({ summary }: { summary: string }) => summary));
      return {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "verdict",
            type: "function",
            function: {
              name: tool.function.name,
              arguments: JSON.stringify({
                categoryId: "1",
                useExistingConclusion: true,
                summary: "本用例临时简述",
                conclusion: { ...conclusion, reason: "本用例临时原因" },
              }),
            },
          },
        ],
      };
    },
    () => "2026-11-25T00:00:00Z",
  );
  const signal = new AbortController().signal;
  await classifier.refineMember(work, signal);
  expect(issues.assignCategory).not.toHaveBeenCalled();
  expect(work.refinement?.afterCategory).toBe("cause-23");
  expect(work.refinement?.preferred).toEqual(candidates[0]);
  const resumedWork = { ...work, leaseToken: "worker-2" };
  await classifier.refineMember(resumedWork, signal);
  expect(comparisons).toEqual([
    candidates.slice(0, 24).map(({ summary }) => summary),
    ["原因 0", "原因 24", "原因 25", "原因 26"],
  ]);
  expect(issues.assignCategory).toHaveBeenCalledWith(
    resumedWork,
    "member",
    candidates[0],
    expect.any(String),
    expect.objectContaining({ reason: "本用例临时原因" }),
  );
});

it("keeps useful initial classification evidence under a smaller configured budget", async () => {
  const stack = "异常堆栈🚧".repeat(600);
  const configuration = aiModelConfigurationSchema.parse({
    baseUrl: "http://model/v1",
    modelId: "test",
    contextTokens: 8192,
    outputTokens: 512,
  });
  const issues = issueRepository({
    stacks: async () => [{ id: "stack", memberCount: 5, evidenceKey: "evidence" }],
  });
  const classifier = new AiIssueClassifier(
    { issues, groupMembers: vi.fn() },
    evidenceRepository(stack),
    configuration,
    async (messages, tool) => {
      expect(estimateAiIssueTokens(messages, configuration)).toBeLessThanOrEqual(8192);
      const payload = JSON.parse(messages.find(({ role }) => role === "tool")!.content!);
      expect(payload.stacks).toHaveLength(1);
      expect(payload.stacks[0]).toMatchObject({ count: 5, shortened: true });
      const excerpt: string = payload.stacks[0].stack;
      expect(excerpt.length).toBeGreaterThan(800);
      expect(excerpt.length).toBeLessThan(stack.length);
      expect(stack.startsWith(excerpt)).toBe(true);
      expect(Array.from(excerpt).at(-1)).not.toMatch(/[\uD800-\uDFFF]/u);
      return {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "verdict",
            type: "function",
            function: {
              name: tool.function.name,
              arguments: JSON.stringify({ categories: [{ stackId: "1", summary: "暂定异常" }] }),
            },
          },
        ],
      };
    },
    () => "2026-11-25T00:00:00Z",
  );
  const work = {
    jobId: "job",
    batchId: "batch",
    projectId: "project",
    requestedBy: "actor",
    leaseToken: "worker",
    phase: "classify" as const,
    cursor: "",
    attempts: 0,
  };
  await classifier.classifyStacks(work, new AbortController().signal);
  expect(issues.saveInitialClassification).toHaveBeenCalledWith(
    work,
    [{ id: "stack", summary: "暂定异常" }],
    expect.any(String),
  );
});

it("rejects a scope copied from another case and bounds verified scope while keeping the shared conclusion", async () => {
  const subjects = Array.from(
    { length: AI_ISSUE_SUBJECT_LIMIT },
    (_, index) => `目标队列-${index}`,
  );
  const candidate: AiIssueCandidate = {
    id: "shared-issue",
    summary: "依赖连接超时",
    conclusion: {
      recommendation: "rerun_likely",
      reason: "共享依赖连接耗时超过等待时限。",
      evidence: "日志记录 ConnectionTimeout。",
      evidenceReferences: ["stdout-1"],
    },
    scope: { subjects, hasMore: false },
  };
  const work: AiGroupWork = {
    id: "group",
    jobId: "job",
    batchId: "batch",
    projectId: "project",
    requestedBy: "actor",
    leaseToken: "worker-1",
    cursor: "",
    signature: "stack",
    conclusion: null,
    attempts: 0,
    processed: 8,
    memberCount: 9,
  };
  const issues = issueRepository({ categories: async () => [candidate] });
  let observed = subjects[0]!;
  const classifier = new AiIssueClassifier(
    {
      issues,
      groupMembers: async () => [
        { id: "member", displayName: "用例", conclusion: null, reason: null, evidenceKey: "log" },
      ],
    },
    { ...evidenceRepository(), part: async () => "NightlySync 依赖连接失败 ConnectionTimeout" },
    aiModelConfigurationSchema.parse({ baseUrl: "http://model/v1", modelId: "test" }),
    async (_messages, tool) => ({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "scope-verdict",
          type: "function",
          function: {
            name: tool.function.name,
            arguments: JSON.stringify({
              categoryId: "1",
              useExistingConclusion: true,
              summary: candidate.summary,
              conclusion: candidate.conclusion,
              affectedSubjects: [observed],
            }),
          },
        },
      ],
    }),
    () => "2026-11-25T00:00:00Z",
  );
  const signal = new AbortController().signal;
  await expect(classifier.refineMember(work, signal)).rejects.toThrow("须原样引用本用例");
  expect(issues.assignCategory).not.toHaveBeenCalled();
  observed = "NightlySync";
  await classifier.refineMember(work, signal);
  expect(issues.assignCategory).toHaveBeenCalledWith(
    work,
    "member",
    { ...candidate, scope: { subjects, hasMore: true } },
    expect.any(String),
    candidate.conclusion,
  );
});

it("combines every member finding across synthesis checkpoints before completing the category", async () => {
  const conclusion = {
    recommendation: "rerun_likely" as const,
    reason: "共享服务连接超时。",
    evidence: "观测到重复的连接错误。",
    evidenceReferences: ["stdout-1"],
  };
  let category: AiIssueSynthesis = {
    id: "issue",
    summary: "连接故障",
    conclusion,
    memberCount: 26,
    memberCursor: "",
  };
  const memberFindings = Array.from({ length: category.memberCount }, (_, index) => ({
    id: String(index).padStart(2, "0"),
    conclusion: index < 24 ? conclusion : { ...conclusion, evidence: "后续成员还记录重连失败。" },
  }));
  const saveSynthesis = vi.fn<AiIssueClassificationRepository["saveSynthesis"]>(
    async (_work, _now, progress) => {
      if (progress) category = { ...progress.category, memberCursor: progress.memberCursor };
    },
  );
  const issues = issueRepository({
    nextSynthesis: async () => category,
    synthesisFindings: async ({ memberCursor }, limit) =>
      memberFindings.filter(({ id }) => id > memberCursor).slice(0, limit),
    saveSynthesis,
  });
  const work: AiGroupWork = {
    id: "group",
    jobId: "job",
    batchId: "batch",
    projectId: "project",
    requestedBy: "actor",
    leaseToken: "worker-1",
    cursor: "",
    signature: "stack",
    conclusion: null,
    attempts: 0,
    processed: 26,
    memberCount: 26,
    synthesisAfter: "",
  };
  const counts: number[] = [];
  const classifier = new AiIssueClassifier(
    { issues, groupMembers: vi.fn() },
    evidenceRepository(),
    aiModelConfigurationSchema.parse({ baseUrl: "http://model/v1", modelId: "test" }),
    async (messages, tool) => {
      expect(tool.function.name).toBe("summarize_ai_issue");
      const payload = JSON.parse(messages.find(({ role }) => role === "tool")!.content!);
      counts.push(payload.findings[0].count);
      if (counts.length === 1) expect(payload.previousSynthesis).toBeNull();
      else {
        expect(payload.previousSynthesis.reason).toBe(conclusion.reason);
        expect(payload.findings[0].evidence).toBe("后续成员还记录重连失败。");
      }
      return {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "synthesis",
            type: "function",
            function: {
              name: tool.function.name,
              arguments: JSON.stringify({
                summary: category.summary,
                conclusion: {
                  ...conclusion,
                  evidenceReferences: [payload.evidenceId],
                  evidence: payload.findings[0].evidence,
                },
              }),
            },
          },
        ],
      };
    },
    () => "2026-11-25T00:00:00Z",
  );
  const signal = new AbortController().signal;
  await classifier.synthesizeCategory(work, signal);
  await classifier.synthesizeCategory({ ...work, leaseToken: "worker-2" }, signal);
  expect(counts).toEqual([24, 2]);
  expect(
    saveSynthesis.mock.calls.map(([, , progress]) => [progress?.memberCursor, progress?.complete]),
  ).toEqual([
    ["23", false],
    ["25", true],
  ]);
});
