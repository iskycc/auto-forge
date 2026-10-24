import {
  srTagImportStatements,
  srTagExistingKeysStatement,
  assertImportSrsExist,
} from "./ddt-sr-tag-import";
import { DomainError } from "@autoforge/domain";
import { SqlDdtSrTagRepository, type SrTagSql } from "./ddt-sr-tags";
import { runPostgresTransaction, retryPostgresWrite } from "./postgres-transaction";
import { VERSION_COPY_RESERVED } from "./version-copy-target";
import type { PostgresDatabaseHandle } from "./postgres-database";
export class PostgresDdtSrTagRepository extends SqlDdtSrTagRepository {
  constructor(handle: PostgresDatabaseHandle) {
    const read: SrTagSql = async (sql, values) => {
      await handle.ready;
      return retryPostgresWrite(async () => (await handle.pool.query(bind(sql), values)).rows);
    };
    const transaction = async <T>(
      scope: import("@autoforge/contracts").DdtSrTagScope,
      operation: (client: import("pg").PoolClient) => Promise<T>,
    ): Promise<T> => {
      await handle.ready;
      return runPostgresTransaction(handle, async (client) => {
        // Use the same version row lock as version-copy reservations and stage/configuration writes.
        if (
          !(
            await client.query(
              "SELECT id FROM project_versions WHERE id=$1 AND project_id=$2 FOR UPDATE",
              [scope.projectVersionId, scope.projectId],
            )
          ).rowCount
        )
          throw new DomainError("PROJECT_VERSION_NOT_FOUND", "项目版本不存在。");
        if (
          (
            await client.query(
              `SELECT id FROM project_version_copies WHERE target_version_id=$1 AND ${VERSION_COPY_RESERVED} LIMIT 1`,
              [scope.projectVersionId],
            )
          ).rowCount
        )
          throw new DomainError(
            "VERSION_COPY_TARGET_RESERVED",
            "目标版本正在复制或等待清理，暂不能修改标签。",
          );
        return operation(client);
      });
    };
    super(
      read,
      "postgres",
      (scope, sql, values) =>
        transaction(scope, async (client) => (await client.query(bind(sql), values)).rows),
      (scope, rows, recordedAt) =>
        transaction(scope, async (client) => {
          if (!rows.length) return 0;
          const validation = srTagExistingKeysStatement(scope, [
            ...new Set(rows.map((row) => row.srNum)),
          ]);
          assertImportSrsExist(
            rows,
            (await client.query<{ key: string }>(bind(validation.sql), validation.values)).rows,
          );
          const statements = srTagImportStatements(scope, rows, recordedAt);
          await client.query(bind(statements.tags.sql), statements.tags.values);
          return (
            await client.query(bind(statements.assignments.sql), statements.assignments.values)
          ).rows.length;
        }),
    );
  }
}
function bind(sql: string) {
  let index = 0;
  return sql.replaceAll("?", () => `$${++index}`);
}
