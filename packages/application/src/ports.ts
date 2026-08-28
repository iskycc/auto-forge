import type {
  AssignmentDto,
  ArtifactDeclaration,
  AttemptEventPage,
  CompleteAttemptResponse,
  CompletionResult,
  ExecutionSpec,
  LogChunk,
  JarInspection,
  JarImportJob,
  JarImportResult,
  JenkinsJobInspection,
  JavaSourceReference,
  JobEnvelope,
  ObjectEntry,
  ReconcileAttemptsInput,
  ReconcileAttemptsResponse,
  RenewLeaseResponse,
  UploadLogChunksResponse,
  TestNgClassCandidate,
  AnalyticsFilter,
  AnalyticsExportJob,
  AnalyticsSummary,
  ApiToken,
  CaseSuiteSchedule,
  GlobalSearchResult,
  LdapSyncJob,
  Notification,
  RetentionCategory,
  RetentionPolicy,
  RetentionPreview,
  ServiceAccount,
} from "@autoforge/contracts";
import type {
  AuditEvent,
  AuthenticatedIdentity,
  BuiltInRoleDefinition,
  CaseDefinitionWithMethods,
  CaseSource,
  CaseSourceComparison,
  CaseSourceSnapshotEntry,
  CaseSuite,
  CaseSuiteDetails,
  CaseSuiteExecutionPolicy,
  CaseVersion,
  CleanupJob,
  ExecutionEnvironmentSecretBinding,
  ExecutionEnvironmentVariable,
  RunAttempt,
  ExecutionRun,
  ExternalIdentity,
  Permission,
  Project,
  ProjectAdapterConfiguration,
  ProjectRuntimeAsset,
  RuntimeAssetKind,
  ProjectStructure,
  ProjectVersion,
  ProjectVersionDependency,
  Role,
  RoleScope,
  RetryConcurrencyState,
  RunBatch,
  RunBatchDetails,
  RunBatchAllRoundsSummary,
  RunBatchExecutionPolicy,
  RunBatchFinalSummary,
  RunBatchRoundConcurrency,
  RunBatchRoundConcurrencySource,
  RunBatchRoundRecovery,
  RunBatchRoundSummary,
  Runner,
  RunnerGroup,
  SchedulingDecision,
  SchedulingEvent,
  SchedulingEventType,
  SchedulingThresholds,
  SystemRoleBindingView,
  User,
  UserSession,
  UserStatus,
  TestStage,
  WebhookConfiguration,
  WebhookDelivery,
  WebhookDispatchClaim,
  WebhookRequestMethod,
} from "@autoforge/domain";
import type {
  DdtCaseListPage,
  DdtCaseListQuery,
  DdtDashboard,
  DdtDeletedCase,
  DdtExportSelection,
  DdtImportCaseOutcome,
  DdtImportFile,
  DdtImportFileResult,
  DdtImportJob,
  DdtImportPreviewFile,
  DdtImportedRow,
  DdtTemplateWriteRecord,
} from "./ddt-types";
import type {
  DdtCase,
  DdtCaseData,
  DdtCaseHistory,
  DdtCaseTemplate,
  DdtScope,
} from "@autoforge/domain";

export type CreateProjectVersionRecord = {
  id: string;
  projectId: string;
  name: string;
  normalizedName: string;
  recordedAt: string;
};

export type CreateTestStageRecord = {
  id: string;
  projectId: string;
  projectVersionId: string;
  name: string;
  normalizedName: string;
  description: string;
  recordedAt: string;
};

export type CreateProjectRuntimeAssetRecord = ProjectRuntimeAsset;

export interface ProjectStructureRepository {
  list(projectId: string): Promise<ProjectStructure>;
  createVersion(record: CreateProjectVersionRecord): Promise<ProjectVersion>;
  createStage(record: CreateTestStageRecord): Promise<TestStage>;
  createRuntimeAsset(record: CreateProjectRuntimeAssetRecord): Promise<ProjectRuntimeAsset>;
  replaceVersionRuntimeAsset(
    projectVersionId: string,
    record: CreateProjectRuntimeAssetRecord,
  ): Promise<ProjectVersionDependency>;
  updateAdapterConfiguration(input: {
    projectId: string;
    projectVersionId?: string;
    jdkAssetId?: string;
    jarBundleAssetId?: string;
    expectedRevision: number;
    actorId?: string;
    updatedAt: string;
  }): Promise<ProjectAdapterConfiguration>;
  inheritAdapterConfiguration(input: {
    projectId: string;
    sourceProjectVersionId: string;
    targetProjectVersionId: string;
    expectedRevision: number;
    actorId?: string;
    updatedAt: string;
  }): Promise<ProjectAdapterConfiguration>;
  detachVersionRuntimeAsset(input: {
    projectId: string;
    projectVersionId: string;
    kind: RuntimeAssetKind;
    expectedRevision: number;
    actorId?: string;
    updatedAt: string;
  }): Promise<{
    configuration: ProjectAdapterConfiguration;
    orphanedAsset?: ProjectRuntimeAsset;
  }>;
  deleteRuntimeAssetMetadata(assetId: string): Promise<void>;
  getAdapterConfiguration(
    projectId: string,
    projectVersionId?: string,
  ): Promise<ProjectAdapterConfiguration>;
}

export type StoredLdapConfiguration = {
  enabled: boolean;
  urls: string[];
  tlsMode: "ldaps" | "starttls";
  verifyTlsCertificate: boolean;
  caPem?: string;
  connectTimeoutMs: number;
  operationTimeoutMs: number;
  pageSize: number;
  maximumUsers: number;
  synchronizationIntervalMinutes: number;
  bindDn: string;
  bindPasswordEncrypted?: string;
  userBaseDn: string;
  userFilter: string;
  userIdAttribute: string;
  usernameAttribute: string;
  displayNameAttribute: string;
  emailAttribute: string;
  groupBaseDn?: string;
  groupFilter?: string;
  groupMemberAttribute: string;
  createdAt: string;
  updatedAt: string;
  version: number;
};

export type DirectoryConfiguration = Omit<StoredLdapConfiguration, "bindPasswordEncrypted"> & {
  bindPassword: string;
};

export type DirectoryIdentity = {
  subject: string;
  username: string;
  displayName: string;
  email?: string;
  distinguishedName: string;
  groupDns: string[];
  attributes: Record<string, string>;
};

export type StoredUserCredential = {
  user: User;
  passwordHash?: string;
};

export type CreateLocalUserRecord = {
  id: string;
  username: string;
  normalizedUsername: string;
  displayName: string;
  email?: string;
  passwordHash: string;
  forcePasswordChange: boolean;
  createdAt: string;
};

export type CreateLdapUserRecord = {
  userId: string;
  externalIdentityId: string;
  providerId: string;
  identity: DirectoryIdentity;
  synchronizedAt: string;
};

export type CreateSessionRecord = {
  id: string;
  userId: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
};

export type IdentityListPage = { items: User[]; nextCursor?: string };
export type AuditListPage = { items: AuditEvent[]; nextCursor?: string };

