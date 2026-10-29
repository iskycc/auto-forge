import type { SqliteDatabaseHandle } from "./database";
import { retrySqliteLockContention } from "./database";
import { DatabaseLogArchiveRepository } from "./log-archive-repository";
export class SqliteLogArchiveRepository extends DatabaseLogArchiveRepository {
  constructor(handle: SqliteDatabaseHandle) {
    super({
      jsonText: (column, key) => `json_extract(${column},'$.${key}')`,
      rows: async <T>(sql: string, parameters: readonly unknown[] = []) =>
        retrySqliteLockContention(() => {
          const bindings: unknown[] = [];
          const prepared = sql.replace(/\$(\d+)/g, (_match, index: string) => {
            bindings.push(parameters[Number(index) - 1]);
            return "?";
          });
          return handle.client.prepare(prepared).all(...bindings) as T[];
        }),
    });
  }
}
