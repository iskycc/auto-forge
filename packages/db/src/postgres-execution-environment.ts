import type {
  CreateExecutionEnvironmentRecord,
  ExecutionEnvironmentRepository,
  UpdateExecutionEnvironmentRecord,
} from "@autoforge/application";
import {
  DomainError,
  type ExecutionEnvironment,
  type ExecutionEnvironmentDetails,
  type ExecutionEnvironmentReference,
  type ExecutionEnvironmentSecretBinding,
  type ExecutionEnvironmentVariable,
  type ExecutionEnvironmentVersion,
} from "@autoforge/domain";
import type { PoolClient, QueryResultRow } from "pg";

import type { PostgresDatabaseHandle } from "./postgres-database";

type EnvironmentRow = QueryResultRow & {
  id: string;
  project_id: string;
  name: string;
  description: string;
  status: "active" | "disabled";
  current_version: number;
  revision: number;
  created_by: string;
  created_at: string;
  updated_at: string;
};

type VersionRow = QueryResultRow & {
  id: string;
  environment_id: string;
  version: number;
  variables_json: string | ExecutionEnvironmentVariable[];
  secret_bindings_json: string | ExecutionEnvironmentSecretBinding[];
  created_by: string;
  created_at: string;
};

export class PostgresExecutionEnvironmentRepository implements ExecutionEnvironmentRepository {
  constructor(private readonly handle: PostgresDatabaseHandle) {}

  async create(record: CreateExecutionEnvironmentRecord): Promise<ExecutionEnvironmentDetails> {
    await this.handle.ready;
    try {
      return await this.transaction(async (client) => {
        await client.query(
          `INSERT INTO execution_environments
           (id, project_id, name, normalized_name, description, status, current_version,
            revision, created_by, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, 'active', 1, 1, $6, $7, $7)`,
          [
            record.id,
            record.projectId,
            record.name,
            record.normalizedName,
            record.description,
            record.actorId,
            record.recordedAt,
          ],
        );
        await insertVersion(client, {
          id: record.versionId,
          environmentId: record.id,
          version: 1,
          variables: record.variables,
          secretBindings: await resolveSecretBindings(
            client,
            record.projectId,
            record.secretBindings,
          ),
          actorId: record.actorId,
          recordedAt: record.recordedAt,
        });
        return requiredDetails(client, record.id);
      });
    } catch (error) {
      throw mapEnvironmentWriteError(error);
    }
  }

  async list(projectIds?: readonly string[]): Promise<ExecutionEnvironment[]> {
    await this.handle.ready;
    if (projectIds?.length === 0) return [];
    const result = projectIds
      ? await this.handle.pool.query<EnvironmentRow>(
          "SELECT * FROM execution_environments WHERE project_id = ANY($1::text[]) ORDER BY name, id",
          [[...projectIds]],
        )
      : await this.handle.pool.query<EnvironmentRow>(
          "SELECT * FROM execution_environments ORDER BY name, id",
        );
    return result.rows.map(mapEnvironment);
  }

  async get(
    environmentId: string,
    projectIds?: readonly string[],
  ): Promise<ExecutionEnvironmentDetails | null> {
    await this.handle.ready;
    if (projectIds?.length === 0) return null;
    const result = projectIds
      ? await this.handle.pool.query<EnvironmentRow>(
          "SELECT * FROM execution_environments WHERE id = $1 AND project_id = ANY($2::text[])",
          [environmentId, [...projectIds]],
        )
      : await this.handle.pool.query<EnvironmentRow>(
          "SELECT * FROM execution_environments WHERE id = $1",
          [environmentId],
        );
    return result.rows[0] ? details(this.handle.pool, result.rows[0]) : null;
  }

