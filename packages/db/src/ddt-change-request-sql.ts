import {
  DomainError,
  ddtCaseCell,
  diffDdtCaseData,
  isDdtJourney,
  type DdtScope,
} from "@autoforge/domain";
import type {
  DdtChangeRequest,
  DdtChangeItem,
  DdtChangeRequestSummary,
  DdtChangeRequestQuery,
  DdtChangeRequestRepository,
} from "@autoforge/application";
import { ddtChangeDataSnapshotSchema } from "@autoforge/contracts";

export type ChangeSql = { sql: string; values: Array<string | number | null>; conflict?: string };
export const changeScopeWhere =
  "r.project_id = ? AND r.project_version_id = ? AND r.test_stage_id = ?";
export const changeScopeValues = (scope: DdtScope) => [
  scope.projectId,
  scope.projectVersionId,
  scope.testStageId,
];
export const changeRequestSelect = `SELECT r.id, r.project_id AS "projectId", r.project_version_id AS "projectVersionId",
  r.test_stage_id AS "testStageId", r.title, r.description, r.owner_user_id AS "ownerUserId",
  u.display_name AS "ownerName", r.status, r.case_count AS "caseCount", r.created_at AS "createdAt",
  r.reviewed_at AS "reviewedAt", r.reviewer_id AS "reviewerId", reviewer.display_name AS "reviewerName",
  r.review_comment AS "reviewComment"
  FROM ddt_change_requests r JOIN users u ON u.id = r.owner_user_id
  LEFT JOIN users reviewer ON reviewer.id = r.reviewer_id`;
export const changeItemsSelect = `SELECT case_id AS "caseId", base_id AS "baseId", base_revision AS "baseRevision",
  personal_revision AS "personalRevision", before_json AS "beforeJson", after_json AS "afterJson"
  FROM ddt_change_request_items WHERE request_id = ? ORDER BY position`;
