import { DomainError } from "@autoforge/domain";
import type {
  LogArchiveRepository,
  LogArchiveRecord,
  ArchivedBatchLocation,
} from "@autoforge/application";
import type {
  LogArchiveJob,
  LogArchiveBatch,
  LogArchiveAttempt,
  LogArchiveOptions,
} from "@autoforge/contracts";

export interface LogArchiveQuery {
  jsonText(column: string, key: string): string;
  rows<T>(sql: string, parameters?: readonly unknown[]): Promise<T[]>;
}
type JobRow = Record<string, unknown>;
// Keep each standalone manifest and its entry index bounded even for empty-log batches.
const MAXIMUM_BATCHES_PER_ARCHIVE_VOLUME = 1000;
const countFields = {
  totalBatches: "total_batches",
  processedBatches: "processed_batches",
  cleanedBatches: "cleaned_batches",
  attemptCount: "attempt_count",
  chunkCount: "chunk_count",
  sourceBytes: "source_bytes",
  archiveBytes: "archive_bytes",
  reclaimedBytes: "reclaimed_bytes",
  estimatedTemporaryBytes: "estimated_temporary_bytes",
  diskReservedBytes: "disk_reserved_bytes",
} as const;
const textFields = {
  status: "status",
  filename: "filename",
  sha256: "sha256",
  errorMessage: "error_message",
  objectKey: "object_key",
  indexSha256: "index_sha256",
  plannedAt: "planning_completed_at",
  copyState: "copy_state",
  copyDeletedAt: "copy_deleted_at",
  copyRemovalError: "copy_removal_error",
} as const;

