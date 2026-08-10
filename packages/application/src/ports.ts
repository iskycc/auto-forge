import type {
  AssignmentDto,
  ArtifactDeclaration,
  AttemptEventPage,
  CompleteAttemptResponse,
  CompletionResult,
  ExecutionSpec,
  LogChunk,
  JarInspection,
  JobEnvelope,
  ObjectEntry,
  ReconcileAttemptsInput,
  ReconcileAttemptsResponse,
  RenewLeaseResponse,
  UploadLogChunksResponse,
  TestNgClassCandidate,
} from "@autoforge/contracts";
import type {
  AuditEvent,
  AuthenticatedIdentity,
  BuiltInRoleDefinition,
  CaseDefinitionWithMethods,
  CaseSource,
  CaseSuite,
  CaseSuiteDetails,
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
  Role,
  RoleScope,
  RunBatch,
  RunBatchDetails,
  Runner,
  SchedulingDecision,
  SchedulingThresholds,
  User,
  UserSession,
  UserStatus,
} from "@autoforge/domain";

export type StoredLdapConfiguration = {
  enabled: boolean;
  urls: string[];
  tlsMode: "ldaps" | "starttls";
  caPem?: string;
  connectTimeoutMs: number;
  operationTimeoutMs: number;
  pageSize: number;
  maximumUsers: number;
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
  listProjects(): Promise<Project[]>;
  createProject(input: {
    id: string;
    name: string;
    slug: string;
    createdAt: string;
  }): Promise<Project>;
  archiveProject(projectId: string, archivedAt: string): Promise<Project>;
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
  recoverExpired(input: { now: string; eventIds: string[]; limit: number }): Promise<number>;
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
}

export type ObjectWriteResult = {
  objectKey: string;
  created: boolean;
};

export type ArtifactUploadTarget =
  { kind: "control-plane" } | { kind: "direct"; uploadUrl: string; objectKey: string };

export type ArtifactObjectIdentity = {
  attemptId: string;
  artifactId: string;
  sha256: string;
  sizeBytes: number;
  mediaType: string;
};

export interface JarObjectStorePort {
  putJar(sha256: string, content: Uint8Array): Promise<ObjectWriteResult>;
  putArtifact(input: {
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
  objectKey: string;
  displayName: string;
  importedAt: string;
  inspection: JarInspection;
  cases: ImportCaseRecord[];
};

export type ExistingSource = {
  sourceId: string;
  classCount: number;
  methodCount: number;
};

export type CaseListQuery = {
  query?: string;
  cursor?: string;
  limit: number;
};

export type CaseListPage = {
  items: CaseDefinitionWithMethods[];
  nextCursor?: string;
};

export type DashboardSummary = {
  sourceCount: number;
  caseCount: number;
  methodCount: number;
  enabledMethodCount: number;
};

export interface CaseCatalogRepository {
  findSourceBySha256(sha256: string): Promise<ExistingSource | null>;
  importCatalog(record: ImportCatalogRecord): Promise<void>;
  listCases(query: CaseListQuery): Promise<CaseListPage>;
  findExistingCaseIds(caseDefinitionIds: string[]): Promise<string[]>;
  listRecentSources(limit: number): Promise<CaseSource[]>;
  listSources(limit: number): Promise<CaseSource[]>;
  getSource(sourceId: string): Promise<{ source: CaseSource; inspection: JarInspection } | null>;
  setAuthoritativeSource(sourceId: string): Promise<CaseSource>;
  getDashboardSummary(): Promise<DashboardSummary>;
}

export type CreateCaseSuiteRecord = {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
};

export interface CaseSuiteRepository {
  create(record: CreateCaseSuiteRecord): Promise<CaseSuite>;
  list(limit: number): Promise<CaseSuite[]>;
  get(suiteId: string): Promise<CaseSuiteDetails | null>;
  addCases(input: {
    suiteId: string;
    items: Array<{ id: string; caseDefinitionId: string }>;
    updatedAt: string;
  }): Promise<CaseSuiteDetails>;
  removeCase(input: {
    suiteId: string;
    caseDefinitionId: string;
    updatedAt: string;
  }): Promise<CaseSuiteDetails>;
}

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
  findByCredentialHash(credentialHash: string): Promise<Runner | null>;
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
}

export type Clock = {
  now(): Date;
};

export type IdGenerator = {
  next(): string;
};

export interface RunnerCredentialPort {
  issue(): string;
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
  queueTimeoutMs?: number;
  claimTimeoutMs?: number;
  executionTimeoutMs?: number;
  uploadTimeoutMs?: number;
  environmentVariables: ExecutionEnvironmentVariable[];
  secretBindings?: ExecutionEnvironmentSecretBinding[];
  runnerIds: string[];
  runs: Array<{
    id: string;
    caseDefinitionId: string;
    caseVersion: number;
    displayName: string;
    className: string;
  }>;
  dispatchJob?: JobEnvelope;
  createdAt: string;
};

export type SchedulingSnapshot = {
  batch: RunBatch;
  queuedRuns: ExecutionRun[];
  candidates: Array<{ runner: Runner; reservedSlots: number }>;
};

export type ReserveSchedulingAssignmentsInput = {
  batchId: string;
  eventId?: string;
  decisions: Array<SchedulingDecision & { attemptId: string; assignmentId: string }>;
  thresholds: SchedulingThresholds;
  offlineBefore: string;
  metricsFreshAfter: string;
  scheduledAt: string;
};

export interface RunBatchRepository {
  create(record: CreateRunBatchRecord): Promise<RunBatchDetails>;
  list(limit: number, projectIds?: readonly string[]): Promise<RunBatch[]>;
  get(batchId: string, projectIds?: readonly string[]): Promise<RunBatchDetails | null>;
  listSchedulableBatchIds(limit: number): Promise<string[]>;
  listSchedulableBatchIdsForRunner(runnerId: string, limit: number): Promise<string[]>;
  getSchedulingSnapshot(batchId: string, offlineBefore: string): Promise<SchedulingSnapshot | null>;
  reserveAssignments(input: ReserveSchedulingAssignmentsInput): Promise<number>;
}
