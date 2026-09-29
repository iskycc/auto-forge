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
import {
  retrySqliteLockContention,
  runSqliteWriteTransaction,
  type SqliteDatabaseHandle,
} from "./database";
export class SqliteDdtDebugRepository implements DdtDebugRepository {
  constructor(private readonly handle: SqliteDatabaseHandle) {}
  async workspace(scope: DdtDebugScope, accessKey: string) {
    const existing = this.handle.client
      .prepare(`SELECT access_key FROM ddt_debug_workspaces WHERE ${debugScopeWhere}`)
      .get(...debugScopeValues(scope)) as { access_key: string } | undefined;
    if (existing) return { ownerUserId: scope.ownerUserId, accessKey: existing.access_key };
    await retrySqliteLockContention(() =>
      this.handle.client
        .prepare(
          `INSERT INTO ddt_debug_workspaces (project_id, project_version_id, test_stage_id, owner_user_id, access_key) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        )
        .run(...debugScopeValues(scope), accessKey),
    );
    const saved = this.handle.client
      .prepare(`SELECT access_key FROM ddt_debug_workspaces WHERE ${debugScopeWhere}`)
      .get(...debugScopeValues(scope)) as { access_key: string };
    return { ownerUserId: scope.ownerUserId, accessKey: saved.access_key };
  }
  async hasAccess(scope: DdtDebugScope, accessKey: string) {
    return Boolean(
      this.handle.client
        .prepare(`SELECT 1 FROM ddt_debug_workspaces WHERE ${debugScopeWhere} AND access_key = ?`)
        .get(...debugScopeValues(scope), accessKey),
    );
  }
  async findCaseData(scope: DdtDebugScope, caseIds: string[]) {
    const result = new Map<string, DdtCaseData>();
    for (const chunk of batchesOf(
      [...new Set(caseIds.map((id) => id.toLocaleLowerCase("en-US")))],
      200,
    )) {
      const rows = this.handle.client
        .prepare(
          `SELECT * FROM ddt_debug_cases WHERE ${debugScopeWhere} AND case_id_normalized IN (${chunk.map(() => "?").join(",")})`,
        )
        .all(...debugScopeValues(scope), ...chunk) as DebugCaseRow[];
      for (const row of rows) result.set(row.case_id_normalized, mapDebugCase(row).data);
    }
    return result;
  }
  async get(scope: DdtDebugScope, caseId: string) {
    const row = this.handle.client
      .prepare(`SELECT * FROM ddt_debug_cases WHERE ${debugScopeWhere} AND case_id_normalized = ?`)
      .get(...debugScopeValues(scope), caseId.toLocaleLowerCase("en-US")) as
      DebugCaseRow | undefined;
    return row ? mapDebugCase(row) : null;
  }
  async list(scope: DdtDebugScope, query: { query: string; cursor?: string; limit: number }) {
    const rows = this.handle.client
      .prepare(
        `SELECT * FROM ddt_debug_cases WHERE ${debugScopeWhere} AND case_id_normalized > ? AND instr(case_id_normalized, ?) > 0 ORDER BY case_id_normalized LIMIT ?`,
      )
      .all(
        ...debugScopeValues(scope),
        query.cursor ?? "",
        query.query.toLocaleLowerCase("en-US"),
        query.limit + 1,
      ) as DebugCaseRow[];
    return debugCasePage(rows, query.limit);
  }
  async write(input: DdtDebugWrite) {
    return retrySqliteLockContention(() =>
      runSqliteWriteTransaction(this.handle, () => {
        if (input.importRowKey) {
          const receipt = this.handle.client
            .prepare("SELECT outcome FROM ddt_debug_import_rows WHERE row_key = ?")
            .get(input.importRowKey) as { outcome: DdtImportCaseOutcome } | undefined;
          if (receipt) return receipt.outcome;
        }
        const row = this.handle.client
          .prepare(
            `SELECT * FROM ddt_debug_cases WHERE ${debugScopeWhere} AND case_id_normalized = ?`,
          )
          .get(...debugScopeValues(input.scope), input.caseId.toLocaleLowerCase("en-US")) as
          DebugCaseRow | undefined;
        const outcome = debugWriteOutcome(row, input);
        if (outcome === "inserted" || outcome === "updated")
          this.handle.client.prepare(debugCaseUpsert).run(...debugWriteValues(input));
        if (input.importRowKey)
          this.handle.client
            .prepare(
              "INSERT INTO ddt_debug_import_rows (row_key, outcome, job_id) VALUES (?, ?, ?)",
            )
            .run(input.importRowKey, outcome, input.importRowKey.split(":")[0]!);
        return outcome;
      }),
    );
  }
}