export interface IdentityAccessRepository {
  ensureBuiltInRoles(definitions: BuiltInRoleDefinition[], recordedAt: string): Promise<void>;
  hasUsers(): Promise<boolean>;
  bootstrapAdministrator(input: {
    tokenHash: string;
    user: CreateLocalUserRecord;
    systemRoleId: string;
    projectId: string;
    projectRoleId: string;
    recordedAt: string;
  }): Promise<User | null>;
  findUserByUsername(normalizedUsername: string): Promise<StoredUserCredential | null>;
  findUser(userId: string): Promise<User | null>;
  findExternalIdentity(providerId: string, subject: string): Promise<ExternalIdentity | null>;
  upsertLdapUser(input: CreateLdapUserRecord): Promise<User>;
  recordLoginFailure(
    userId: string,
    failedAttempts: number,
    lockedUntil: string | undefined,
    recordedAt: string,
  ): Promise<void>;
  createSessionAfterLogin(input: CreateSessionRecord): Promise<User>;
  resolveSession(tokenHash: string, now: string): Promise<AuthenticatedIdentity | null>;
  touchSession(sessionId: string, touchedAt: string): Promise<void>;
  revokeSession(sessionId: string, revokedAt: string): Promise<void>;
  revokeUserSessions(userId: string, revokedAt: string): Promise<void>;
  revokeUserSessionsForRole(roleId: string, revokedAt: string): Promise<void>;
  listUserSessions(userId: string, now: string): Promise<UserSession[]>;
  findSession(sessionId: string): Promise<UserSession | null>;
  listUsers(input: {
    query?: string;
    source?: "local" | "ldap";
    cursor?: string;
    limit: number;
  }): Promise<IdentityListPage>;
  createLocalUser(record: CreateLocalUserRecord): Promise<User>;
  updateUserStatus(userId: string, status: UserStatus, updatedAt: string): Promise<User>;
  resetPassword(
    userId: string,
    passwordHash: string,
    forcePasswordChange: boolean,
    updatedAt: string,
  ): Promise<User>;
  listRoles(): Promise<Role[]>;
  findRole(roleId: string): Promise<Role | null>;
  createRole(input: {
    id: string;
    key: string;
    name: string;
    description: string;
    scope: RoleScope;
    permissions: Permission[];
    createdAt: string;
  }): Promise<Role>;
  updateRole(input: {
    id: string;
    name?: string;
    description?: string;
    scope?: RoleScope;
    permissions?: Permission[];
    active?: boolean;
    updatedAt: string;
  }): Promise<Role>;
  deleteRole(roleId: string): Promise<boolean>;
  assignSystemRole(
    userId: string,
    roleId: string,
    actorId: string,
    assignedAt: string,
  ): Promise<void>;
  removeSystemRole(userId: string, roleId: string, removedAt: string): Promise<boolean>;
  assignProjectRole(input: {
    userId: string;
    projectId: string;
    roleId: string;
    actorId: string;
    assignedAt: string;
  }): Promise<void>;
  removeProjectRole(userId: string, projectId: string, roleId: string): Promise<boolean>;
  listProjectMemberships(projectId: string): Promise<Array<{ user: User; roleIds: string[] }>>;
  listProjects(projectIds?: readonly string[]): Promise<Project[]>;
  createProject(input: {
    id: string;
    name: string;
    slug: string;
    ownerUserId?: string;
    createdAt: string;
  }): Promise<Project>;
  archiveProject(projectId: string, archivedAt: string): Promise<Project>;
  transferProjectOwner(input: {
    projectId: string;
    ownerUserId: string;
    updatedAt: string;
  }): Promise<Project>;
  listSystemRoleBindingsForActiveUsers(): Promise<SystemRoleBindingView[]>;
  listSystemRoleBindings(): Promise<Array<{ userId: string; roleId: string }>>;
  getLdapConfiguration(): Promise<StoredLdapConfiguration | null>;
  saveLdapConfiguration(
    input: Omit<StoredLdapConfiguration, "createdAt" | "updatedAt" | "version"> & {
      updatedAt: string;
    },
  ): Promise<StoredLdapConfiguration>;
  listLdapGroupMappings(): Promise<
    Array<{ id: string; groupDn: string; roleId: string; projectId?: string; priority: number }>
  >;
  addLdapGroupMapping(input: {
    id: string;
    groupDn: string;
    normalizedGroupDn: string;
    roleId: string;
    projectId?: string;
    priority: number;
    recordedAt: string;
  }): Promise<void>;
  replaceLdapRoleBindings(input: {
    userId: string;
    groupDns: string[];
    mappings: Array<{ groupDn: string; roleId: string; projectId?: string; priority: number }>;
    recordedAt: string;
  }): Promise<void>;
  disableMissingLdapUsers(input: {
    providerId: string;
    activeSubjects: string[];
    recordedAt: string;
  }): Promise<string[]>;
  appendAudit(event: AuditEvent): Promise<void>;
  listAudit(input: {
    projectIds?: readonly string[];
    includeUnscoped?: boolean;
    actorId?: string;
    action?: string;
    resourceType?: string;
    result?: AuditEvent["result"];
    recordedAfter?: string;
    recordedBefore?: string;
    cursor?: string;
    limit: number;
  }): Promise<AuditListPage>;
}

export type ClaimedAssignmentRecord = {
  assignment: AssignmentDto;
  lease: {
    id: string;
    tokenEncrypted: string;
    version: number;
    expiresAt: string;
  };
};

// recoverExpired 命中的过期原因；resultCode 映射由应用层统一维护（见 recovery-scheduling-events）。
export type AttemptRecoveryReason =
  "claim_timeout" | "lease_expired" | "execution_timeout" | "upload_timeout";

// recoverExpired 实际回收的 attempt 明细，供应用层补写调度事件（总体/单 Runner 日志）。
// 排队超时（run 从未产生 attempt）不包含在明细中。
export type RecoveredAttemptExpiration = {
  attemptId: string;
  batchId: string;
  executionRunId: string;
  // claim_timeout 的 assignment 无人领取，事件不归属任何执行机。
  runnerId: string | null;
  reason: AttemptRecoveryReason;
  retryScheduled: boolean;
};

export interface ExecutionControlRepository {
  claim(input: {
    runnerId: string;
    requestId: string;
    availableSlots: number;
    labels: string[];
    capabilities: string[];
    leaseSeeds: Array<{ id: string; eventId: string; tokenHash: string; tokenEncrypted: string }>;
    now: string;
    leaseExpiresAt: string;
  }): Promise<ClaimedAssignmentRecord[]>;
  renewLease(input: {
    runnerId: string;
    leaseId: string;
    tokenHash: string;
    expectedVersion: number;
    now: string;
    expiresAt: string;
  }): Promise<RenewLeaseResponse>;
  completeAttempt(
    input: {
      runnerId: string;
      attemptId: string;
      completionId: string;
      leaseTokenHash: string;
      resultDigest: string;
      result: CompletionResult;
      eventId: string;
      auditEventId?: string;
      acceptedAt: string;
    },
    completionEvents?: CompletionSchedulingEventFactory,
  ): Promise<CompleteAttemptResponse>;
  reconcile(input: {
    runnerId: string;
    request: ReconcileAttemptsInput;
    now: string;
  }): Promise<ReconcileAttemptsResponse>;
  resolveAttemptInput(input: {
    runnerId: string;
    attemptId: string;
    inputId: string;
    leaseTokenHash: string;
    now: string;
  }): Promise<{ objectKey: string; sizeBytes: number; sha256: string }>;
  appendLogChunks(input: {
    runnerId: string;
    attemptId: string;
    leaseTokenHash: string;
    chunks: LogChunk[];
    receivedAt: string;
  }): Promise<UploadLogChunksResponse>;
  resolveAttemptProjectId(attemptId: string): Promise<string | null>;
  resolveExecutionRunProjectId(runId: string): Promise<string | null>;
  listLogChunks(input: {
    attemptId: string;
    stream: LogChunk["stream"];
    afterSequence: number;
    limit: number;
    query?: string;
    recordedAfter?: string;
    recordedBefore?: string;
  }): Promise<{
    items: LogChunk[];
    acknowledgedSequence: number;
    nextSequence?: number;
    truncated: boolean;
  }>;
  listAttemptEvents(input: {
    attemptId: string;
    afterEventId?: string;
    limit: number;
  }): Promise<AttemptEventPage>;
  declareArtifacts(input: {
    runnerId: string;
    attemptId: string;
    leaseTokenHash: string;
    artifacts: ArtifactDeclaration[];
    declaredAt: string;
  }): Promise<Array<ArtifactDeclaration & { status: "declared" | "uploaded" }>>;
  resolveArtifactUpload(input: {
    runnerId: string;
    attemptId: string;
    artifactId: string;
    leaseTokenHash: string;
    now: string;
  }): Promise<ArtifactDeclaration & { status: "declared" | "uploaded"; objectKey?: string }>;
  markArtifactUploaded(input: {
    attemptId: string;
    artifactId: string;
    objectKey: string;
    uploadedAt: string;
  }): Promise<void>;
  listArtifacts(attemptId: string): Promise<
    Array<
      ArtifactDeclaration & {
        status: "declared" | "uploaded" | "rejected";
        objectKey?: string;
      }
    >
  >;
  recoverExpired(input: {
    now: string;
    eventIds: string[];
    limit: number;
  }): Promise<RecoveredAttemptExpiration[]>;
  terminateBatch(input: {
    batchId: string;
    actorId: string;
    reason: string;
    eventId: string;
    requestedAt: string;
  }): Promise<number>;
  cancelRun(input: {
    runId: string;
    actorId: string;
    reason: string;
    eventId: string;
    requestedAt: string;
  }): Promise<boolean>;
  // 事件写入需要按 attempt 反查批次/执行机上下文；claim/complete 的 DTO 不携带 batchId。
  resolveAttemptSchedulingContext(attemptId: string): Promise<AttemptSchedulingContext | null>;
  /** 高频领取与恢复路径一次解析多个 attempt，避免每个 assignment 产生一次数据库往返。 */
  resolveAttemptSchedulingContexts?(
    attemptIds: readonly string[],
  ): Promise<Array<AttemptSchedulingContext & { attemptId: string }>>;
  /**
   * 统计入参中真实存在的 attempt 数量（内部分批查询，避免 IN 参数超出数据库绑定上限）。
   * 批量签发日志公开访问链接场景用一次校验替代逐个 resolveAttemptSchedulingContext。
   */
  countExistingAttemptIds(attemptIds: readonly string[]): Promise<number>;
}

