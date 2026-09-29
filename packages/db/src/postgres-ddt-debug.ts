import type { DdtCaseData } from "@autoforge/domain";
import { batchesOf } from "./database-batches";
import type {
  DdtDebugRepository,
  DdtDebugScope,
  DdtDebugWrite,
  DdtImportCaseOutcome,
} from "@autoforge/application";
import {
  debugScopeWhere,
  debugScopeValues,
  type DebugCaseRow,
  mapDebugCase,
  debugCasePage,
  debugWriteOutcome,
  debugCaseUpsert,
  debugWriteValues,
} from "./ddt-debug-sql";
import type { PostgresDatabaseHandle } from "./postgres-database";
import { runPostgresTransaction } from "./postgres-transaction";
// Only module-owned SQL is converted; values always remain parameterized.
function pg(sql: string) {
  let index = 0;
  return sql.replace(/\?/gu, () => `$${++index}`);
}
export class PostgresDdtDebugRepository implements DdtDebugRepository {
  constructor(private readonly handle: PostgresDatabaseHandle) {}
  async workspace(scope: DdtDebugScope, accessKey: string) {
    await this.handle.ready;
    const existing = await this.handle.pool.query<{ access_key: string }>(
      pg(`SELECT access_key FROM ddt_debug_workspaces WHERE ${debugScopeWhere}`),
      debugScopeValues(scope),
    );
    if (existing.rows[0])
      return { ownerUserId: scope.ownerUserId, accessKey: existing.rows[0].access_key };
    await this.handle.pool.query(
      pg(
        `INSERT INTO ddt_debug_workspaces (project_id, project_version_id, test_stage_id, owner_user_id, access_key) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      ),
      [...debugScopeValues(scope), accessKey],
    );
    const saved = await this.handle.pool.query<{ access_key: string }>(
      pg(`SELECT access_key FROM ddt_debug_workspaces WHERE ${debugScopeWhere}`),
      debugScopeValues(scope),
    );
    return { ownerUserId: scope.ownerUserId, accessKey: saved.rows[0]!.access_key };
  }
  async hasAccess(scope: DdtDebugScope, accessKey: string) {
    await this.handle.ready;
    const result = await this.handle.pool.query(
      pg(`SELECT 1 FROM ddt_debug_workspaces WHERE ${debugScopeWhere} AND access_key = ?`),
      [...debugScopeValues(scope), accessKey],
    );
    return result.rows.length > 0;
  }
  async findCaseData(scope: DdtDebugScope, caseIds: string[]) {
    const result = new Map<string, DdtCaseData>();
    for (const chunk of batchesOf(
      [...new Set(caseIds.map((id) => id.toLocaleLowerCase("en-US")))],
      200,
    )) {
      await this.handle.ready;
      const response = await this.handle.pool.query<DebugCaseRow>(
        pg(
          `SELECT * FROM ddt_debug_cases WHERE ${debugScopeWhere} AND case_id_normalized IN (${chunk.map(() => "?").join(",")})`,
        ),
        [...debugScopeValues(scope), ...chunk],
      );
      const rows = response.rows;
      for (const row of rows) result.set(row.case_id_normalized, mapDebugCase(row).data);
    }
    return result;
  }
  async get(scope: DdtDebugScope, caseId: string) {
    await this.handle.ready;
    const result = await this.handle.pool.query<DebugCaseRow>(
      pg(`SELECT * FROM ddt_debug_cases WHERE ${debugScopeWhere} AND case_id_normalized = ?`),
      [...debugScopeValues(scope), caseId.toLocaleLowerCase("en-US")],
    );
    return result.rows[0] ? mapDebugCase(result.rows[0]) : null;
  }
  async list(scope: DdtDebugScope, query: { query: string; cursor?: string; limit: number }) {
    await this.handle.ready;
    const result = await this.handle.pool.query<DebugCaseRow>(
      pg(
        `SELECT * FROM ddt_debug_cases WHERE ${debugScopeWhere} AND case_id_normalized > ? AND strpos(case_id_normalized, ?) > 0 ORDER BY case_id_normalized LIMIT ?`,
      ),
      [
        ...debugScopeValues(scope),
        query.cursor ?? "",
        query.query.toLocaleLowerCase("en-US"),
        query.limit + 1,
      ],
    );
    return debugCasePage(result.rows, query.limit);
  }
  async write(input: DdtDebugWrite) {
    await this.handle.ready;
    return runPostgresTransaction(this.handle, async (client) => {
      // Serialize only writes to this owner's CaseId, including the first insertion.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        JSON.stringify([...debugScopeValues(input.scope), input.caseId.toLocaleLowerCase("en-US")]),
      ]);
      if (input.importRowKey) {
        const receipt = await client.query<{ outcome: DdtImportCaseOutcome }>(
          "SELECT outcome FROM ddt_debug_import_rows WHERE row_key = $1",
          [input.importRowKey],
        );
        if (receipt.rows[0]) return receipt.rows[0].outcome;
      }
      const result = await client.query<DebugCaseRow>(
        pg(
          `SELECT * FROM ddt_debug_cases WHERE ${debugScopeWhere} AND case_id_normalized = ? FOR UPDATE`,
        ),
        [...debugScopeValues(input.scope), input.caseId.toLocaleLowerCase("en-US")],
      );
      const outcome = debugWriteOutcome(result.rows[0], input);
      if (outcome === "inserted" || outcome === "updated")
        await client.query(pg(debugCaseUpsert), debugWriteValues(input));
      if (input.importRowKey)
        await client.query(
          "INSERT INTO ddt_debug_import_rows (row_key, outcome, job_id) VALUES ($1, $2, $3)",
          [input.importRowKey, outcome, input.importRowKey.split(":")[0]!],
        );
      return outcome;
    });
  }
}
