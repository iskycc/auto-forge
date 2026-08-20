export type ProjectVersion = {
  id: string;
  projectId: string;
  name: string;
  status: "active" | "archived";
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type TestStage = {
  id: string;
  projectId: string;
  projectVersionId: string;
  name: string;
  description: string;
  position: number;
  status: "active" | "archived";
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type RuntimeAssetKind = "jdk" | "jar-bundle";
export type RuntimeArchiveFormat = "zip" | "tar.gz";

export type ProjectRuntimeAsset = {
  id: string;
  projectId: string;
  kind: RuntimeAssetKind;
  sourceType: "upload" | "url";
  fileName: string;
  url?: string;
  objectKey?: string;
  sha256: string;
  sizeBytes: number;
  archiveFormat: RuntimeArchiveFormat;
  createdBy?: string;
  createdAt: string;
};

export type ProjectAdapterConfiguration = {
  projectId: string;
  projectVersionId?: string;
  jdkAsset?: ProjectRuntimeAsset;
  jarBundleAsset?: ProjectRuntimeAsset;
  revision: number;
  updatedBy?: string;
  updatedAt: string;
};

export type ProjectVersionDependency = {
  version: ProjectVersion;
  asset: ProjectRuntimeAsset;
};

export type ProjectStructure = {
  versions: Array<ProjectVersion & { stages: TestStage[] }>;
  adapterConfiguration: ProjectAdapterConfiguration;
};
