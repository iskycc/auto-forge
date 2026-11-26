import { aiModelConfigurationSchema } from "@autoforge/contracts";
import { expect, it, vi } from "vitest";
import type {
  AiEvidencePort,
  AiGroupWork,
  AiIssueCandidate,
  AiIssueClassificationRepository,
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