export type AttemptSchedulingContext = {
  batchId: string;
  executionRunId: string;
  runnerId: string;
  attemptNumber: number;
  // execution_runs.display_name，供事件消息组装用例名。
  displayName: string;
  heldRound?: number;
};

export type SchedulingEventDraft = {
  id: string;
  batchId: string;
  runnerId?: string;
  executionRunId?: string;
  attemptId?: string;
  eventType: SchedulingEventType;
  message: string;
  payload?: Record<string, unknown>;
  recordedAt: string;
};

/**
 * 完成上报被状态机接受后，在同一数据库事务内生成调度事件。
 * 仓储在提交前调用工厂并写入事件，避免完成热路径额外支付两次往返。
 */
export type CompletionSchedulingEventFactory = (
  context: AttemptSchedulingContext,
  retryScheduled: boolean,
) => SchedulingEventDraft[];

export type ScheduledAssignmentRecord = {
  assignmentId: string;
  attemptId: string;
  executionRunId: string;
  batchId: string;
  runnerId: string;
  priority: number;
  executionSpec: ExecutionSpec;
  availableAt: string;
  claimDeadlineAt: string;
};

export interface PasswordHashPort {
  hash(password: string): Promise<string>;
  verify(password: string, encodedHash: string): Promise<boolean>;
}

export interface IdentityTokenPort {
  issue(): string;
  hash(value: string): string;
  verifyBootstrapToken(value: string): boolean;
}

export interface SecretCipherPort {
  readonly available: boolean;
  encrypt(plaintext: string, purpose: string): string;
  decrypt(ciphertext: string, purpose: string): string;
}

export interface DirectoryPort {
  test(configuration: DirectoryConfiguration): Promise<void>;
  authenticate(
    configuration: DirectoryConfiguration,
    username: string,
    password: string,
  ): Promise<DirectoryIdentity>;
  listUsers(configuration: DirectoryConfiguration): Promise<DirectoryIdentity[]>;
}

export interface JarDiscoveryPort {
  inspect(fileName: string, content: Uint8Array): Promise<JarInspection>;
  readSource(content: Uint8Array, reference: JavaSourceReference | undefined): Promise<string>;
}

export type ObjectWriteResult = {
  objectKey: string;
  created: boolean;
};

export type ArtifactUploadTarget =
  { kind: "control-plane" } | { kind: "direct"; uploadUrl: string; objectKey: string };

export type ArtifactObjectIdentity = {
  projectId: string;
  attemptId: string;
  artifactId: string;
  sha256: string;
  sizeBytes: number;
  mediaType: string;
};

export interface JarObjectStorePort {
  putJar(projectId: string, sha256: string, content: Uint8Array): Promise<ObjectWriteResult>;
  putObject(input: {
    objectKey: string;
    sha256: string;
    sizeBytes: number;
    mediaType: string;
    content: AsyncIterable<Uint8Array>;
  }): Promise<ObjectWriteResult>;
  putArtifact(input: {
    projectId: string;
    attemptId: string;
    artifactId: string;
    sha256: string;
    sizeBytes: number;
    mediaType: string;
    content: AsyncIterable<Uint8Array>;
  }): Promise<ObjectWriteResult>;
  prepareArtifactUpload(input: ArtifactObjectIdentity): Promise<ArtifactUploadTarget>;
  verifyArtifactUpload(input: ArtifactObjectIdentity): Promise<ObjectWriteResult>;
  delete(objectKey: string): Promise<void>;
  exists(objectKey: string): Promise<boolean>;
  list(input: { cursor?: string; limit: number; prefix?: string }): Promise<{
    items: ObjectEntry[];
    nextCursor?: string;
  }>;
  read(objectKey: string): Promise<Uint8Array>;
  ready(): Promise<void>;
  readonly storageKind: "local" | "minio";
}

export type ImportCaseRecord = {
  caseDefinitionId: string;
  caseVersionId: string;
  candidate: TestNgClassCandidate;
  methods: Array<{
    methodId: string;
    methodIndex: number;
  }>;
};

export type ImportCatalogRecord = {
  sourceId: string;
  projectId?: string;
  projectVersionId?: string;
  testStageId?: string;
  importedBy?: string;
  objectKey: string;
  displayName: string;
  importedAt: string;
  inspection: JarInspection;
  cases: ImportCaseRecord[];
};

export type CaseSourceVersionMerge = {
  currentCaseDefinitionId: string;
  candidateCaseDefinitionId: string;
  caseVersionId: string;
  snapshot: TestNgClassCandidate;
  methodIds: string[];
};

export type ExistingSource = {
  sourceId: string;
  classCount: number;
  methodCount: number;
};

export type CaseListQuery = {
  projectIds?: readonly string[];
  projectVersionId?: string;
  testStageId?: string;
  scopedOnly?: boolean;
  query?: string;
  cursor?: string;
  limit: number;
};

export type DeletedCaseDefinition = {
  id: string;
  projectId: string;
  displayName: string;
};

export type CaseListPage = {
  items: CaseDefinitionWithMethods[];
  nextCursor?: string;
};

export type InheritCaseDefinitionRecord = {
  sourceCaseDefinitionId: string;
  targetCaseDefinitionId: string;
  targetCaseVersionId: string;
  methods: Array<{ sourceMethodId: string; targetMethodId: string }>;
};

// 每个用例最近一次已到达终态的执行结果；尚无终态 run 的用例不返回。
// resultCode 为该终态 run 最后一次 attempt 的结果码，用于 blocked 口径分类
// （历史数据可能缺失）。
export type LatestCaseRunOutcome = {
  caseDefinitionId: string;
  outcome: "succeeded" | "failed" | "timed_out" | "cancelled";
  resultCode?: string;
  executedAt: string;
};

export type CaseActivity = {
  executions: Array<{
    runId: string;
    batchId: string;
    status: string;
    attemptId?: string;
    runnerId?: string;
    resultCode?: string;
    durationMs?: number;
    createdAt: string;
    finishedAt?: string;
  }>;
  analyses: Array<{
    attemptId: string;
    batchId: string;
    outcome: string;
    resultCode?: string;
    failureSignature?: string;
    durationMs?: number;
    passed: number;
    failed: number;
    skipped: number;
    completedAt: string;
  }>;
};

export type CaseExecutionHistoryAttempt = {
  id: string;
  attemptNumber: number;
  status: RunAttempt["status"];
  runnerId: string;
  runnerName?: string;
  resultCode?: string;
  durationMs?: number;
  createdAt: string;
  finishedAt?: string;
};

export type CaseExecutionHistoryItem = {
  runId: string;
  batchId: string;
  batchSequenceNumber: number;
  batchName: string;
  status: ExecutionRun["status"];
  createdAt: string;
  attempts: CaseExecutionHistoryAttempt[];
};

export type CaseExecutionHistoryQuery = {
  cursor?: string;
  limit: number;
  includeRunnerNames?: boolean;
};

export type CaseExecutionHistoryPage = {
  items: CaseExecutionHistoryItem[];
  nextCursor?: string;
};

export type DashboardSummary = {
  sourceCount: number;
  caseCount: number;
  methodCount: number;
  enabledMethodCount: number;
};

export type PublicPlatformStatisticsSnapshot = DashboardSummary & {
  runnerCount: number;
  onlineRunnerCount: number;
  busyRunnerCount: number;
  activeBatchCount: number;
  completedBatchCount: number;
  totalRunCount: number;
  succeededRunCount: number;
  failedRunCount: number;
};

export interface PlatformStatisticsRepository {
  read(onlineSince: string): Promise<PublicPlatformStatisticsSnapshot>;
}

