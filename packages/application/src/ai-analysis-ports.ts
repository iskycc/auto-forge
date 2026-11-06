import type {
  AiAnalysisJob,
  AiAnalysisItem,
  AiAnalysisView,
  AiModelConfiguration,
  AiConclusionDraft,
  AiAnalysisStrategy,
} from "@autoforge/contracts";

export type AiConfigurationRecord = {
  revision: number;
  configuration: AiModelConfiguration | null;
  encryptedKey: string | null;
};
export type AiCandidate = { executionRunId: string; attemptId: string; displayName: string };
export type AiPlanningJob = AiAnalysisJob & { cursor: string | null; leaseToken: string };
export type AiEvidencePart = { id: string; objectKey: string; sizeBytes: number };
export const AI_EVIDENCE_INPUT_POLICY = "stdout_business_tail_v3";
export type AiEvidence = {
  version: 1;
  inputPolicy?: "stdout_business_v1" | "stdout_business_tail_v2" | typeof AI_EVIDENCE_INPUT_POLICY;
  inputTransformations?: string[];
  stdoutComplete?: boolean;
  executionRunId: string;
  attemptId: string;
  parts: AiEvidencePart[];
  limitations: string[];
  signature: string;
  stackParts?: AiEvidencePart[];
};
export type AiWork = AiAnalysisItem & {
  strategy?: AiAnalysisStrategy;
  projectId: string;
  batchId: string;
  requestedBy: string;
  leaseToken: string;
  evidenceKey: string | null;
  attempts: number;
  partCursor: number;
  drafts: AiConclusionDraft[];
};
export type AiGroupWork = {
  strategy?: AiAnalysisStrategy;
  partCursor?: number;
  id: string;
  jobId: string;
  batchId: string;
  projectId: string;
  requestedBy: string;
  leaseToken: string;
  cursor: string;
  signature: string;
  conclusion: string | null;
  attempts: number;
  processed: number;
  memberCount: number;
};
export type AiGroupMember = {
  id: string;
  displayName: string;
  conclusion: string | null;
  reason: string | null;
  evidenceKey?: string | null;
};
export interface AiAnalysisRepository {
  configuration(): Promise<AiConfigurationRecord>;
  saveConfiguration(record: AiConfigurationRecord, expectedRevision: number): Promise<boolean>;
  create(job: AiAnalysisJob, requestKey: string): Promise<AiAnalysisJob>;
  view(input: {
    batchId: string;
    jobId?: string;
    attemptId?: string;
    after?: string;
    groupAfter?: string;
    limit: number;
  }): Promise<AiAnalysisView | null>;
  claimPlanning(token: string, now: string, expiresAt: string): Promise<AiPlanningJob | null>;
  candidates(job: AiPlanningJob, limit: number): Promise<AiCandidate[]>;
  appendCandidates(
    job: AiPlanningJob,
    candidates: AiCandidate[],
    done: boolean,
    now: string,
  ): Promise<void>;
  claimWork(token: string, now: string, expiresAt: string): Promise<AiWork | null>;
  renew(work: AiWork, expiresAt: string, now: string): Promise<boolean>;
  saveEvidence(work: AiWork, evidenceKey: string, signature: string, now: string): Promise<void>;
  saveDraft(
    work: AiWork,
    draft: AiConclusionDraft,
    cursor: number,
    conclusion: string,
    done: boolean,
    partial: boolean,
    now: string,
  ): Promise<void>;
  defer(work: AiWork, reason: string, retryAt: string, failed: boolean, now: string): Promise<void>;
  cancel(jobId: string, now: string): Promise<void>;
  wait(work: AiWork, reason: string, retryAt: string, now: string): Promise<void>;
  prepareGroups(now: string): Promise<void>;
  claimGroup(token: string, now: string, expiresAt: string): Promise<AiGroupWork | null>;
  groupMembers(work: AiGroupWork, limit?: number): Promise<AiGroupMember[]>;
  groupEvidence(work: AiGroupWork): Promise<string | null>;
  saveStackGroup(
    work: AiGroupWork,
    progress: {
      cursor: string;
      partCursor: number;
      processed: number;
      conclusion: string;
      done: boolean;
    },
    now: string,
  ): Promise<void>;
  saveGroup(
    work: AiGroupWork,
    cursor: string,
    conclusion: string,
    done: boolean,
    now: string,
  ): Promise<void>;
  deferGroup(
    work: AiGroupWork,
    reason: string,
    retryAt: string,
    failed: boolean,
    now: string,
    consumeAttempt?: boolean,
  ): Promise<void>;
  reserveModel(input: {
    token: string;
    revision: number;
    now: string;
    expiresAt: string;
    tokens: number;
    configuration: AiModelConfiguration;
  }): Promise<boolean>;
  releaseModel(token: string): Promise<void>;
  coolDown(until: string): Promise<void>;
  exportConclusions(
    batchId: string,
    attemptIds: string[],
    before: string,
  ): Promise<Array<{ attemptId: string; conclusion: string }>>;
  hasAnalysis(batchId: string, before: string): Promise<boolean>;
  source(attemptId: string): Promise<Record<string, unknown> | null>;
  evidenceReference(jobId: string, itemId: string): Promise<string | null>;
  automaticCandidates(
    after: string | null,
    limit: number,
  ): Promise<Array<{ batchId: string; projectId: string; requestedByUsername: string | null }>>;
}

export type AiToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    strict: true;
  };
};
export type AiModelMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
};
export interface AiModelGatewayPort {
  complete(input: {
    configuration: AiModelConfiguration;
    apiKey: string;
    messages: AiModelMessage[];
    tools: AiToolDefinition[];
    signal: AbortSignal;
  }): Promise<AiModelMessage>;
}
export class AiModelRequestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AiModelRequestError";
  }
}
export class AiResourceDeferral extends Error {
  constructor(options?: ErrorOptions) {
    super("平台资源繁忙，AI 已暂时退避。", options);
    this.name = "AiResourceDeferral";
  }
}
