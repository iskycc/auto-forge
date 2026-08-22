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
  inheritedFromProjectVersionId?: string;
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
  versions: Array<
    ProjectVersion & { stages: TestStage[]; adapterConfiguration: ProjectAdapterConfiguration }
  >;
  // 仅为历史升级读取保留；新配置必须写入具体项目版本。
  adapterConfiguration: ProjectAdapterConfiguration;
};
