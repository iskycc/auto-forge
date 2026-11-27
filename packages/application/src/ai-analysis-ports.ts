import type {
  AiAnalysisJob,
  AiAnalysisItem,
  AiAnalysisView,
  AiModelConfiguration,
  AiConclusionDraft,
  AiAnalysisStrategy,
  AiIssueCategory,
  AiIssueScope,
  AiPreliminaryConclusion,
} from "@autoforge/contracts";

export type AiConfigurationRecord = {
  revision: number;
  configuration: AiModelConfiguration | null;
  encryptedKey: string | null;
};
export type AiCandidate = { executionRunId: string; attemptId: string; displayName: string };
export type AiPlanningJob = AiAnalysisJob & {
  cursor: string | null;
  leaseToken: string;
  intakeOpen?: boolean;
};
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
  stackLine?: string;
  stackLineShortened?: boolean;
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
  initialSummary?: string;
  refinement?: AiIssueRefinement;
  releaseAfter?: string;
  synthesisAfter?: string;
};
export type AiIssueCandidate = {
  id: string;
  summary: string;
  conclusion: AiPreliminaryConclusion;
  scope?: AiIssueScope;
};
export type AiIssueRefinement = {
  previousPart?: AiPreliminaryConclusion;
  subjectCandidates?: string[];
  afterCategory?: string;
  preferred?: AiIssueCandidate;
};
export type AiIssueBatchWork = Pick<
  AiGroupWork,
  "jobId" | "batchId" | "projectId" | "requestedBy" | "leaseToken" | "attempts"
> & {
  phase: "plan" | "classify" | "refine" | "rank" | "publish";
  cursor: string;
};
export type AiIssueStack = { id: string; memberCount: number; evidenceKey: string };
export type AiIssueSynthesis = AiIssueCandidate & { memberCount: number; memberCursor: string };
export interface AiIssueClassificationRepository {
  claimBatch(token: string, now: string, expiresAt: string): Promise<AiIssueBatchWork | null>;
  advanceBatch(work: AiIssueBatchWork, now: string): Promise<void>;
  stacks(work: AiIssueBatchWork, limit: number): Promise<AiIssueStack[]>;
  saveInitialClassification(
    work: AiIssueBatchWork,
    labels: ReadonlyArray<{ id: string; summary: string }>,
    now: string,
  ): Promise<void>;
  deferBatch(
    work: AiIssueBatchWork,
    reason: string,
    retryAt: string,
    failed: boolean,
    consumeAttempt: boolean,
    now: string,
  ): Promise<void>;
  categories(work: AiGroupWork, after: string, limit: number): Promise<AiIssueCandidate[]>;
  saveRefinement(
    work: AiGroupWork,
    progress: { partCursor: number; state: AiIssueRefinement },
    now: string,
  ): Promise<void>;
  assignCategory(
    work: AiGroupWork,
    memberId: string,
    category: AiIssueCandidate,
    now: string,
    finding?: AiPreliminaryConclusion,
  ): Promise<void>;
  skipMember(work: AiGroupWork, memberId: string, now: string): Promise<void>;
  releaseSmallCategories(work: AiGroupWork, now: string): Promise<void>;
  nextSynthesis(work: AiGroupWork): Promise<AiIssueSynthesis | null>;
  synthesisFindings(
    category: AiIssueSynthesis,
    limit: number,
  ): Promise<Array<{ id: string; conclusion: AiPreliminaryConclusion }>>;
  saveSynthesis(
    work: AiGroupWork,
    now: string,
    progress?: { category: AiIssueSynthesis; memberCursor: string; complete: boolean },
  ): Promise<void>;
}
export type AiGroupMember = {
  id: string;
  displayName: string;
  conclusion: string | null;
  reason: string | null;
  evidenceKey?: string | null;
};
export interface AiAnalysisRepository {
  readonly issues: AiIssueClassificationRepository;
  configuration(): Promise<AiConfigurationRecord>;
  runtime(input: {
    now: string;
    projectIds?: readonly string[];
  }): Promise<import("@autoforge/contracts").AiAnalysisRuntimeSnapshot>;
  saveConfiguration(record: AiConfigurationRecord, expectedRevision: number): Promise<boolean>;
  create(
    job: AiAnalysisJob,
    requestKey: string,
    options?: { followFinalResults: boolean },
  ): Promise<AiAnalysisJob>;
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
  claimWork(
    token: string,
    now: string,
    expiresAt: string,
    stage?: "prepare" | "infer" | "supplement",
  ): Promise<AiWork | null>;
  renew(work: AiWork, expiresAt: string, now: string): Promise<boolean>;
  saveEvidence(work: AiWork, evidenceKey: string, signature: string, now: string): Promise<void>;
  saveDraft(
    work: AiWork,
    draft: AiConclusionDraft,
    cursor: number,
    conclusion: string | null,
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
    work?: { jobId: string; stage: import("@autoforge/contracts").AiModelRequestStage };
  }): Promise<boolean>;
  releaseModel(token: string): Promise<void>;
  coolDown(until: string): Promise<void>;
  exportConclusions(
    batchId: string,
    attemptIds: string[],
    before: string,
    classificationJobId?: string,
  ): Promise<Array<{ attemptId: string; conclusion: string; category?: AiIssueCategory }>>;
  exportClassificationJob(batchId: string, before: string): Promise<string | null>;
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

/** Web routes and background bundles can contain different copies of this error class. */
export function isAiModelRequestError(error: unknown): error is AiModelRequestError {
  return (
    error instanceof Error &&
    error.name === "AiModelRequestError" &&
    "retryable" in error &&
    typeof error.retryable === "boolean" &&
    (!("retryAfterMs" in error) ||
      error.retryAfterMs === undefined ||
      (typeof error.retryAfterMs === "number" &&
        Number.isFinite(error.retryAfterMs) &&
        error.retryAfterMs >= 0))
  );
}
export class AiResourceDeferral extends Error {
  constructor(options?: ErrorOptions) {
    super("平台资源繁忙，AI 已暂时退避。", options);
    this.name = "AiResourceDeferral";
  }
}
