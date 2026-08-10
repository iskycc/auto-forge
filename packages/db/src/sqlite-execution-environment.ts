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

import type { SqliteDatabaseHandle } from "./database";

type EnvironmentRow = {
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

type VersionRow = {
  id: string;
  environment_id: string;
  version: number;
  variables_json: string;
  secret_bindings_json: string;
  created_by: string;
  created_at: string;
};

export class SqliteExecutionEnvironmentRepository implements ExecutionEnvironmentRepository {
  constructor(private readonly handle: SqliteDatabaseHandle) {}

  async create(record: CreateExecutionEnvironmentRecord): Promise<ExecutionEnvironmentDetails> {
    try {
      return this.handle.client.transaction(() => {
        this.handle.client
          .prepare(
            `INSERT INTO execution_environments
             (id, project_id, name, normalized_name, description, status, current_version,
              revision, created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'active', 1, 1, ?, ?, ?)`,
          )
          .run(
            record.id,
            record.projectId,
            record.name,
            record.normalizedName,
            record.description,
            record.actorId,
            record.recordedAt,
            record.recordedAt,
          );
        this.insertVersion({
          id: record.versionId,
          environmentId: record.id,
          version: 1,
          variables: record.variables,
          secretBindings: this.resolveSecretBindings(record.projectId, record.secretBindings),
          actorId: record.actorId,
          recordedAt: record.recordedAt,
        });
        return this.required(record.id);
      })();
    } catch (error) {
      throw mapEnvironmentWriteError(error);
    }
  }

  async list(projectIds?: readonly string[]): Promise<ExecutionEnvironment[]> {
    if (projectIds?.length === 0) return [];
    const scope = projectIds ? `WHERE project_id IN (${projectIds.map(() => "?").join(", ")})` : "";
    return (
      this.handle.client
        .prepare(`SELECT * FROM execution_environments ${scope} ORDER BY name, id`)
        .all(...(projectIds ?? [])) as EnvironmentRow[]
    ).map(mapEnvironment);
  }

  async get(
    environmentId: string,
    projectIds?: readonly string[],
  ): Promise<ExecutionEnvironmentDetails | null> {
    if (projectIds?.length === 0) return null;
    const scope = projectIds ? `AND project_id IN (${projectIds.map(() => "?").join(", ")})` : "";
    const row = this.handle.client
      .prepare(`SELECT * FROM execution_environments WHERE id = ? ${scope}`)
      .get(environmentId, ...(projectIds ?? [])) as EnvironmentRow | undefined;
    return row ? this.details(row) : null;
  }

  async getVersion(versionId: string, projectId: string) {
    const row = this.handle.client
      .prepare(
        `SELECT e.*, v.id AS version_id, v.environment_id, v.version AS selected_version,
         v.variables_json, v.secret_bindings_json,
         v.created_by AS version_created_by, v.created_at AS version_created_at
         FROM execution_environment_versions v
         JOIN execution_environments e ON e.id = v.environment_id
         WHERE v.id = ? AND e.project_id = ?`,
      )
      .get(versionId, projectId) as
      | (EnvironmentRow & {
          version_id: string;
          environment_id: string;
          selected_version: number;
          variables_json: string;
          secret_bindings_json: string;
          version_created_by: string;
          version_created_at: string;
        })
      | undefined;
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
    if (projectIds?.length === 0) return [];
    const scope = projectIds ? `AND e.project_id IN (${projectIds.map(() => "?").join(", ")})` : "";
    const rows = this.handle.client
      .prepare(
        `SELECT v.* FROM execution_environment_versions v
         JOIN execution_environments e ON e.id = v.environment_id
         WHERE v.environment_id = ? ${scope}
         ORDER BY v.version DESC`,
      )
      .all(environmentId, ...(projectIds ?? [])) as VersionRow[];
    return rows.map(mapVersion);
  }

  async listReferences(
    environmentId: string,
    projectIds?: readonly string[],
    limit = 100,
  ): Promise<{ items: ExecutionEnvironmentReference[]; total: number }> {
    if (projectIds?.length === 0) return { items: [], total: 0 };
    const scope = projectIds ? `AND project_id IN (${projectIds.map(() => "?").join(", ")})` : "";
    const parameters = [environmentId, ...(projectIds ?? [])];
    const total = this.handle.client
      .prepare(`SELECT COUNT(*) AS total FROM run_batches WHERE environment_id = ? ${scope}`)
      .get(...parameters) as { total: number };
    const rows = this.handle.client
      .prepare(
        `SELECT id, environment_version_id, suite_name, status, created_at
         FROM run_batches WHERE environment_id = ? ${scope}
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...parameters, limit) as Array<{
      id: string;
      environment_version_id: string;
      suite_name: string;
      status: ExecutionEnvironmentReference["status"];
      created_at: string;
    }>;
    return {
      total: total.total,
      items: rows.map((row) => ({
        batchId: row.id,
        environmentVersionId: row.environment_version_id,
        suiteName: row.suite_name,
        status: row.status,
        createdAt: row.created_at,
      })),
    };
  }

  async update(record: UpdateExecutionEnvironmentRecord): Promise<ExecutionEnvironmentDetails> {
    try {
      return this.handle.client.transaction(() => {
        const current = this.requiredRow(record.environmentId);
        if (current.revision !== record.expectedRevision) {
          throw revisionConflict();
        }
        const nextVersion = record.nextVersion
          ? current.current_version + 1
          : current.current_version;
        const update = this.handle.client
          .prepare(
            `UPDATE execution_environments
             SET name = ?, normalized_name = ?, description = ?, current_version = ?,
                 revision = revision + 1, updated_at = ?
             WHERE id = ? AND revision = ?`,
          )
          .run(
            record.name ?? current.name,
            record.normalizedName ?? normalizeStoredName(current.name),
            record.description ?? current.description,
            nextVersion,
            record.recordedAt,
            record.environmentId,
            record.expectedRevision,
          );
        if (update.changes !== 1) throw revisionConflict();
        if (record.nextVersion) {
          const currentVersion = this.requiredVersion(
            record.environmentId,
            current.current_version,
          );
          this.insertVersion({
            id: record.nextVersion.id,
            environmentId: record.environmentId,
            version: nextVersion,
            variables:
              record.nextVersion.variables ?? parseVariables(currentVersion.variables_json),
            secretBindings: record.nextVersion.secretBindings
              ? this.resolveSecretBindings(current.project_id, record.nextVersion.secretBindings)
              : parseSecretBindings(currentVersion.secret_bindings_json),
            actorId: record.actorId,
            recordedAt: record.recordedAt,
          });
        }
        return this.required(record.environmentId);
      })();
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
    return bindings.filter((binding) => {
      const available = this.handle.client
        .prepare(
          `SELECT 1 AS available
           FROM execution_secret_versions v
           JOIN execution_secrets s ON s.id = v.secret_id
           WHERE s.id = ? AND s.project_id = ? AND s.status = 'active' AND v.id = ?`,
        )
        .get(binding.secretId, projectId, binding.secretVersionId) as
        { available: number } | undefined;
      return !available;
    });
  }

  async setStatus(
    input: Parameters<ExecutionEnvironmentRepository["setStatus"]>[0],
  ): Promise<ExecutionEnvironmentDetails> {
    const update = this.handle.client
      .prepare(
        `UPDATE execution_environments SET status = ?, revision = revision + 1, updated_at = ?
         WHERE id = ? AND revision = ?`,
      )
      .run(input.status, input.recordedAt, input.environmentId, input.expectedRevision);
    if (update.changes !== 1) {
      if (!this.findRow(input.environmentId)) {
        throw new DomainError("EXECUTION_ENVIRONMENT_NOT_FOUND", "指定的执行环境不存在。");
      }
      throw revisionConflict();
    }
    return this.required(input.environmentId);
  }

  private details(row: EnvironmentRow): ExecutionEnvironmentDetails {
    const version = this.handle.client
      .prepare(
        "SELECT * FROM execution_environment_versions WHERE environment_id = ? AND version = ?",
      )
      .get(row.id, row.current_version) as VersionRow | undefined;
    if (!version) throw new Error(`Execution environment ${row.id} has no current version.`);
    return { ...mapEnvironment(row), current: mapVersion(version) };
  }

  private required(environmentId: string): ExecutionEnvironmentDetails {
    return this.details(this.requiredRow(environmentId));
  }

  private requiredRow(environmentId: string): EnvironmentRow {
    const row = this.findRow(environmentId);
    if (!row) {
      throw new DomainError("EXECUTION_ENVIRONMENT_NOT_FOUND", "指定的执行环境不存在。");
    }
    return row;
  }

  private findRow(environmentId: string): EnvironmentRow | undefined {
    return this.handle.client
      .prepare("SELECT * FROM execution_environments WHERE id = ?")
      .get(environmentId) as EnvironmentRow | undefined;
  }

  private insertVersion(input: {
    id: string;
    environmentId: string;
    version: number;
    variables: ExecutionEnvironmentVariable[];
    secretBindings: ExecutionEnvironmentSecretBinding[];
    actorId: string;
    recordedAt: string;
  }): void {
    this.handle.client
      .prepare(
        `INSERT INTO execution_environment_versions
         (id, environment_id, version, variables_json, secret_bindings_json, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.environmentId,
        input.version,
        JSON.stringify(input.variables),
        JSON.stringify(input.secretBindings),
        input.actorId,
        input.recordedAt,
      );
  }

  private requiredVersion(environmentId: string, version: number): VersionRow {
    const row = this.handle.client
      .prepare(
        "SELECT * FROM execution_environment_versions WHERE environment_id = ? AND version = ?",
      )
      .get(environmentId, version) as VersionRow | undefined;
    if (!row) throw new Error(`Execution environment ${environmentId} has no version ${version}.`);
    return row;
  }

  private resolveSecretBindings(
    projectId: string,
    bindings: Array<{ name: string; secretId: string; secretVersionId?: string }>,
  ): ExecutionEnvironmentSecretBinding[] {
    return bindings.map((binding) => {
      const versionClause = binding.secretVersionId
        ? "AND v.id = ?"
        : "AND v.version = s.current_version";
      const row = this.handle.client
        .prepare(
          `SELECT s.status, v.id AS version_id
           FROM execution_secrets s
           JOIN execution_secret_versions v
             ON v.secret_id = s.id
           WHERE s.id = ? AND s.project_id = ? ${versionClause}`,
        )
        .get(
          binding.secretId,
          projectId,
          ...(binding.secretVersionId ? [binding.secretVersionId] : []),
        ) as { status: "active" | "disabled"; version_id: string } | undefined;
      if (!row) {
        throw new DomainError("EXECUTION_SECRET_NOT_FOUND", "指定的执行密文不存在。");
      }
      if (row.status !== "active") {
        throw new DomainError("EXECUTION_SECRET_DISABLED", "已停用的执行密文不能加入环境版本。");
      }
      return {
        name: binding.name,
        secretId: binding.secretId,
        secretVersionId: row.version_id,
      };
    });
  }
}

function mapEnvironment(row: EnvironmentRow): ExecutionEnvironment {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description,
    status: row.status,
    currentVersion: row.current_version,
    revision: row.revision,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapVersion(row: VersionRow): ExecutionEnvironmentVersion {
  return {
    id: row.id,
    environmentId: row.environment_id,
    version: row.version,
    variables: parseVariables(row.variables_json),
    secretBindings: parseSecretBindings(row.secret_bindings_json),
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function parseSecretBindings(value: string): ExecutionEnvironmentSecretBinding[] {
  const parsed: unknown = JSON.parse(value);
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

function parseVariables(value: string): ExecutionEnvironmentVariable[] {
  const parsed: unknown = JSON.parse(value);
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
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "SQLITE_CONSTRAINT_UNIQUE"
  ) {
    return new DomainError("EXECUTION_ENVIRONMENT_NAME_CONFLICT", "项目内执行环境名称不能重复。", {
      cause: error,
    });
  }
  return new Error("无法保存执行环境。", { cause: error });
}
