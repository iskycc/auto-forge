export type CaseDefinition = {
  id: string;
  sourceId: string;
  className: string;
  packageName: string;
  displayName: string;
  enabled: boolean;
  groups: string[];
  currentVersion: number;
  createdAt: string;
  updatedAt: string;
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
  createdAt: string;
};
