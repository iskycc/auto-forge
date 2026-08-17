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
  ExecutionEnvironment,
  ExecutionEnvironmentDetails,
  ExecutionEnvironmentReference,
  ExecutionEnvironmentSecretBinding,
  ExecutionEnvironmentVariable,
  ExecutionEnvironmentVersion,
  ExecutionEnvironmentStatus,
  ExecutionSecret,
  ExecutionSecretStatus,
  ExecutionRun,
  ExternalIdentity,
  Permission,
  Project,
  ProjectAdapterConfiguration,
  ProjectRuntimeAsset,
  ProjectStructure,
  ProjectVersion,
  Role,
  RoleScope,
  RunBatch,
  RunBatchDetails,
  RunBatchExecutionPolicy,
  Runner,
  SchedulingDecision,
  SchedulingEvent,
  SchedulingEventType,
  SchedulingThresholds,
  SystemRoleBindingView,
  User,
  UserSession,
  UserStatus,
  TestStage,
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
  updateAdapterConfiguration(input: {
    projectId: string;
    jdkAssetId?: string;
    jarBundleAssetId?: string;
    expectedRevision: number;
    actorId?: string;
    updatedAt: string;
  }): Promise<ProjectAdapterConfiguration>;
  getAdapterConfiguration(projectId: string): Promise<ProjectAdapterConfiguration>;
}