  async getVersion(versionId: string, projectId: string) {
    await this.handle.ready;
    const result = await this.handle.pool.query<
      EnvironmentRow & {
        version_id: string;
        environment_id: string;
        selected_version: number;
        variables_json: string | ExecutionEnvironmentVariable[];
        secret_bindings_json: string | ExecutionEnvironmentSecretBinding[];
        version_created_by: string;
        version_created_at: string;
      }
    >(
      `SELECT e.*, v.id AS version_id, v.environment_id, v.version AS selected_version,
       v.variables_json, v.secret_bindings_json,
       v.created_by AS version_created_by, v.created_at AS version_created_at
       FROM execution_environment_versions v
       JOIN execution_environments e ON e.id = v.environment_id
       WHERE v.id = $1 AND e.project_id = $2`,
      [versionId, projectId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      environment: mapEnvironment(row),
      version: {
        id: row.version_id,
        environmentId: row.environment_id,
        version: row.selected_version,
        variables: parseVariables(row.variables_json),
        secretBindings: parseSecretBindings(row.secret_bindings_json),
        createdBy: row.version_created_by,
        createdAt: row.version_created_at,
      },
    };
  }

  async listVersions(
    environmentId: string,
    projectIds?: readonly string[],
  ): Promise<ExecutionEnvironmentVersion[]> {
    await this.handle.ready;
    if (projectIds?.length === 0) return [];
    const result = projectIds
      ? await this.handle.pool.query<VersionRow>(
          `SELECT v.* FROM execution_environment_versions v
           JOIN execution_environments e ON e.id = v.environment_id
           WHERE v.environment_id = $1 AND e.project_id = ANY($2::text[])
           ORDER BY v.version DESC`,
          [environmentId, [...projectIds]],
        )
      : await this.handle.pool.query<VersionRow>(
          `SELECT * FROM execution_environment_versions
           WHERE environment_id = $1 ORDER BY version DESC`,
          [environmentId],
        );
    return result.rows.map(mapVersion);
  }

  async listReferences(
    environmentId: string,
    projectIds?: readonly string[],
    limit = 100,
  ): Promise<{ items: ExecutionEnvironmentReference[]; total: number }> {
    await this.handle.ready;
    if (projectIds?.length === 0) return { items: [], total: 0 };
    const scope = projectIds ? "AND project_id = ANY($2::text[])" : "";
    const parameters = projectIds ? [environmentId, [...projectIds]] : [environmentId];
    const countResult = await this.handle.pool.query<{ total: string }>(
      `SELECT COUNT(*) AS total FROM run_batches WHERE environment_id = $1 ${scope}`,
      parameters,
    );
    const limitIndex = projectIds ? 3 : 2;
    const result = await this.handle.pool.query<
      QueryResultRow & {
        id: string;
        environment_version_id: string;
        suite_name: string;
        status: ExecutionEnvironmentReference["status"];
        created_at: string;
      }
    >(
      `SELECT id, environment_version_id, suite_name, status, created_at
       FROM run_batches WHERE environment_id = $1 ${scope}
       ORDER BY created_at DESC, id DESC LIMIT $${limitIndex}`,
      [...parameters, limit],
    );
    return {
      total: Number(countResult.rows[0]?.total ?? 0),
      items: result.rows.map((row) => ({
        batchId: row.id,
        environmentVersionId: row.environment_version_id,
        suiteName: row.suite_name,
        status: row.status,
        createdAt: new Date(row.created_at).toISOString(),
      })),
    };
  }

  async update(record: UpdateExecutionEnvironmentRecord): Promise<ExecutionEnvironmentDetails> {
    await this.handle.ready;
    try {
      return await this.transaction(async (client) => {
        const current = await requiredRow(client, record.environmentId, true);
        if (current.revision !== record.expectedRevision) throw revisionConflict();
        const nextVersion = record.nextVersion
          ? current.current_version + 1
          : current.current_version;
        const update = await client.query(
          `UPDATE execution_environments
           SET name = $1, normalized_name = $2, description = $3, current_version = $4,
               revision = revision + 1, updated_at = $5
           WHERE id = $6 AND revision = $7`,
          [
            record.name ?? current.name,
            record.normalizedName ?? normalizeStoredName(current.name),
            record.description ?? current.description,
            nextVersion,
            record.recordedAt,
            record.environmentId,
            record.expectedRevision,
          ],
        );
        if (update.rowCount !== 1) throw revisionConflict();
        if (record.nextVersion) {
          const currentVersion = await requiredVersion(
            client,
            record.environmentId,
            current.current_version,
          );
          await insertVersion(client, {
            id: record.nextVersion.id,
            environmentId: record.environmentId,
            version: nextVersion,
            variables:
              record.nextVersion.variables ?? parseVariables(currentVersion.variables_json),
            secretBindings: record.nextVersion.secretBindings
              ? await resolveSecretBindings(
                  client,
                  current.project_id,
                  record.nextVersion.secretBindings,
                )
              : parseSecretBindings(currentVersion.secret_bindings_json),
            actorId: record.actorId,
            recordedAt: record.recordedAt,
          });
        }
        return requiredDetails(client, record.environmentId);
      });
    } catch (error) {
      throw mapEnvironmentWriteError(error);
    }
  }

  async assertSecretsAvailableForExecution(
    projectId: string,
    bindings: readonly ExecutionEnvironmentSecretBinding[],
  ): Promise<void> {
    if ((await this.findUnavailableSecretsForExecution(projectId, bindings)).length > 0) {
      throw new DomainError("EXECUTION_SECRET_UNAVAILABLE", "执行环境引用的密文不可用或已撤销。");
    }
  }

  async findUnavailableSecretsForExecution(
    projectId: string,
    bindings: readonly ExecutionEnvironmentSecretBinding[],
  ): Promise<ExecutionEnvironmentSecretBinding[]> {
    await this.handle.ready;
    const unavailable: ExecutionEnvironmentSecretBinding[] = [];
    for (const binding of bindings) {
      const result = await this.handle.pool.query(
        `SELECT 1
         FROM execution_secret_versions v
         JOIN execution_secrets s ON s.id = v.secret_id
         WHERE s.id = $1 AND s.project_id = $2 AND s.status = 'active' AND v.id = $3`,
        [binding.secretId, projectId, binding.secretVersionId],
      );
      if (!result.rows[0]) {
        unavailable.push(binding);
      }
    }
    return unavailable;
  }

  async setStatus(
    input: Parameters<ExecutionEnvironmentRepository["setStatus"]>[0],
  ): Promise<ExecutionEnvironmentDetails> {
    await this.handle.ready;
    return this.transaction(async (client) => {
      const update = await client.query(
        `UPDATE execution_environments SET status = $1, revision = revision + 1, updated_at = $2
         WHERE id = $3 AND revision = $4`,
        [input.status, input.recordedAt, input.environmentId, input.expectedRevision],
      );
      if (update.rowCount !== 1) {
        const existing = await client.query("SELECT 1 FROM execution_environments WHERE id = $1", [
          input.environmentId,
        ]);
        if (!existing.rows[0]) {
          throw new DomainError("EXECUTION_ENVIRONMENT_NOT_FOUND", "指定的执行环境不存在。");
        }
        throw revisionConflict();
      }
      return requiredDetails(client, input.environmentId);
    });
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.handle.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
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

async function requiredDetails(
  client: Pick<PoolClient, "query">,
  environmentId: string,
): Promise<ExecutionEnvironmentDetails> {
  const environment = await requiredRow(client, environmentId);
  return details(client, environment);
}

async function details(
  client: Pick<PoolClient, "query">,
  environment: EnvironmentRow,
): Promise<ExecutionEnvironmentDetails> {
  const result = await client.query<VersionRow>(
    "SELECT * FROM execution_environment_versions WHERE environment_id = $1 AND version = $2",
    [environment.id, environment.current_version],
  );
  const version = result.rows[0];
  if (!version) throw new Error(`Execution environment ${environment.id} has no current version.`);
  return { ...mapEnvironment(environment), current: mapVersion(version) };
}

async function requiredRow(
  client: Pick<PoolClient, "query">,
  environmentId: string,
  lock = false,
): Promise<EnvironmentRow> {
  const result = await client.query<EnvironmentRow>(
    `SELECT * FROM execution_environments WHERE id = $1${lock ? " FOR UPDATE" : ""}`,
    [environmentId],
  );
  const row = result.rows[0];
  if (!row) throw new DomainError("EXECUTION_ENVIRONMENT_NOT_FOUND", "指定的执行环境不存在。");
  return row;
}

async function insertVersion(
  client: Pick<PoolClient, "query">,
  input: {
    id: string;
    environmentId: string;
    version: number;
    variables: ExecutionEnvironmentVariable[];
    secretBindings: ExecutionEnvironmentSecretBinding[];
    actorId: string;
    recordedAt: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO execution_environment_versions
     (id, environment_id, version, variables_json, secret_bindings_json, created_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.id,
      input.environmentId,
      input.version,
      JSON.stringify(input.variables),
      JSON.stringify(input.secretBindings),
      input.actorId,
      input.recordedAt,
    ],
  );
}

async function requiredVersion(
  client: Pick<PoolClient, "query">,
  environmentId: string,
  version: number,
): Promise<VersionRow> {
  const result = await client.query<VersionRow>(
    "SELECT * FROM execution_environment_versions WHERE environment_id = $1 AND version = $2",
    [environmentId, version],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`Execution environment ${environmentId} has no version ${version}.`);
  return row;
}

async function resolveSecretBindings(
  client: Pick<PoolClient, "query">,
  projectId: string,
  bindings: Array<{ name: string; secretId: string; secretVersionId?: string }>,
): Promise<ExecutionEnvironmentSecretBinding[]> {
  const resolved: ExecutionEnvironmentSecretBinding[] = [];
  for (const binding of bindings) {
    const versionClause = binding.secretVersionId
      ? "AND v.id = $3"
      : "AND v.version = s.current_version";
    const result = await client.query<{ status: "active" | "disabled"; version_id: string }>(
      `SELECT s.status, v.id AS version_id
       FROM execution_secrets s
       JOIN execution_secret_versions v
         ON v.secret_id = s.id
       WHERE s.id = $1 AND s.project_id = $2 ${versionClause}`,
      [binding.secretId, projectId, ...(binding.secretVersionId ? [binding.secretVersionId] : [])],
    );
    const row = result.rows[0];
    if (!row) throw new DomainError("EXECUTION_SECRET_NOT_FOUND", "指定的执行密文不存在。");
    if (row.status !== "active") {
      throw new DomainError("EXECUTION_SECRET_DISABLED", "已停用的执行密文不能加入环境版本。");
    }
    resolved.push({
      name: binding.name,
      secretId: binding.secretId,
      secretVersionId: row.version_id,
    });
  }
  return resolved;
}

function mapEnvironment(row: EnvironmentRow): ExecutionEnvironment {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description,
    status: row.status,
    currentVersion: Number(row.current_version),
    revision: Number(row.revision),
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function mapVersion(row: VersionRow): ExecutionEnvironmentVersion {
  return {
    id: row.id,
    environmentId: row.environment_id,
    version: Number(row.version),
    variables: parseVariables(row.variables_json),
    secretBindings: parseSecretBindings(row.secret_bindings_json),
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function parseSecretBindings(
  value: string | ExecutionEnvironmentSecretBinding[],
): ExecutionEnvironmentSecretBinding[] {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) throw new Error("Stored execution secret bindings are invalid.");
  return parsed.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as { name?: unknown }).name !== "string" ||
      typeof (entry as { secretId?: unknown }).secretId !== "string" ||
      typeof (entry as { secretVersionId?: unknown }).secretVersionId !== "string"
    ) {
      throw new Error("Stored execution secret binding is invalid.");
    }
    return {
      name: (entry as { name: string }).name,
      secretId: (entry as { secretId: string }).secretId,
      secretVersionId: (entry as { secretVersionId: string }).secretVersionId,
    };
  });
}

function parseVariables(
  value: string | ExecutionEnvironmentVariable[],
): ExecutionEnvironmentVariable[] {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed))
    throw new Error("Stored execution environment variables are invalid.");
  return parsed.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as { name?: unknown }).name !== "string" ||
      typeof (entry as { value?: unknown }).value !== "string"
    ) {
      throw new Error("Stored execution environment variable is invalid.");
    }
    return { name: (entry as { name: string }).name, value: (entry as { value: string }).value };
  });
}

function normalizeStoredName(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function revisionConflict(): DomainError {
  return new DomainError("EXECUTION_ENVIRONMENT_VERSION_CONFLICT", "执行环境已被并发修改。");
}

function mapEnvironmentWriteError(error: unknown): Error {
  if (error instanceof DomainError) return error;
  if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
    return new DomainError("EXECUTION_ENVIRONMENT_NAME_CONFLICT", "项目内执行环境名称不能重复。", {
      cause: error,
    });
  }
  return new Error("无法保存执行环境。", { cause: error });
}
