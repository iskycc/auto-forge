import type {
  CreateProjectRuntimeAssetRecord,
  CreateProjectVersionRecord,
  CreateTestStageRecord,
  ProjectStructureRepository,
} from "@autoforge/application";
import {
  DomainError,
  type ProjectAdapterConfiguration,
  type ProjectRuntimeAsset,
  type ProjectVersion,
  type TestStage,
} from "@autoforge/domain";

import type { SqliteDatabaseHandle } from "./database";

type VersionRow = {
  id: string;
  project_id: string;
  name: string;
  status: "active" | "archived";
  revision: number;
  created_at: string;
  updated_at: string;
};

type StageRow = {
  id: string;
  project_id: string;
  project_version_id: string;
  name: string;
  description: string;
  position: number;
  status: "active" | "archived";
  revision: number;
  created_at: string;
  updated_at: string;
};

type AssetRow = {
  id: string;
  project_id: string;
  kind: "jdk" | "jar-bundle";
  source_type: "upload" | "url";
  file_name: string;
  url: string | null;
  object_key: string | null;
  sha256: string;
  size_bytes: number;
  archive_format: "zip" | "tar.gz";
  created_by: string | null;
  created_at: string;
};

type ConfigurationRow = {
  project_id: string;
  suite_name: string;
  test_name: string;
  environment_address: string;
  jdk_asset_id: string | null;
  jar_bundle_asset_id: string | null;
  revision: number;
  updated_by: string | null;
  updated_at: string;
};

export class SqliteProjectStructureRepository implements ProjectStructureRepository {
  constructor(private readonly handle: SqliteDatabaseHandle) {}

  async list(projectId: string) {
    const versions = (
      this.handle.client
        .prepare("SELECT * FROM project_versions WHERE project_id = ? ORDER BY created_at, id")
        .all(projectId) as VersionRow[]
    ).map(mapVersion);
    const stages = (
      this.handle.client
        .prepare(
          "SELECT * FROM test_stages WHERE project_id = ? ORDER BY project_version_id, position, id",
        )
        .all(projectId) as StageRow[]
    ).map(mapStage);
    return {
      versions: versions.map((version) => ({
        ...version,
        stages: stages.filter((stage) => stage.projectVersionId === version.id),
      })),
      adapterConfiguration: await this.getAdapterConfiguration(projectId),
    };
  }

  async createVersion(record: CreateProjectVersionRecord): Promise<ProjectVersion> {
    try {
      this.handle.client
        .prepare(
          `INSERT INTO project_versions
           (id, project_id, name, normalized_name, status, revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'active', 1, ?, ?)`,
        )
        .run(
          record.id,
          record.projectId,
          record.name,
          record.normalizedName,
          record.recordedAt,
          record.recordedAt,
        );
      return this.requiredVersion(record.id);
    } catch (error) {
      throw mapStructureWriteError(error);
    }
  }

  async createStage(record: CreateTestStageRecord): Promise<TestStage> {
    try {
      return this.handle.client.transaction(() => {
        const version = this.handle.client
          .prepare("SELECT id FROM project_versions WHERE id = ? AND project_id = ?")
          .get(record.projectVersionId, record.projectId);
        if (!version) {
          throw new DomainError("PROJECT_VERSION_NOT_FOUND", "指定的项目版本不存在。");
        }
        const position = (
          this.handle.client
            .prepare(
              "SELECT COALESCE(MAX(position), 0) + 1 AS position FROM test_stages WHERE project_version_id = ?",
            )
            .get(record.projectVersionId) as { position: number }
        ).position;
        this.handle.client
          .prepare(
            `INSERT INTO test_stages
             (id, project_id, project_version_id, name, normalized_name, description, position,
              status, revision, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?)`,
          )
          .run(
            record.id,
            record.projectId,
            record.projectVersionId,
            record.name,
            record.normalizedName,
            record.description,
            position,
            record.recordedAt,
            record.recordedAt,
          );
        return this.requiredStage(record.id);
      })();
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw mapStructureWriteError(error);
    }
  }