export type ChangeItemRow = Omit<DdtChangeItem, "before" | "after"> & {
  beforeJson: string;
  afterJson: string;
};
export function mapChangeItem(row: ChangeItemRow): DdtChangeItem {
  const { beforeJson, afterJson, ...item } = row;
  return {
    ...item,
    before: ddtChangeDataSnapshotSchema.parse(JSON.parse(beforeJson)).data,
    after: ddtChangeDataSnapshotSchema.parse(JSON.parse(afterJson)).data,
  };
}
export function changeListSql(scope: DdtScope, query: DdtChangeRequestQuery): ChangeSql {
  const conditions = [changeScopeWhere];
  const values: ChangeSql["values"] = changeScopeValues(scope);
  if (query.ownerUserId) {
    conditions.push("r.owner_user_id = ?");
    values.push(query.ownerUserId);
  }
  if (query.status) {
    conditions.push("r.status = ?");
    values.push(query.status);
  }
  if (query.cursor) {
    conditions.push(`(r.created_at, r.id) < (SELECT created_at, id FROM ddt_change_requests
      WHERE id = ? AND project_id = ? AND project_version_id = ? AND test_stage_id = ?)`);
    values.push(query.cursor, ...changeScopeValues(scope));
  }
  values.push(query.limit + 1);
  return {
    sql: `${changeRequestSelect} WHERE ${conditions.join(" AND ")} ORDER BY r.created_at DESC, r.id DESC LIMIT ?`,
    values,
  };
}
export function changeRequestPage(rows: DdtChangeRequestSummary[], limit: number) {
  return {
    items: rows.slice(0, limit),
    ...(rows.length > limit ? { nextCursor: rows[limit - 1]!.id } : {}),
  };
}
export function createChangeSql(request: DdtChangeRequest): ChangeSql[] {
  return [
    {
      sql: `INSERT INTO ddt_change_requests
      (id, project_id, project_version_id, test_stage_id, owner_user_id, title, description, status, case_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?) ON CONFLICT(id) DO NOTHING`,
      values: [
        request.id,
        ...changeScopeValues(request),
        request.ownerUserId,
        request.title,
        request.description,
        request.items.length,
        request.createdAt,
      ],
    },
    ...request.items.map((item, index) => ({
      sql: `INSERT INTO ddt_change_request_items
      (request_id, position, case_id, base_id, base_revision, personal_revision, before_json, after_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      values: [
        request.id,
        index,
        item.caseId,
        item.baseId,
        item.baseRevision,
        item.personalRevision,
        JSON.stringify({ schemaVersion: 1, data: item.before }),
        JSON.stringify({ schemaVersion: 1, data: item.after }),
      ],
    })),
  ];
}
export function decideChangeSql(
  input: Parameters<DdtChangeRequestRepository["decide"]>[0],
): ChangeSql[] {
  const { request, status, actorId, now } = input;
  const commands: ChangeSql[] = [
    {
      sql: `UPDATE ddt_change_requests SET status = ?, reviewer_id = ?, reviewed_at = ?, review_comment = ?
      WHERE id = ? AND project_id = ? AND project_version_id = ? AND test_stage_id = ? AND status = 'pending'`,
      values: [status, actorId, now, input.comment, request.id, ...changeScopeValues(request)],
      conflict: "申请已被处理，请刷新查看最新状态。",
    },
  ];
  if (status !== "approved") return commands;
  for (const [index, item] of request.items.entries()) {
    const srNum = String(ddtCaseCell(item.after, "srNum"));
    const caseId = String(ddtCaseCell(item.after, "CaseID"));
    const kind = isDdtJourney(item.after) ? "journey" : "standard";
    const sourceName = `调试变更审核 ${request.id}`;
    const conflict = `CaseId“${item.caseId}”的正式数据已变化，整单未合入。请撤回或退回后重新对比提交。`;
    if (item.baseId)
      commands.push({
        sql: `UPDATE ddt_cases SET case_id = ?, sr_num = ?, sr_num_normalized = ?, case_kind = ?, data_json = ?,
        revision = revision + 1, updated_by = ?, updated_at = ?
        WHERE id = ? AND revision = ? AND project_id = ? AND project_version_id = ? AND test_stage_id = ?`,
        values: [
          caseId,
          srNum,
          srNum.toLocaleLowerCase("en-US"),
          kind,
          JSON.stringify(item.after),
          actorId,
          now,
          item.baseId,
          item.baseRevision,
          ...changeScopeValues(request),
        ],
        conflict,
      });
    else
      commands.push({
        sql: `INSERT INTO ddt_cases (id, project_id, project_version_id, test_stage_id, case_id, case_id_normalized,
        sr_num, sr_num_normalized, case_kind, data_json, source_name, revision, created_by, updated_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
        ON CONFLICT(project_id, project_version_id, test_stage_id, case_id_normalized) DO NOTHING`,
        values: [
          input.caseIds[index]!,
          ...changeScopeValues(request),
          caseId,
          caseId.toLocaleLowerCase("en-US"),
          srNum,
          srNum.toLocaleLowerCase("en-US"),
          kind,
          JSON.stringify(item.after),
          sourceName,
          request.ownerUserId,
          actorId,
          now,
          now,
        ],
        conflict,
      });
    commands.push({
      sql: `INSERT INTO ddt_case_history (id, ddt_case_id, case_id, change_type, actor_id, source_name,
        before_json, after_json, changes_json, created_at) VALUES (?, ?, ?, 'edit', ?, ?, ?, ?, ?, ?)`,
      values: [
        input.historyIds[index]!,
        item.baseId ?? input.caseIds[index]!,
        caseId,
        actorId,
        sourceName,
        JSON.stringify(item.before),
        JSON.stringify(item.after),
        JSON.stringify(diffDdtCaseData(item.before, item.after)),
        now,
      ],
    });
  }
  return commands;
}
export function assertChangeWrite(command: ChangeSql, count: number) {
  if (command.conflict && count !== 1)
    throw new DomainError("DDT_CHANGE_REQUEST_CONFLICT", command.conflict);
}
export function postgresChangeSql(sql: string) {
  let index = 0;
  return sql.replace(/\?/gu, () => `$${++index}`);
}