export interface CaseCatalogRepository {
  createJarImportJob(record: {
    job: JarImportJob;
    objectKey: string;
    idempotencyKey: string;
    dispatchJob: JobEnvelope;
  }): Promise<JarImportJob>;
  getJarImportJob(jobId: string, projectIds?: readonly string[]): Promise<JarImportJob | null>;
  claimJarImportJob(input: {
    jobId: string;
    startedAt: string;
  }): Promise<{ job: JarImportJob; objectKey: string } | null>;
  updateJarImportJob(input: {
    jobId: string;
    status: JarImportJob["status"];
    progressPercent: number;
    result?: JarImportResult;
    errorCode?: string;
    errorSummary?: string;
    updatedAt: string;
    finishedAt?: string;
  }): Promise<JarImportJob>;
  requestJarImportCancellation(input: {
    jobId: string;
    projectIds?: readonly string[];
    updatedAt: string;
  }): Promise<JarImportJob>;
  retryJarImportJob(input: {
    jobId: string;
    projectIds?: readonly string[];
    dispatchJob: JobEnvelope;
    updatedAt: string;
  }): Promise<JarImportJob>;
  findSourceBySha256(
    sha256: string,
    projectId?: string,
    projectVersionId?: string,
    testStageId?: string,
  ): Promise<ExistingSource | null>;
  importCatalog(record: ImportCatalogRecord): Promise<void>;
  listCases(query: CaseListQuery): Promise<CaseListPage>;
  getCaseDefinition(
    caseDefinitionId: string,
    projectIds?: readonly string[],
  ): Promise<CaseDefinitionWithMethods | null>;
  listCaseActivity?(caseDefinitionId: string, limit: number): Promise<CaseActivity>;
  listCaseExecutionHistory(
    caseDefinitionId: string,
    query: CaseExecutionHistoryQuery,
  ): Promise<CaseExecutionHistoryPage>;
  // 批量查询每个用例最新一条终态 run 的结果；无终态记录或入参为空时不返回该用例。
  listLatestRunOutcomes(caseDefinitionIds: readonly string[]): Promise<LatestCaseRunOutcome[]>;
  updateCaseDefinition(input: {
    caseDefinitionId: string;
    expectedRevision: number;
    displayName?: string;
    description?: string;
    tags?: string[];
    enabled?: boolean;
    archived?: boolean;
    actorId: string;
    updatedAt: string;
  }): Promise<CaseDefinitionWithMethods>;
  deleteCaseDefinitions(
    caseDefinitionIds: readonly string[],
    projectIds?: readonly string[],
  ): Promise<DeletedCaseDefinition[]>;
  inheritCaseDefinitions(input: {
    projectId: string;
    sourceProjectVersionId: string;
    sourceTestStageId: string;
    targetProjectVersionId: string;
    targetTestStageId: string;
    records: InheritCaseDefinitionRecord[];
    actorId: string;
    inheritedAt: string;
  }): Promise<{ inheritedCount: number; skippedCount: number }>;
  listCaseVersions(caseDefinitionId: string, limit: number): Promise<CaseVersion[]>;
  getCaseVersion(caseDefinitionId: string, version: number): Promise<CaseVersion | null>;
  restoreCaseVersion(input: {
    caseDefinitionId: string;
    expectedRevision: number;
    versionId: string;
    version: number;
    sourceId: string;
    snapshot: TestNgClassCandidate;
    changeReason: string;
    methodIds: string[];
    actorId: string;
    restoredAt: string;
  }): Promise<CaseDefinitionWithMethods>;
  findExistingCaseIds(
    caseDefinitionIds: string[],
    projectId?: string,
    projectVersionId?: string,
  ): Promise<string[]>;
  listRecentSources(limit: number, projectIds?: readonly string[]): Promise<CaseSource[]>;
  listSources(limit: number, projectIds?: readonly string[]): Promise<CaseSource[]>;
  getSource(
    sourceId: string,
    projectIds?: readonly string[],
  ): Promise<{ source: CaseSource; inspection: JarInspection } | null>;
  setAuthoritativeSource(sourceId: string, projectId?: string): Promise<CaseSource>;
  getDashboardSummary(projectIds?: readonly string[]): Promise<DashboardSummary>;
  getAuthoritativeSource(projectId: string): Promise<CaseSource | null>;
  // 返回该来源对每个用例提供的最新不可变版本，用于来源间目录对比；
  // 不依赖 CaseDefinition 当前是否被手动恢复到其他来源版本。
  listSourceCaseSnapshots(
    sourceId: string,
  ): Promise<Array<{ caseDefinitionId: string; className: string; snapshotJson: string }>>;
  createSourceComparison(record: CreateSourceComparisonRecord): Promise<CaseSourceComparison>;
  getSourceComparison(comparisonId: string): Promise<CaseSourceComparison | null>;
  // 带修订号条件切换权威来源；冲突抛 CASE_SOURCE_REVISION_CONFLICT / CASE_SOURCE_NOT_FOUND。
  promoteAuthoritativeSource(input: {
    sourceId: string;
    expectedRevision: number;
    updatedAt: string;
    actorId?: string;
    versionMerges?: CaseSourceVersionMerge[];
  }): Promise<CaseSource>;
  updateSourceLifecycle(input: {
    sourceId: string;
    expectedRevision: number;
    lifecycleStatus: "active" | "archived" | "deleting";
    updatedAt: string;
  }): Promise<CaseSource>;
  countSourceReferences(
    sourceId: string,
  ): Promise<{ caseDefinitions: number; caseVersions: number; executionRuns: number }>;
  // 原子移除 deleting 来源并返回同一对象剩余的来源引用数。Full 实现必须按对象键加锁，
  // 使多个版本同时清理共享内容寻址对象时恰有最后一个任务负责回收对象。
  detachSourceForCleanup(sourceId: string, objectKey: string): Promise<number>;
  // 同事务把来源置为 deleting 并写入对象清理任务；修订冲突同上。
  enqueueSourceDeletion(input: {
    sourceId: string;
    expectedRevision: number;
    cleanupJobId: string;
    objectKey: string;
    availableAt: string;
    updatedAt: string;
  }): Promise<CaseSource>;
  getCleanupJob(cleanupJobId: string): Promise<CleanupJob | null>;
  completeCleanupJob(input: {
    id: string;
    status: "succeeded" | "failed";
    attemptCount: number;
    errorSummary?: string;
    finishedAt: string;
  }): Promise<void>;
}

export type CreateSourceComparisonRecord = {
  id: string;
  projectId: string;
  currentSourceId?: string;
  candidateSourceId: string;
  added: CaseSourceSnapshotEntry[];
  changed: CaseSourceSnapshotEntry[];
  removed: CaseSourceSnapshotEntry[];
  conflicts: CaseSourceSnapshotEntry[];
  truncated: boolean;
  createdBy?: string;
  createdAt: string;
};

export type CreateCaseSuiteRecord = {
  id: string;
  projectId?: string;
  actorId?: string;
  name: string;
  description?: string;
  policy?: CaseSuiteExecutionPolicy;
  createdAt: string;
};

export interface DdtRepository {
  listCases(query: DdtCaseListQuery): Promise<DdtCaseListPage>;
  getCase(scope: DdtScope, caseId: string): Promise<DdtCase | null>;
  getCases(scope: DdtScope, caseIds: readonly string[]): Promise<DdtCase[]>;
  findCaseData(scope: DdtScope, caseIds: readonly string[]): Promise<Map<string, DdtCaseData>>;
  listGroups(
    scope: DdtScope,
    query?: string,
    limit?: number,
  ): Promise<Array<{ srNum: string; count: number }>>;
  dashboard(scope: DdtScope): Promise<DdtDashboard>;
  exportCases(selection: DdtExportSelection): Promise<DdtCaseData[]>;
  updateCases(
    records: Array<{
      scope: DdtScope;
      caseId: string;
      expectedRevision: number;
      nextData: DdtCaseData;
      historyId: string;
      historyType: DdtCaseHistory["changeType"];
      sourceName: string;
      actorId?: string;
      updatedAt: string;
    }>,
  ): Promise<DdtCase[]>;
  trashCases(input: {
    scope: DdtScope;
    caseIds: readonly string[];
    recycleIds: readonly string[];
    actorId?: string;
    deletedAt: string;
  }): Promise<number>;
  listDeletedCases(input: DdtScope & { query?: string; cursor?: string; limit: number }): Promise<{
    items: DdtDeletedCase[];
    nextCursor?: string;
  }>;
  restoreDeletedCase(input: {
    scope: DdtScope;
    recycleId: string;
    restoredAt: string;
    actorId?: string;
  }): Promise<DdtCase>;
  purgeDeletedCase(scope: DdtScope, recycleId: string): Promise<boolean>;
  listHistory(input: DdtScope & { caseId: string; cursor?: string; limit: number }): Promise<{
    items: DdtCaseHistory[];
    nextCursor?: string;
  }>;
  getHistory(scope: DdtScope, caseId: string, historyId: string): Promise<DdtCaseHistory | null>;
  listTemplates(scope: DdtScope): Promise<DdtCaseTemplate[]>;
  getTemplateForSrNum(scope: DdtScope, srNum: string): Promise<DdtCaseTemplate | null>;
  writeTemplate(record: DdtTemplateWriteRecord): Promise<DdtCaseTemplate>;
  deleteTemplate(scope: DdtScope, templateId: string, expectedRevision: number): Promise<boolean>;
  createImportPreview(input: {
    job: Omit<DdtImportJob, "files">;
    files: DdtImportPreviewFile[];
  }): Promise<DdtImportJob>;
  confirmImport(input: {
    jobId: string;
    conflictStrategy: "overwrite" | "skip" | "error";
    dispatchJob: JobEnvelope;
    updatedAt: string;
    projectIds?: readonly string[];
  }): Promise<DdtImportJob>;
  getImportJob(jobId: string, projectIds?: readonly string[]): Promise<DdtImportJob | null>;
  listImportJobs(input: DdtScope & { cursor?: string; limit: number }): Promise<{
    items: DdtImportJob[];
    nextCursor?: string;
  }>;
  claimImportJob(jobId: string, startedAt: string): Promise<DdtImportJob | null>;
  requestImportCancellation(
    jobId: string,
    updatedAt: string,
    projectIds?: readonly string[],
  ): Promise<DdtImportJob>;
  updateImportJob(input: {
    jobId: string;
    status: DdtImportJob["status"];
    progressPercent: number;
    insertedCount?: number;
    updatedCount?: number;
    unchangedCount?: number;
    skippedCount?: number;
    failedFiles?: number;
    errorCode?: string;
    errorSummary?: string;
    updatedAt: string;
    finishedAt?: string;
  }): Promise<DdtImportJob>;
  updateImportFile(input: {
    fileId: string;
    status: DdtImportFile["status"];
    result?: DdtImportFileResult;
    errorSummary?: string;
    updatedAt: string;
  }): Promise<void>;
  importFile(input: {
    jobId: string;
    fileId: string;
    scope: DdtScope;
    sourceName: string;
    rows: DdtImportedRow[];
    conflictStrategy: "overwrite" | "skip" | "error";
    actorId?: string;
    importedAt: string;
    historyIds: readonly string[];
  }): Promise<DdtImportFileResult>;
  listImportCaseIds(
    jobId: string,
    projectIds?: readonly string[],
  ): Promise<Array<{ caseId: string; outcome: DdtImportCaseOutcome }>>;
}

