export type CaseDefinition = {
  id: string;
  projectId: string;
  projectVersionId?: string;
  testStageId?: string;
  directoryPath: string;
  sourceId: string;
  className: string;
  packageName: string;
  displayName: string;
  description: string;
  tags: string[];
  enabled: boolean;
  archived: boolean;
  groups: string[];
  parameters: Record<string, string>;
  currentVersion: number;
  revision: number;
  updatedBy?: string;
  createdAt: string;
  updatedAt: string;
};

export type CaseVersion = {
  id: string;
  caseDefinitionId: string;
  sourceId: string;
  version: number;
  snapshot: unknown;
  changeReason: string;
  createdBy?: string;
  createdAt: string;
};

export type TestMethod = {
  id: string;
  caseDefinitionId: string;
  methodName: string;
  descriptor: string;
  enabled: boolean;
  groups: string[];
  description?: string;
  dataProvider?: string;
  dependsOnMethods: string[];
  dependsOnGroups: string[];
  priority?: number;
  createdAt: string;
};

export type CaseDefinitionWithMethods = CaseDefinition & {
  methods: TestMethod[];
};

export type CaseSource = {
  id: string;
  projectId: string;
  projectVersionId?: string;
  testStageId?: string;
  displayName: string;
  originalFileName: string;
  objectKey: string;
  sha256: string;
  sizeBytes: number;
  classCount: number;
  methodCount: number;
  status: "ready" | "failed";
  warningCount: number;
  authoritative: boolean;
  lifecycleStatus: "active" | "archived" | "deleting";
  revision: number;
  importedBy?: string;
  createdAt: string;
  updatedAt: string;
};
