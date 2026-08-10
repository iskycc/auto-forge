import type {
  CreateExecutionSecretRecord,
  ExecutionSecretRepository,
} from "@autoforge/application";
import { DomainError, type ExecutionSecret } from "@autoforge/domain";

import type { SqliteDatabaseHandle } from "./database";

type SecretRow = {
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

export class SqliteExecutionSecretRepository implements ExecutionSecretRepository {
  constructor(private readonly handle: SqliteDatabaseHandle) {}

  async create(record: CreateExecutionSecretRecord): Promise<ExecutionSecret> {
    try {
      return this.handle.client.transaction(() => {
        this.handle.client
          .prepare(
            `INSERT INTO execution_secrets
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
          secretId: record.id,
          version: 1,
          valueEncrypted: record.valueEncrypted,
          actorId: record.actorId,
          recordedAt: record.recordedAt,
        });
        return this.required(record.id);
      })();
    } catch (error) {
      throw mapSecretWriteError(error);
    }
  }

  async list(projectIds?: readonly string[]): Promise<ExecutionSecret[]> {
    if (projectIds?.length === 0) return [];
    const scope = projectIds ? `WHERE project_id IN (${projectIds.map(() => "?").join(", ")})` : "";
    return (
      this.handle.client
        .prepare(`SELECT * FROM execution_secrets ${scope} ORDER BY name, id`)
        .all(...(projectIds ?? [])) as SecretRow[]
    ).map(mapSecret);
  }

  async get(secretId: string, projectIds?: readonly string[]): Promise<ExecutionSecret | null> {
    if (projectIds?.length === 0) return null;
    const scope = projectIds ? `AND project_id IN (${projectIds.map(() => "?").join(", ")})` : "";
    const row = this.handle.client
      .prepare(`SELECT * FROM execution_secrets WHERE id = ? ${scope}`)
      .get(secretId, ...(projectIds ?? [])) as SecretRow | undefined;
    return row ? mapSecret(row) : null;
  }

  async rotate(
    input: Parameters<ExecutionSecretRepository["rotate"]>[0],
  ): Promise<ExecutionSecret> {
    return this.handle.client.transaction(() => {
      const current = this.requiredRow(input.secretId);
      if (current.revision !== input.expectedRevision) throw secretRevisionConflict();
      const nextVersion = current.current_version + 1;
      const update = this.handle.client
        .prepare(
          `UPDATE execution_secrets
           SET current_version = ?, revision = revision + 1, updated_at = ?
           WHERE id = ? AND revision = ?`,
        )
        .run(nextVersion, input.recordedAt, input.secretId, input.expectedRevision);
      if (update.changes !== 1) throw secretRevisionConflict();
      this.insertVersion({
        id: input.versionId,
        secretId: input.secretId,
        version: nextVersion,
        valueEncrypted: input.valueEncrypted,
        actorId: input.actorId,
        recordedAt: input.recordedAt,
      });
      return this.required(input.secretId);
    })();
  }

  async setStatus(
    input: Parameters<ExecutionSecretRepository["setStatus"]>[0],
  ): Promise<ExecutionSecret> {
    const update = this.handle.client
      .prepare(
        `UPDATE execution_secrets SET status = ?, revision = revision + 1, updated_at = ?
         WHERE id = ? AND revision = ?`,
      )
      .run(input.status, input.recordedAt, input.secretId, input.expectedRevision);
    if (update.changes !== 1) {
      if (!this.findRow(input.secretId)) {
        throw new DomainError("EXECUTION_SECRET_NOT_FOUND", "指定的执行密文不存在。");
      }
      throw secretRevisionConflict();
    }
    return this.required(input.secretId);
  }

  private insertVersion(input: {
    id: string;
    secretId: string;
    version: number;
    valueEncrypted: string;
    actorId: string;
    recordedAt: string;
  }): void {
    this.handle.client
      .prepare(
        `INSERT INTO execution_secret_versions
         (id, secret_id, version, value_encrypted, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.secretId,
        input.version,
        input.valueEncrypted,
        input.actorId,
        input.recordedAt,
      );
  }

  private required(secretId: string): ExecutionSecret {
    return mapSecret(this.requiredRow(secretId));
  }

  private requiredRow(secretId: string): SecretRow {
    const row = this.findRow(secretId);
    if (!row) throw new DomainError("EXECUTION_SECRET_NOT_FOUND", "指定的执行密文不存在。");
    return row;
  }

  private findRow(secretId: string): SecretRow | undefined {
    return this.handle.client
      .prepare("SELECT * FROM execution_secrets WHERE id = ?")
      .get(secretId) as SecretRow | undefined;
  }
}

function mapSecret(row: SecretRow): ExecutionSecret {
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

function secretRevisionConflict(): DomainError {
  return new DomainError("EXECUTION_SECRET_VERSION_CONFLICT", "执行密文已被并发修改。");
}

function mapSecretWriteError(error: unknown): Error {
  if (error instanceof DomainError) return error;
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "SQLITE_CONSTRAINT_UNIQUE"
  ) {
    return new DomainError("EXECUTION_SECRET_NAME_CONFLICT", "项目内执行密文名称不能重复。", {
      cause: error,
    });
  }
  return new Error("无法保存执行密文。", { cause: error });
}