  async createRuntimeAsset(record: CreateProjectRuntimeAssetRecord): Promise<ProjectRuntimeAsset> {
    try {
      this.handle.client
        .prepare(
          `INSERT INTO project_runtime_assets
           (id, project_id, kind, source_type, file_name, url, object_key, sha256, size_bytes,
            archive_format, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.projectId,
          record.kind,
          record.sourceType,
          record.fileName,
          record.url ?? null,
          record.objectKey ?? null,
          record.sha256,
          record.sizeBytes,
          record.archiveFormat,
          record.createdBy ?? null,
          record.createdAt,
        );
      return this.requiredAsset(record.id);
    } catch (error) {
      throw mapStructureWriteError(error);
    }
  }

  async updateAdapterConfiguration(
    input: Parameters<ProjectStructureRepository["updateAdapterConfiguration"]>[0],
  ): Promise<ProjectAdapterConfiguration> {
    try {
      return this.handle.client.transaction(() => {
        this.validateAsset(input.projectId, input.jdkAssetId, "jdk");
        this.validateAsset(input.projectId, input.jarBundleAssetId, "jar-bundle");
        const current = this.configurationRow(input.projectId);
        if (!current) {
          if (input.expectedRevision !== 0) throw revisionConflict();
          this.handle.client
            .prepare(
              `INSERT INTO project_adapter_configurations
               (project_id, suite_name, test_name, environment_address, jdk_asset_id,
                jar_bundle_asset_id, revision, updated_by, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
            )
            .run(
              input.projectId,
              input.suiteName,
              input.testName,
              input.environmentAddress,
              input.jdkAssetId ?? null,
              input.jarBundleAssetId ?? null,
              input.actorId ?? null,
              input.updatedAt,
            );
        } else {
          const changed = this.handle.client
            .prepare(
              `UPDATE project_adapter_configurations
               SET suite_name = ?, test_name = ?, environment_address = ?, jdk_asset_id = ?,
                   jar_bundle_asset_id = ?, revision = revision + 1, updated_by = ?, updated_at = ?
               WHERE project_id = ? AND revision = ?`,
            )
            .run(
              input.suiteName,
              input.testName,
              input.environmentAddress,
              input.jdkAssetId ?? null,
              input.jarBundleAssetId ?? null,
              input.actorId ?? null,
              input.updatedAt,
              input.projectId,
              input.expectedRevision,
            );
          if (changed.changes !== 1) throw revisionConflict();
        }
        return this.requiredConfiguration(input.projectId);
      })();
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw mapStructureWriteError(error);
    }
  }

  async getAdapterConfiguration(projectId: string): Promise<ProjectAdapterConfiguration> {
    const row = this.configurationRow(projectId);
    return row
      ? this.mapConfiguration(row)
      : {
          projectId,
          suiteName: "",
          testName: "",
          environmentAddress: "",
          revision: 0,
          updatedAt: "",
        };
  }

  private requiredVersion(id: string): ProjectVersion {
    const row = this.handle.client
      .prepare("SELECT * FROM project_versions WHERE id = ?")
      .get(id) as VersionRow | undefined;
    if (!row) throw new Error("Created project version could not be read.");
    return mapVersion(row);
  }

  private requiredStage(id: string): TestStage {
    const row = this.handle.client.prepare("SELECT * FROM test_stages WHERE id = ?").get(id) as
      StageRow | undefined;
    if (!row) throw new Error("Created test stage could not be read.");
    return mapStage(row);
  }

  private requiredAsset(id: string): ProjectRuntimeAsset {
    const row = this.handle.client
      .prepare("SELECT * FROM project_runtime_assets WHERE id = ?")
      .get(id) as AssetRow | undefined;
    if (!row) throw new Error("Created runtime asset could not be read.");
    return mapAsset(row);
  }

  private configurationRow(projectId: string): ConfigurationRow | undefined {
    return this.handle.client
      .prepare("SELECT * FROM project_adapter_configurations WHERE project_id = ?")
      .get(projectId) as ConfigurationRow | undefined;
  }

  private requiredConfiguration(projectId: string): ProjectAdapterConfiguration {
    const row = this.configurationRow(projectId);
    if (!row) throw new Error("Updated adapter configuration could not be read.");
    return this.mapConfiguration(row);
  }

  private mapConfiguration(row: ConfigurationRow): ProjectAdapterConfiguration {
    return {
      projectId: row.project_id,
      suiteName: row.suite_name,
      testName: row.test_name,
      environmentAddress: row.environment_address,
      ...(row.jdk_asset_id ? { jdkAsset: this.requiredAsset(row.jdk_asset_id) } : {}),
      ...(row.jar_bundle_asset_id
        ? { jarBundleAsset: this.requiredAsset(row.jar_bundle_asset_id) }
        : {}),
      revision: row.revision,
      ...(row.updated_by ? { updatedBy: row.updated_by } : {}),
      updatedAt: row.updated_at,
    };
  }

  private validateAsset(
    projectId: string,
    assetId: string | undefined,
    kind: ProjectRuntimeAsset["kind"],
  ): void {
    if (!assetId) return;
    const asset = this.requiredAsset(assetId);
    if (asset.projectId !== projectId || asset.kind !== kind) {
      throw new DomainError(
        "RUNTIME_ASSET_SCOPE_INVALID",
        `所选 ${kind} 资源不属于当前项目或类型不匹配。`,
      );
    }
  }
}

function mapVersion(row: VersionRow): ProjectVersion {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    status: row.status,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapStage(row: StageRow): TestStage {
  return {
    id: row.id,
    projectId: row.project_id,
    projectVersionId: row.project_version_id,
    name: row.name,
    description: row.description,
    position: row.position,
    status: row.status,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAsset(row: AssetRow): ProjectRuntimeAsset {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    sourceType: row.source_type,
    fileName: row.file_name,
    ...(row.url ? { url: row.url } : {}),
    ...(row.object_key ? { objectKey: row.object_key } : {}),
    sha256: row.sha256,
    sizeBytes: row.size_bytes,
    archiveFormat: row.archive_format,
    ...(row.created_by ? { createdBy: row.created_by } : {}),
    createdAt: row.created_at,
  };
}

function revisionConflict(): DomainError {
  return new DomainError(
    "PROJECT_ADAPTER_CONFIGURATION_REVISION_CONFLICT",
    "Adapter 配置已被其他请求修改，请刷新后重试。",
  );
}

function mapStructureWriteError(error: unknown): Error {
  const message = error instanceof Error ? error.message : "";
  if (/UNIQUE constraint failed/u.test(message)) {
    return new DomainError("PROJECT_STRUCTURE_NAME_CONFLICT", "同一层级下已存在同名记录。");
  }
  return new Error("无法写入项目版本结构。", { cause: error });
}
