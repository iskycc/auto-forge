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
  jdk_asset_id: string | null;
  jar_bundle_asset_id: string | null;
  inherited_from_project_version_id: string | null;
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
    const versions = versionResult.rows.map(mapVersion);
    const configurations = await Promise.all(
      versions.map((version) => this.getAdapterConfiguration(projectId, version.id)),
    );
    return {
      versions: versions.map((version, index) => ({
        ...version,
        stages: stages.filter((stage) => stage.projectVersionId === version.id),
        adapterConfiguration: configurations[index]!,
      })),
      adapterConfiguration,
    };
  }

  async listRuntimeAssetsPage(
    input: Parameters<ProjectStructureRepository["listRuntimeAssetsPage"]>[0],
  ) {
    await this.handle.ready;
    assertRuntimeAssetPageLimit(input.limit);
    const conditions: string[] = [];
    const parameters: Array<string | number> = [];
    if (input.sourceType) {
      parameters.push(input.sourceType);
      conditions.push(`source_type = $${parameters.length}`);
    }
    if (input.afterId) {
      parameters.push(input.afterId);
      conditions.push(`id > $${parameters.length}`);
    }
    parameters.push(input.limit + 1);
    const result = await this.handle.pool.query<AssetRow>(
      `SELECT * FROM project_runtime_assets
       ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY id LIMIT $${parameters.length}`,
      parameters,
    );
    const pageRows = result.rows.slice(0, input.limit);
    const page: { items: ProjectRuntimeAsset[]; nextCursor?: string } = {
      items: pageRows.map(mapAsset),
    };
    const last = pageRows.at(-1);
    if (result.rows.length > input.limit && last) page.nextCursor = last.id;
    return page;
  }

  async findRuntimeAssetsByObjectKeys(
    objectKeys: readonly string[],
  ): Promise<ProjectRuntimeAsset[]> {
    await this.handle.ready;
    if (objectKeys.length === 0) return [];
    if (objectKeys.length > 200) throw new Error("Runtime asset object-key query is too large.");
    const result = await this.handle.pool.query<AssetRow>(
      "SELECT * FROM project_runtime_assets WHERE object_key = ANY($1::text[]) ORDER BY id",
      [[...objectKeys]],
    );
    return result.rows.map(mapAsset);
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
             inherited_from_project_version_id = NULL,
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
          await deleteAssetMetadataIfUnreferenced(client, previousAssetId);
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
    if (input.projectVersionId) {
      return this.updateVersionConfiguration({
        ...input,
        projectVersionId: input.projectVersionId,
      });
    }
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
    const versionResult = await this.handle.pool.query<VersionRuntimeRow>(
      `SELECT * FROM project_version_runtime_assets
       WHERE project_version_id = $1 AND project_id = $2`,
      [projectVersionId, projectId],
    );
    const versionRuntime = versionResult.rows[0];
    return versionRuntime
      ? mapVersionConfiguration(this.handle.pool, versionRuntime)
      : { projectId, projectVersionId, revision: 0, updatedAt: "" };
  }

  async inheritAdapterConfiguration(
    input: Parameters<ProjectStructureRepository["inheritAdapterConfiguration"]>[0],
  ): Promise<ProjectAdapterConfiguration> {
    await this.handle.ready;
    try {
      return await this.transaction(async (client) => {
        await requireVersionInProject(client, input.sourceProjectVersionId, input.projectId);
        await requireVersionInProject(client, input.targetProjectVersionId, input.projectId);
        const source = await versionRuntimeRow(client, input.sourceProjectVersionId, true);
        if (!source) {
          throw new DomainError(
            "PROJECT_VERSION_RUNTIME_ASSETS_MISSING",
            "来源版本尚未配置 JDK 或依赖 JAR 压缩包。",
          );
        }
        await writeVersionConfiguration(client, {
          projectId: input.projectId,
          projectVersionId: input.targetProjectVersionId,
          ...(source.jdk_asset_id ? { jdkAssetId: source.jdk_asset_id } : {}),
          ...(source.jar_bundle_asset_id ? { jarBundleAssetId: source.jar_bundle_asset_id } : {}),
          inheritedFromProjectVersionId: input.sourceProjectVersionId,
          expectedRevision: input.expectedRevision,
          ...(input.actorId ? { actorId: input.actorId } : {}),
          updatedAt: input.updatedAt,
        });
        const updated = await versionRuntimeRow(client, input.targetProjectVersionId, false);
        return mapVersionConfiguration(client, updated!);
      });
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
    await this.handle.ready;
    try {
      return await this.transaction(async (client) => {
        await requireVersionInProject(client, input.projectVersionId, input.projectId);
        const current = await versionRuntimeRow(client, input.projectVersionId, true);
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
        let configuration: ProjectAdapterConfiguration;
        if (!jdkAssetId && !jarBundleAssetId) {
          const deleted = await client.query(
            `DELETE FROM project_version_runtime_assets
             WHERE project_version_id = $1 AND revision = $2`,
            [input.projectVersionId, input.expectedRevision],
          );
          if (deleted.rowCount !== 1) throw revisionConflict();
          configuration = {
            projectId: input.projectId,
            projectVersionId: input.projectVersionId,
            revision: 0,
            updatedAt: "",
          };
        } else {
          await writeVersionConfiguration(client, {
            projectId: input.projectId,
            projectVersionId: input.projectVersionId,
            ...(jdkAssetId ? { jdkAssetId } : {}),
            ...(jarBundleAssetId ? { jarBundleAssetId } : {}),
            expectedRevision: input.expectedRevision,
            ...(input.actorId ? { actorId: input.actorId } : {}),
            updatedAt: input.updatedAt,
          });
          configuration = await mapVersionConfiguration(
            client,
            (await versionRuntimeRow(client, input.projectVersionId, false))!,
          );
        }
        const orphanedAsset = await findUnreferencedAsset(client, assetId);
        return { configuration, ...(orphanedAsset ? { orphanedAsset } : {}) };
      });
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw mapStructureWriteError(error);
    }
  }

  async deleteRuntimeAssetMetadata(assetId: string): Promise<void> {
    await this.handle.ready;
    await this.transaction(async (client) => {
      const orphan = await findUnreferencedAsset(client, assetId);
      if (orphan) {
        await client.query("DELETE FROM project_runtime_assets WHERE id = $1", [assetId]);
      }
    });
  }

  private async updateVersionConfiguration(
    input: Parameters<ProjectStructureRepository["updateAdapterConfiguration"]>[0] & {
      projectVersionId: string;
    },
  ): Promise<ProjectAdapterConfiguration> {
    try {
      return await this.transaction(async (client) => {
        await requireVersionInProject(client, input.projectVersionId, input.projectId);
        await validateAsset(client, input.projectId, input.jdkAssetId, "jdk");
        await validateAsset(client, input.projectId, input.jarBundleAssetId, "jar-bundle");
        await writeVersionConfiguration(client, input);
        return mapVersionConfiguration(
          client,
          (await versionRuntimeRow(client, input.projectVersionId, false))!,
        );
      });
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw mapStructureWriteError(error);
    }
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

async function requireVersionInProject(
  client: Queryable,
  projectVersionId: string,
  projectId: string,
): Promise<void> {
  const result = await client.query(
    "SELECT 1 FROM project_versions WHERE id = $1 AND project_id = $2",
    [projectVersionId, projectId],
  );
  if (result.rowCount !== 1) {
    throw new DomainError("PROJECT_VERSION_NOT_FOUND", "指定的项目版本不存在或不属于当前项目。");
  }
}

async function versionRuntimeRow(
  client: Queryable,
  projectVersionId: string,
  lock: boolean,
): Promise<VersionRuntimeRow | undefined> {
  const result = await client.query<VersionRuntimeRow>(
    `SELECT * FROM project_version_runtime_assets WHERE project_version_id = $1${lock ? " FOR UPDATE" : ""}`,
    [projectVersionId],
  );
  return result.rows[0];
}

async function writeVersionConfiguration(
  client: Queryable,
  input: {
    projectId: string;
    projectVersionId: string;
    jdkAssetId?: string;
    jarBundleAssetId?: string;
    inheritedFromProjectVersionId?: string;
    expectedRevision: number;
    actorId?: string;
    updatedAt: string;
  },
): Promise<void> {
  const current = await versionRuntimeRow(client, input.projectVersionId, true);
  if ((current?.revision ?? 0) !== input.expectedRevision) throw revisionConflict();
  if (!input.jdkAssetId && !input.jarBundleAssetId) {
    throw new DomainError(
      "PROJECT_VERSION_RUNTIME_ASSETS_REQUIRED",
      "项目版本至少需要配置一个运行时资源。",
    );
  }
  if (!current) {
    await client.query(
      `INSERT INTO project_version_runtime_assets
       (project_version_id, project_id, jdk_asset_id, jar_bundle_asset_id,
        inherited_from_project_version_id, revision, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, 1, $6, $7)`,
      [
        input.projectVersionId,
        input.projectId,
        input.jdkAssetId ?? null,
        input.jarBundleAssetId ?? null,
        input.inheritedFromProjectVersionId ?? null,
        input.actorId ?? null,
        input.updatedAt,
      ],
    );
    return;
  }
  const updated = await client.query(
    `UPDATE project_version_runtime_assets
     SET jdk_asset_id = $1, jar_bundle_asset_id = $2, inherited_from_project_version_id = $3,
         revision = revision + 1, updated_by = $4, updated_at = $5
     WHERE project_version_id = $6 AND project_id = $7 AND revision = $8`,
    [
      input.jdkAssetId ?? null,
      input.jarBundleAssetId ?? null,
      input.inheritedFromProjectVersionId ?? null,
      input.actorId ?? null,
      input.updatedAt,
      input.projectVersionId,
      input.projectId,
      input.expectedRevision,
    ],
  );
  if (updated.rowCount !== 1) throw revisionConflict();
}

async function mapVersionConfiguration(
  client: Queryable,
  row: VersionRuntimeRow,
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
    projectVersionId: row.project_version_id,
    ...(row.inherited_from_project_version_id
      ? { inheritedFromProjectVersionId: row.inherited_from_project_version_id }
      : {}),
    ...(jdkAsset ? { jdkAsset } : {}),
    ...(jarBundleAsset ? { jarBundleAsset } : {}),
    revision: row.revision,
    ...(row.updated_by ? { updatedBy: row.updated_by } : {}),
    updatedAt: row.updated_at,
  };
}

async function deleteAssetMetadataIfUnreferenced(
  client: Queryable,
  assetId: string,
): Promise<ProjectRuntimeAsset | undefined> {
  const asset = await findUnreferencedAsset(client, assetId);
  // Jenkins 这里只替换 URL 登记；上传对象必须由具备 ObjectStore 的应用服务清理，
  // 不能先删元数据而遗失可重试的对象引用。
  if (!asset || asset.sourceType !== "url") return undefined;
  await client.query("DELETE FROM project_runtime_assets WHERE id = $1", [assetId]);
  return asset;
}

async function findUnreferencedAsset(
  client: Queryable,
  assetId: string,
): Promise<ProjectRuntimeAsset | undefined> {
  const references = await client.query<{ value: string }>(
    `SELECT (
       (SELECT COUNT(*) FROM project_adapter_configurations
         WHERE jdk_asset_id = $1 OR jar_bundle_asset_id = $1) +
       (SELECT COUNT(*) FROM project_version_runtime_assets
         WHERE jdk_asset_id = $1 OR jar_bundle_asset_id = $1) +
       (SELECT COUNT(*) FROM run_batches
         WHERE status IN ('queued','dispatching','scheduled','running')
           AND adapter_runtime_json LIKE $2)
     ) AS value`,
    [assetId, `%\"id\":\"${assetId}\"%`],
  );
  if (Number(references.rows[0]?.value ?? 0) > 0) return undefined;
  const asset = await client.query<AssetRow>("SELECT * FROM project_runtime_assets WHERE id = $1", [
    assetId,
  ]);
  return asset.rows[0] ? mapAsset(asset.rows[0]) : undefined;
}

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

function assertRuntimeAssetPageLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("Runtime asset page limit must be between 1 and 200.");
  }
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
  // 结构写入前已校验版本/阶段等父记录，外键冲突实际含义是项目不存在
  // （或写入期间项目被并发删除），返回可区分的领域错误而不是泛化 500。
  if (typeof error === "object" && error !== null && "code" in error && error.code === "23503") {
    return new DomainError("PROJECT_NOT_FOUND", "指定的项目不存在。", { cause: error });
  }
  return new Error("无法写入项目版本结构。", { cause: error });
}
