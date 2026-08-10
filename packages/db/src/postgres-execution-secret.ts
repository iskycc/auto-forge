import type {
  CreateExecutionSecretRecord,
  ExecutionSecretRepository,
} from "@autoforge/application";
import { DomainError, type ExecutionSecret } from "@autoforge/domain";
import type { PoolClient, QueryResultRow } from "pg";

import type { PostgresDatabaseHandle } from "./postgres-database";

type SecretRow = QueryResultRow & {
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

export class PostgresExecutionSecretRepository implements ExecutionSecretRepository {
  constructor(private readonly handle: PostgresDatabaseHandle) {}

  async create(record: CreateExecutionSecretRecord): Promise<ExecutionSecret> {
    await this.handle.ready;
    try {
      return await this.transaction(async (client) => {
        await client.query(
          `INSERT INTO execution_secrets
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
          secretId: record.id,
          version: 1,
          valueEncrypted: record.valueEncrypted,
          actorId: record.actorId,
          recordedAt: record.recordedAt,
        });
        return mapSecret(await requiredRow(client, record.id));
      });
    } catch (error) {
      throw mapSecretWriteError(error);
    }
  }

  async list(projectIds?: readonly string[]): Promise<ExecutionSecret[]> {
    await this.handle.ready;
    if (projectIds?.length === 0) return [];
    const result = projectIds
      ? await this.handle.pool.query<SecretRow>(
          "SELECT * FROM execution_secrets WHERE project_id = ANY($1::text[]) ORDER BY name, id",
          [[...projectIds]],
        )
      : await this.handle.pool.query<SecretRow>(
          "SELECT * FROM execution_secrets ORDER BY name, id",
        );
    return result.rows.map(mapSecret);
  }

  async get(secretId: string, projectIds?: readonly string[]): Promise<ExecutionSecret | null> {
    await this.handle.ready;
    if (projectIds?.length === 0) return null;
    const result = projectIds
      ? await this.handle.pool.query<SecretRow>(
          "SELECT * FROM execution_secrets WHERE id = $1 AND project_id = ANY($2::text[])",
          [secretId, [...projectIds]],
        )
      : await this.handle.pool.query<SecretRow>("SELECT * FROM execution_secrets WHERE id = $1", [
          secretId,
        ]);
    return result.rows[0] ? mapSecret(result.rows[0]) : null;
  }

  async rotate(
    input: Parameters<ExecutionSecretRepository["rotate"]>[0],
  ): Promise<ExecutionSecret> {
    await this.handle.ready;
    return this.transaction(async (client) => {
      const current = await requiredRow(client, input.secretId, true);
      if (Number(current.revision) !== input.expectedRevision) throw secretRevisionConflict();
      const nextVersion = Number(current.current_version) + 1;
      const update = await client.query(
        `UPDATE execution_secrets
         SET current_version = $1, revision = revision + 1, updated_at = $2
         WHERE id = $3 AND revision = $4`,
        [nextVersion, input.recordedAt, input.secretId, input.expectedRevision],
      );
      if (update.rowCount !== 1) throw secretRevisionConflict();
      await insertVersion(client, {
        id: input.versionId,
        secretId: input.secretId,
        version: nextVersion,
        valueEncrypted: input.valueEncrypted,
        actorId: input.actorId,
        recordedAt: input.recordedAt,
      });
      return mapSecret(await requiredRow(client, input.secretId));
    });
  }

  async setStatus(
    input: Parameters<ExecutionSecretRepository["setStatus"]>[0],
  ): Promise<ExecutionSecret> {
    await this.handle.ready;
    return this.transaction(async (client) => {
      const update = await client.query(
        `UPDATE execution_secrets SET status = $1, revision = revision + 1, updated_at = $2
         WHERE id = $3 AND revision = $4`,
        [input.status, input.recordedAt, input.secretId, input.expectedRevision],
      );
      if (update.rowCount !== 1) {
        const existing = await client.query("SELECT 1 FROM execution_secrets WHERE id = $1", [
          input.secretId,
        ]);
        if (!existing.rows[0]) {
          throw new DomainError("EXECUTION_SECRET_NOT_FOUND", "指定的执行密文不存在。");
        }
        throw secretRevisionConflict();
      }
      return mapSecret(await requiredRow(client, input.secretId));
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

async function requiredRow(
  client: Pick<PoolClient, "query">,
  secretId: string,
  lock = false,
): Promise<SecretRow> {
  const result = await client.query<SecretRow>(
    `SELECT * FROM execution_secrets WHERE id = $1${lock ? " FOR UPDATE" : ""}`,
    [secretId],
  );
  const row = result.rows[0];
  if (!row) throw new DomainError("EXECUTION_SECRET_NOT_FOUND", "指定的执行密文不存在。");
  return row;
}

async function insertVersion(
  client: Pick<PoolClient, "query">,
  input: {
    id: string;
    secretId: string;
    version: number;
    valueEncrypted: string;
    actorId: string;
    recordedAt: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO execution_secret_versions
     (id, secret_id, version, value_encrypted, created_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.id,
      input.secretId,
      input.version,
      input.valueEncrypted,
      input.actorId,
      input.recordedAt,
    ],
  );
}

function mapSecret(row: SecretRow): ExecutionSecret {
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

function secretRevisionConflict(): DomainError {
  return new DomainError("EXECUTION_SECRET_VERSION_CONFLICT", "执行密文已被并发修改。");
}

function mapSecretWriteError(error: unknown): Error {
  if (error instanceof DomainError) return error;
  if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
    return new DomainError("EXECUTION_SECRET_NAME_CONFLICT", "项目内执行密文名称不能重复。", {
      cause: error,
    });
  }
  return new Error("无法保存执行密文。", { cause: error });
}
