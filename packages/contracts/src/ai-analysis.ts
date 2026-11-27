import { z } from "zod";

export const aiReasoningEffortSchema = z.enum([
  "default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export const aiReferencePromptSchema = z
  .object({
    title: z.string().trim().min(1).max(60),
    content: z.string().trim().min(1).max(1500),
  })
  .strict();

export const aiModelConfigurationSchema = z
  .object({
    enabled: z.boolean().default(false),
    baseUrl: z
      .url()
      .max(2048)
      .refine((value) => {
        const url = new URL(value);
        return (
          ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
        );
      }, "模型地址须为不含凭据及查询参数的 HTTP(S) API 根地址。"),
    modelId: z.string().trim().min(1).max(200),
    reasoningEffort: aiReasoningEffortSchema.default("default"),
    contextTokens: z.number().int().min(8192).max(2097152).default(32768),
    outputTokens: z.number().int().min(512).max(16384).default(2048),
    concurrency: z.number().int().min(1).max(32).default(2),
    requestsPerMinute: z.number().int().min(1).max(10000).default(30),
    tokensPerMinute: z.number().int().min(4096).max(10000000).default(200000),
    timeoutSeconds: z.number().int().min(10).max(300).default(90),
    maximumRetries: z.number().int().min(0).max(8).default(3),
    maximumEvidenceMiB: z.number().int().min(1).max(64).default(16),
    referencePrompts: z.array(aiReferencePromptSchema).max(20).default([]),
  })
  .strict()
  .refine(
    (value) =>
      value.outputTokens * 4 +
        5600 +
        new TextEncoder().encode(JSON.stringify(value.referencePrompts)).byteLength <
      value.contextTokens,
    "上下文不足，请降低输出预算或增大上下文，为工具、系统提示和证据保留空间。",
  )
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value.referencePrompts)).byteLength <= 20000,
    "参考提示词合计不得超过 20,000 UTF-8 字节，请精简内容。",
  );
export type AiModelConfiguration = z.infer<typeof aiModelConfigurationSchema>;
export const updateAiModelConfigurationSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    configuration: aiModelConfigurationSchema,
    apiKey: z.string().max(4096).optional(),
  })
  .strict();
export type AiModelConfigurationView = {
  revision: number;
  configuration: AiModelConfiguration | null;
  apiKeyConfigured: boolean;
};

export const createAiAnalysisSchema = z
  .object({
    batchId: z.string().min(1).max(128),
    attemptId: z.string().min(1).max(128).optional(),
    requestKey: z.string().min(1).max(128),
  })
  .strict();
export type CreateAiAnalysis = z.infer<typeof createAiAnalysisSchema>;
export const aiConclusionSchema = z
  .object({
    summary: z.string().trim().min(1).max(3000),
    possibleCauses: z.array(z.string().min(1).max(1000)).max(8),
    checks: z.array(z.string().min(1).max(1000)).max(8),
    evidenceReferences: z.array(z.string().min(1).max(300)).min(1).max(30),
    limitations: z.array(z.string().min(1).max(600)).max(8),
    confidence: z.enum(["low", "medium", "high"]),
  })
  .strict();
export type AiConclusion = z.infer<typeof aiConclusionSchema>;
export const AI_RECOMMENDATION_LABELS = {
  rerun_likely: "可能重跑通过",
  case_change_likely: "可能用例问题需要修改",
  business_issue_likely: "可能业务问题需要提单",
} as const;
export const AI_PRELIMINARY_TEXT_LIMITS = { reason: 160, evidence: 200 } as const;
export const AI_INTERMEDIATE_CONCLUSION_SUFFIX = "（分析中，待确认）";

const PREVIOUS_NOTE_PREFIX =
  /^(?:结合|根据|综合)(?:前片|前一片|上一片|本片|当前分片|前序分片|前后分片)(?:分析|证据|日志|内容)?\s*[，,：:、]\s*/u;
const LOG_PART_PREFIX =
  /^(?:(?:定位到|发现|识别出)\s*)?(?:本片|当前片|本分片|当前分片|本日志片|当前日志片|前片|前一片|上一片|最后一片)(?:日志)?(?:中(?:的)?|的)?[、，,：:\s]*/u;
const EXCEPTION_HEADING =
  /^(?:(?:最早(?:的)?|首个)(?:可)?解释性异常|最早(?:能|可)解释失败的异常)\s*(?:是|为|[：:＝=])?\s*/u;
const READING_PROCESS =
  /解释性异常|^(?:(?:请|仍需|有待|需要|需|待|已|尚未|仅|正在)\s*)?(?:结合|等待|查看|读取|分析)(?:前片|前一片|上一片|本片|后续(?:的)?(?:片段|分片|日志片)|下片|下一片|各分片)|^(?:已|尚未|仅|正在)(?:查看|读取|分析)(?:日志片|证据片)[。.!…\s]*$/u;
const EMPTY_OBSERVATION = /^(?:未知|无|暂无|待确认|参考日志|详见日志)[。.!…\s]*$/u;

/** Removes commentary about reading evidence while retaining the observation. */
export function aiPublishedStatement(value: string): string {
  return value
    .split(/(?<=[。！？])|\r?\n/u)
    .map((sentence) =>
      sentence
        .trim()
        .replace(PREVIOUS_NOTE_PREFIX, "")
        .replace(LOG_PART_PREFIX, "")
        .replace(EXCEPTION_HEADING, "")
        .replace(/^[：:，,\s]+/u, "")
        .trim(),
    )
    .filter(
      (sentence) =>
        /[\p{L}\p{N}]/u.test(sentence) &&
        !READING_PROCESS.test(sentence) &&
        !EMPTY_OBSERVATION.test(sentence),
    )
    .join(" ");
}

