import type { PostgresDatabaseHandle } from "./postgres-database";
import {
  JenkinsDependencySqlRepository,
  type JenkinsDependencyQuery,
} from "./jenkins-dependency-repository";
import { retryPostgresWrite } from "./postgres-transaction";
export class PostgresJenkinsDependencyRepository extends JenkinsDependencySqlRepository {
  constructor(handle: PostgresDatabaseHandle) {
    const query: JenkinsDependencyQuery = async <R extends Record<string, unknown>>(
      statement: string,
      values: Array<string | number | null>,
    ) => {
      await handle.ready;
      let position = 0;
      const sql = statement.replaceAll("?", () => `$${++position}`);
      return (await retryPostgresWrite(() => handle.pool.query<R>(sql, values))).rows;
    };
    super(query);
  }
}
