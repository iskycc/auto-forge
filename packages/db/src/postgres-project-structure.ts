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
import type { PoolClient, QueryResultRow } from "pg";

import type { PostgresDatabaseHandle } from "./postgres-database";

type VersionRow = QueryResultRow & {
  id: string;
  project_id: string;
  name: string;
  status: "active" | "archived";
  revision: number;
  created_at: string;
  updated_at: string;
};
type StageRow = QueryResultRow & {
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
type AssetRow = QueryResultRow & {
  id: string;
  project_id: string;
  kind: "jdk" | "jar-bundle";
  source_type: "upload" | "url";
  file_name: string;
  url: string | null;
  object_key: string | null;
  sha256: string;
  size_bytes: string | number;
  archive_format: "zip" | "tar.gz";
  created_by: string | null;
  created_at: string;
};
type ConfigurationRow = QueryResultRow & {
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
type VersionRuntimeRow = QueryResultRow & {
  project_version_id: string;
  project_id: string;
  jar_bundle_asset_id: string;
  revision: number;
  updated_by: string | null;
  updated_at: string;
};

export class PostgresProjectStructureRepository implements ProjectStructureRepository {
  constructor(private readonly handle: PostgresDatabaseHandle) {}

  async list(projectId: string) {
    await this.handle.ready;
    const [versionResult, stageResult, adapterConfiguration] = await Promise.all([
      this.handle.pool.query<VersionRow>(
        "SELECT * FROM project_versions WHERE project_id = $1 ORDER BY created_at, id",
        [projectId],
      ),
      this.handle.pool.query<StageRow>(
        `SELECT * FROM test_stages WHERE project_id = $1
         ORDER BY project_version_id, position, id`,
        [projectId],
      ),
      this.getAdapterConfiguration(projectId),
    ]);
    const stages = stageResult.rows.map(mapStage);
    return {
      versions: versionResult.rows.map(mapVersion).map((version) => ({
        ...version,
        stages: stages.filter((stage) => stage.projectVersionId === version.id),
      })),
      adapterConfiguration,
    };
  }

  async createVersion(record: CreateProjectVersionRecord): Promise<ProjectVersion> {
    await this.handle.ready;
    try {
      const result = await this.handle.pool.query<VersionRow>(
        `INSERT INTO project_versions
         (id, project_id, name, normalized_name, status, revision, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'active', 1, $5, $5) RETURNING *`,
        [record.id, record.projectId, record.name, record.normalizedName, record.recordedAt],
      );
      return mapVersion(required(result.rows[0], "Created project version could not be read."));
    } catch (error) {
      throw mapStructureWriteError(error);
    }
  }

  async createStage(record: CreateTestStageRecord): Promise<TestStage> {
    await this.handle.ready;
    try {
      return await this.transaction(async (client) => {
        const version = await client.query(
          "SELECT id FROM project_versions WHERE id = $1 AND project_id = $2 FOR UPDATE",
          [record.projectVersionId, record.projectId],
        );
        if (version.rowCount !== 1) {
          throw new DomainError("PROJECT_VERSION_NOT_FOUND", "指定的项目版本不存在。");
        }
        const result = await client.query<StageRow>(
          `INSERT INTO test_stages
           (id, project_id, project_version_id, name, normalized_name, description, position,
            status, revision, created_at, updated_at)
           SELECT $1, $2, $3, $4, $5, $6, COALESCE(MAX(position), 0) + 1,
                  'active', 1, $7, $7
           FROM test_stages WHERE project_version_id = $3 RETURNING *`,
          [
            record.id,
            record.projectId,
            record.projectVersionId,
            record.name,
            record.normalizedName,
            record.description,
            record.recordedAt,
          ],
        );
        return mapStage(required(result.rows[0], "Created test stage could not be read."));
      });
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw mapStructureWriteError(error);
    }
  }

  async createRuntimeAsset(record: CreateProjectRuntimeAssetRecord): Promise<ProjectRuntimeAsset> {
    await this.handle.ready;
    try {
      const result = await this.handle.pool.query<AssetRow>(
        `INSERT INTO project_runtime_assets
         (id, project_id, kind, source_type, file_name, url, object_key, sha256, size_bytes,
          archive_format, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
        [
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
        ],
      );
      return mapAsset(required(result.rows[0], "Created runtime asset could not be read."));
    } catch (error) {
      throw mapStructureWriteError(error);
    }
  }

  async replaceVersionRuntimeAsset(
    projectVersionId: string,
    record: CreateProjectRuntimeAssetRecord,
  ) {
    await this.handle.ready;
    try {
      return await this.transaction(async (client) => {
        const versions = await client.query<VersionRow>(
          "SELECT * FROM project_versions WHERE id = $1 AND project_id = $2 FOR UPDATE",
          [projectVersionId, record.projectId],
        );
        const version = versions.rows[0];
        if (!version) {
          throw new DomainError(
            "PROJECT_VERSION_NOT_FOUND",
            "指定的项目版本不存在或不属于当前项目。",
          );
        }
        const previous = await client.query<VersionRuntimeRow>(
          "SELECT * FROM project_version_runtime_assets WHERE project_version_id = $1 FOR UPDATE",
          [projectVersionId],
        );
        const inserted = await client.query<AssetRow>(
          `INSERT INTO project_runtime_assets
           (id, project_id, kind, source_type, file_name, url, object_key, sha256, size_bytes,
            archive_format, created_by, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
          [
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
          ],
        );
        await client.query(
          `INSERT INTO project_version_runtime_assets
           (project_version_id, project_id, jar_bundle_asset_id, revision, updated_by, updated_at)
           VALUES ($1, $2, $3, 1, $4, $5)
           ON CONFLICT (project_version_id) DO UPDATE SET
             jar_bundle_asset_id = EXCLUDED.jar_bundle_asset_id,
             revision = project_version_runtime_assets.revision + 1,
             updated_by = EXCLUDED.updated_by,
             updated_at = EXCLUDED.updated_at`,
          [
            projectVersionId,
            record.projectId,
            record.id,
            record.createdBy ?? null,
            record.createdAt,
          ],
        );
        const previousAssetId = previous.rows[0]?.jar_bundle_asset_id;
        if (previousAssetId && previousAssetId !== record.id) {
          await client.query(
            "DELETE FROM project_runtime_assets WHERE id = $1 AND source_type = 'url'",
            [previousAssetId],
          );
        }
        return {
          version: mapVersion(version),
          asset: mapAsset(required(inserted.rows[0], "Created runtime asset could not be read.")),
        };
      });
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw mapStructureWriteError(error);
    }
  }

  async updateAdapterConfiguration(
    input: Parameters<ProjectStructureRepository["updateAdapterConfiguration"]>[0],
  ): Promise<ProjectAdapterConfiguration> {
    await this.handle.ready;
    try {
      return await this.transaction(async (client) => {
        await validateAsset(client, input.projectId, input.jdkAssetId, "jdk");
        await validateAsset(client, input.projectId, input.jarBundleAssetId, "jar-bundle");
        const current = await client.query<ConfigurationRow>(
          "SELECT * FROM project_adapter_configurations WHERE project_id = $1 FOR UPDATE",
          [input.projectId],
        );
        let result;
        if (current.rowCount === 0) {
          if (input.expectedRevision !== 0) throw revisionConflict();
          result = await client.query<ConfigurationRow>(
            `INSERT INTO project_adapter_configurations
             (project_id, suite_name, test_name, environment_address, jdk_asset_id,
              jar_bundle_asset_id, revision, updated_by, updated_at)
             VALUES ($1, '', '', '', $2, $3, 1, $4, $5) RETURNING *`,
            [
              input.projectId,
              input.jdkAssetId ?? null,
              input.jarBundleAssetId ?? null,
              input.actorId ?? null,
              input.updatedAt,
            ],
          );
        } else {
          result = await client.query<ConfigurationRow>(
            `UPDATE project_adapter_configurations
             SET suite_name = '', test_name = '', environment_address = '', jdk_asset_id = $1,
                 jar_bundle_asset_id = $2, revision = revision + 1, updated_by = $3, updated_at = $4
             WHERE project_id = $5 AND revision = $6 RETURNING *`,
            [
              input.jdkAssetId ?? null,
              input.jarBundleAssetId ?? null,
              input.actorId ?? null,
              input.updatedAt,
              input.projectId,
              input.expectedRevision,
            ],
          );
          if (result.rowCount !== 1) throw revisionConflict();
        }
        return mapConfiguration(
          client,
          required(result.rows[0], "Updated adapter configuration could not be read."),
        );
      });
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw mapStructureWriteError(error);
    }
  }

  async getAdapterConfiguration(
    projectId: string,
    projectVersionId?: string,
  ): Promise<ProjectAdapterConfiguration> {
    await this.handle.ready;
    const result = await this.handle.pool.query<ConfigurationRow>(
      "SELECT * FROM project_adapter_configurations WHERE project_id = $1",
      [projectId],
    );
    const globalConfiguration = result.rows[0]
      ? await mapConfiguration(this.handle.pool, result.rows[0])
      : { projectId, revision: 0, updatedAt: "" };
    if (!projectVersionId) return globalConfiguration;
    const versionResult = await this.handle.pool.query<VersionRuntimeRow & AssetRow>(
      `SELECT configuration.*, asset.id, asset.project_id, asset.kind, asset.source_type,
              asset.file_name, asset.url, asset.object_key, asset.sha256, asset.size_bytes,
              asset.archive_format, asset.created_by, asset.created_at
       FROM project_version_runtime_assets configuration
       JOIN project_runtime_assets asset ON asset.id = configuration.jar_bundle_asset_id
       WHERE configuration.project_version_id = $1 AND configuration.project_id = $2`,
      [projectVersionId, projectId],
    );
    const versionRuntime = versionResult.rows[0];
    return {
      projectId,
      projectVersionId,
      ...(globalConfiguration.jdkAsset ? { jdkAsset: globalConfiguration.jdkAsset } : {}),
      ...(versionRuntime ? { jarBundleAsset: mapAsset(versionRuntime) } : {}),
      revision: versionRuntime?.revision ?? 0,
      ...(versionRuntime?.updated_by ? { updatedBy: versionRuntime.updated_by } : {}),
      updatedAt: versionRuntime?.updated_at ?? "",
    };
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.handle.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

type Queryable = Pick<PoolClient, "query">;

async function mapConfiguration(
  client: Queryable,
  row: ConfigurationRow,
): Promise<ProjectAdapterConfiguration> {
  const assetIds = [row.jdk_asset_id, row.jar_bundle_asset_id].filter((value): value is string =>
    Boolean(value),
  );
  const assets = assetIds.length
    ? (
        await client.query<AssetRow>(
          "SELECT * FROM project_runtime_assets WHERE id = ANY($1::text[])",
          [assetIds],
        )
      ).rows.map(mapAsset)
    : [];
  const findAsset = (id: string | null) => assets.find((asset) => asset.id === id);
  const jdkAsset = findAsset(row.jdk_asset_id);
  const jarBundleAsset = findAsset(row.jar_bundle_asset_id);
  return {
    projectId: row.project_id,
    ...(jdkAsset ? { jdkAsset } : {}),
    ...(jarBundleAsset ? { jarBundleAsset } : {}),
    revision: row.revision,
    ...(row.updated_by ? { updatedBy: row.updated_by } : {}),
    updatedAt: row.updated_at,
  };
}

async function validateAsset(
  client: Queryable,
  projectId: string,
  assetId: string | undefined,
  kind: ProjectRuntimeAsset["kind"],
): Promise<void> {
  if (!assetId) return;
  const result = await client.query<AssetRow>(
    "SELECT * FROM project_runtime_assets WHERE id = $1 AND project_id = $2 AND kind = $3",
    [assetId, projectId, kind],
  );
  if (result.rowCount !== 1) {
    throw new DomainError(
      "RUNTIME_ASSET_SCOPE_INVALID",
      `所选 ${kind} 资源不属于当前项目或类型不匹配。`,
    );
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
    sizeBytes: Number(row.size_bytes),
    archiveFormat: row.archive_format,
    ...(row.created_by ? { createdBy: row.created_by } : {}),
    createdAt: row.created_at,
  };
}

function required<T>(value: T | undefined, message: string): T {
  if (!value) throw new Error(message);
  return value;
}

function revisionConflict(): DomainError {
  return new DomainError(
    "PROJECT_ADAPTER_CONFIGURATION_REVISION_CONFLICT",
    "Adapter 配置已被其他请求修改，请刷新后重试。",
  );
}

function mapStructureWriteError(error: unknown): Error {
  if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
    return new DomainError("PROJECT_STRUCTURE_NAME_CONFLICT", "同一层级下已存在同名记录。");
  }
  return new Error("无法写入项目版本结构。", { cause: error });
}