export interface CaseSuiteRepository {
  create(record: CreateCaseSuiteRecord): Promise<CaseSuite>;
  list(
    limit: number,
    projectIds?: readonly string[],
    projectVersionId?: string,
  ): Promise<CaseSuite[]>;
  getSummary(suiteId: string, projectIds?: readonly string[]): Promise<CaseSuite | null>;
  get(suiteId: string, projectIds?: readonly string[]): Promise<CaseSuiteDetails | null>;
  findMemberCaseDefinitionIds(suiteId: string, candidateIds: readonly string[]): Promise<string[]>;
  getRoundRecoveryCredentials(
    suiteId: string,
    ruleIds: readonly string[],
  ): Promise<Record<string, string>>;
  updateSuite(input: UpdateCaseSuiteRecord): Promise<CaseSuite>;
  copySuite(input: CopyCaseSuiteRecord): Promise<CaseSuite>;
  addCases(input: {
    suiteId: string;
    items: Array<{ id: string; caseDefinitionId: string }>;
    versionId: string;
    actorId?: string;
    updatedAt: string;
  }): Promise<CaseSuite>;
  removeCases(input: {
    suiteId: string;
    caseDefinitionIds: string[];
    versionId: string;
    actorId?: string;
    updatedAt: string;
  }): Promise<CaseSuite>;
}

export type UpdateCaseSuiteRecord = {
  suiteId: string;
  expectedRevision: number;
  // versionId 是新 case_suite_versions 行的 ID，由应用层生成。
  versionId: string;
  changeReason: string;
  actorId?: string;
  updatedAt: string;
  name?: string;
  // undefined 保持不变，null 清空描述。
  description?: string | null;
  enabled?: boolean;
  archived?: boolean;
  // policy 必须是与现有策略合并后的完整策略。
  policy?: CaseSuiteExecutionPolicy;
  roundRecoveryCredentialUpserts?: Record<string, string>;
};

export type CopyCaseSuiteRecord = {
  id: string;
  projectId?: string;
  name: string;
  description?: string;
  // 复制继承源任务的完整策略与用例清单；ID 均由应用层生成。
  policy: CaseSuiteExecutionPolicy;
  items: Array<{ id: string; caseDefinitionId: string }>;
  versionId: string;
  actorId?: string;
  createdAt: string;
  roundRecoveryCredentials?: Record<string, string>;
};

export type RegisterRunnerRecord = {
  id: string;
  /** Rebind a reinstall to an existing, non-revoked Runner identity. */
  recoverExistingIdentity?: boolean;
  bootstrapTokenHash: string;
  credentialHash: string;
  name: string;
  os: string;
  architecture: string;
  agentVersion: string;
  protocolVersion: number;
  labels: string[];
  capabilities: string[];
  maxConcurrency: number;
  terminalEnabled: boolean;
  recordedAt: string;
};

export interface RunnerRepository {
  register(record: RegisterRunnerRecord): Promise<Runner | null>;
  findByCredentialHash(credentialHash: string, now: string): Promise<Runner | null>;
  heartbeat(input: {
    runnerId: string;
    labels: string[];
    capabilities: string[];
    maxConcurrency: number;
    busySlots: number;
    agentVersion: string;
    terminalEnabled: boolean;
    resourceSnapshot?: {
      cpuUtilizationPercent: number;
      memoryUtilizationPercent: number;
      loadAverage1m: number;
      logicalCpuCount: number;
      observedAt: string;
    };
    recordedAt: string;
  }): Promise<Runner>;
  list(offlineBefore: string, limit: number): Promise<Runner[]>;
  get(runnerId: string, offlineBefore: string): Promise<Runner | null>;
  /** 批量读取执行机，避免预检/创建路径按 ID 逐台查询形成 N+1 往返。 */
  listByIds(runnerIds: readonly string[], offlineBefore: string): Promise<Runner[]>;
  setLifecycleState(input: {
    runnerId: string;
    state: "active" | "draining" | "disabled";
    updatedAt: string;
  }): Promise<Runner>;
  requestCredentialRotation(input: { runnerId: string; requestedAt: string }): Promise<Runner>;
  rotateCredential(input: {
    runnerId: string;
    credentialHash: string;
    previousCredentialValidUntil: string;
    rotatedAt: string;
  }): Promise<Runner>;
  revokeCredential(input: { runnerId: string; revokedAt: string }): Promise<Runner>;
  deregister(input: { runnerId: string; deregisteredAt: string }): Promise<Runner>;
  // purge 是注销后的墓碑清除：写入 purgedAt、使凭据哈希不可再匹配并清空标签/能力，
  // 记录因执行历史外键保留在库中，但从列表隐藏。
  purge(input: { runnerId: string; purgedAt: string }): Promise<Runner>;
}

export type RunnerInstallationProfileRecord = {
  id: string;
  runnerId?: string;
  runnerName: string;
  connectionEncrypted: string;
  expectedHostKeySha256: string;
  installationMode: "auto" | "ubuntu" | "opensuse" | "opensuse-leap" | "opensuse-tumbleweed";
  runAsRoot: boolean;
  dataDirectory?: string;
  createdAt: string;
  updatedAt: string;
};

export interface RunnerInstallationProfileRepository {
  list(limit: number): Promise<RunnerInstallationProfileRecord[]>;
  get(profileId: string): Promise<RunnerInstallationProfileRecord | null>;
  findByRunnerId(runnerId: string): Promise<RunnerInstallationProfileRecord | null>;
  findPendingByRunnerName(runnerName: string): Promise<RunnerInstallationProfileRecord | null>;
  upsert(record: RunnerInstallationProfileRecord): Promise<RunnerInstallationProfileRecord>;
  bindPending(input: { runnerName: string; runnerId: string; updatedAt: string }): Promise<void>;
}

export interface RunnerGroupRepository {
  list(): Promise<RunnerGroup[]>;
  get(groupId: string): Promise<RunnerGroup | null>;
  create(input: {
    id: string;
    name: string;
    normalizedName: string;
    description: string;
    runnerIds: string[];
    recordedAt: string;
  }): Promise<RunnerGroup>;
  update(input: {
    groupId: string;
    expectedRevision: number;
    name?: string;
    normalizedName?: string;
    description?: string;
    runnerIds?: string[];
    updatedAt: string;
  }): Promise<RunnerGroup | null>;
  delete(groupId: string): Promise<boolean>;
}

export type Clock = {
  now(): Date;
};

export type IdGenerator = {
  next(): string;
};

export interface RunnerCredentialPort {
  issue(): string;
  issueBootstrapToken(replacementRunnerId?: string): string;
  hash(value: string): string;
  verifyBootstrapToken(value: string): boolean;
  replacementRunnerId?(value: string): string | undefined;
}

export type ClaimedJob = {
  job: JobEnvelope;
  deliveryId: string;
  leaseExpiresAt: string;
  deliveryAttempt: number;
};

export type DeadLetterJob = {
  messageId: string;
  runId: string;
  kind: JobEnvelope["kind"];
  deliveryAttempts: number;
  errorCode: string;
  errorSummary: string;
  failedAt: string;
};

