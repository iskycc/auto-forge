import { retrySqliteLockContention, type SqliteDatabaseHandle } from "./database";
import {
  JenkinsDependencySqlRepository,
  type JenkinsDependencyQuery,
} from "./jenkins-dependency-repository";
export class SqliteJenkinsDependencyRepository extends JenkinsDependencySqlRepository {
  constructor(handle: SqliteDatabaseHandle) {
    const query: JenkinsDependencyQuery = async <R extends Record<string, unknown>>(
      statement: string,
      values: Array<string | number | null>,
    ) => retrySqliteLockContention(() => handle.client.prepare(statement).all(...values) as R[]);
    super(query);
  }
}
