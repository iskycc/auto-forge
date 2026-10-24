import {
  projectVersionCopySchema,
  projectVersionCopySnapshotSchema,
  type JobEnvelope,
} from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";
import type {
  ProjectVersionCopyRepository,
  VersionCopyState,
  VersionCopyRow,
  VersionCopySnapshotSink,
} from "@autoforge/application";
import {
  VERSION_COPY_TABLES,
  versionCopyScopeSql,
  type VersionCopyTable,
} from "./version-copy-plan";
import type { VersionCopyQuery, VersionCopySql } from "./version-copy-sql";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { VERSION_COPY_RESERVED, versionCopyTargetHasContentSql } from "./version-copy-target";

const METRIC_COLUMNS = [
  "total_rows",
  "copied_rows",
  "total_objects",
  "copied_objects",
  "total_attempts",
  "copied_attempts",
  "progress_percent",
  "cursor",
  "collection_index",
] as const;
const camel = (value: string) =>
  value.replace(/_([a-z])/gu, (_, letter: string) => letter.toUpperCase());

/** Shared copy rules; only connection/placeholder/snapshot behavior lives in dialect adapters. */
export class SqlProjectVersionCopyRepository implements ProjectVersionCopyRepository {
  constructor(private readonly sql: VersionCopySql) {}
  close(): Promise<void> {
    return this.sql.close();
  }

