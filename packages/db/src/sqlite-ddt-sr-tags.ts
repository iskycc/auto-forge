import {
  srTagImportStatements,
  srTagExistingKeysStatement,
  assertImportSrsExist,
} from "./ddt-sr-tag-import";
import { DomainError } from "@autoforge/domain";
import { SqlDdtSrTagRepository, type SrTagSql } from "./ddt-sr-tags";
import {
  retrySqliteLockContention,
  runSqliteWriteTransaction,
  type SqliteDatabaseHandle,
} from "./database";
import { VERSION_COPY_RESERVED } from "./version-copy-target";
export class SqliteDdtSrTagRepository extends SqlDdtSrTagRepository {
  constructor(handle: SqliteDatabaseHandle) {
    const query = <T extends Record<string, unknown>>(sql: string, values: (string | number)[]) =>
      handle.client.prepare(sql).all(...values) as T[];
    const read: SrTagSql = (sql, values) => retrySqliteLockContention(() => query(sql, values));
    const transaction = <T>(
      scope: import("@autoforge/contracts").DdtSrTagScope,
      operation: () => T,
    ): Promise<T> =>
      retrySqliteLockContention(() =>
        runSqliteWriteTransaction(handle, () => {
          if (
            !handle.client
              .prepare("SELECT id FROM project_versions WHERE id=? AND project_id=?")
              .get(scope.projectVersionId, scope.projectId)
          )
            throw new DomainError("PROJECT_VERSION_NOT_FOUND", "项目版本不存在。");
          if (
            handle.client
              .prepare(
                `SELECT id FROM project_version_copies WHERE target_version_id=? AND ${VERSION_COPY_RESERVED} LIMIT 1`,
              )
              .get(scope.projectVersionId)
          )
            throw new DomainError(
              "VERSION_COPY_TARGET_RESERVED",
              "目标版本正在复制或等待清理，暂不能修改标签。",
            );
          return operation();
        }),
      );
    super(
      read,
      "sqlite",
      (scope, sql, values) => transaction(scope, () => query(sql, values)),
      (scope, rows, recordedAt) =>
        transaction(scope, () => {
          if (!rows.length) return 0;
          const validation = srTagExistingKeysStatement(scope, [
            ...new Set(rows.map((row) => row.srNum)),
          ]);
          assertImportSrsExist(rows, query<{ key: string }>(validation.sql, validation.values));
          const statements = srTagImportStatements(scope, rows, recordedAt);
          query(statements.tags.sql, statements.tags.values);
          return query(statements.assignments.sql, statements.assignments.values).length;
        }),
    );
  }
}
