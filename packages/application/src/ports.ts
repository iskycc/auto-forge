import type { JarInspection, TestNgClassCandidate } from "@autoforge/contracts";
import type { CaseDefinitionWithMethods, CaseSource } from "@autoforge/domain";

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
  listRecentSources(limit: number): Promise<CaseSource[]>;
  getDashboardSummary(): Promise<DashboardSummary>;
}

export type Clock = {
  now(): Date;
};

export type IdGenerator = {
  next(): string;
};