  async create(
    input: Parameters<ProjectVersionCopyRepository["create"]>[0],
  ): Promise<VersionCopyState> {
    try {
      return await this.sql.transaction(async (query) => {
        const previous = (
          await query.rows(
            "SELECT * FROM project_version_copies WHERE requested_by=? AND request_key=?",
            [input.actorId, input.requestKey],
          )
        )[0];
        if (previous) return matchingRequest(previous, input);
        const source = (
          await query.rows(
            `SELECT v.name FROM project_versions v WHERE v.id=? AND v.project_id=? AND NOT EXISTS (SELECT 1 FROM project_version_copies c WHERE c.target_version_id=v.id AND c.${VERSION_COPY_RESERVED})`,
            [input.sourceVersionId, input.sourceProjectId],
          )
        )[0];
        const target = (
          await query.rows("SELECT id FROM projects WHERE id=? AND archived=FALSE", [
            input.targetProjectId,
          ])
        )[0];
        if (!source || !target)
          throw new DomainError(
            "VERSION_COPY_SCOPE_INVALID",
            "来源版本不存在，或目标项目不存在／已归档。",
          );
        if (
          (
            await query.rows(
              "SELECT id FROM project_version_copies WHERE status IN ('queued','running','cancelling') LIMIT 1",
            )
          ).length
        )
          throw new DomainError("VERSION_COPY_BUSY", "当前已有版本复制任务，请待其结束后再创建。");
        const destination = await this.reserveTarget(query, input);
        await query.rows(
          `INSERT INTO project_version_copies (id,source_project_id,source_version_id,source_version_name,target_project_id,target_version_id,target_version_name,target_mode,request_key,requested_by,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,'queued',?,?)`,
          [
            input.id,
            input.sourceProjectId,
            input.sourceVersionId,
            String(source.name),
            input.targetProjectId,
            destination.id,
            destination.name,
            input.targetVersionId ? "existing" : "new",
            input.requestKey,
            input.actorId,
            input.now,
            input.now,
          ],
        );
        await this.enqueue(query, input.job);
        return mapState(
          (await query.rows("SELECT * FROM project_version_copies WHERE id=?", [input.id]))[0]!,
        );
      });
    } catch (cause) {
      if (cause instanceof DomainError) throw cause;
      const existing = (
        await this.sql.rows(
          "SELECT * FROM project_version_copies WHERE requested_by=? AND request_key=?",
          [input.actorId, input.requestKey],
        )
      )[0];
      if (existing) return matchingRequest(existing, input);
      if (String(cause).includes("project_version_copies_one_active"))
        throw new DomainError("VERSION_COPY_BUSY", "当前已有版本复制任务。", { cause });
      throw cause;
    }
  }
  private async reserveTarget(
    query: VersionCopyQuery,
    input: Parameters<ProjectVersionCopyRepository["create"]>[0],
  ): Promise<{ id: string; name: string }> {
    if (input.targetVersionId) {
      if (input.targetVersionId === input.sourceVersionId)
        throw new DomainError("VERSION_COPY_TARGET_INVALID", "来源版本不能作为复制目标。");
      // The same row lock is taken by stage creation and runtime-configuration writes.
      // A concurrent first write either commits before this check, or sees the reservation.
      const target = (
        await query.rows(
          `SELECT * FROM project_versions WHERE id=? AND project_id=?${this.sql.dialect === "postgres" ? " FOR UPDATE" : ""}`,
          [input.targetVersionId, input.targetProjectId],
        )
      )[0];
      if (!target)
        throw new DomainError("VERSION_COPY_TARGET_INVALID", "目标版本不存在或不属于目标项目。");
      if (
        (
          await query.rows(
            `SELECT id FROM project_version_copies WHERE target_version_id=? AND ${VERSION_COPY_RESERVED} LIMIT 1`,
            [input.targetVersionId],
          )
        ).length
      )
        throw new DomainError(
          "VERSION_COPY_TARGET_RESERVED",
          "目标版本已有未完成的复制，请先完成或清理该复制。",
        );
      const occupied = await query.rows(
        `SELECT v.id FROM project_versions v WHERE v.id=? AND (${versionCopyTargetHasContentSql(this.sql.dialect)})`,
        [input.targetVersionId],
      );
      if (occupied.length)
        throw new DomainError(
          "VERSION_COPY_TARGET_NOT_EMPTY",
          "目标版本不是空版本：已存在测试阶段、用例、任务、执行记录或版本配置。请选择其他空版本。",
        );
      return { id: String(target.id), name: String(target.name) };
    }
    const name = input.targetVersionName;
    if (!name) throw new DomainError("VERSION_COPY_TARGET_INVALID", "请填写新版本名称。");
    const normalized = name.normalize("NFKC").trim().toLowerCase();
    if (
      (
        await query.rows(
          "SELECT id FROM project_versions WHERE project_id=? AND normalized_name=?",
          [input.targetProjectId, normalized],
        )
      ).length
    )
      throw new DomainError(
        "VERSION_COPY_TARGET_EXISTS",
        "目标版本名称已存在，请选择已有空版本或填写新的版本名称。",
      );
    await query.rows(
      "INSERT INTO project_versions (id,project_id,name,normalized_name,status,revision,created_at,updated_at) VALUES (?,?,?,?,'archived',1,?,?)",
      [
        input.allocatedTargetVersionId,
        input.targetProjectId,
        name,
        normalized,
        input.now,
        input.now,
      ],
    );
    return { id: input.allocatedTargetVersionId, name };
  }
  async listTargets(projectId: string, afterId?: string) {
    const rows = await this.sql.rows(
      `SELECT v.id,v.name,v.status,CASE WHEN (${versionCopyTargetHasContentSql(this.sql.dialect)}) THEN 0 ELSE 1 END AS empty
       FROM project_versions v JOIN projects p ON p.id=v.project_id AND p.archived=FALSE
       WHERE v.project_id=? AND v.id>? AND NOT EXISTS (SELECT 1 FROM project_version_copies c WHERE c.target_version_id=v.id AND c.${VERSION_COPY_RESERVED})
       ORDER BY v.id LIMIT 21`,
      [projectId, afterId ?? ""],
    );
    const items = rows.slice(0, 20).map((row) => ({
      id: String(row.id),
      name: String(row.name),
      status: row.status as "active" | "archived",
      empty: Number(row.empty) === 1,
    }));
    return { items, ...(rows.length > 20 ? { nextCursor: items.at(-1)!.id } : {}) };
  }
  async get(id: string): Promise<VersionCopyState | null> {
    const row = (await this.sql.rows("SELECT * FROM project_version_copies WHERE id=?", [id]))[0];
    return row ? mapState(row) : null;
  }
  async list(
    projectIds: readonly string[] | undefined,
    projectId: string,
  ): Promise<VersionCopyState[]> {
    const rows = await this.sql.rows(
      "SELECT * FROM project_version_copies WHERE source_project_id=? OR target_project_id=? ORDER BY created_at DESC,id DESC LIMIT 50",
      [projectId, projectId],
    );
    return rows
      .map(mapState)
      .filter(
        (job) =>
          !projectIds ||
          (projectIds.includes(job.sourceProjectId) && projectIds.includes(job.targetProjectId)),
      );
  }
  async claim(
    id: string,
    token: string,
    now: string,
    expiresAt: string,
  ): Promise<VersionCopyState | null> {
    return this.sql.transaction(async (query) => {
      const rows = await query.rows(
        "UPDATE project_version_copies SET lease_token=?,lease_expires_at=?,status=CASE WHEN status='cancelling' THEN status ELSE 'running' END,updated_at=? WHERE id=? AND status IN ('queued','running','cancelling') AND (lease_expires_at IS NULL OR lease_expires_at<?) RETURNING *",
        [token, expiresAt, now, id, now],
      );
      return rows[0] ? mapState(rows[0]) : null;
    });
  }
  async save(state: VersionCopyState, expectedToken: string): Promise<void> {
    await this.sql.transaction((query) => this.saveWith(query, state, expectedToken));
  }
  private async saveWith(
    query: VersionCopyQuery,
    state: VersionCopyState,
    token: string,
  ): Promise<void> {
    const values = METRIC_COLUMNS.map((column) => metricValue(state, column));
    const updated = await query.rows(
      `UPDATE project_version_copies SET ${METRIC_COLUMNS.map((column) => `${column}=?`).join(",")},phase=?,snapshot_json=?,status=?,error_code=?,error_message=?,updated_at=? WHERE id=? AND lease_token=? AND status=? AND lease_expires_at>? RETURNING id`,
      [
        ...values,
        state.phase,
        state.snapshot ? JSON.stringify({ schemaVersion: 1, ...state.snapshot }) : null,
        state.status,
        state.errorCode,
        state.errorMessage,
        state.updatedAt,
        state.id,
        token,
        state.status,
        state.updatedAt,
      ],
    );
    if (!updated.length)
      await this.assertOwned(
        query,
        state.id,
        token,
        state.status === "cancelling",
        state.updatedAt,
      );
  }
  async renew(id: string, token: string, now: string, expiresAt: string): Promise<boolean> {
    return (
      (
        await this.sql.transaction((query) =>
          query.rows(
            "UPDATE project_version_copies SET lease_expires_at=?,updated_at=? WHERE id=? AND lease_token=? AND status IN ('running','cancelling') AND lease_expires_at>? RETURNING id",
            [expiresAt, now, id, token, now],
          ),
        )
      ).length === 1
    );
  }
  async action(
    id: string,
    action: "retry" | "cancel",
    now: string,
    job: JobEnvelope,
  ): Promise<VersionCopyState> {
    return this.sql.transaction(async (query) => {
      const row = (await query.rows("SELECT * FROM project_version_copies WHERE id=?", [id]))[0];
      if (!row) throw new DomainError("VERSION_COPY_NOT_FOUND", "复制任务不存在。");
      const current = mapState(row);
      if (action === "retry" && current.status !== "failed")
        throw new DomainError("VERSION_COPY_STATE_CONFLICT", "仅失败的复制任务可以重试。");
      if (action === "cancel" && ["completed", "cancelled"].includes(current.status))
        return current;
      if (
        action === "retry" &&
        (
          await query.rows(
            "SELECT id FROM project_version_copies WHERE id<>? AND status IN ('queued','running','cancelling') LIMIT 1",
            [id],
          )
        ).length
      )
        throw new DomainError("VERSION_COPY_BUSY", "请先等待正在进行的版本复制结束。");
      if (action === "retry")
        await query.rows(
          "UPDATE project_version_copies SET status='queued',lease_token=NULL,lease_expires_at=NULL,error_code=NULL,error_message=NULL,updated_at=? WHERE id=?",
          [now, id],
        );
      else
        await query.rows(
          "UPDATE project_version_copies SET status='cancelling',phase='cleanup',updated_at=? WHERE id=?",
          [now, id],
        );
      await this.enqueue(query, job);
      return mapState(
        (await query.rows("SELECT * FROM project_version_copies WHERE id=?", [id]))[0]!,
      );
    });
  }
  async fail(
    id: string,
    token: string,
    now: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<void> {
    await this.sql.transaction((query) =>
      query.rows(
        "UPDATE project_version_copies SET phase=CASE WHEN status='cancelling' THEN 'cleanup' ELSE phase END,status='failed',error_code=?,error_message=?,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND lease_token=? AND status IN ('running','cancelling')",
        [errorCode, errorMessage, now, id, token],
      ),
    );
  }
  async release(id: string, token: string, now: string): Promise<void> {
    await this.sql.transaction((query) =>
      query.rows(
        "UPDATE project_version_copies SET lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND lease_token=?",
        [now, id, token],
      ),
    );
  }
  async capture(
    state: VersionCopyState,
    sink: VersionCopySnapshotSink,
    signal: AbortSignal,
  ): Promise<void> {
    await this.sql.snapshot(async (query) => {
      if (
        !(
          await query.rows("SELECT id FROM project_versions WHERE id=? AND project_id=?", [
            state.sourceVersionId,
            state.sourceProjectId,
          ])
        ).length
      )
        throw new DomainError("VERSION_COPY_SCOPE_INVALID", "来源版本在生成快照前已被删除。");
      const scope = versionCopyScopeSql(this.sql.dialect);
      const values = [state.sourceProjectId, state.sourceVersionId];
      const active = await query.rows(
        `${scope} SELECT id FROM run_batches WHERE id IN (SELECT id FROM selected_batches) AND status NOT IN ('succeeded','failed','cancelled') LIMIT 1`,
        values,
      );
      const importing = await query.rows(
        "SELECT id FROM case_import_jobs WHERE project_version_id=? AND status NOT IN ('succeeded','completed','failed','cancelled') UNION SELECT id FROM ddt_import_jobs WHERE project_version_id=? AND debug_owner_id IS NULL AND status NOT IN ('succeeded','completed','failed','cancelled') LIMIT 1",
        [state.sourceVersionId, state.sourceVersionId],
      );
      const recovering = await query.rows(
        `${scope} SELECT batch_id FROM run_batch_round_recoveries WHERE batch_id IN (SELECT id FROM selected_batches) AND status NOT IN ('idle','succeeded','completed','failed','timed_out','cancelled','skipped') LIMIT 1`,
        values,
      );
      const attempts = await query.rows(
        `${scope} SELECT id FROM run_attempts WHERE id IN (SELECT id FROM selected_attempts) AND status NOT IN ('succeeded','failed','timed_out','cancelled') UNION SELECT id FROM assignments WHERE batch_id IN (SELECT id FROM selected_batches) AND status NOT IN ('completed','cancelled','expired') LIMIT 1`,
        values,
      );
      if (active.length || importing.length || recovering.length || attempts.length)
        throw new DomainError(
          "VERSION_COPY_SOURCE_ACTIVE",
          "来源版本仍有未结束的执行、导入或环境恢复，请结束后重试复制。",
        );
      const legacy = await query.rows(
        `${scope} SELECT id FROM run_batches WHERE id IN (SELECT id FROM selected_batches) AND (environment_id IS NOT NULL OR environment_version_id IS NOT NULL) LIMIT 1`,
        values,
      );
      if (legacy.length)
        throw new DomainError(
          "VERSION_COPY_LEGACY_ENVIRONMENT",
          "来源版本引用了退役执行环境，需要先处理历史环境引用，不能生成不完整副本。",
        );
      for (const collection of VERSION_COPY_TABLES) {
        const columns = await this.sql.columns(query, collection.name);
        const size = columns
          .map((column) => `COALESCE(length(CAST(c."${column}" AS TEXT)),0)`)
          .join("+");
        const key = collection.primaryKey.map((column) => `c."${column}"`).join(",");
        // Materialize only keys/sizes once. Re-evaluating version/history joins and
        // sorting a 100,000-row collection for every 32-row page would be quadratic.
        const encodedKey =
          this.sql.dialect === "sqlite" ? `json_array(${key})` : `json_build_array(${key})::text`;
        await query.rows(
          `INSERT INTO version_copy_keys ${scope} SELECT ROW_NUMBER() OVER (ORDER BY ${key}),${encodedKey},(${size})*4+256 FROM "${collection.name}" c WHERE (${collection.predicate})`,
          values,
        );
        let after = 0;
        for (;;) {
          signal.throwIfAborted();
          const page = await query.rows(
            "SELECT * FROM version_copy_keys WHERE ordinal>? ORDER BY ordinal LIMIT 32",
            [after],
          );
          if (!page.length) break;
          const chosen: VersionCopyRow[] = [];
          let bytes = 0;
          for (const entry of page) {
            const length = Number(entry.copy_row_bytes);
            if (chosen.length && bytes + length > 2 * 1024 * 1024) break;
            chosen.push(entry);
            bytes += length;
          }
          const where = chosen
            .map(() => `(${collection.primaryKey.map((column) => `"${column}"=?`).join(" AND ")})`)
            .join(" OR ");
          const records = await query.rows(
            `SELECT * FROM "${collection.name}" WHERE ${where} ORDER BY ${collection.primaryKey.map((column) => `"${column}"`).join(",")}`,
            chosen.flatMap(
              (row) =>
                JSON.parse(String(row.record_key)) as Array<string | number | boolean | null>,
            ),
          );
          if (
            records.some(
              (row) => row.project_id !== undefined && row.project_id !== state.sourceProjectId,
            )
          )
            throw new DomainError(
              "VERSION_COPY_SCOPE_INVALID",
              "来源数据存在跨项目关联，复制已停止。",
            );
          await sink.append(collection, records);
          const last = chosen.at(-1)!;
          after = Number(last.ordinal);
          await yieldTurn();
        }
        await query.rows("DELETE FROM version_copy_keys");
      }
    });
  }
  async insertPage(
    state: VersionCopyState,
    records: Parameters<ProjectVersionCopyRepository["insertPage"]>[1],
    token: string,
  ): Promise<void> {
    await this.sql.transaction(async (query) => {
      await this.assertOwned(query, state.id, token, false, state.updatedAt);
      const rows: VersionCopyRow[] = [];
      let nextSequence =
        records[0]?.collection === "run_batches" && this.sql.dialect === "sqlite"
          ? Number(
              (
                await query.rows(
                  "SELECT COALESCE(MAX(sequence_number),0) AS maximum FROM run_batches",
                )
              )[0]!.maximum,
            )
          : 0;
      for (const record of records) {
        table(record.collection);
        const row = { ...record.row };
        if (record.collection === "run_batches")
          row.sequence_number =
            this.sql.dialect === "sqlite"
              ? ++nextSequence
              : Number(
                  (await query.rows("SELECT nextval('run_batch_sequence_numbers') AS next"))[0]!
                    .next,
                );
        rows.push(row);
      }
      const collection = records[0]?.collection;
      if (collection) {
        if (records.some((record) => record.collection !== collection))
          throw new Error("A version-copy page must contain one collection.");
        const columns = Object.keys(rows[0]!);
        const pageSize = Math.max(1, Math.floor(512 / columns.length));
        for (let start = 0; start < rows.length; start += pageSize) {
          const page = rows.slice(start, start + pageSize);
          await query.rows(
            `INSERT INTO "${collection}" (${columns.map((column) => `"${column}"`).join(",")}) VALUES ${page.map(() => `(${columns.map(() => "?").join(",")})`).join(",")}`,
            page.flatMap((row) => columns.map((column) => row[column] ?? null)),
          );
        }
      }
      await this.saveWith(query, state, token);
    });
  }
  async finish(
    state: VersionCopyState,
    manifest: Parameters<ProjectVersionCopyRepository["finish"]>[1],
    token: string,
  ): Promise<void> {
    // Verify one indexed collection at a time; publication is the only final transaction.
    for (const collection of manifest.collections) {
      const definition = table(collection.name);
      const count = Number(
        (
          await this.sql.rows(
            `${versionCopyScopeSql(this.sql.dialect)} SELECT COUNT(*) AS count FROM "${definition.name}" c WHERE ${definition.predicate}`,
            [state.targetProjectId, state.targetVersionId],
          )
        )[0]!.count,
      );
      if (count !== collection.count)
        throw new DomainError(
          "VERSION_COPY_COUNT_MISMATCH",
          `复制校验失败：${collection.name} 的记录数量不一致。`,
        );
      await yieldTurn();
    }
    await this.sql.transaction(async (query) => {
      await this.assertOwned(query, state.id, token, false, state.updatedAt);
      if (
        !(
          await query.rows("SELECT id FROM projects WHERE id=? AND archived=FALSE", [
            state.targetProjectId,
          ])
        ).length
      )
        throw new DomainError("VERSION_COPY_SCOPE_INVALID", "目标项目在复制过程中已被删除或归档。");
      if (state.targetMode === "new")
        await query.rows("UPDATE project_versions SET status='active',updated_at=? WHERE id=?", [
          state.updatedAt,
          state.targetVersionId,
        ]);
      await query.rows(
        "UPDATE project_version_copies SET status='completed',phase='done',progress_percent=100,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND lease_token=?",
        [state.updatedAt, state.id, token],
      );
    });
  }
  async removePage(
    state: VersionCopyState,
    collection: Parameters<ProjectVersionCopyRepository["removePage"]>[1],
    keys: readonly VersionCopyRow[],
    token: string,
  ): Promise<void> {
    table(collection.name);
    await this.sql.transaction(async (query) => {
      await this.assertOwned(query, state.id, token, true, state.updatedAt);
      if (keys.length)
        await query.rows(
          `DELETE FROM "${collection.name}" WHERE ${keys.map(() => `(${collection.primaryKey.map((column) => `"${column}"=?`).join(" AND ")})`).join(" OR ")}`,
          keys.flatMap((key) => collection.primaryKey.map((column) => key[column] ?? null)),
        );
    });
  }
  async removeTarget(state: VersionCopyState, token: string): Promise<void> {
    await this.sql.transaction(async (query) => {
      await this.assertOwned(query, state.id, token, true, state.updatedAt);
      if (state.targetMode === "new")
        await query.rows("DELETE FROM project_versions WHERE id=?", [state.targetVersionId]);
      await query.rows(
        "UPDATE project_version_copies SET status='cancelled',lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND lease_token=?",
        [state.updatedAt, state.id, token],
      );
    });
  }
  private async assertOwned(
    query: VersionCopyQuery,
    id: string,
    token: string,
    cancelling: boolean,
    now: string,
  ): Promise<void> {
    const row = (
      await query.rows(
        "SELECT status,lease_token,lease_expires_at FROM project_version_copies WHERE id=?",
        [id],
      )
    )[0];
    if (
      !row ||
      row.lease_token !== token ||
      !row.lease_expires_at ||
      String(row.lease_expires_at) <= now
    )
      throw new DomainError("VERSION_COPY_LEASE_LOST", "复制任务已由其他工作器接管。");
    if (!cancelling && row.status === "cancelling")
      throw new DomainError("VERSION_COPY_CANCELLED", "复制任务已请求取消。");
    if (!["running", "cancelling"].includes(String(row.status)))
      throw new DomainError("VERSION_COPY_LEASE_LOST", "复制任务已结束。");
  }
  private async enqueue(query: VersionCopyQuery, job: JobEnvelope): Promise<void> {
    if (this.sql.dialect === "sqlite")
      await query.rows(
        "INSERT INTO queue_jobs (message_id,run_id,attempt,schema_version,kind,payload_json,priority,deduplication_key,status,available_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'available',?,?,?) ON CONFLICT(deduplication_key) DO NOTHING",
        [
          job.messageId,
          job.runId,
          job.attempt,
          job.schemaVersion,
          job.kind,
          JSON.stringify(job.payload),
          job.priority,
          job.deduplicationKey,
          job.createdAt,
          job.createdAt,
          job.createdAt,
        ],
      );
    else
      await query.rows(
        "INSERT INTO transactional_outbox (message_id,run_id,attempt,schema_version,subject,payload_json,deduplication_key,created_at,available_at) VALUES (?,?,?,?,'autoforge.jobs.v1.ready',?::jsonb,?,?,?) ON CONFLICT(deduplication_key) DO NOTHING",
        [
          job.messageId,
          job.runId,
          job.attempt,
          job.schemaVersion,
          JSON.stringify(job),
          job.deduplicationKey,
          job.createdAt,
          job.createdAt,
        ],
      );
  }
}

function table(name: string): VersionCopyTable {
  const collection = VERSION_COPY_TABLES.find((candidate) => candidate.name === name);
  if (!collection) throw new Error("Unsupported version-copy collection.");
  return collection;
}
function metricValue(state: VersionCopyState, column: (typeof METRIC_COLUMNS)[number]): number {
  return Number(state[camel(column) as keyof VersionCopyState]);
}
function mapState(row: VersionCopyRow): VersionCopyState {
  const values = Object.fromEntries(Object.entries(row).map(([key, value]) => [camel(key), value]));
  for (const column of METRIC_COLUMNS) values[camel(column)] = Number(row[column]);
  return {
    ...projectVersionCopySchema.parse(values),
    targetVersionId: String(row.target_version_id),
    requestKey: String(row.request_key),
    snapshot: row.snapshot_json
      ? projectVersionCopySnapshotSchema.parse(JSON.parse(String(row.snapshot_json)))
      : null,
    cursor: Number(row.cursor),
    collectionIndex: Number(row.collection_index),
    leaseToken: row.lease_token === null ? null : String(row.lease_token),
    leaseExpiresAt: row.lease_expires_at === null ? null : String(row.lease_expires_at),
  };
}
function matchingRequest(
  row: VersionCopyRow,
  input: Parameters<ProjectVersionCopyRepository["create"]>[0],
): VersionCopyState {
  const current = mapState(row);
  if (
    current.sourceProjectId !== input.sourceProjectId ||
    current.sourceVersionId !== input.sourceVersionId ||
    current.targetProjectId !== input.targetProjectId ||
    (input.targetVersionId
      ? current.targetMode !== "existing" || current.targetVersionId !== input.targetVersionId
      : current.targetMode !== "new" || current.targetVersionName !== input.targetVersionName)
  )
    throw new DomainError("VERSION_COPY_REQUEST_CONFLICT", "同一请求标识已用于其他版本复制。");
  return current;
}