export type StoredLdapConfiguration = {
  enabled: boolean;
  urls: string[];
  tlsMode: "ldaps" | "starttls";
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
  completeAttempt(input: {
    runnerId: string;
    attemptId: string;
    completionId: string;
    leaseTokenHash: string;
    resultDigest: string;
    result: CompletionResult;
    eventId: string;
    auditEventId?: string;
    acceptedAt: string;
  }): Promise<CompleteAttemptResponse>;
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
  resolveAttemptSecrets(input: {
    runnerId: string;
    attemptId: string;
    leaseTokenHash: string;
    now: string;
  }): Promise<
    Array<{
      name: string;
      secretId: string;
      secretVersionId: string;
      valueEncrypted: string;
    }>
  >;
  acquireAttemptSecrets(input: {
    runnerId: string;
    attemptId: string;
    leaseTokenHash: string;
    now: string;
  }): Promise<
    Array<{
      name: string;
      secretId: string;
      secretVersionId: string;
      valueEncrypted: string;
    }>
  >;
  recordAttemptSecretAccess(input: {
    id: string;
    runnerId: string;
    attemptId: string;
    requestId: string;
    secretIds: string[];
    recordedAt: string;
  }): Promise<void>;
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
  cancelBatch(input: {
    batchId: string;
    actorId: string;
    reason: string;
    eventIds: string[];
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
  resolveAttemptSchedulingContext(attemptId: string): Promise<{
    batchId: string;
    executionRunId: string;
    runnerId: string;
    attemptNumber: number;
    // execution_runs.display_name，供事件消息组装用例名。
    displayName: string;
    heldRound?: number;
  } | null>;
}

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

export type CaseListPage = {
  items: CaseDefinitionWithMethods[];
  nextCursor?: string;
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
  findExistingCaseIds(caseDefinitionIds: string[], projectId?: string): Promise<string[]>;
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

export interface CaseSuiteRepository {
  create(record: CreateCaseSuiteRecord): Promise<CaseSuite>;
  list(limit: number, projectIds?: readonly string[]): Promise<CaseSuite[]>;
  get(suiteId: string, projectIds?: readonly string[]): Promise<CaseSuiteDetails | null>;
  updateSuite(input: UpdateCaseSuiteRecord): Promise<CaseSuiteDetails>;
  copySuite(input: CopyCaseSuiteRecord): Promise<CaseSuiteDetails>;
  addCases(input: {
    suiteId: string;
    items: Array<{ id: string; caseDefinitionId: string }>;
    versionId: string;
    actorId?: string;
    updatedAt: string;
  }): Promise<CaseSuiteDetails>;
  removeCase(input: {
    suiteId: string;
    caseDefinitionId: string;
    versionId: string;
    actorId?: string;
    updatedAt: string;
  }): Promise<CaseSuiteDetails>;
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
};

export type RegisterRunnerRecord = {
  id: string;
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

export type Clock = {
  now(): Date;
};

export type IdGenerator = {
  next(): string;
};

export interface RunnerCredentialPort {
  issue(): string;
  issueBootstrapToken(): string;
  hash(value: string): string;
  verifyBootstrapToken(value: string): boolean;
}

export type ClaimedJob = {
  job: JobEnvelope;
  deliveryId: string;
  leaseExpiresAt: string;
  deliveryAttempt: number;
};

export interface JobQueuePort {
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

export type CreateExecutionEnvironmentRecord = {
  id: string;
  versionId: string;
  projectId: string;
  name: string;
  normalizedName: string;
  description: string;
  variables: ExecutionEnvironmentVariable[];
  secretBindings: Array<{ name: string; secretId: string; secretVersionId?: string }>;
  actorId: string;
  recordedAt: string;
};

export type UpdateExecutionEnvironmentRecord = {
  environmentId: string;
  expectedRevision: number;
  actorId: string;
  recordedAt: string;
  name?: string;
  normalizedName?: string;
  description?: string;
  nextVersion?: {
    id: string;
    variables?: ExecutionEnvironmentVariable[];
    secretBindings?: Array<{ name: string; secretId: string }>;
  };
};

export interface ExecutionEnvironmentRepository {
  create(record: CreateExecutionEnvironmentRecord): Promise<ExecutionEnvironmentDetails>;
  list(projectIds?: readonly string[]): Promise<ExecutionEnvironment[]>;
  get(
    environmentId: string,
    projectIds?: readonly string[],
  ): Promise<ExecutionEnvironmentDetails | null>;
  getVersion(
    versionId: string,
    projectId: string,
  ): Promise<{
    environment: ExecutionEnvironment;
    version: ExecutionEnvironmentVersion;
  } | null>;
  listVersions(
    environmentId: string,
    projectIds?: readonly string[],
  ): Promise<ExecutionEnvironmentVersion[]>;
  listReferences(
    environmentId: string,
    projectIds?: readonly string[],
    limit?: number,
  ): Promise<{ items: ExecutionEnvironmentReference[]; total: number }>;
  assertSecretsAvailableForExecution(
    projectId: string,
    bindings: readonly ExecutionEnvironmentSecretBinding[],
  ): Promise<void>;
  findUnavailableSecretsForExecution(
    projectId: string,
    bindings: readonly ExecutionEnvironmentSecretBinding[],
  ): Promise<ExecutionEnvironmentSecretBinding[]>;
  update(record: UpdateExecutionEnvironmentRecord): Promise<ExecutionEnvironmentDetails>;
  setStatus(input: {
    environmentId: string;
    expectedRevision: number;
    status: ExecutionEnvironmentStatus;
    recordedAt: string;
  }): Promise<ExecutionEnvironmentDetails>;
}

export type CreateExecutionSecretRecord = {
  id: string;
  versionId: string;
  projectId: string;
  name: string;
  normalizedName: string;
  description: string;
  valueEncrypted: string;
  actorId: string;
  recordedAt: string;
};

export interface ExecutionSecretRepository {
  create(record: CreateExecutionSecretRecord): Promise<ExecutionSecret>;
  list(projectIds?: readonly string[]): Promise<ExecutionSecret[]>;
  get(secretId: string, projectIds?: readonly string[]): Promise<ExecutionSecret | null>;
  rotate(input: {
    secretId: string;
    versionId: string;
    expectedRevision: number;
    valueEncrypted: string;
    actorId: string;
    recordedAt: string;
  }): Promise<ExecutionSecret>;
  setStatus(input: {
    secretId: string;
    expectedRevision: number;
    status: ExecutionSecretStatus;
    recordedAt: string;
  }): Promise<ExecutionSecret>;
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
  runs: Array<{
    id: string;
    caseDefinitionId: string;
    caseVersion: number;
    displayName: string;
    className: string;
    parameters?: Record<string, string>;
  }>;
  adapter?: CaseSuiteExecutionPolicy["adapter"];
  dispatchJob?: JobEnvelope;
  createdAt: string;
};

export type SchedulingSnapshot = {
  batch: RunBatch;
  queuedRuns: ExecutionRun[];
  candidates: Array<{ runner: Runner; reservedSlots: number }>;
  projectActiveRuns: number;
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

export type RunBatchListQuery = {
  projectIds?: readonly string[];
  projectId?: string;
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

export interface RunBatchRepository {
  create(record: CreateRunBatchRecord): Promise<RunBatchDetails>;
  list(limit: number, projectIds?: readonly string[]): Promise<RunBatch[]>;
  listPage(input: RunBatchListQuery): Promise<RunBatchListPage>;
  get(batchId: string, projectIds?: readonly string[]): Promise<RunBatchDetails | null>;
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
  getSchedulingSnapshot(batchId: string, offlineBefore: string): Promise<SchedulingSnapshot | null>;
  reserveAssignments(input: ReserveSchedulingAssignmentsInput): Promise<number>;
  appendSchedulingEvents(
    events: Array<{
      id: string;
      batchId: string;
      runnerId?: string;
      executionRunId?: string;
      attemptId?: string;
      eventType: SchedulingEventType;
      message: string;
      payload?: Record<string, unknown>;
      recordedAt: string;
    }>,
  ): Promise<void>;
  listSchedulingEvents(input: {
    batchId: string;
    runnerId?: string;
    // 游标：返回该 id 之后的记录（按 recorded_at, id 定位）
    afterId?: string;
    limit: number;
  }): Promise<{ items: SchedulingEvent[]; nextAfterId?: string }>;
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
