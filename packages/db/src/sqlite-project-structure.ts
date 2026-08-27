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

type VersionRuntimeRow = {
  project_version_id: string;
  project_id: string;
  jdk_asset_id: string | null;
  jar_bundle_asset_id: string | null;
  inherited_from_project_version_id: string | null;
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
    const configurations = await Promise.all(
      versions.map((version) => this.getAdapterConfiguration(projectId, version.id)),
    );
    return {
      versions: versions.map((version, index) => ({
        ...version,
        stages: stages.filter((stage) => stage.projectVersionId === version.id),
        adapterConfiguration: configurations[index]!,
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

  async replaceVersionRuntimeAsset(
    projectVersionId: string,
    record: CreateProjectRuntimeAssetRecord,
  ) {
    try {
      return this.handle.client.transaction(() => {
        const version = this.handle.client
          .prepare("SELECT * FROM project_versions WHERE id = ? AND project_id = ?")
          .get(projectVersionId, record.projectId) as VersionRow | undefined;
        if (!version) {
          throw new DomainError(
            "PROJECT_VERSION_NOT_FOUND",
            "指定的项目版本不存在或不属于当前项目。",
          );
        }
        const previous = this.versionRuntimeRow(projectVersionId);
        this.insertRuntimeAsset(record);
        this.handle.client
          .prepare(
            `INSERT INTO project_version_runtime_assets
             (project_version_id, project_id, jar_bundle_asset_id, revision, updated_by, updated_at)
             VALUES (?, ?, ?, 1, ?, ?)
             ON CONFLICT(project_version_id) DO UPDATE SET
               jar_bundle_asset_id = excluded.jar_bundle_asset_id,
               inherited_from_project_version_id = NULL,
               revision = project_version_runtime_assets.revision + 1,
               updated_by = excluded.updated_by,
               updated_at = excluded.updated_at`,
          )
          .run(
            projectVersionId,
            record.projectId,
            record.id,
            record.createdBy ?? null,
            record.createdAt,
          );
        if (previous && previous.jar_bundle_asset_id !== record.id) {
          if (previous.jar_bundle_asset_id) {
            this.deleteAssetMetadataIfUnreferenced(previous.jar_bundle_asset_id);
          }
        }
        return { version: mapVersion(version), asset: this.requiredAsset(record.id) };
      })();
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw mapStructureWriteError(error);
    }
  }

  async updateAdapterConfiguration(
    input: Parameters<ProjectStructureRepository["updateAdapterConfiguration"]>[0],
  ): Promise<ProjectAdapterConfiguration> {
    if (input.projectVersionId) {
      return this.updateVersionConfiguration({
        ...input,
        projectVersionId: input.projectVersionId,
      });
    }
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
               VALUES (?, '', '', '', ?, ?, 1, ?, ?)`,
            )
            .run(
              input.projectId,
              input.jdkAssetId ?? null,
              input.jarBundleAssetId ?? null,
              input.actorId ?? null,
              input.updatedAt,
            );
        } else {
          const changed = this.handle.client
            .prepare(
              `UPDATE project_adapter_configurations
               SET suite_name = '', test_name = '', environment_address = '', jdk_asset_id = ?,
                   jar_bundle_asset_id = ?, revision = revision + 1, updated_by = ?, updated_at = ?
               WHERE project_id = ? AND revision = ?`,
            )
            .run(
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

  async getAdapterConfiguration(
    projectId: string,
    projectVersionId?: string,
  ): Promise<ProjectAdapterConfiguration> {
    const row = this.configurationRow(projectId);
    if (projectVersionId) {
      const versionRuntime = this.versionRuntimeRow(projectVersionId);
      return {
        projectId,
        projectVersionId,
        ...(versionRuntime?.inherited_from_project_version_id
          ? { inheritedFromProjectVersionId: versionRuntime.inherited_from_project_version_id }
          : {}),
        ...(versionRuntime?.jdk_asset_id
          ? { jdkAsset: this.requiredAsset(versionRuntime.jdk_asset_id) }
          : {}),
        ...(versionRuntime?.jar_bundle_asset_id
          ? { jarBundleAsset: this.requiredAsset(versionRuntime.jar_bundle_asset_id) }
          : {}),
        revision: versionRuntime?.revision ?? 0,
        ...(versionRuntime?.updated_by ? { updatedBy: versionRuntime.updated_by } : {}),
        updatedAt: versionRuntime?.updated_at ?? "",
      };
    }
    return row
      ? this.mapConfiguration(row)
      : {
          projectId,
          revision: 0,
          updatedAt: "",
        };
  }

  async inheritAdapterConfiguration(
    input: Parameters<ProjectStructureRepository["inheritAdapterConfiguration"]>[0],
  ): Promise<ProjectAdapterConfiguration> {
    try {
      return this.handle.client.transaction(() => {
        this.requireVersionInProject(input.sourceProjectVersionId, input.projectId);
        this.requireVersionInProject(input.targetProjectVersionId, input.projectId);
        const source = this.versionRuntimeRow(input.sourceProjectVersionId);
        if (!source) {
          throw new DomainError(
            "PROJECT_VERSION_RUNTIME_ASSETS_MISSING",
            "来源版本尚未配置 JDK 或依赖 JAR 压缩包。",
          );
        }
        const current = this.versionRuntimeRow(input.targetProjectVersionId);
        if ((current?.revision ?? 0) !== input.expectedRevision) throw revisionConflict();
        this.writeVersionConfiguration({
          projectId: input.projectId,
          projectVersionId: input.targetProjectVersionId,
          ...(source.jdk_asset_id ? { jdkAssetId: source.jdk_asset_id } : {}),
          ...(source.jar_bundle_asset_id ? { jarBundleAssetId: source.jar_bundle_asset_id } : {}),
          inheritedFromProjectVersionId: input.sourceProjectVersionId,
          expectedRevision: input.expectedRevision,
          ...(input.actorId ? { actorId: input.actorId } : {}),
          updatedAt: input.updatedAt,
        });
        return this.requiredVersionConfiguration(input.projectId, input.targetProjectVersionId);
      })();
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw mapStructureWriteError(error);
    }
  }

  async detachVersionRuntimeAsset(
    input: Parameters<ProjectStructureRepository["detachVersionRuntimeAsset"]>[0],
  ): Promise<{
    configuration: ProjectAdapterConfiguration;
    orphanedAsset?: ProjectRuntimeAsset;
  }> {
    try {
      return this.handle.client.transaction(() => {
        this.requireVersionInProject(input.projectVersionId, input.projectId);
        const current = this.versionRuntimeRow(input.projectVersionId);
        if (!current) {
          throw new DomainError(
            "PROJECT_VERSION_RUNTIME_ASSETS_MISSING",
            "当前版本没有可删除的资源。",
          );
        }
        if (current.revision !== input.expectedRevision) throw revisionConflict();
        const assetId = input.kind === "jdk" ? current.jdk_asset_id : current.jar_bundle_asset_id;
        if (!assetId) {
          throw new DomainError("PROJECT_VERSION_RUNTIME_ASSET_MISSING", "当前版本未配置该资源。");
        }
        const jdkAssetId = input.kind === "jdk" ? undefined : (current.jdk_asset_id ?? undefined);
        const jarBundleAssetId =
          input.kind === "jar-bundle" ? undefined : (current.jar_bundle_asset_id ?? undefined);
        if (!jdkAssetId && !jarBundleAssetId) {
          this.handle.client
            .prepare(
              "DELETE FROM project_version_runtime_assets WHERE project_version_id = ? AND revision = ?",
            )
            .run(input.projectVersionId, input.expectedRevision);
        } else {
          this.writeVersionConfiguration({
            projectId: input.projectId,
            projectVersionId: input.projectVersionId,
            ...(jdkAssetId ? { jdkAssetId } : {}),
            ...(jarBundleAssetId ? { jarBundleAssetId } : {}),
            expectedRevision: input.expectedRevision,
            ...(input.actorId ? { actorId: input.actorId } : {}),
            updatedAt: input.updatedAt,
          });
        }
        const configuration = this.requiredVersionConfiguration(
          input.projectId,
          input.projectVersionId,
          true,
        );
        const orphanedAsset = this.findUnreferencedAsset(assetId);
        return { configuration, ...(orphanedAsset ? { orphanedAsset } : {}) };
      })();
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw mapStructureWriteError(error);
    }
  }

  async deleteRuntimeAssetMetadata(assetId: string): Promise<void> {
    this.handle.client.transaction(() => {
      const orphan = this.findUnreferencedAsset(assetId);
      if (orphan) {
        this.handle.client.prepare("DELETE FROM project_runtime_assets WHERE id = ?").run(assetId);
      }
    })();
  }

  private updateVersionConfiguration(
    input: Parameters<ProjectStructureRepository["updateAdapterConfiguration"]>[0] & {
      projectVersionId: string;
    },
  ): ProjectAdapterConfiguration {
    try {
      return this.handle.client.transaction(() => {
        this.requireVersionInProject(input.projectVersionId, input.projectId);
        this.validateAsset(input.projectId, input.jdkAssetId, "jdk");
        this.validateAsset(input.projectId, input.jarBundleAssetId, "jar-bundle");
        this.writeVersionConfiguration(input);
        return this.requiredVersionConfiguration(input.projectId, input.projectVersionId);
      })();
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw mapStructureWriteError(error);
    }
  }

  private writeVersionConfiguration(input: {
    projectId: string;
    projectVersionId: string;
    jdkAssetId?: string;
    jarBundleAssetId?: string;
    inheritedFromProjectVersionId?: string;
    expectedRevision: number;
    actorId?: string;
    updatedAt: string;
  }): void {
    const current = this.versionRuntimeRow(input.projectVersionId);
    if ((current?.revision ?? 0) !== input.expectedRevision) throw revisionConflict();
    if (!input.jdkAssetId && !input.jarBundleAssetId) {
      throw new DomainError(
        "PROJECT_VERSION_RUNTIME_ASSETS_REQUIRED",
        "项目版本至少需要配置一个运行时资源。",
      );
    }
    if (!current) {
      this.handle.client
        .prepare(
          `INSERT INTO project_version_runtime_assets
           (project_version_id, project_id, jdk_asset_id, jar_bundle_asset_id,
            inherited_from_project_version_id, revision, updated_by, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          input.projectVersionId,
          input.projectId,
          input.jdkAssetId ?? null,
          input.jarBundleAssetId ?? null,
          input.inheritedFromProjectVersionId ?? null,
          input.actorId ?? null,
          input.updatedAt,
        );
      return;
    }
    const changed = this.handle.client
      .prepare(
        `UPDATE project_version_runtime_assets
         SET jdk_asset_id = ?, jar_bundle_asset_id = ?, inherited_from_project_version_id = ?,
             revision = revision + 1, updated_by = ?, updated_at = ?
         WHERE project_version_id = ? AND project_id = ? AND revision = ?`,
      )
      .run(
        input.jdkAssetId ?? null,
        input.jarBundleAssetId ?? null,
        input.inheritedFromProjectVersionId ?? null,
        input.actorId ?? null,
        input.updatedAt,
        input.projectVersionId,
        input.projectId,
        input.expectedRevision,
      );
    if (changed.changes !== 1) throw revisionConflict();
  }

  private requiredVersionConfiguration(
    projectId: string,
    projectVersionId: string,
    allowEmpty = false,
  ): ProjectAdapterConfiguration {
    const row = this.versionRuntimeRow(projectVersionId);
    if (!row) {
      if (allowEmpty) return { projectId, projectVersionId, revision: 0, updatedAt: "" };
      throw new Error("Updated project version configuration could not be read.");
    }
    return {
      projectId,
      projectVersionId,
      ...(row.inherited_from_project_version_id
        ? { inheritedFromProjectVersionId: row.inherited_from_project_version_id }
        : {}),
      ...(row.jdk_asset_id ? { jdkAsset: this.requiredAsset(row.jdk_asset_id) } : {}),
      ...(row.jar_bundle_asset_id
        ? { jarBundleAsset: this.requiredAsset(row.jar_bundle_asset_id) }
        : {}),
      revision: row.revision,
      ...(row.updated_by ? { updatedBy: row.updated_by } : {}),
      updatedAt: row.updated_at,
    };
  }

  private requireVersionInProject(projectVersionId: string, projectId: string): void {
    const version = this.handle.client
      .prepare("SELECT 1 FROM project_versions WHERE id = ? AND project_id = ?")
      .get(projectVersionId, projectId);
    if (!version) {
      throw new DomainError("PROJECT_VERSION_NOT_FOUND", "指定的项目版本不存在或不属于当前项目。");
    }
  }

  private deleteAssetMetadataIfUnreferenced(assetId: string): ProjectRuntimeAsset | undefined {
    const asset = this.findUnreferencedAsset(assetId);
    // Jenkins 这里只替换 URL 登记；上传对象必须由具备 ObjectStore 的应用服务清理，
    // 不能先删元数据而遗失可重试的对象引用。
    if (!asset || asset.sourceType !== "url") return undefined;
    this.handle.client.prepare("DELETE FROM project_runtime_assets WHERE id = ?").run(assetId);
    return asset;
  }

  private findUnreferencedAsset(assetId: string): ProjectRuntimeAsset | undefined {
    const references = this.handle.client
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM project_adapter_configurations
             WHERE jdk_asset_id = ? OR jar_bundle_asset_id = ?) +
           (SELECT COUNT(*) FROM project_version_runtime_assets
             WHERE jdk_asset_id = ? OR jar_bundle_asset_id = ?) +
           (SELECT COUNT(*) FROM run_batches
             WHERE status IN ('queued','dispatching','scheduled','running')
               AND adapter_runtime_json LIKE ?) AS value`,
      )
      .get(assetId, assetId, assetId, assetId, `%\"id\":\"${assetId}\"%`) as { value: number };
    if (references.value > 0) return undefined;
    return this.requiredAsset(assetId);
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

  private insertRuntimeAsset(record: CreateProjectRuntimeAssetRecord): void {
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
  }

  private versionRuntimeRow(projectVersionId: string): VersionRuntimeRow | undefined {
    return this.handle.client
      .prepare("SELECT * FROM project_version_runtime_assets WHERE project_version_id = ?")
      .get(projectVersionId) as VersionRuntimeRow | undefined;
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
  // 结构写入前已校验版本/阶段等父记录，外键冲突实际含义是项目不存在
  // （或写入期间项目被并发删除），返回可区分的领域错误而不是泛化 500。
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "SQLITE_CONSTRAINT_FOREIGNKEY" || /FOREIGN KEY constraint failed/u.test(message)) {
    return new DomainError("PROJECT_NOT_FOUND", "指定的项目不存在。", { cause: error });
  }
  return new Error("无法写入项目版本结构。", { cause: error });
}