export interface JobQueuePort {
  /**
   * true 表示 claim 自身携带服务端阻塞等待（如 JetStream fetch 的 expires）：
   * 空轮询的退避已由 claim 内部承担，JobWorker 不再叠加指数退避，避免空闲期后
   * 首个任务额外支付最长 maximumPollMs 的领取启动延迟。缺省/false 表示 claim
   * 立即返回（如 SQLite SELECT），空闲退避由 JobWorker 负责。
   */
  readonly blockingClaim?: boolean;
  publish(job: JobEnvelope, availableAt?: string): Promise<"published" | "duplicate">;
  claim(input: {
    workerId: string;
    now: string;
    leaseExpiresAt: string;
    limit: number;
  }): Promise<ClaimedJob[]>;
  renew(input: {
    workerId: string;
    deliveryId: string;
    now: string;
    leaseExpiresAt: string;
  }): Promise<boolean>;
  acknowledge(input: {
    workerId: string;
    deliveryId: string;
    acknowledgedAt: string;
  }): Promise<void>;
  reject(input: {
    workerId: string;
    deliveryId: string;
    errorCode: string;
    errorSummary: string;
    retryAt?: string;
    rejectedAt: string;
  }): Promise<"retrying" | "dead_letter">;
  recoverExpired(now: string, limit: number): Promise<number>;
  listDeadLetters(limit: number): Promise<DeadLetterJob[]>;
  redriveDeadLetters(input: { redrivenAt: string; limit: number }): Promise<number>;
  depth(): Promise<{ available: number; leased: number; deadLetter: number }>;
  ready(): Promise<void>;
  close(): Promise<void>;
}

export interface CachePort {
  get(
    namespace: string,
    tenantId: string,
    schemaVersion: number,
    key: string,
  ): Promise<string | null>;
  set(input: {
    namespace: string;
    tenantId: string;
    schemaVersion: number;
    key: string;
    value: string;
    ttlMs: number;
  }): Promise<void>;
  delete(namespace: string, tenantId: string, schemaVersion: number, key: string): Promise<void>;
  close(): Promise<void>;
}

export type CreateRunBatchRecord = {
  id: string;
  projectId?: string;
  environmentId?: string;
  environmentVersionId?: string;
  eventId?: string;
  suiteId: string;
  suiteName: string;
  suiteVersion: number;
  kind?: RunBatch["kind"];
  parentBatchId?: string;
  sourceExecutionRunId?: string;
  requestedBy?: RunBatch["requestedBy"];
  retryLimit: number;
  retryMode?: "immediate" | "round";
  priority?: number;
  queueTimeoutMs?: number;
  claimTimeoutMs?: number;
  executionTimeoutMs?: number;
  uploadTimeoutMs?: number;
  environmentVariables: ExecutionEnvironmentVariable[];
  secretBindings?: ExecutionEnvironmentSecretBinding[];
  runnerIds: string[];
  // 创建时固化的执行策略快照；缺省保持历史行为（不限并发、内置标签与默认产物规则）。
  policy?: RunBatchExecutionPolicy;
  roundRecoveries?: Array<{
    ruleId: string;
    afterRound: number;
    jenkinsJobUrl: string;
    apiKeyCiphertext: string;
    waitMinutes: number;
  }>;
  runs: Array<{
    id: string;
    caseDefinitionId: string;
    caseVersion: number;
    displayName: string;
    className: string;
    parameters?: Record<string, string>;
  }>;
  adapter?: CaseSuiteExecutionPolicy["adapter"];
  adapterRuntimeSnapshot?: RunBatchAdapterRuntimeSnapshot;
  dispatchJob?: JobEnvelope;
  scheduledFor?: string;
  createdAt: string;
};

export type RunBatchRuntimeAssetSnapshot = {
  id: string;
  sourceType: "upload" | "url";
  url?: string;
  sha256: string;
  sizeBytes: number;
  archiveFormat: "zip" | "tar.gz";
};

export type RunBatchAdapterRuntimeSnapshot = {
  suiteName: string;
  testName: string;
  environmentAddresses: string[];
  jdk?: RunBatchRuntimeAssetSnapshot;
  jarBundle?: RunBatchRuntimeAssetSnapshot;
};

/**
 * 派生执行必须读取原批次的不可变快照，而不是重新读取可能已经变更的任务配置。
 * Jenkins 密钥只在应用层编排和仓储之间传递，不进入 RunBatchDetails 或 HTTP DTO。
 */
export type RunBatchRerunSnapshot = {
  batch: RunBatch;
  adapterRuntime?: RunBatchAdapterRuntimeSnapshot;
  roundRecoveries: NonNullable<CreateRunBatchRecord["roundRecoveries"]>;
  runs: CreateRunBatchRecord["runs"];
};

export type AttemptRerunSource = {
  batchId: string;
  executionRunId: string;
  attemptStatus: RunAttempt["status"];
};

export type SchedulingSnapshot = {
  batch: RunBatch;
  queuedRuns: ExecutionRun[];
  candidates: Array<{ runner: Runner; reservedSlots: number }>;
  runnerFailureIdsByRun: Record<string, string[]>;
  projectActiveRuns: number;
  retryConcurrencyState?: RetryConcurrencyState;
  retryContext?: {
    executionRound: number;
    previousRoundPassRate: number | null;
    remainingRuns: number;
  };
};

export type ReserveSchedulingAssignmentsInput = {
  batchId: string;
  eventId?: string;
  projectMaximumConcurrency?: number;
  decisions: Array<SchedulingDecision & { attemptId: string; assignmentId: string }>;
  thresholds: SchedulingThresholds;
  offlineBefore: string;
  metricsFreshAfter: string;
  scheduledAt: string;
};

/**
 * 调度预留结果。acceptedAttemptIds 仅包含真正写入 run_attempts 的决策，
 * 被并发调度轮抢占（run 已不是 queued）的决策不在其中；
 * 后续调度事件只能引用被接受的 attempt，否则会触发外键冲突。
 */
export type ReserveAssignmentsOutcome = {
  reserved: number;
  acceptedAttemptIds: readonly string[];
};

export type RunBatchListQuery = {
  projectIds?: readonly string[];
  projectId?: string;
  projectVersionId?: string;
  suiteId?: string;
  caseDefinitionId?: string;
  status?: RunBatch["status"];
  runnerId?: string;
  createdAfter?: string;
  createdBefore?: string;
  cursor?: string;
  limit: number;
};

export type RunBatchListPage = {
  items: RunBatch[];
  nextCursor?: string;
};

export type RunBatchCaseScope = number | "all" | "summary";
export type RunBatchCaseStatusFilter = RunAttempt["status"] | "pending";
export type RunBatchCaseSort = "none" | "name" | "status" | "runner" | "duration";

export type RunBatchCasePageQuery = {
  batchId: string;
  projectIds?: readonly string[];
  scope: RunBatchCaseScope;
  status?: RunBatchCaseStatusFilter;
  query?: string;
  sort: RunBatchCaseSort;
  direction: "asc" | "desc";
  offset: number;
  limit: number;
};

export type RunBatchCasePage = {
  items: Array<{ run: ExecutionRun; attempt?: RunAttempt; round: number }>;
  total: number;
};

export type RunBatchRoundRunnerSummary = {
  round: number;
  runnerId: string;
  executed: number;
  passed: number;
  failed: number;
  lastActivity: string;
};

export type RunBatchRunnerFaultIncident = {
  key: string;
  runnerId: string;
  resultCode: string;
  summary: string;
  count: number;
  caseNames: string[];
  attemptNumbers: number[];
  lastOccurredAt: string;
};

/**
 * 批次详情首屏只携带有界聚合结果。用例/attempt 明细必须通过 listCasePage
 * 分页读取，避免 10 万用例批次被序列化到页面或由浏览器全量排序。
 */
export type RunBatchDetailOverview = {
  batch: RunBatch;
  roundSummaries: RunBatchRoundSummary[];
  allRoundsSummary: RunBatchAllRoundsSummary;
  finalSummary: RunBatchFinalSummary;
  roundRecoveries: RunBatchRoundRecovery[];
  roundConcurrencies: RunBatchRoundConcurrency[];
  runnerRoundSummaries: RunBatchRoundRunnerSummary[];
  runnerFaultIncidents: RunBatchRunnerFaultIncident[];
  participatingRunnerIds: string[];
  finishedAt: string;
};

/** 恢复与 Runner 生命周期路径只依赖这两个调度入口，不依赖具体服务实现。 */
export interface RunBatchSchedulingPort {
  schedule(batchId: string): Promise<unknown>;
  scheduleForRunner(runnerId: string, batchLimit?: number): Promise<unknown>;
}

