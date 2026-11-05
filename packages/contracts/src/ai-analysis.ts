import { z } from "zod";

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
export const aiPreliminaryConclusionSchema = z
  .object({
    recommendation: z.enum(["rerun_likely", "case_change_likely", "business_issue_likely"]),
    reason: z.string().trim().min(1).max(160),
    evidence: z.string().trim().min(1).max(200),
    evidenceReferences: z.array(z.string().min(1).max(300)).min(1).max(100),
  })
  .strict();
export type AiPreliminaryConclusion = z.infer<typeof aiPreliminaryConclusionSchema>;
export type AiConclusionDraft = AiConclusion | AiPreliminaryConclusion;
export type AiAnalysisStrategy = "legacy" | "stack_groups_v2" | "single_full_v2";
export type AiAnalysisStatus =
  | "queued"
  | "preparing"
  | "analyzing"
  | "summarizing"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled";
export type AiAnalysisJob = {
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