/** Shared bounded SQL, with dialect differences limited to parameter binding in the adapter. */
export class DatabaseLogArchiveRepository implements LogArchiveRepository {
  constructor(private readonly database: LogArchiveQuery) {}
  async create(
    id: string,
    month: string,
    projectId: string | undefined,
    actorId: string,
    now: string,
    options?: LogArchiveOptions,
  ): Promise<LogArchiveJob> {
    const bounds = monthBounds(month);
    await this.database.rows(
      `INSERT INTO log_archive_jobs(id,month,project_id,status,requested_by,created_at,updated_at,group_id,target_source_bytes,minimum_free_bytes,minimum_free_percent,source_cutoff_at,month_start_at,month_end_at)
       VALUES($1,$2,$3,'queued',$4,$5,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [
        id,
        month,
        projectId ?? null,
        actorId,
        now,
        options ? id : null,
        (options?.targetVolumeMiB ?? 1024) * 1024 ** 2,
        (options?.minimumFreeMiB ?? 1024) * 1024 ** 2,
        options?.minimumFreePercent ?? 10,
        options ? now : null,
        bounds.start,
        bounds.end,
      ],
    );
    return this.find(id);
  }
  async list(cursor?: string, actorId?: string) {
    const rows = await this.database.rows<JobRow>(
      `SELECT j.*,r.completed_at AS downloaded_at FROM log_archive_jobs j
       LEFT JOIN log_archive_download_receipts r ON r.archive_id=j.id AND r.actor_id=$2
       WHERE j.id<$1 ORDER BY j.id DESC LIMIT 21`,
      [cursor ?? "~", actorId ?? ""],
    );
    return {
      items: rows.slice(0, 20).map(view),
      ...(rows.length > 20 ? { nextCursor: String(rows[19]!.id) } : {}),
    };
  }
  async find(id: string): Promise<LogArchiveRecord> {
    const row = (
      await this.database.rows<JobRow>("SELECT * FROM log_archive_jobs WHERE id=$1", [id])
    )[0];
    if (!row) throw new DomainError("LOG_ARCHIVE_NOT_FOUND", "日志归档不存在。");
    return {
      ...view(row),
      ...(row.object_key ? { objectKey: String(row.object_key) } : {}),
      ...(row.index_sha256 ? { indexSha256: String(row.index_sha256) } : {}),
      requestedBy: String(row.requested_by),
      ...(row.source_cutoff_at ? { sourceCutoffAt: String(row.source_cutoff_at) } : {}),
      nextVolumePending: Boolean(row.next_volume_pending),
      ...(row.planning_completed_at ? { plannedAt: String(row.planning_completed_at) } : {}),
    };
  }
  async requestCleanup(id: string, now: string): Promise<void> {
    const rows = await this.database.rows(
      "UPDATE log_archive_jobs SET status='cleaning',cleanup_requested_at=$2,error_message=NULL,updated_at=$2 WHERE id=$1 AND (status='ready' OR (status='failed' AND object_key IS NOT NULL)) AND sha256 IS NOT NULL AND index_sha256 IS NOT NULL RETURNING id",
      [id, now],
    );
    if (!rows.length)
      throw new DomainError("LOG_ARCHIVE_NOT_READY", "归档未完成校验，不能清理原日志。");
  }
  async recordDownload(
    id: string,
    actorId: string,
    sha256: string,
    sizeBytes: number,
    now: string,
  ): Promise<void> {
    const rows = await this.database.rows(
      `INSERT INTO log_archive_download_receipts(archive_id,actor_id,sha256,size_bytes,completed_at)
       SELECT id,$2,$3,$4,$5 FROM log_archive_jobs WHERE id=$1 AND sha256=$3 AND archive_bytes=$4 AND object_key IS NOT NULL AND copy_state='retained'
       ON CONFLICT(archive_id,actor_id) DO UPDATE SET sha256=excluded.sha256,size_bytes=excluded.size_bytes,completed_at=excluded.completed_at RETURNING archive_id`,
      [id, actorId, sha256, sizeBytes, now],
    );
    if (!rows.length)
      throw new DomainError(
        "LOG_ARCHIVE_DOWNLOAD_CONFLICT",
        "下载完成时归档状态已变化，请刷新归档记录。",
      );
  }
  async requestCopyRemoval(
    id: string,
    actorId: string,
    sha256: string,
    now: string,
  ): Promise<void> {
    const job = await this.find(id);
    if (job.sha256 !== sha256)
      throw new DomainError(
        "LOG_ARCHIVE_DOWNLOAD_CONFLICT",
        "归档校验值已变化，请核对本地文件后重试。",
      );
    if (job.status !== "completed")
      throw new DomainError(
        "LOG_ARCHIVE_NOT_READY",
        "请先完成原日志清理，再删除已下载的归档副本。",
      );
    if (["delete_requested", "deleting", "deleted"].includes(job.copyState ?? "")) return;
    const rows = await this.database.rows(
      `UPDATE log_archive_jobs SET copy_state='delete_requested',download_confirmed_by=$2,download_confirmed_at=$4,copy_removal_error=NULL,updated_at=$4
       WHERE id=$1 AND status='completed' AND sha256=$3 AND copy_state IN ('retained','delete_failed')
       AND (EXISTS(SELECT 1 FROM log_archive_download_receipts r WHERE r.archive_id=$1 AND r.actor_id=$2 AND r.sha256=$3 AND r.size_bytes=log_archive_jobs.archive_bytes)
       OR (copy_state='delete_failed' AND download_confirmed_at IS NOT NULL)) RETURNING id`,
      [id, actorId, sha256, now],
    );
    if (!rows.length)
      throw new DomainError(
        "LOG_ARCHIVE_DOWNLOAD_REQUIRED",
        "当前账号尚未完整下载本卷，请先下载并确认离线查看正常，再删除平台副本。",
      );
  }
  async cancel(id: string, now: string): Promise<void> {
    const rows = await this.database.rows(
      "UPDATE log_archive_jobs SET cancel_requested_at=$2,updated_at=$2 WHERE id=$1 AND status IN ('queued','building','verifying','failed') AND object_key IS NULL RETURNING id",
      [id, now],
    );
    if (!rows.length)
      throw new DomainError(
        "LOG_ARCHIVE_CANCEL_CONFLICT",
        "当前归档不能取消；已完成的归档及清理需要保留。",
      );
  }
  async retry(id: string, now: string): Promise<void> {
    const rows = await this.database.rows(
      "UPDATE log_archive_jobs SET status='queued',error_message=NULL,updated_at=$2 WHERE id=$1 AND status='failed' AND object_key IS NULL AND cancel_requested_at IS NULL RETURNING id",
      [id, now],
    );
    if (!rows.length)
      throw new DomainError("LOG_ARCHIVE_RETRY_CONFLICT", "当前归档不能重新生成；请刷新后重试。");
  }
  async enqueueNextVolume(id: string, owner: string, nextId: string, now: string): Promise<void> {
    await this.database.rows(
      `INSERT INTO log_archive_jobs(id,month,project_id,status,requested_by,created_at,updated_at,group_id,volume_number,target_source_bytes,minimum_free_bytes,minimum_free_percent,source_cutoff_at,month_start_at,month_end_at)
       SELECT $1,month,project_id,'queued',requested_by,$4,$4,group_id,volume_number+1,target_source_bytes,minimum_free_bytes,minimum_free_percent,source_cutoff_at,month_start_at,month_end_at
       FROM log_archive_jobs WHERE id=$2 AND status IN ('ready','cleaning','completed') AND next_volume_pending=1 AND group_id IS NOT NULL
       AND EXISTS(SELECT 1 FROM log_archive_worker_lock WHERE id=1 AND owner=$3 AND lease_expires_at>$4)
       ON CONFLICT(group_id,volume_number) WHERE group_id IS NOT NULL DO NOTHING RETURNING id`,
      [nextId, id, owner, now],
    );
    await this.update(id, owner, { nextVolumePending: false }, now);
  }
  async archivedBatch(batchId: string): Promise<ArchivedBatchLocation | undefined> {
    const row = (
      await this.database.rows<{
        archive_id: string;
        object_key: string;
        index_sha256: string;
        copy_state: string;
      }>(
        "SELECT b.archive_id,j.object_key,j.index_sha256,j.copy_state FROM log_archive_batches b JOIN log_archive_jobs j ON j.id=b.archive_id WHERE b.batch_id=$1 AND b.state IN ('cleaning','cleaned') AND j.object_key IS NOT NULL",
        [batchId],
      )
    )[0];
    return row
      ? {
          archiveId: row.archive_id,
          objectKey: row.object_key,
          indexSha256: row.index_sha256,
          ...(row.copy_state !== "retained" ? { offline: true } : {}),
        }
      : undefined;
  }
  async claim(
    owner: string,
    now: string,
    expiresAt: string,
  ): Promise<LogArchiveRecord | undefined> {
    const pending = await this.database.rows(
      "SELECT 1 FROM log_archive_jobs WHERE status IN ('queued','building','verifying','cleaning') OR (status IN ('ready','completed') AND next_volume_pending=1) OR copy_state IN ('delete_requested','deleting') OR (status='failed' AND cancel_requested_at IS NOT NULL AND object_key IS NULL) LIMIT 1",
    );
    if (!pending.length) return;
    const lock = await this.database.rows<{
      owner: string | null;
      lease_expires_at: string | null;
    }>("SELECT owner,lease_expires_at FROM log_archive_worker_lock WHERE id=1");
    if (lock[0]?.owner && lock[0].owner !== owner && lock[0].lease_expires_at! > now) return;
    const acquired = await this.database.rows(
      "UPDATE log_archive_worker_lock SET owner=$1,lease_expires_at=$3 WHERE id=1 AND (owner=$1 OR lease_expires_at IS NULL OR lease_expires_at<=$2) RETURNING id",
      [owner, now, expiresAt],
    );
    if (!acquired.length) return;
    const rows = await this.database.rows<{ id: string }>(
      "SELECT id FROM log_archive_jobs WHERE status IN ('queued','building','verifying','cleaning') OR (status IN ('ready','completed') AND next_volume_pending=1) OR copy_state IN ('delete_requested','deleting') OR (status='failed' AND cancel_requested_at IS NOT NULL AND object_key IS NULL) ORDER BY CASE WHEN copy_state IN ('delete_requested','deleting') THEN 0 WHEN status='cleaning' THEN 1 ELSE 2 END,created_at LIMIT 1",
    );
    if (!rows[0]) {
      await this.release(owner);
      return;
    }
    await this.database.rows(
      "UPDATE log_archive_jobs SET lease_owner=$2,lease_expires_at=$3 WHERE id=$1 RETURNING id",
      [rows[0].id, owner, expiresAt],
    );
    return this.find(rows[0].id);
  }
  async renew(owner: string, now: string, expiresAt: string): Promise<boolean> {
    const rows = await this.database.rows(
      "UPDATE log_archive_worker_lock SET lease_expires_at=$3 WHERE id=1 AND owner=$1 AND lease_expires_at>$2 RETURNING id",
      [owner, now, expiresAt],
    );
    if (!rows.length) return false;
    await this.database.rows(
      "UPDATE log_archive_jobs SET lease_expires_at=$2 WHERE lease_owner=$1 AND status IN ('building','verifying','cleaning') RETURNING id",
      [owner, expiresAt],
    );
    return true;
  }
  async release(owner: string): Promise<void> {
    await this.database.rows(
      "UPDATE log_archive_worker_lock SET owner=NULL,lease_expires_at=NULL WHERE id=1 AND owner=$1 RETURNING id",
      [owner],
    );
  }
  async update(
    id: string,
    owner: string,
    patch: Partial<LogArchiveRecord>,
    now: string,
  ): Promise<void> {
    const parameters: unknown[] = [id, owner, now];
    const assignments = ["updated_at=$3", "version=version+1"];
    for (const [name, column] of Object.entries({
      ...countFields,
      ...textFields,
      nextVolumePending: "next_volume_pending",
    })) {
      const value = patch[name as keyof LogArchiveRecord];
      if (value === undefined) continue;
      parameters.push(name === "nextVolumePending" ? Number(value) : value);
      assignments.push(`${column}=$${parameters.length}`);
    }
    const publicationGuard = patch.status === "ready" ? " AND cancel_requested_at IS NULL" : "";
    const result = await this.database.rows(
      `UPDATE log_archive_jobs SET ${assignments.join(",")} WHERE id=$1 AND lease_owner=$2${publicationGuard} AND EXISTS(SELECT 1 FROM log_archive_worker_lock WHERE id=1 AND owner=$2 AND lease_expires_at>$3) RETURNING id`,
      parameters,
    );
    if (!result.length) {
      if (patch.status === "ready" && (await this.find(id)).cancelRequested)
        throw new DomainError("LOG_ARCHIVE_CANCELLED", "日志归档已取消，原日志保留。");
      throw new DomainError("LOG_ARCHIVE_LEASE_LOST", "归档工作租约已失效，将由后台安全恢复。");
    }
    if (patch.status === "cancelled")
      await this.database.rows(
        "DELETE FROM log_archive_batches WHERE archive_id=$1 AND state NOT IN ('cleaning','cleaned') RETURNING batch_id",
        [id],
      );
  }
  async reserveBatches(
    job: LogArchiveRecord,
    owner: string,
    now: string,
    checkpoint?: () => Promise<void>,
    volume?: {
      maximumSourceBytes: number;
      sizes(batchIds: readonly string[]): Promise<Map<string, number>>;
    },
  ): Promise<number> {
    if (job.plannedAt) return this.reservedCount(job.id);
    const bounds = monthBounds(job.month);
    let cursor = "",
      sourceBytes = 0,
      selected = 0,
      hasNext = false;
    for (;;) {
      await checkpoint?.();
      // Batch terminal time is updated_at. Active leases exclude delayed final uploads and cross-month in-flight work.
      const rows = await this.database.rows<{ id: string }>(
        `SELECT b.id FROM run_batches b WHERE b.id>$1 AND b.status IN ('succeeded','failed','cancelled') AND b.updated_at>=$2 AND b.updated_at<$3
        AND (CAST($4 AS TEXT) IS NULL OR b.project_id=$4) AND (CAST($7 AS TEXT) IS NULL OR b.updated_at<=$7) AND NOT EXISTS(SELECT 1 FROM assignments a JOIN assignment_leases l ON l.assignment_id=a.id WHERE a.batch_id=b.id AND l.status='active' AND l.expires_at>$5)
        AND NOT EXISTS(SELECT 1 FROM log_archive_batches x WHERE x.batch_id=b.id AND x.archive_id<>$6) ORDER BY b.id LIMIT 100`,
        [
          cursor,
          bounds.start,
          bounds.end,
          job.projectId ?? null,
          now,
          job.id,
          job.sourceCutoffAt ?? null,
        ],
      );
      const sizes = volume
        ? await volume.sizes(rows.map((row) => row.id))
        : new Map<string, number>();
      for (const row of rows) {
        const bytes = Math.max(0, sizes.get(row.id) ?? 0);
        if (
          volume &&
          selected > 0 &&
          (sourceBytes + bytes > volume.maximumSourceBytes ||
            selected >= MAXIMUM_BATCHES_PER_ARCHIVE_VOLUME)
        ) {
          hasNext = true;
          break;
        }
        const reserved = await this.database.rows(
          `INSERT INTO log_archive_batches(batch_id,archive_id,state,source_bytes) SELECT $1,$2,'reserved',$5 WHERE EXISTS(SELECT 1 FROM log_archive_worker_lock WHERE id=1 AND owner=$3 AND lease_expires_at>$4)
           ON CONFLICT(batch_id) DO UPDATE SET source_bytes=excluded.source_bytes WHERE log_archive_batches.archive_id=excluded.archive_id
           RETURNING batch_id`,
          [row.id, job.id, owner, now, bytes],
        );
        if (!reserved.length)
          throw new DomainError("LOG_ARCHIVE_LEASE_LOST", "归档规划所有权已变化，请等待后台接管。");
        selected++;
        sourceBytes += bytes;
        cursor = row.id;
      }
      if (hasNext || rows.length < 100) break;
    }
    await this.update(job.id, owner, { plannedAt: now, nextVolumePending: hasNext }, now);
    return this.reservedCount(job.id);
  }
  private async reservedCount(id: string): Promise<number> {
    const rows = await this.database.rows<{ total: number | string }>(
      "SELECT count(*) AS total FROM log_archive_batches WHERE archive_id=$1",
      [id],
    );
    return Number(rows[0]!.total);
  }
  async attemptCount(id: string): Promise<number> {
    const rows = await this.database.rows<{ total: number | string }>(
      "SELECT count(*) AS total FROM log_archive_batches b JOIN execution_runs r ON r.batch_id=b.batch_id JOIN run_attempts a ON a.execution_run_id=r.id WHERE b.archive_id=$1",
      [id],
    );
    return Number(rows[0]!.total);
  }
  async batches(id: string, cursor = ""): Promise<LogArchiveBatch[]> {
    return this.database.rows<LogArchiveBatch>(
      `SELECT b.id,COALESCE(b.project_id,'') AS "projectId",COALESCE(p.name,'') AS "projectName",COALESCE(v.name,'') AS "projectVersionName",COALESCE(t.name,'') AS "testStageName",b.suite_name AS "suiteName",b.sequence_number AS "sequenceNumber",b.status,b.created_at AS "createdAt",b.updated_at AS "finishedAt"
      FROM log_archive_batches x JOIN run_batches b ON b.id=x.batch_id LEFT JOIN projects p ON p.id=b.project_id LEFT JOIN project_versions v ON v.id=${this.database.jsonText("b.policy_json", "projectVersionId")} LEFT JOIN test_stages t ON t.id=${this.database.jsonText("b.policy_json", "testStageId")}
      WHERE x.archive_id=$1 AND b.id>$2 ORDER BY b.id LIMIT 100`,
      [id, cursor],
    );
  }
  async attempts(batchId: string, cursor = ""): Promise<Omit<LogArchiveAttempt, "streams">[]> {
    const [runCursor = "", attemptCursor = ""] = cursor.split("/");
    return this.database.rows<Omit<LogArchiveAttempt, "streams">>(
      `SELECT a.id,a.execution_run_id AS "executionRunId",r.case_definition_id AS "caseId",r.case_type AS "caseType",r.class_name AS "className",r.display_name AS "displayName",a.execution_round AS "roundIndex",a.attempt_number AS "attemptNumber",a.status,a.outcome,a.started_at AS "startedAt",a.finished_at AS "finishedAt" FROM run_attempts a JOIN execution_runs r ON r.id=a.execution_run_id WHERE r.batch_id=$1 AND r.id>=$2 AND (r.id>$2 OR a.id>$3) ORDER BY r.id,a.id LIMIT 100`,
      [batchId, runCursor, attemptCursor],
    );
  }
  async batchState(
    id: string,
    batchId: string,
    state: "exported" | "verified" | "cleaning" | "cleaned",
    owner: string,
    now: string,
  ): Promise<void> {
    const rows = await this.database.rows(
      "UPDATE log_archive_batches SET state=$3,archived_at=$5 WHERE archive_id=$1 AND batch_id=$2 AND EXISTS(SELECT 1 FROM log_archive_worker_lock WHERE id=1 AND owner=$4 AND lease_expires_at>$5) RETURNING batch_id",
      [id, batchId, state, owner, now],
    );
    if (!rows.length)
      throw new DomainError("LOG_ARCHIVE_LEASE_LOST", "归档租约或批次已变化，停止清理原日志。");
  }
  async cleanupBatches(id: string): Promise<string[]> {
    return (
      await this.database.rows<{ batch_id: string }>(
        "SELECT batch_id FROM log_archive_batches WHERE archive_id=$1 AND state<>'cleaned' ORDER BY batch_id LIMIT 20",
        [id],
      )
    ).map((r) => r.batch_id);
  }
}
function view(row: JobRow): LogArchiveJob {
  const counts = Object.fromEntries(
    Object.entries(countFields).map(([name, column]) => [name, Number(row[column])]),
  ) as Pick<LogArchiveJob, keyof typeof countFields>;
  return {
    id: String(row.id),
    month: String(row.month),
    ...(row.project_id ? { projectId: String(row.project_id) } : {}),
    status: row.status as LogArchiveJob["status"],
    ...counts,
    ...(row.filename ? { filename: String(row.filename) } : {}),
    ...(row.sha256 ? { sha256: String(row.sha256) } : {}),
    ...(row.error_message ? { errorMessage: String(row.error_message) } : {}),
    cancelRequested: Boolean(row.cancel_requested_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    ...(row.group_id ? { groupId: String(row.group_id) } : {}),
    volumeNumber: Number(row.volume_number ?? 1),
    moreVolumesPending: Boolean(row.next_volume_pending),
    targetVolumeMiB: Number(row.target_source_bytes ?? 1073741824) / 1024 ** 2,
    minimumFreeMiB: Number(row.minimum_free_bytes ?? 1073741824) / 1024 ** 2,
    minimumFreePercent: Number(row.minimum_free_percent ?? 10),
    copyState: (row.copy_state ?? "retained") as NonNullable<LogArchiveJob["copyState"]>,
    ...(row.downloaded_at ? { downloadedAt: String(row.downloaded_at) } : {}),
    ...(row.copy_deleted_at ? { copyDeletedAt: String(row.copy_deleted_at) } : {}),
    ...(row.copy_removal_error ? { copyRemovalError: String(row.copy_removal_error) } : {}),
  };
}

function monthBounds(month: string): { start: string; end: string } {
  const start = new Date(`${month}-01T00:00:00+08:00`);
  const [year, index] = month.split("-").map(Number);
  const end = new Date(0);
  end.setUTCFullYear(year!, index!, 1);
  end.setUTCHours(0, 0, 0, 0);
  end.setTime(end.getTime() - 8 * 3600000);
  return { start: start.toISOString(), end: end.toISOString() };
}
