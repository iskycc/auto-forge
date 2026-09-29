import type { DdtScope } from "@autoforge/domain";
import type {
  DdtChangeRequestRepository,
  DdtChangeRequestSummary,
  DdtChangeRequest,
  DdtChangeRequestQuery,
} from "@autoforge/application";
import { retrySqliteWriteTransaction, type SqliteDatabaseHandle } from "./database";
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
} from "./ddt-change-request-sql";

export class SqliteDdtChangeRequestRepository implements DdtChangeRequestRepository {
  constructor(private readonly handle: SqliteDatabaseHandle) {}
  async get(scope: DdtScope, id: string) {
    const summary = this.handle.client
      .prepare(`${changeRequestSelect} WHERE ${changeScopeWhere} AND r.id = ?`)
      .get(...changeScopeValues(scope), id) as DdtChangeRequestSummary | undefined;
    if (!summary) return null;
    const rows = this.handle.client.prepare(changeItemsSelect).all(id) as ChangeItemRow[];
    return { ...summary, items: rows.map(mapChangeItem) };
  }
  async list(scope: DdtScope, query: DdtChangeRequestQuery) {
    const command = changeListSql(scope, query);
    const rows = this.handle.client
      .prepare(command.sql)
      .all(...command.values) as DdtChangeRequestSummary[];
    return changeRequestPage(rows, query.limit);
  }
  async create(request: DdtChangeRequest) {
    const commands = createChangeSql(request);
    await retrySqliteWriteTransaction(this.handle, () => {
      for (const [index, command] of commands.entries()) {
        const result = this.handle.client.prepare(command.sql).run(...command.values);
        if (index === 0 && !result.changes) return;
      }
    });
  }
  async decide(input: Parameters<DdtChangeRequestRepository["decide"]>[0]) {
    // Snapshot encoding/diffing happens before taking the SQLite writer lock.
    const commands = decideChangeSql(input);
    await retrySqliteWriteTransaction(this.handle, () => {
      for (const command of commands) {
        const result = this.handle.client.prepare(command.sql).run(...command.values);
        assertChangeWrite(command, result.changes);
      }
    });
  }
}