export const aiPreliminaryConclusionSchema = z
  .object({
    recommendation: z.enum(["rerun_likely", "case_change_likely", "business_issue_likely"]),
    reason: z.string().trim().min(1).max(AI_PRELIMINARY_TEXT_LIMITS.reason),
    evidence: z.string().trim().min(1).max(AI_PRELIMINARY_TEXT_LIMITS.evidence),
    evidenceReferences: z.array(z.string().min(1).max(300)).min(1).max(100),
  })
  .strict();
export type AiPreliminaryConclusion = z.infer<typeof aiPreliminaryConclusionSchema>;
export type AiConclusionDraft = AiConclusion | AiPreliminaryConclusion;
export const AI_BULK_ISSUE_MINIMUM = 5;
export const AI_BATCH_CLASSIFICATION_STRATEGY = "stack_refinement_v3";
export type AiAnalysisStrategy =
  "legacy" | "stack_groups_v2" | "single_full_v2" | typeof AI_BATCH_CLASSIFICATION_STRATEGY;
export type AiIssueCategory = { rank: number; summary: string };
export const AI_ISSUE_SUBJECT_LIMIT = 8;
export const AI_ISSUE_SUBJECT_LENGTH = 80;
export const AI_ISSUE_SCOPE_PREFIX = "受影响对象：";
export const aiIssueSubjectsSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(AI_ISSUE_SUBJECT_LENGTH)
      .regex(/^[^\p{Cc}\p{Cs}]+$/u),
  )
  .max(AI_ISSUE_SUBJECT_LIMIT);
export const aiIssueScopeSchema = z
  .object({ subjects: aiIssueSubjectsSchema, hasMore: z.boolean() })
  .strict();
export type AiIssueScope = z.infer<typeof aiIssueScopeSchema>;
export const aiIssueMemberObservationSchema = z
  .object({ conclusion: z.unknown(), affectedSubjects: aiIssueSubjectsSchema })
  .strict();
export const aiIssueSynthesisVerdictSchema = z
  .object({ summary: z.string(), conclusion: z.unknown() })
  .strict();
export const aiInitialStackVerdictSchema = z
  .object({
    categories: z.array(z.object({ stackId: z.string(), summary: z.string() }).strict()).max(50),
  })
  .strict();
export const aiIssueVerdictSchema = z
  .object({
    categoryId: z.string().nullable(),
    useExistingConclusion: z.boolean(),
    summary: z.string(),
    conclusion: z.unknown(),
    affectedSubjects: aiIssueSubjectsSchema.default([]),
  })
  .strict();
export type AiAnalysisStatus =
  | "queued"
  | "preparing"
  | "analyzing"
  | "summarizing"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled";

export const aiModelRequestStageSchema = z.enum(["stack", "group", "individual"]);
export type AiModelRequestStage = z.infer<typeof aiModelRequestStageSchema>;

const aiRuntimeCount = z.number().int().nonnegative();
const aiRuntimeJobSchema = z.object({
  id: z.string(),
  batchId: z.string(),
  taskName: z.string(),
  sequenceNumber: aiRuntimeCount.nullable(),
  single: z.boolean(),
  status: z.enum(["queued", "preparing", "analyzing", "summarizing"]),
  phase: z.enum(["plan", "classify", "refine", "rank", "publish", "individual"]).nullable(),
  acceptingFinalResults: z.boolean(),
  total: aiRuntimeCount,
  prepared: aiRuntimeCount,
  reviewed: aiRuntimeCount,
  completed: aiRuntimeCount,
  failed: aiRuntimeCount,
  requests: z.object({
    stack: aiRuntimeCount,
    group: aiRuntimeCount,
    individual: aiRuntimeCount,
  }),
});
const aiRuntimeTotalsSchema = z.object({
  sampledAt: z.iso.datetime(),
  enabled: z.boolean(),
  activeRequests: aiRuntimeCount,
  concurrencyLimit: aiRuntimeCount,
  coolingUntil: z.iso.datetime().nullable(),
  hasMoreJobs: z.boolean(),
});
export const aiAnalysisRuntimeSnapshotSchema = aiRuntimeTotalsSchema.extend({
  jobs: z.array(aiRuntimeJobSchema.extend({ projectId: z.string() })).max(20),
});
export type AiAnalysisRuntimeSnapshot = z.infer<typeof aiAnalysisRuntimeSnapshotSchema>;
export const aiAnalysisRuntimeSchema = aiRuntimeTotalsSchema.extend({
  jobs: z.array(aiRuntimeJobSchema.extend({ canCancel: z.boolean().default(false) })).max(20),
});
export type AiAnalysisRuntime = z.infer<typeof aiAnalysisRuntimeSchema>;
export type AiAnalysisJob = {
  acceptingFinalResults?: boolean;
  classificationReviewed?: number;
  strategy?: AiAnalysisStrategy;
  id: string;
  batchId: string;
  projectId: string;
  attemptId: string | null;
  requestedBy: string;
  status: AiAnalysisStatus;
  createdAt: string;
  updatedAt: string;
  total: number;
  prepared: number;
  completed: number;
  failed: number;
  reason: string | null;
  revision: number;
};
export type AiAnalysisItem = {
  id: string;
  jobId: string;
  executionRunId: string;
  attemptId: string;
  displayName: string;
  status: string;
  signature: string | null;
  conclusion: string | null;
  reason: string | null;
  updatedAt: string;
};
export type AiGroupFinding = {
  id: string;
  signature: string;
  memberCount: number;
  processed: number;
  status: string;
  conclusion: string | null;
  reason: string | null;
};
export type AiAnalysisView = {
  job: AiAnalysisJob;
  items: AiAnalysisItem[];
  groups?: AiGroupFinding[];
  nextCursor?: string;
  nextGroupCursor?: string;
};
