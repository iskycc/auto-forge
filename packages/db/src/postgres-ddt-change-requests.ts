import type { DdtScope } from "@autoforge/domain";
import type {
  DdtChangeRequestRepository,
  DdtChangeRequestSummary,
  DdtChangeRequest,
  DdtChangeRequestQuery,
} from "@autoforge/application";
import type { PostgresDatabaseHandle } from "./postgres-database";
import { runPostgresTransaction } from "./postgres-transaction";
import {
  changeRequestSelect,
  changeScopeWhere,
  changeScopeValues,
  changeItemsSelect,
  type ChangeItemRow,
  mapChangeItem,
  changeListSql,
  changeRequestPage,
  createChangeSql,
  decideChangeSql,
  assertChangeWrite,
  postgresChangeSql as pg,
} from "./ddt-change-request-sql";

export class PostgresDdtChangeRequestRepository implements DdtChangeRequestRepository {
  constructor(private readonly handle: PostgresDatabaseHandle) {}
  async get(scope: DdtScope, id: string) {
    await this.handle.ready;
    const result = await this.handle.pool.query<DdtChangeRequestSummary>(
      pg(`${changeRequestSelect} WHERE ${changeScopeWhere} AND r.id = ?`),
      [...changeScopeValues(scope), id],
    );
    const summary = result.rows[0];
    if (!summary) return null;
    const rows = await this.handle.pool.query<ChangeItemRow>(pg(changeItemsSelect), [id]);
    return { ...summary, items: rows.rows.map(mapChangeItem) };
  }
  async list(scope: DdtScope, query: DdtChangeRequestQuery) {
    await this.handle.ready;
    const command = changeListSql(scope, query);
    const result = await this.handle.pool.query<DdtChangeRequestSummary>(
      pg(command.sql),
      command.values,
    );
    return changeRequestPage(result.rows, query.limit);
  }
  async create(request: DdtChangeRequest) {
    await this.handle.ready;
    const commands = createChangeSql(request);
    await runPostgresTransaction(this.handle, async (client) => {
      for (const [index, command] of commands.entries()) {
        const result = await client.query(pg(command.sql), command.values);
        if (index === 0 && !result.rowCount) return;
      }
    });
  }
  async decide(input: Parameters<DdtChangeRequestRepository["decide"]>[0]) {
    await this.handle.ready;
    const commands = decideChangeSql(input);
    await runPostgresTransaction(this.handle, async (client) => {
      for (const command of commands) {
        const result = await client.query(pg(command.sql), command.values);
        assertChangeWrite(command, result.rowCount ?? 0);
      }
    });
  }
}