export interface RunBatchRepository {
  create(record: CreateRunBatchRecord): Promise<RunBatch>;
  resolveAttemptRerunSource(attemptId: string): Promise<AttemptRerunSource | null>;
  getRerunSnapshot(
    batchId: string,
    selection: { executionRunId?: string; finalFailuresOnly?: boolean },
  ): Promise<RunBatchRerunSnapshot | null>;
  listCaseLogRerunBatches(
    parentBatchId: string,
    sourceExecutionRunId: string,
    limit: number,
  ): Promise<RunBatchDetails[]>;
  list(
    limit: number,
    projectIds?: readonly string[],
    projectVersionId?: string,
  ): Promise<RunBatch[]>;
  listPage(input: RunBatchListQuery): Promise<RunBatchListPage>;
  getSummary(batchId: string, projectIds?: readonly string[]): Promise<RunBatch | null>;
  getDetailOverview(
    batchId: string,
    projectIds?: readonly string[],
  ): Promise<RunBatchDetailOverview | null>;
  listCasePage(input: RunBatchCasePageQuery): Promise<RunBatchCasePage | null>;
  get(batchId: string, projectIds?: readonly string[]): Promise<RunBatchDetails | null>;
  /** 返回指定 Runner 仍可能收到后续 attempt 的非终态批次 ID。 */
  listReusableBatchIdsForRunner(runnerId: string, batchIds: readonly string[]): Promise<string[]>;
  listSchedulableBatchIds(
    limit: number,
    now?: string,
    agingIntervalMinutes?: number,
  ): Promise<string[]>;
  listSchedulableBatchIdsForRunner(
    runnerId: string,
    limit: number,
    now?: string,
    agingIntervalMinutes?: number,
  ): Promise<string[]>;
  getSchedulingSnapshot(
    batchId: string,
    offlineBefore: string,
    maximumQueuedRuns?: number,
  ): Promise<SchedulingSnapshot | null>;
  activateRetryConcurrency(input: {
    batchId: string;
    executionRound: number;
    expectedRuleId: string | null;
    state: RetryConcurrencyState;
    updatedAt: string;
  }): Promise<RetryConcurrencyState | null>;
  recordRoundConcurrency(input: {
    batchId: string;
    round: number;
    concurrency: number;
    source: RunBatchRoundConcurrencySource;
    ruleId?: string;
    previousConcurrency?: number;
    transitionEvent?: {
      id: string;
      message: string;
      payload: Record<string, unknown>;
    };
    recordedAt: string;
  }): Promise<"created" | "existing">;
  /** 批次是否仍有可立即调度的排队 run；用于短路无分配的空调度轮。 */
  hasSchedulableRuns(batchId: string): Promise<boolean>;
  reserveAssignments(input: ReserveSchedulingAssignmentsInput): Promise<ReserveAssignmentsOutcome>;
  appendSchedulingEvents(events: SchedulingEventDraft[]): Promise<void>;
  listSchedulingEvents(input: {
    batchId: string;
    runnerId?: string;
    // 游标：返回该 id 之后的记录（按 recorded_at, id 定位）
    afterId?: string;
    // 反向游标：返回该 id 之前最近的一页，结果仍按时间正序返回。
    beforeId?: string;
    // 未提供游标时从最新一页开始读取。
    latest?: boolean;
    limit: number;
  }): Promise<{
    items: SchedulingEvent[];
    nextAfterId?: string;
    nextBeforeId?: string;
  }>;
}

export type RoundRecoveryStatus = "pending" | "polling" | "waiting" | "releasing";

export type RoundRecoveryClaim = {
  batchId: string;
  suiteId: string;
  ruleId: string;
  afterRound: number;
  nextRound: number;
  jenkinsJobUrl: string;
  apiKeyCiphertext: string;
  waitMinutes: number;
  status: RoundRecoveryStatus;
  pollFailureCount: number;
  sourceBuildNumber?: number;
  rebuildNumber?: number;
  rebuildUrl?: string;
};

export type RoundRecoveryStepCompletion =
  | { outcome: "claim_lost" }
  | { outcome: "step_completed"; remainingSteps: number }
  | { outcome: "round_releasing" };

export interface RoundRecoveryRepository {
  claimDue(input: {
    workerId: string;
    now: string;
    leaseExpiresAt: string;
    limit: number;
  }): Promise<RoundRecoveryClaim[]>;
  markPolling(input: {
    batchId: string;
    ruleId: string;
    workerId: string;
    sourceBuildNumber: number;
    rebuildNumber?: number;
    rebuildUrl?: string;
    startedAt?: string;
    availableAt: string;
    updatedAt: string;
  }): Promise<boolean>;
  markWaiting(input: {
    batchId: string;
    ruleId: string;
    workerId: string;
    rebuildNumber: number;
    rebuildUrl: string;
    startedAt?: string;
    finishedAt?: string;
    buildResult: string;
    availableAt: string;
    updatedAt: string;
  }): Promise<boolean>;
  completeWaitingStep(input: {
    batchId: string;
    ruleId: string;
    workerId: string;
    updatedAt: string;
  }): Promise<RoundRecoveryStepCompletion>;
  completeRoundRelease(input: {
    batchId: string;
    ruleId: string;
    workerId: string;
    updatedAt: string;
  }): Promise<boolean>;
  retryRoundRelease(input: {
    batchId: string;
    ruleId: string;
    workerId: string;
    errorMessage: string;
    availableAt: string;
    updatedAt: string;
  }): Promise<boolean>;
  deferPollingFailure(input: {
    batchId: string;
    ruleId: string;
    workerId: string;
    errorMessage: string;
    availableAt: string;
    updatedAt: string;
  }): Promise<boolean>;
  fail(input: {
    batchId: string;
    ruleId: string;
    workerId: string;
    errorMessage: string;
    rebuildNumber?: number;
    rebuildUrl?: string;
    startedAt?: string;
    finishedAt?: string;
    buildResult?: string;
    eventId: string;
    updatedAt: string;
  }): Promise<boolean>;
}

export type JenkinsRebuildState =
  | { status: "discovering" }
  | { status: "running"; buildNumber: number; buildUrl: string; startedAt?: string }
  | {
      status: "succeeded";
      buildNumber: number;
      buildUrl: string;
      startedAt?: string;
      finishedAt?: string;
      result: "SUCCESS";
    }
  | {
      status: "failed";
      buildNumber: number;
      buildUrl: string;
      startedAt?: string;
      finishedAt?: string;
      result: string;
    };

export interface JenkinsRoundRecoveryTransport {
  inspectJob(input: { jobUrl: string; credential: string }): Promise<JenkinsJobInspection>;
  rebuildLast(input: {
    jobUrl: string;
    credential: string;
  }): Promise<{ sourceBuildNumber: number }>;
  inspectRebuild(input: {
    jobUrl: string;
    credential: string;
    sourceBuildNumber: number;
    rebuildNumber?: number;
    rebuildUrl?: string;
  }): Promise<JenkinsRebuildState>;
}

export type ApiTokenAuthentication = {
  serviceAccount: ServiceAccount;
  token: ApiToken;
  effectiveScopes: Permission[];
};

export interface PlatformOperationsRepository {
  readOperationalMetrics(): Promise<{
    activeLeases: number;
    runnerCapacity: number;
    runnerBusySlots: number;
    storedLogBytes: number;
    uploadedArtifacts: number;
    failedAttempts: number;
    pendingCleanupJobs: number;
    deadLetterCleanupJobs: number;
  }>;
  listServiceAccounts(): Promise<ServiceAccount[]>;
  createServiceAccount(record: ServiceAccount): Promise<ServiceAccount>;
  updateServiceAccount(input: {
    accountId: string;
    expectedRevision: number;
    name?: string;
    description?: string;
    status?: "active" | "disabled";
    systemPermissions?: Permission[];
    projectPermissions?: Record<string, Permission[]>;
    updatedAt: string;
  }): Promise<ServiceAccount>;
  listApiTokens(accountId: string): Promise<ApiToken[]>;
  createApiToken(record: ApiToken & { tokenHash: string }): Promise<ApiToken>;
  revokeApiToken(input: { tokenId: string; revokedAt: string }): Promise<ApiToken>;
  authenticateApiToken(input: {
    tokenHash: string;
    usedAt: string;
  }): Promise<ApiTokenAuthentication | null>;

  listSchedules(projectIds?: readonly string[]): Promise<CaseSuiteSchedule[]>;
  findScheduleBySuite(suiteId: string): Promise<CaseSuiteSchedule | null>;
  upsertSchedule(record: CaseSuiteSchedule, expectedRevision?: number): Promise<CaseSuiteSchedule>;
  deleteSchedule(scheduleId: string, expectedRevision: number): Promise<void>;
  listDueSchedules(now: string, limit: number): Promise<CaseSuiteSchedule[]>;
  claimScheduleTrigger(input: {
    scheduleId: string;
    scheduledFor: string;
    claimId: string;
    claimedAt: string;
    leaseExpiresAt: string;
  }): Promise<boolean>;
  completeScheduleTrigger(input: {
    scheduleId: string;
    scheduledFor: string;
    claimId: string;
    batchId?: string;
    status: "created" | "skipped" | "failed";
    nextTriggerAt: string;
    recordedAt: string;
  }): Promise<boolean>;

