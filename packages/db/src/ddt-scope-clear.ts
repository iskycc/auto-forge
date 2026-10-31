import { sql } from "drizzle-orm";
import type { DdtScopeClearWrite } from "@autoforge/application";
import type { DdtScope } from "@autoforge/domain";
import { auditEventRow } from "./audit-event-row";

export const DDT_SCOPE_CLEAR_PAGE_SIZE = 100;
export const emptyDdtScopeClearPage = {
  removedMembers: 0,
  deletedHistory: 0,
  deletedCases: 0,
  deletedRecycled: 0,
};
export type DdtScopeClearPhase = "history" | "cases" | "recycle";

export function ddtClearCondition(
  alias: "c" | "r" | "t",
  scope: DdtScope,
  clearedBefore: string,
  timeColumn: "updated_at" | "deleted_at" = "updated_at",
) {
  return sql`${sql.raw(alias)}.project_id=${scope.projectId}
    AND ${sql.raw(alias)}.project_version_id=${scope.projectVersionId}
    AND ${sql.raw(alias)}.test_stage_id=${scope.testStageId}
    AND ${sql.raw(alias)}.${sql.raw(timeColumn)}<=${clearedBefore}`;
}

export function ddtScopeClearCounts(scope: DdtScope, clearedBefore: string) {
  const active = ddtClearCondition("c", scope, clearedBefore);
  const recycled = ddtClearCondition("r", scope, clearedBefore, "deleted_at");
  return sql`SELECT
    (SELECT COUNT(*) FROM ddt_cases c WHERE ${active}) AS active_cases,
    (SELECT COUNT(*) FROM ddt_deleted_cases r WHERE ${recycled}) AS recycled_cases,
    (SELECT COUNT(*) FROM case_suite_ddt_items m JOIN ddt_cases c ON c.id=m.ddt_case_id WHERE ${active}) AS suite_members,
    (SELECT COUNT(DISTINCT m.suite_id) FROM case_suite_ddt_items m JOIN ddt_cases c ON c.id=m.ddt_case_id WHERE ${active}) AS affected_suites`;
}
export type DdtScopeClearCountRow = {
  active_cases: number | string;
  recycled_cases: number | string;
  suite_members: number | string;
  affected_suites: number | string;
};
export function mapDdtScopeClearCounts(row: DdtScopeClearCountRow) {
  return {
    activeCases: Number(row.active_cases),
    recycledCases: Number(row.recycled_cases),
    suiteMembers: Number(row.suite_members),
    affectedSuites: Number(row.affected_suites),
  };
}

export function ddtClearSuiteCandidate(input: DdtScopeClearWrite, dialect: "sqlite" | "postgres") {
  return sql`SELECT suite.id FROM case_suites suite
    WHERE suite.project_id=${input.scope.projectId} AND EXISTS (
      SELECT 1 FROM case_suite_ddt_items m JOIN ddt_cases c ON c.id=m.ddt_case_id
      WHERE m.suite_id=suite.id AND ${ddtClearCondition("c", input.scope, input.clearedBefore)})
    ORDER BY suite.id LIMIT 1 ${dialect === "postgres" ? sql`FOR UPDATE OF suite SKIP LOCKED` : sql``}`;
}
export function ddtClearSuiteMembers(input: DdtScopeClearWrite, suiteId: string) {
  return sql`DELETE FROM case_suite_ddt_items WHERE suite_id=${suiteId}
    AND ddt_case_id IN (SELECT c.id FROM ddt_cases c WHERE ${ddtClearCondition("c", input.scope, input.clearedBefore)})`;
}

export function ddtClearCandidates(
  input: DdtScopeClearWrite,
  phase: DdtScopeClearPhase,
  dialect: "sqlite" | "postgres",
) {
  const table =
    phase === "history"
      ? "ddt_case_history"
      : phase === "cases"
        ? "ddt_cases"
        : "ddt_deleted_cases";
  const condition =
    phase === "history"
      ? sql`t.ddt_case_id IN (
    SELECT c.id FROM ddt_cases c WHERE ${ddtClearCondition("c", input.scope, input.clearedBefore)}
    UNION SELECT r.ddt_case_id FROM ddt_deleted_cases r WHERE ${ddtClearCondition("r", input.scope, input.clearedBefore, "deleted_at")}
      AND NOT EXISTS (SELECT 1 FROM ddt_cases live WHERE live.id=r.ddt_case_id AND live.updated_at>${input.clearedBefore}))`
      : ddtClearCondition(
          "t",
          input.scope,
          input.clearedBefore,
          phase === "cases" ? "updated_at" : "deleted_at",
        );
  return sql`SELECT t.id FROM ${sql.raw(table)} t WHERE ${condition}
    ${phase === "cases" ? sql`AND NOT EXISTS(SELECT 1 FROM case_suite_ddt_items m WHERE m.ddt_case_id=t.id)` : sql``}
    ORDER BY t.id LIMIT ${DDT_SCOPE_CLEAR_PAGE_SIZE}
    ${dialect === "postgres" ? sql`FOR UPDATE OF t SKIP LOCKED` : sql``}`;
}
export function ddtClearDelete(phase: DdtScopeClearPhase, ids: readonly string[]) {
  const table =
    phase === "history"
      ? "ddt_case_history"
      : phase === "cases"
        ? "ddt_cases"
        : "ddt_deleted_cases";
  return sql`DELETE FROM ${sql.raw(table)} WHERE id IN (${sql.join(
    ids.map((id) => sql`${id}`),
    sql`,`,
  )})`;
}
export function ddtClearAudit(input: DdtScopeClearWrite, phase: string, count: number) {
  return auditEventRow({
    id: input.auditId,
    actorType: "user",
    actorId: input.auditActorId,
    action: "ddt_case.purge",
    resourceType: "ddt_case",
    projectId: input.scope.projectId,
    result: "succeeded",
    requestId: input.requestId,
    recordedAt: input.updatedAt,
    details: {
      operation: "clear_scope",
      phase,
      count,
      ...input.scope,
      clearedBefore: input.clearedBefore,
    },
  });
}
export function ddtClearInvalidate(input: DdtScopeClearWrite) {
  return sql`UPDATE read_model_snapshots SET requested_revision=requested_revision+1,failed=0,refresh_after=${input.updatedAt} WHERE project_id=${input.scope.projectId}`;
}
