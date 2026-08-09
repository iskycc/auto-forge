import type { JarInspection, ObjectEntry, TestNgClassCandidate } from "@autoforge/contracts";
import type {
  CaseDefinitionWithMethods,
  CaseSource,
  CaseSuite,
  CaseSuiteDetails,
  ExecutionEnvironmentVariable,
  ExecutionRun,
  RunBatch,
  RunBatchDetails,
  Runner,
  SchedulingDecision,
  SchedulingThresholds,
} from "@autoforge/domain";

export interface JarDiscoveryPort {
  inspect(fileName: string, content: Uint8Array): Promise<JarInspection>;
}

export type ObjectWriteResult = {
  objectKey: string;
  created: boolean;
};

export interface JarObjectStorePort {
  putJar(sha256: string, content: Uint8Array): Promise<ObjectWriteResult>;
  delete(objectKey: string): Promise<void>;
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

export type CreateRunBatchRecord = {
  id: string;
  suiteId: string;
  suiteName: string;
  suiteVersion: number;
  retryLimit: number;
  environmentVariables: ExecutionEnvironmentVariable[];
  runnerIds: string[];
  runs: Array<{
    id: string;
    caseDefinitionId: string;
    caseVersion: number;
    displayName: string;
    className: string;
  }>;
  createdAt: string;
};

export type SchedulingSnapshot = {
  batch: RunBatch;
  queuedRuns: ExecutionRun[];
  candidates: Array<{ runner: Runner; reservedSlots: number }>;
};

export type ReserveSchedulingAssignmentsInput = {
  batchId: string;
  decisions: Array<SchedulingDecision & { attemptId: string }>;
  thresholds: SchedulingThresholds;
  offlineBefore: string;
  metricsFreshAfter: string;
  scheduledAt: string;
};

export interface RunBatchRepository {
  create(record: CreateRunBatchRecord): Promise<RunBatchDetails>;
  list(limit: number): Promise<RunBatch[]>;
  get(batchId: string): Promise<RunBatchDetails | null>;
  listSchedulableBatchIds(limit: number): Promise<string[]>;
  listSchedulableBatchIdsForRunner(runnerId: string, limit: number): Promise<string[]>;
  getSchedulingSnapshot(batchId: string, offlineBefore: string): Promise<SchedulingSnapshot | null>;
  reserveAssignments(input: ReserveSchedulingAssignmentsInput): Promise<number>;
}
