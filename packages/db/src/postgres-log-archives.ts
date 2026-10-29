import type { PostgresDatabaseHandle } from "./postgres-database";
import { DatabaseLogArchiveRepository } from "./log-archive-repository";
export class PostgresLogArchiveRepository extends DatabaseLogArchiveRepository {
  constructor(handle: PostgresDatabaseHandle) {
    super({
      jsonText: (column, key) => `(${column}::jsonb ->> '${key}')`,
      rows: async <T>(sql: string, parameters: readonly unknown[] = []) => {
        const result = await handle.pool.query(sql, [...parameters]);
        return result.rows as T[];
      },
    });
  }
}