  createLdapSyncJob(record: LdapSyncJob): Promise<LdapSyncJob>;
  updateLdapSyncJob(input: {
    jobId: string;
    status: LdapSyncJob["status"];
    checkpoint?: Record<string, unknown>;
    processedUsers?: number;
    disabledUsers?: number;
    errorCode?: string;
    errorSummary?: string;
    startedAt?: string;
    finishedAt?: string;
    updatedAt: string;
  }): Promise<LdapSyncJob>;
  listLdapSyncJobs(limit: number): Promise<LdapSyncJob[]>;
  claimScheduledLdapSync(input: {
    claimId: string;
    now: string;
    leaseExpiresAt: string;
  }): Promise<boolean>;
  completeScheduledLdapSync(input: {
    claimId: string;
    nextAt: string;
    completedAt: string;
  }): Promise<boolean>;

  listNotifications(input: {
    userId: string;
    projectIds?: readonly string[];
    unreadOnly: boolean;
    cursor?: string;
    limit: number;
  }): Promise<{ items: Notification[]; nextCursor?: string }>;
  createNotification(record: Notification): Promise<Notification>;
  generateNotifications(input: {
    now: string;
    runnerOfflineBefore: string;
    limit: number;
  }): Promise<number>;
  markNotificationRead(input: {
    notificationId: string;
    userId: string;
    readAt: string;
  }): Promise<void>;

  ensureRetentionPolicies(records: RetentionPolicy[]): Promise<void>;
  listRetentionPolicies(): Promise<RetentionPolicy[]>;
  updateRetentionPolicy(input: {
    category: RetentionCategory;
    retentionDays: number;
    expectedRevision: number;
    actorId: string;
    updatedAt: string;
  }): Promise<RetentionPolicy>;
  previewRetention(category: RetentionCategory, cutoffAt: string): Promise<RetentionPreview>;
  executeRetention(input: {
    category: RetentionCategory;
    cutoffAt: string;
    limit: number;
    recordedAt: string;
  }): Promise<{ deletedRecords: number; objectKeys: string[] }>;
  claimRetentionCleanupJobs(input: {
    owner: string;
    now: string;
    leaseExpiresAt: string;
    limit: number;
  }): Promise<
    Array<{
      id: string;
      category: string;
      resourceType: string;
      resourceId: string;
      objectKey: string;
      attemptCount: number;
    }>
  >;
  completeRetentionCleanupJob(input: {
    id: string;
    owner: string;
    status: "succeeded" | "failed" | "dead_letter";
    errorSummary?: string;
    availableAt: string;
    updatedAt: string;
  }): Promise<void>;

  rebuildAnalyticsFacts(limit: number): Promise<number>;
  readAnalytics(input: {
    filter: AnalyticsFilter;
    projectIds?: readonly string[];
    generatedAt: string;
  }): Promise<AnalyticsSummary>;
  readAnalyticsOverview(input: {
    filter: AnalyticsFilter;
    projectIds?: readonly string[];
    generatedAt: string;
  }): Promise<AnalyticsSummary>;
  exportAnalytics(input: {
    filter: AnalyticsFilter;
    projectIds?: readonly string[];
    maximumRows: number;
  }): Promise<Array<Record<string, string | number | null>>>;
  createAnalyticsExportJob(record: {
    job: AnalyticsExportJob;
    projectIds?: readonly string[];
    idempotencyKey: string;
    dispatchJob: JobEnvelope;
  }): Promise<AnalyticsExportJob>;
  getAnalyticsExportJob(jobId: string, requestedBy: string): Promise<AnalyticsExportJob | null>;
  claimAnalyticsExportJob(input: {
    jobId: string;
    startedAt: string;
  }): Promise<{ job: AnalyticsExportJob; projectIds?: string[] } | null>;
  updateAnalyticsExportJob(input: {
    jobId: string;
    status: AnalyticsExportJob["status"];
    progressPercent: number;
    rowCount?: number;
    sizeBytes?: number;
    sha256?: string;
    objectKey?: string;
    fileName?: string;
    errorCode?: string;
    errorSummary?: string;
    updatedAt: string;
    finishedAt?: string;
  }): Promise<AnalyticsExportJob>;
  requestAnalyticsExportCancellation(input: {
    jobId: string;
    requestedBy: string;
    updatedAt: string;
  }): Promise<AnalyticsExportJob>;
  resolveAnalyticsExportObject(input: { jobId: string; requestedBy: string }): Promise<{
    job: AnalyticsExportJob;
    objectKey: string;
    mediaType: string;
  } | null>;
  globalSearch(input: {
    query: string;
    limit: number;
    projectIds?: readonly string[];
  }): Promise<GlobalSearchResult>;
}

/**
 * 日志公开访问记录。token 明文只在创建时返回给导出响应，库中只存 SHA-256 哈希；
 * 因此只能判断链接是否活跃，无法还原链接，有效性判断统一由仓储的 now 参数完成。
 * expiresAt 对新记录固定为永久哨兵值（见 PERMANENT_LOG_ACCESS_EXPIRY）。
 */
export type AttemptLogShareRecord = {
  id: string;
  tokenHash: string;
  attemptId: string;
  batchId: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
};

export interface AttemptLogShareRepository {
  create(record: AttemptLogShareRecord): Promise<void>;
  /** 单事务批量插入公开访问记录；任一条冲突或失败时整体回滚。 */
  createMany(records: readonly AttemptLogShareRecord[]): Promise<void>;
  /** 返回该 attempt 最新创建的有效链接记录；无有效记录时返回 null。 */
  findActiveByAttemptId(attemptId: string, now: string): Promise<AttemptLogShareRecord | null>;
  /**
   * 批量返回每个 attempt 最新创建的有效链接记录；无有效记录的 attempt 不出现在结果中。
   * 内部分批查询，避免 IN 参数超出数据库绑定上限。
   */
  findActiveByAttemptIds(
    attemptIds: readonly string[],
    now: string,
  ): Promise<AttemptLogShareRecord[]>;
  findActiveByTokenHash(tokenHash: string, now: string): Promise<AttemptLogShareRecord | null>;
}

export interface WebhookRepository {
  listConfigurations(projectId: string): Promise<WebhookConfiguration[]>;
  getConfiguration(
    webhookId: string,
    projectIds?: readonly string[],
  ): Promise<WebhookConfiguration | null>;
  createConfiguration(input: {
    id: string;
    projectId: string;
    name: string;
    normalizedName: string;
    description: string;
    targetUrl: string;
    method: WebhookRequestMethod;
    bodyTemplate?: string;
    enabled: boolean;
    recordedAt: string;
  }): Promise<WebhookConfiguration>;
  updateConfiguration(input: {
    webhookId: string;
    expectedRevision: number;
    name?: string;
    normalizedName?: string;
    description?: string;
    targetUrl?: string;
    method?: WebhookRequestMethod;
    bodyTemplate?: string | null;
    enabled?: boolean;
    updatedAt: string;
    projectIds?: readonly string[];
  }): Promise<WebhookConfiguration | null>;
  deleteConfiguration(input: {
    webhookId: string;
    deletedAt: string;
    projectIds?: readonly string[];
  }): Promise<boolean>;
  listSuiteBindings(suiteId: string, projectIds?: readonly string[]): Promise<string[]>;
  replaceSuiteBindings(input: {
    suiteId: string;
    webhookIds: readonly string[];
    recordedAt: string;
    projectIds?: readonly string[];
  }): Promise<string[]>;
  listDeliveries(projectId: string, limit: number): Promise<WebhookDelivery[]>;
  materializeDeliveries(input: { now: string; limit: number }): Promise<number>;
  claimDueDeliveries(input: {
    owner: string;
    now: string;
    leaseExpiresAt: string;
    limit: number;
  }): Promise<WebhookDispatchClaim[]>;
  completeDelivery(input: {
    deliveryId: string;
    owner: string;
    responseStatus: number;
    completedAt: string;
  }): Promise<void>;
  failDelivery(input: {
    deliveryId: string;
    owner: string;
    errorMessage: string;
    responseStatus?: number;
    retryAt?: string;
    failedAt: string;
  }): Promise<void>;
}

export interface WebhookTransport {
  send(input: {
    method: WebhookRequestMethod;
    url: string;
    body?: string;
  }): Promise<{ statusCode: number }>;
}
