import type {
  AnalyticsFilter,
  ApiToken,
  CaseSuiteSchedule,
  GlobalSearchResult,
  LdapSyncJob,
  Notification,
  RetentionCategory,
  RetentionPolicy,
  RetentionPreview,
  ServiceAccount,
} from "@autoforge/contracts";
import type { PlatformOperationsRepository } from "@autoforge/application";
import { DomainError, isPermission, type Permission } from "@autoforge/domain";
import type { PoolClient } from "pg";

import type { AttemptLogStore } from "./attempt-log-store";
import type { PostgresDatabaseHandle } from "./postgres-database";
import {
  ANALYTICS_FACT_SCHEMA_VERSION,
  aggregateAnalytics,
  analyticsExportProjectIds,
  failureSignature,
  mapApiToken,
  mapAnalyticsExportJob,
  mapLdapSyncJob,
  mapNotification,
  mapSchedule,
  mapServiceAccount,
  resultCounts,
  type AnalyticsFactRow,
  type AnalyticsExportJobRow,
  type ApiTokenRow,
  type LdapSyncJobRow,
  type NotificationRow,
  type ScheduleRow,
  type ServiceAccountRow,
} from "./platform-operations-shared";

type Queryable = Pick<PostgresDatabaseHandle["pool"], "query">;
type CountRow = { count: string | number; bytes: string | number | null };

export class PostgresPlatformOperationsRepository implements PlatformOperationsRepository {
  constructor(
    private readonly handle: PostgresDatabaseHandle,
    private readonly attemptLogs?: AttemptLogStore,
  ) {}

  async readOperationalMetrics() {
    await this.ready();
    const result = await this.handle.pool.query<{
      activeLeases: string;
      runnerCapacity: string;
      runnerBusySlots: string;
      storedLogBytes: string;
      uploadedArtifacts: string;
      failedAttempts: string;
      pendingCleanupJobs: string;
      deadLetterCleanupJobs: string;
    }>(`SELECT
      (SELECT count(*) FROM assignment_leases WHERE status='active' AND expires_at > to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS "activeLeases",
      (SELECT COALESCE(sum(max_concurrency),0) FROM runners WHERE disabled=FALSE AND deregistered_at IS NULL) AS "runnerCapacity",
      (SELECT COALESCE(sum(busy_slots),0) FROM runners WHERE disabled=FALSE AND deregistered_at IS NULL) AS "runnerBusySlots",
      (SELECT COALESCE(sum(size_bytes),0) FROM attempt_log_chunks) AS "storedLogBytes",
      (SELECT count(*) FROM attempt_artifacts WHERE status='uploaded') AS "uploadedArtifacts",
      (SELECT count(*) FROM run_attempts WHERE status IN ('failed','timed_out')) AS "failedAttempts",
      (SELECT count(*) FROM cleanup_jobs WHERE status IN ('pending','failed','leased')) AS "pendingCleanupJobs",
      (SELECT count(*) FROM cleanup_jobs WHERE status='dead_letter') AS "deadLetterCleanupJobs"`);
    const row = result.rows[0];
    if (!row) throw new Error("Operational metrics query returned no row.");
    const metrics = Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, Number(value)]),
    ) as Awaited<ReturnType<PlatformOperationsRepository["readOperationalMetrics"]>>;
    // 用例日志保存在每批次独立 SQLite 文件中，磁盘占用按目录统计；旧表只保留历史数据。
    if (this.attemptLogs) {
      metrics.storedLogBytes = this.attemptLogs.directoryBytes();
    }
    return metrics;
  }

  async listServiceAccounts(): Promise<ServiceAccount[]> {
    await this.ready();
    const result = await this.handle.pool.query<ServiceAccountRow>(
      "SELECT * FROM service_accounts ORDER BY normalized_name, id",
    );
    return result.rows.map(mapServiceAccount);
  }

  async createServiceAccount(record: ServiceAccount): Promise<ServiceAccount> {
    await this.ready();
    try {
      await this.handle.pool.query(
        `INSERT INTO service_accounts
         (id, name, normalized_name, description, status, system_permissions_json,
          project_permissions_json, created_by, created_at, updated_at, revision)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          record.id,
          record.name,
          normalizeName(record.name),
          record.description,
          record.status,
          JSON.stringify(record.systemPermissions),
          JSON.stringify(record.projectPermissions),
          record.createdBy,
          record.createdAt,
          record.updatedAt,
          record.revision,
        ],
      );
    } catch (error) {
      throw databaseConflict(error, "SERVICE_ACCOUNT_NAME_CONFLICT", "服务账号名称已存在。");
    }
    return record;
  }

  async updateServiceAccount(
    input: Parameters<PlatformOperationsRepository["updateServiceAccount"]>[0],
  ): Promise<ServiceAccount> {
    await this.ready();
    const current = await this.requiredServiceAccountRow(input.accountId);
    try {
      const result = await this.handle.pool.query(
        `UPDATE service_accounts SET name=$1, normalized_name=$2, description=$3, status=$4,
         system_permissions_json=$5, project_permissions_json=$6, updated_at=$7,
         revision=revision+1 WHERE id=$8 AND revision=$9`,
        [
          input.name ?? current.name,
          normalizeName(input.name ?? current.name),
          input.description ?? current.description,
          input.status ?? current.status,
          input.systemPermissions === undefined
            ? current.system_permissions_json
            : JSON.stringify(input.systemPermissions),
          input.projectPermissions === undefined
            ? current.project_permissions_json
            : JSON.stringify(input.projectPermissions),
          input.updatedAt,
          input.accountId,
          input.expectedRevision,
        ],
      );
      if (result.rowCount !== 1) versionConflict();
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw databaseConflict(error, "SERVICE_ACCOUNT_NAME_CONFLICT", "服务账号名称已存在。");
    }
    return mapServiceAccount(await this.requiredServiceAccountRow(input.accountId));
  }

  async listApiTokens(accountId: string): Promise<ApiToken[]> {
    await this.ready();
    const result = await this.handle.pool.query<ApiTokenRow>(
      "SELECT * FROM api_tokens WHERE service_account_id=$1 ORDER BY created_at DESC, id",
      [accountId],
    );
    return result.rows.map(mapApiToken);
  }

  async createApiToken(record: ApiToken & { tokenHash: string }): Promise<ApiToken> {
    await this.ready();
    await this.requiredServiceAccountRow(record.serviceAccountId);
    await this.handle.pool.query(
      `INSERT INTO api_tokens
       (id,service_account_id,name,token_prefix,token_hash,scopes_json,expires_at,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        record.id,
        record.serviceAccountId,
        record.name,
        record.prefix,
        record.tokenHash,
        JSON.stringify(record.scopes),
        record.expiresAt,
        record.createdAt,
      ],
    );
    return record;
  }

  async revokeApiToken(input: { tokenId: string; revokedAt: string }): Promise<ApiToken> {
    await this.ready();
    const result = await this.handle.pool.query<ApiTokenRow>(
      `UPDATE api_tokens SET revoked_at=COALESCE(revoked_at,$1) WHERE id=$2 RETURNING *`,
      [input.revokedAt, input.tokenId],
    );
    if (!result.rows[0]) throw new DomainError("API_TOKEN_NOT_FOUND", "API 令牌不存在。");
    return mapApiToken(result.rows[0]);
  }

  async authenticateApiToken(
    input: Parameters<PlatformOperationsRepository["authenticateApiToken"]>[0],
  ) {
    await this.ready();
    return withTransaction(this.handle, async (client) => {
      const tokenResult = await client.query<ApiTokenRow>(
        `SELECT t.* FROM api_tokens t JOIN service_accounts a ON a.id=t.service_account_id
         WHERE t.token_hash=$1 AND t.revoked_at IS NULL AND t.expires_at>$2
           AND a.status='active' FOR UPDATE OF t`,
        [input.tokenHash, input.usedAt],
      );
      const row = tokenResult.rows[0];
      if (!row) return null;
      await client.query("UPDATE api_tokens SET last_used_at=$1 WHERE id=$2", [
        input.usedAt,
        row.id,
      ]);
      const account = mapServiceAccount(
        await requiredServiceAccountRow(client, row.service_account_id),
      );
      const token = mapApiToken({ ...row, last_used_at: input.usedAt });
      const allowed = new Set<Permission>(
        [...account.systemPermissions, ...Object.values(account.projectPermissions).flat()].filter(
          isPermission,
        ),
      );
      return {
        serviceAccount: account,
        token,
        effectiveScopes: token.scopes.filter(isPermission).filter((scope) => allowed.has(scope)),
      };
    });
  }

  async listSchedules(projectIds?: readonly string[]): Promise<CaseSuiteSchedule[]> {
    await this.ready();
    if (projectIds?.length === 0) return [];
    const result = await this.handle.pool.query<ScheduleRow>(
      `SELECT s.*,
         (SELECT receipt.status FROM scheduled_trigger_receipts receipt
          WHERE receipt.schedule_id=s.id ORDER BY receipt.scheduled_for DESC LIMIT 1)
           AS last_trigger_status,
         (SELECT receipt.batch_id FROM scheduled_trigger_receipts receipt
          WHERE receipt.schedule_id=s.id ORDER BY receipt.scheduled_for DESC LIMIT 1)
           AS last_batch_id
       FROM case_suite_schedules s
       ${projectIds ? "WHERE s.project_id=ANY($1::text[])" : ""}
       ORDER BY s.next_trigger_at,s.id`,
      projectIds ? [[...projectIds]] : [],
    );
    return result.rows.map(mapSchedule);
  }

  async findScheduleBySuite(suiteId: string): Promise<CaseSuiteSchedule | null> {
    await this.ready();
    const result = await this.handle.pool.query<ScheduleRow>(
      "SELECT * FROM case_suite_schedules WHERE suite_id=$1",
      [suiteId],
    );
    return result.rows[0] ? mapSchedule(result.rows[0]) : null;
  }

  async upsertSchedule(record: CaseSuiteSchedule, expectedRevision?: number) {
    await this.ready();
    return withTransaction(this.handle, async (client) => {
      const currentResult = await client.query<ScheduleRow>(
        "SELECT * FROM case_suite_schedules WHERE suite_id=$1 FOR UPDATE",
        [record.suiteId],
      );
      const current = currentResult.rows[0];
      if (!current) {
        if (expectedRevision !== undefined) versionConflict();
        await client.query(
          `INSERT INTO case_suite_schedules
           (id,suite_id,project_id,cron_expression,time_zone,missed_run_policy,enabled,
            next_trigger_at,last_trigger_at,revision,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11)`,
          [
            record.id,
            record.suiteId,
            record.projectId,
            record.cronExpression,
            record.timeZone,
            record.missedRunPolicy,
            record.enabled,
            record.nextTriggerAt,
            record.lastTriggerAt ?? null,
            record.createdAt,
            record.updatedAt,
          ],
        );
      } else {
        if (expectedRevision === undefined || expectedRevision !== current.revision)
          versionConflict();
        const updated = await client.query(
          `UPDATE case_suite_schedules SET cron_expression=$1,time_zone=$2,missed_run_policy=$3,
           enabled=$4,next_trigger_at=$5,revision=revision+1,updated_at=$6
           WHERE id=$7 AND revision=$8`,
          [
            record.cronExpression,
            record.timeZone,
            record.missedRunPolicy,
            record.enabled,
            record.nextTriggerAt,
            record.updatedAt,
            current.id,
            expectedRevision,
          ],
        );
        if (updated.rowCount !== 1) versionConflict();
      }
      const result = await client.query<ScheduleRow>(
        "SELECT * FROM case_suite_schedules WHERE suite_id=$1",
        [record.suiteId],
      );
      return mapSchedule(result.rows[0] as ScheduleRow);
    });
  }

  async deleteSchedule(scheduleId: string, expectedRevision: number): Promise<void> {
    await this.ready();
    const result = await this.handle.pool.query(
      "DELETE FROM case_suite_schedules WHERE id=$1 AND revision=$2",
      [scheduleId, expectedRevision],
    );
    if (result.rowCount !== 1) versionConflict();
  }

  async listDueSchedules(now: string, limit: number): Promise<CaseSuiteSchedule[]> {
    await this.ready();
    const result = await this.handle.pool.query<ScheduleRow>(
      `SELECT * FROM case_suite_schedules WHERE enabled=TRUE AND next_trigger_at<=$1
       ORDER BY next_trigger_at,id LIMIT $2`,
      [now, limit],
    );
    return result.rows.map(mapSchedule);
  }

  async claimScheduleTrigger(
    input: Parameters<PlatformOperationsRepository["claimScheduleTrigger"]>[0],
  ): Promise<boolean> {
    await this.ready();
    const result = await this.handle.pool.query(
      `INSERT INTO schedule_trigger_claims
       (schedule_id,scheduled_for,claim_id,lease_expires_at,claimed_at) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (schedule_id,scheduled_for) DO UPDATE SET
         claim_id=EXCLUDED.claim_id,lease_expires_at=EXCLUDED.lease_expires_at,
         claimed_at=EXCLUDED.claimed_at
       WHERE schedule_trigger_claims.lease_expires_at<=EXCLUDED.claimed_at`,
      [input.scheduleId, input.scheduledFor, input.claimId, input.leaseExpiresAt, input.claimedAt],
    );
    return result.rowCount === 1;
  }

  async completeScheduleTrigger(
    input: Parameters<PlatformOperationsRepository["completeScheduleTrigger"]>[0],
  ): Promise<boolean> {
    await this.ready();
    return withTransaction(this.handle, async (client) => {
      const claim = await client.query<{ claim_id: string }>(
        `SELECT claim_id FROM schedule_trigger_claims
         WHERE schedule_id=$1 AND scheduled_for=$2 FOR UPDATE`,
        [input.scheduleId, input.scheduledFor],
      );
      if (claim.rows[0]?.claim_id !== input.claimId) return false;
      const inserted = await client.query(
        `INSERT INTO scheduled_trigger_receipts
         (schedule_id,scheduled_for,batch_id,status,created_at) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (schedule_id,scheduled_for) DO NOTHING`,
        [
          input.scheduleId,
          input.scheduledFor,
          input.batchId ?? null,
          input.status,
          input.recordedAt,
        ],
      );
      if (inserted.rowCount !== 1) return false;
      await client.query(
        `UPDATE case_suite_schedules SET last_trigger_at=$1,next_trigger_at=$2,
         revision=revision+1,updated_at=$3 WHERE id=$4`,
        [input.scheduledFor, input.nextTriggerAt, input.recordedAt, input.scheduleId],
      );
      await client.query(
        `DELETE FROM schedule_trigger_claims
         WHERE schedule_id=$1 AND scheduled_for=$2 AND claim_id=$3`,
        [input.scheduleId, input.scheduledFor, input.claimId],
      );
      return true;
    });
  }

  async createLdapSyncJob(record: LdapSyncJob): Promise<LdapSyncJob> {
    await this.ready();
    await this.handle.pool.query(
      `INSERT INTO ldap_sync_jobs
       (id,status,trigger_kind,checkpoint_json,processed_users,disabled_users,error_code,
        error_summary,requested_by,scheduled_at,started_at,finished_at,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        record.id,
        record.status,
        record.triggerKind,
        JSON.stringify(record.checkpoint),
        record.processedUsers,
        record.disabledUsers,
        record.errorCode ?? null,
        record.errorSummary ?? null,
        record.requestedBy ?? null,
        record.scheduledAt,
        record.startedAt ?? null,
        record.finishedAt ?? null,
        record.createdAt,
        record.updatedAt,
      ],
    );
    return record;
  }

  async updateLdapSyncJob(
    input: Parameters<PlatformOperationsRepository["updateLdapSyncJob"]>[0],
  ): Promise<LdapSyncJob> {
    await this.ready();
    const current = await this.requiredLdapSyncJobRow(input.jobId);
    const result = await this.handle.pool.query<LdapSyncJobRow>(
      `UPDATE ldap_sync_jobs SET status=$1,checkpoint_json=$2,processed_users=$3,
       disabled_users=$4,error_code=$5,error_summary=$6,started_at=$7,finished_at=$8,
       updated_at=$9 WHERE id=$10 RETURNING *`,
      [
        input.status,
        JSON.stringify(input.checkpoint ?? JSON.parse(current.checkpoint_json)),
        input.processedUsers ?? current.processed_users,
        input.disabledUsers ?? current.disabled_users,
        input.errorCode ?? current.error_code,
        input.errorSummary ?? current.error_summary,
        input.startedAt ?? current.started_at,
        input.finishedAt ?? current.finished_at,
        input.updatedAt,
        input.jobId,
      ],
    );
    return mapLdapSyncJob(result.rows[0] as LdapSyncJobRow);
  }

  async listLdapSyncJobs(limit: number): Promise<LdapSyncJob[]> {
    await this.ready();
    const result = await this.handle.pool.query<LdapSyncJobRow>(
      "SELECT * FROM ldap_sync_jobs ORDER BY created_at DESC,id DESC LIMIT $1",
      [limit],
    );
    return result.rows.map(mapLdapSyncJob);
  }

  async claimScheduledLdapSync(
    input: Parameters<PlatformOperationsRepository["claimScheduledLdapSync"]>[0],
  ): Promise<boolean> {
    await this.ready();
    return withTransaction(this.handle, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('autoforge.ldap.scheduled-sync.v1'))",
      );
      const result = await client.query<{ value_json: string }>(
        "SELECT value_json FROM system_settings WHERE setting_key='ldap.scheduled-sync.v1'",
      );
      const state = scheduledLdapState(result.rows[0]?.value_json);
      if (state.claimId && state.leaseExpiresAt && state.leaseExpiresAt > input.now) return false;
      if (state.nextAt && state.nextAt > input.now) return false;
      await client.query(
        `INSERT INTO system_settings(setting_key,value_json,updated_at,revision)
         VALUES ('ldap.scheduled-sync.v1',$1,$2,1)
         ON CONFLICT(setting_key) DO UPDATE SET value_json=EXCLUDED.value_json,
           updated_at=EXCLUDED.updated_at,revision=system_settings.revision+1`,
        [
          JSON.stringify({
            claimId: input.claimId,
            leaseExpiresAt: input.leaseExpiresAt,
            nextAt: state.nextAt ?? input.now,
          }),
          input.now,
        ],
      );
      return true;
    });
  }

  async completeScheduledLdapSync(
    input: Parameters<PlatformOperationsRepository["completeScheduledLdapSync"]>[0],
  ): Promise<boolean> {
    await this.ready();
    return withTransaction(this.handle, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('autoforge.ldap.scheduled-sync.v1'))",
      );
      const result = await client.query<{ value_json: string }>(
        "SELECT value_json FROM system_settings WHERE setting_key='ldap.scheduled-sync.v1' FOR UPDATE",
      );
      if (scheduledLdapState(result.rows[0]?.value_json).claimId !== input.claimId) return false;
      const updated = await client.query(
        `UPDATE system_settings SET value_json=$1,updated_at=$2,revision=revision+1
         WHERE setting_key='ldap.scheduled-sync.v1'`,
        [JSON.stringify({ nextAt: input.nextAt }), input.completedAt],
      );
      return updated.rowCount === 1;
    });
  }

  async listNotifications(input: Parameters<PlatformOperationsRepository["listNotifications"]>[0]) {
    await this.ready();
    if (input.projectIds?.length === 0) return { items: [] };
    const values: unknown[] = [input.userId];
    const where = ["user_id=$1"];
    if (input.unreadOnly) where.push("read_at IS NULL");
    if (input.projectIds) {
      values.push([...input.projectIds]);
      where.push(`(project_id IS NULL OR project_id=ANY($${values.length}::text[]))`);
    }
    if (input.cursor) {
      const cursor = decodeCursor(input.cursor);
      values.push(cursor.createdAt, cursor.id);
      where.push(`(created_at,id)<($${values.length - 1}::text,$${values.length}::text)`);
    }
    values.push(input.limit + 1);
    const result = await this.handle.pool.query<NotificationRow>(
      `SELECT * FROM notifications WHERE ${where.join(" AND ")}
       ORDER BY created_at DESC,id DESC LIMIT $${values.length}`,
      values,
    );
    const page = result.rows.slice(0, input.limit);
    return {
      items: page.map(mapNotification),
      ...(result.rows.length > input.limit && page.length > 0
        ? { nextCursor: encodeCursor(page.at(-1) as NotificationRow) }
        : {}),
    };
  }

  async createNotification(record: Notification): Promise<Notification> {
    await this.ready();
    await this.handle.pool.query(
      `INSERT INTO notifications
       (id,user_id,project_id,kind,severity,title,message,resource_type,resource_id,read_at,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        record.id,
        record.userId,
        record.projectId ?? null,
        record.kind,
        record.severity,
        record.title,
        record.message,
        record.resourceType ?? null,
        record.resourceId ?? null,
        record.readAt ?? null,
        record.createdAt,
      ],
    );
    return record;
  }

  async generateNotifications(
    input: Parameters<PlatformOperationsRepository["generateNotifications"]>[0],
  ): Promise<number> {
    await this.ready();
    return withTransaction(this.handle, async (client) => {
      const statements: Array<{ sql: string; values: unknown[] }> = [
        {
          sql: `INSERT INTO notifications
            (id,user_id,project_id,kind,severity,title,message,resource_type,resource_id,created_at)
            SELECT 'notice-batch-' || recipients.user_id || '-' || b.id,
                   recipients.user_id,b.project_id,'batch.completed',
                   CASE WHEN b.status='succeeded' THEN 'info' ELSE 'warning' END,
                   '执行批次已完成',b.suite_name || '：' || b.status,'run_batch',b.id,$1
            FROM run_batches b JOIN (
              SELECT project_id,user_id FROM project_role_bindings
              UNION SELECT id,owner_user_id FROM projects WHERE owner_user_id IS NOT NULL
            ) recipients ON recipients.project_id=b.project_id
            WHERE b.status IN ('succeeded','failed','cancelled') ORDER BY b.updated_at DESC LIMIT $2
            ON CONFLICT DO NOTHING`,
          values: [input.now, input.limit],
        },
        {
          sql: `INSERT INTO notifications
            (id,user_id,kind,severity,title,message,resource_type,resource_id,created_at)
            SELECT 'notice-runner-' || u.id || '-' || r.id,u.id,'runner.offline','critical',
                   'Runner 已离线',r.name || ' 最近心跳：' || r.last_seen_at,'runner',r.id,$1
            FROM runners r CROSS JOIN users u
            WHERE r.last_seen_at<$2 AND r.disabled=FALSE AND r.deregistered_at IS NULL
              AND u.status='active' AND EXISTS (
                SELECT 1 FROM user_system_roles usr JOIN roles role ON role.id=usr.role_id
                WHERE usr.user_id=u.id AND position('runner.read' in role.permissions_json)>0
              ) ORDER BY r.last_seen_at LIMIT $3 ON CONFLICT DO NOTHING`,
          values: [input.now, input.runnerOfflineBefore, input.limit],
        },
        {
          sql: `INSERT INTO notifications
            (id,user_id,kind,severity,title,message,resource_type,resource_id,created_at)
            SELECT 'notice-ldap-' || requested_by || '-' || id,requested_by,'ldap.sync_failed','warning',
                   'LDAP 同步失败',COALESCE(error_summary,'LDAP 同步失败。'),'ldap_sync_job',id,$1
            FROM ldap_sync_jobs WHERE status='failed' AND requested_by IS NOT NULL
            ORDER BY updated_at DESC LIMIT $2 ON CONFLICT DO NOTHING`,
          values: [input.now, input.limit],
        },
        {
          sql: `INSERT INTO notifications
            (id,user_id,kind,severity,title,message,resource_type,resource_id,created_at)
            SELECT 'notice-cleanup-' || u.id || '-' || j.id,u.id,'cleanup.dead_letter','critical',
                   '清理任务进入死信',j.category || ' / ' || j.resource_type,'cleanup_job',j.id,$1
            FROM cleanup_jobs j CROSS JOIN users u
            WHERE j.status='dead_letter' AND u.status='active' AND EXISTS (
              SELECT 1 FROM user_system_roles usr JOIN roles role ON role.id=usr.role_id
              WHERE usr.user_id=u.id AND position('settings.manage' in role.permissions_json)>0
            ) ORDER BY j.updated_at DESC LIMIT $2 ON CONFLICT DO NOTHING`,
          values: [input.now, input.limit],
        },
      ];
      let inserted = 0;
      for (const statement of statements) {
        const result = await client.query(statement.sql, statement.values);
        inserted += result.rowCount ?? 0;
      }
      return inserted;
    });
  }

  async markNotificationRead(input: { notificationId: string; userId: string; readAt: string }) {
    await this.ready();
    const result = await this.handle.pool.query(
      "UPDATE notifications SET read_at=COALESCE(read_at,$1) WHERE id=$2 AND user_id=$3",
      [input.readAt, input.notificationId, input.userId],
    );
    if (result.rowCount !== 1) {
      throw new DomainError("NOTIFICATION_NOT_FOUND", "通知不存在或不属于当前用户。");
    }
  }

  async ensureRetentionPolicies(records: RetentionPolicy[]): Promise<void> {
    await this.ready();
    await withTransaction(this.handle, async (client) => {
      for (const record of records) {
        await client.query(
          `INSERT INTO retention_policies
           (category,retention_days,minimum_days,maximum_days,updated_by,updated_at,revision)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (category) DO NOTHING`,
          [
            record.category,
            record.retentionDays,
            record.minimumDays,
            record.maximumDays,
            record.updatedBy ?? null,
            record.updatedAt,
            record.revision,
          ],
        );
      }
    });
  }

  async listRetentionPolicies(): Promise<RetentionPolicy[]> {
    await this.ready();
    const result = await this.handle.pool.query<{
      category: RetentionCategory;
      retention_days: number;
      minimum_days: number;
      maximum_days: number;
      updated_by: string | null;
      updated_at: string;
      revision: number;
    }>("SELECT * FROM retention_policies ORDER BY category");
    return result.rows.map((row) => ({
      category: row.category,
      retentionDays: row.retention_days,
      minimumDays: row.minimum_days,
      maximumDays: row.maximum_days,
      ...(row.updated_by ? { updatedBy: row.updated_by } : {}),
      updatedAt: row.updated_at,
      revision: row.revision,
    }));
  }

  async updateRetentionPolicy(
    input: Parameters<PlatformOperationsRepository["updateRetentionPolicy"]>[0],
  ): Promise<RetentionPolicy> {
    await this.ready();
    const result = await this.handle.pool.query(
      `UPDATE retention_policies SET retention_days=$1,updated_by=$2,updated_at=$3,
       revision=revision+1 WHERE category=$4 AND revision=$5
       AND $1 BETWEEN minimum_days AND maximum_days`,
      [input.retentionDays, input.actorId, input.updatedAt, input.category, input.expectedRevision],
    );
    if (result.rowCount !== 1) versionConflict();
    return (await this.listRetentionPolicies()).find(
      (policy) => policy.category === input.category,
    ) as RetentionPolicy;
  }

  async previewRetention(category: RetentionCategory, cutoffAt: string): Promise<RetentionPreview> {
    await this.ready();
    const row = await this.retentionCount(category, cutoffAt);
    return {
      category,
      cutoffAt,
      eligibleRecords: Number(row.count),
      eligibleBytes: Number(row.bytes ?? 0),
    };
  }

  async executeRetention(input: Parameters<PlatformOperationsRepository["executeRetention"]>[0]) {
    await this.ready();
    if (input.category === "log" && this.attemptLogs) {
      // 日志保存在每批次独立 SQLite 文件中；按批次文件整体回收，主库无日志行可删。
      const batchIds = await this.terminalBatchIdsBefore(input.cutoffAt);
      const limited = batchIds.slice(0, input.limit);
      for (const batchId of limited) {
        this.attemptLogs.removeBatchStore(batchId);
      }
      return { deletedRecords: limited.length, objectKeys: [] };
    }
    const result = await withTransaction(this.handle, (client) =>
      executePostgresRetention(client, input),
    );
    // 批次日志文件在数据库事务提交后删除；缺失文件时 removeBatchStore 为幂等 noop。
    for (const batchId of result.removedBatchStoreIds) {
      this.attemptLogs?.removeBatchStore(batchId);
    }
    return { deletedRecords: result.deletedRecords, objectKeys: result.objectKeys };
  }

  async claimRetentionCleanupJobs(
    input: Parameters<PlatformOperationsRepository["claimRetentionCleanupJobs"]>[0],
  ): ReturnType<PlatformOperationsRepository["claimRetentionCleanupJobs"]> {
    await this.ready();
    return withTransaction(this.handle, async (client) => {
      const result = await client.query<{
        id: string;
        category: string;
        resource_type: string;
        resource_id: string;
        object_key: string;
        attempt_count: number;
      }>(
        `WITH candidates AS (
           SELECT id FROM cleanup_jobs
           WHERE category LIKE 'retention-%' AND object_key IS NOT NULL AND available_at <= $1
             AND (status IN ('pending','failed') OR (status='leased' AND lease_expires_at <= $1))
           ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT $2
         )
         UPDATE cleanup_jobs j SET status='leased',lease_owner=$3,lease_expires_at=$4,
           attempt_count=j.attempt_count+1,updated_at=$1
         FROM candidates c WHERE j.id=c.id
         RETURNING j.id,j.category,j.resource_type,j.resource_id,j.object_key,j.attempt_count`,
        [input.now, input.limit, input.owner, input.leaseExpiresAt],
      );
      return result.rows.map((job) => ({
        id: job.id,
        category: job.category,
        resourceType: job.resource_type,
        resourceId: job.resource_id,
        objectKey: job.object_key,
        attemptCount: Number(job.attempt_count),
      }));
    });
  }

  async completeRetentionCleanupJob(
    input: Parameters<PlatformOperationsRepository["completeRetentionCleanupJob"]>[0],
  ): Promise<void> {
    await this.ready();
    await this.handle.pool.query(
      `UPDATE cleanup_jobs SET status=$1,error_summary=$2,available_at=$3,lease_owner=NULL,
       lease_expires_at=NULL,updated_at=$4 WHERE id=$5 AND status='leased' AND lease_owner=$6`,
      [
        input.status,
        input.errorSummary ?? null,
        input.availableAt,
        input.updatedAt,
        input.id,
        input.owner,
      ],
    );
  }

  async rebuildAnalyticsFacts(limit: number): Promise<number> {
    await this.ready();
    return withTransaction(this.handle, async (client) => {
      const result = await client.query<{
        attempt_id: string;
        project_id: string;
        batch_id: string;
        run_id: string;
        suite_id: string;
        case_definition_id: string;
        case_version: number;
        runner_id: string;
        environment_version_id: string | null;
        outcome: string;
        result_code: string | null;
        result_summary: string | null;
        duration_ms: number | null;
        testng_result_json: string | null;
        finished_at: string;
      }>(
        `SELECT a.id AS attempt_id,b.project_id,b.id AS batch_id,r.id AS run_id,b.suite_id,
                r.case_definition_id,r.case_version,a.runner_id,b.environment_version_id,
                a.outcome,a.result_code,a.result_summary,a.duration_ms,a.testng_result_json,a.finished_at
         FROM run_attempts a JOIN execution_runs r ON r.id=a.execution_run_id
         JOIN run_batches b ON b.id=r.batch_id LEFT JOIN analytics_facts f ON f.attempt_id=a.id
         WHERE (f.attempt_id IS NULL OR f.schema_version < $1)
           AND a.finished_at IS NOT NULL AND a.outcome IS NOT NULL
         ORDER BY a.finished_at,a.id LIMIT $2 FOR UPDATE OF a SKIP LOCKED`,
        [ANALYTICS_FACT_SCHEMA_VERSION, limit],
      );
      let inserted = 0;
      for (const row of result.rows) {
        const counts = resultCounts(row.testng_result_json);
        const write = await client.query(
          `INSERT INTO analytics_facts
           (attempt_id,project_id,batch_id,run_id,suite_id,case_definition_id,case_version,
            runner_id,environment_version_id,outcome,result_code,failure_signature,duration_ms,
            passed,failed,skipped,completed_at,schema_version)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
           ON CONFLICT (attempt_id) DO UPDATE SET
             project_id=EXCLUDED.project_id,
             batch_id=EXCLUDED.batch_id,
             run_id=EXCLUDED.run_id,
             suite_id=EXCLUDED.suite_id,
             case_definition_id=EXCLUDED.case_definition_id,
             case_version=EXCLUDED.case_version,
             runner_id=EXCLUDED.runner_id,
             environment_version_id=EXCLUDED.environment_version_id,
             outcome=EXCLUDED.outcome,
             result_code=EXCLUDED.result_code,
             failure_signature=EXCLUDED.failure_signature,
             duration_ms=EXCLUDED.duration_ms,
             passed=EXCLUDED.passed,
             failed=EXCLUDED.failed,
             skipped=EXCLUDED.skipped,
             completed_at=EXCLUDED.completed_at,
             schema_version=EXCLUDED.schema_version
           WHERE analytics_facts.schema_version < EXCLUDED.schema_version`,
          [
            row.attempt_id,
            row.project_id,
            row.batch_id,
            row.run_id,
            row.suite_id,
            row.case_definition_id,
            row.case_version,
            row.runner_id,
            row.environment_version_id,
            row.outcome,
            row.result_code,
            failureSignature(row.outcome, row.result_code, row.result_summary),
            row.duration_ms,
            counts.passed,
            counts.failed,
            counts.skipped,
            row.finished_at,
            ANALYTICS_FACT_SCHEMA_VERSION,
          ],
        );
        inserted += write.rowCount ?? 0;
      }
      return inserted;
    });
  }

  async readAnalytics(input: Parameters<PlatformOperationsRepository["readAnalytics"]>[0]) {
    await this.rebuildAnalyticsFacts(10_000);
    return aggregateAnalytics(
      await this.analyticsRows(input.filter, input.projectIds),
      input.generatedAt,
    );
  }

  async exportAnalytics(input: Parameters<PlatformOperationsRepository["exportAnalytics"]>[0]) {
    await this.rebuildAnalyticsFacts(input.maximumRows);
    return (await this.analyticsRows(input.filter, input.projectIds))
      .slice(0, input.maximumRows)
      .map((row) => ({ ...row }));
  }

  async createAnalyticsExportJob(
    record: Parameters<PlatformOperationsRepository["createAnalyticsExportJob"]>[0],
  ) {
    await this.ready();
    await withTransaction(this.handle, async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO analytics_export_jobs
         (id,requested_by,project_ids_json,filter_json,format,idempotency_key,status,
          progress_percent,created_at,updated_at)
         VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (requested_by,idempotency_key) DO NOTHING RETURNING id`,
        [
          record.job.id,
          record.job.requestedBy,
          record.projectIds === undefined ? null : JSON.stringify(record.projectIds),
          JSON.stringify(record.job.filter),
          record.job.format,
          record.idempotencyKey,
          record.job.status,
          record.job.progressPercent,
          record.job.createdAt,
          record.job.updatedAt,
        ],
      );
      if (!inserted.rows[0]) return;
      await client.query(
        `INSERT INTO transactional_outbox
         (message_id,run_id,attempt,schema_version,subject,payload_json,deduplication_key,
          created_at,available_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$8)`,
        [
          record.dispatchJob.messageId,
          record.dispatchJob.runId,
          record.dispatchJob.attempt,
          record.dispatchJob.schemaVersion,
          "autoforge.jobs.v1.ready",
          JSON.stringify(record.dispatchJob),
          record.dispatchJob.deduplicationKey,
          record.dispatchJob.createdAt,
        ],
      );
    });
    const result = await this.handle.pool.query<AnalyticsExportJobRow>(
      "SELECT * FROM analytics_export_jobs WHERE requested_by=$1 AND idempotency_key=$2",
      [record.job.requestedBy, record.idempotencyKey],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Analytics export job was not persisted.");
    return mapAnalyticsExportJob(row);
  }

  async getAnalyticsExportJob(jobId: string, requestedBy: string) {
    await this.ready();
    const result = await this.handle.pool.query<AnalyticsExportJobRow>(
      "SELECT * FROM analytics_export_jobs WHERE id=$1 AND requested_by=$2",
      [jobId, requestedBy],
    );
    return result.rows[0] ? mapAnalyticsExportJob(result.rows[0]) : null;
  }

  async claimAnalyticsExportJob(
    input: Parameters<PlatformOperationsRepository["claimAnalyticsExportJob"]>[0],
  ) {
    await this.ready();
    const result = await this.handle.pool.query<AnalyticsExportJobRow>(
      `UPDATE analytics_export_jobs
       SET status='running',progress_percent=10,started_at=COALESCE(started_at,$1),updated_at=$1
       WHERE id=$2 AND status IN ('queued','failed') RETURNING *`,
      [input.startedAt, input.jobId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const projectIds = analyticsExportProjectIds(row);
    return { job: mapAnalyticsExportJob(row), ...(projectIds === undefined ? {} : { projectIds }) };
  }

  async updateAnalyticsExportJob(
    input: Parameters<PlatformOperationsRepository["updateAnalyticsExportJob"]>[0],
  ) {
    await this.ready();
    const result = await this.handle.pool.query<AnalyticsExportJobRow>(
      `UPDATE analytics_export_jobs SET
         status=$1,progress_percent=$2,row_count=$3,size_bytes=$4,sha256=$5,object_key=$6,
         file_name=$7,error_code=$8,error_summary=$9,updated_at=$10,finished_at=$11
       WHERE id=$12 RETURNING *`,
      [
        input.status,
        input.progressPercent,
        input.rowCount ?? null,
        input.sizeBytes ?? null,
        input.sha256 ?? null,
        input.objectKey ?? null,
        input.fileName ?? null,
        input.errorCode ?? null,
        input.errorSummary ?? null,
        input.updatedAt,
        input.finishedAt ?? null,
        input.jobId,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new DomainError("ANALYTICS_EXPORT_NOT_FOUND", "分析导出任务不存在。");
    return mapAnalyticsExportJob(row);
  }

  async requestAnalyticsExportCancellation(
    input: Parameters<PlatformOperationsRepository["requestAnalyticsExportCancellation"]>[0],
  ) {
    await this.ready();
    await this.handle.pool.query(
      `UPDATE analytics_export_jobs SET
         status=CASE status WHEN 'queued' THEN 'cancelled' WHEN 'running' THEN 'cancel_requested' ELSE status END,
         progress_percent=CASE status WHEN 'queued' THEN 100 ELSE progress_percent END,
         finished_at=CASE status WHEN 'queued' THEN $1 ELSE finished_at END,
         updated_at=$1
       WHERE id=$2 AND requested_by=$3 AND status IN ('queued','running')`,
      [input.updatedAt, input.jobId, input.requestedBy],
    );
    const job = await this.getAnalyticsExportJob(input.jobId, input.requestedBy);
    if (!job) throw new DomainError("ANALYTICS_EXPORT_NOT_FOUND", "分析导出任务不存在。");
    return job;
  }

  async resolveAnalyticsExportObject(
    input: Parameters<PlatformOperationsRepository["resolveAnalyticsExportObject"]>[0],
  ) {
    await this.ready();
    const result = await this.handle.pool.query<AnalyticsExportJobRow>(
      `SELECT * FROM analytics_export_jobs
       WHERE id=$1 AND requested_by=$2 AND status='succeeded' AND object_key IS NOT NULL`,
      [input.jobId, input.requestedBy],
    );
    const row = result.rows[0];
    return row?.object_key
      ? {
          job: mapAnalyticsExportJob(row),
          objectKey: row.object_key,
          mediaType: row.format === "json" ? "application/json" : "text/csv",
        }
      : null;
  }

  async globalSearch(
    input: Parameters<PlatformOperationsRepository["globalSearch"]>[0],
  ): Promise<GlobalSearchResult> {
    await this.ready();
    if (input.projectIds?.length === 0) return { items: [] };
    const search = `%${escapeLike(input.query.toLocaleLowerCase("en-US"))}%`;
    const scope = input.projectIds ? " AND project_id=ANY($2::text[])" : "";
    const values = input.projectIds
      ? [search, [...input.projectIds], input.limit]
      : [search, input.limit];
    const limitParameter = input.projectIds ? "$3" : "$2";
    const [cases, suites, batches, runs, runners] = await Promise.all([
      this.handle.pool.query<SearchRow>(
        `SELECT id,project_id,display_name AS title,class_name AS subtitle FROM case_definitions
         WHERE archived=FALSE AND (lower(display_name) LIKE $1 ESCAPE '\\' OR lower(class_name) LIKE $1 ESCAPE '\\')
         ${scope} ORDER BY updated_at DESC LIMIT ${limitParameter}`,
        values,
      ),
      this.handle.pool.query<SearchRow>(
        `SELECT id,project_id,name AS title,COALESCE(description,'') AS subtitle FROM case_suites
         WHERE status='active' AND lower(name) LIKE $1 ESCAPE '\\' ${scope}
         ORDER BY updated_at DESC LIMIT ${limitParameter}`,
        values,
      ),
      this.handle.pool.query<SearchRow>(
        `SELECT id,project_id,suite_name AS title,status AS subtitle FROM run_batches
         WHERE (lower(suite_name) LIKE $1 ESCAPE '\\' OR lower(id) LIKE $1 ESCAPE '\\') ${scope}
         ORDER BY created_at DESC LIMIT ${limitParameter}`,
        values,
      ),
      this.handle.pool.query<SearchRow>(
        `SELECT r.id,b.project_id,r.display_name AS title,r.status AS subtitle
         FROM execution_runs r JOIN run_batches b ON b.id=r.batch_id
         WHERE (lower(r.display_name) LIKE $1 ESCAPE '\\' OR lower(r.id) LIKE $1 ESCAPE '\\')
         ${input.projectIds ? "AND b.project_id=ANY($2::text[])" : ""}
         ORDER BY r.created_at DESC LIMIT ${limitParameter}`,
        values,
      ),
      input.projectIds
        ? Promise.resolve({ rows: [] as SearchRow[] })
        : this.handle.pool.query<SearchRow>(
            `SELECT id,NULL AS project_id,name AS title,
                    os || ' · ' || architecture || ' · ' || agent_version AS subtitle
             FROM runners WHERE deregistered_at IS NULL AND lower(name) LIKE $1 ESCAPE '\\'
             ORDER BY updated_at DESC LIMIT $2`,
            [search, input.limit],
          ),
    ]);
    return {
      items: [
        ...searchItems("case", cases.rows, (id) => `/cases/${encodeURIComponent(id)}`),
        ...searchItems("suite", suites.rows, (id) => `/case-suites/${encodeURIComponent(id)}`),
        ...searchItems("batch", batches.rows, (id) => `/run-batches/${encodeURIComponent(id)}`),
        ...searchItems("run", runs.rows, (id) => `/run-batches?runId=${encodeURIComponent(id)}`),
        ...searchItems("runner", runners.rows, () => "/runners"),
      ].slice(0, input.limit),
    };
  }

  private async ready(): Promise<void> {
    await this.handle.ready;
  }

  private requiredServiceAccountRow(accountId: string) {
    return requiredServiceAccountRow(this.handle.pool, accountId);
  }

  private async requiredLdapSyncJobRow(jobId: string): Promise<LdapSyncJobRow> {
    const result = await this.handle.pool.query<LdapSyncJobRow>(
      "SELECT * FROM ldap_sync_jobs WHERE id=$1",
      [jobId],
    );
    if (!result.rows[0]) throw new DomainError("LDAP_SYNC_JOB_NOT_FOUND", "LDAP 同步任务不存在。");
    return result.rows[0];
  }

  private async retentionCount(category: RetentionCategory, cutoffAt: string): Promise<CountRow> {
    // Full 模式的任务队列由 JetStream 承担并通过 stream 保留策略回收，
    // PostgreSQL 中没有 queue_jobs 表；queue 类别在这里恒为零。
    if (category === "log" && this.attemptLogs) {
      // 日志已迁移到每批次独立 SQLite 文件：按终态批次汇总文件大小。
      const batchIds = await this.terminalBatchIdsBefore(cutoffAt);
      const stats = this.attemptLogs.batchStoreStats(batchIds);
      let bytes = 0;
      for (const value of stats.values()) bytes += value;
      return { count: batchIds.length, bytes };
    }
    const queries: Partial<Record<RetentionCategory, string>> = {
      execution:
        "SELECT count(*) AS count,0 AS bytes FROM run_batches WHERE status IN ('succeeded','failed','cancelled') AND updated_at<$1",
      log: `SELECT count(*) AS count,COALESCE(sum(size_bytes),0) AS bytes FROM attempt_log_chunks l
            JOIN run_attempts a ON a.id=l.attempt_id WHERE a.finished_at<$1`,
      artifact: `SELECT count(*) AS count,COALESCE(sum(size_bytes),0) AS bytes FROM attempt_artifacts f
                 JOIN run_attempts a ON a.id=f.attempt_id WHERE a.finished_at<$1 AND f.status='uploaded'`,
      source: `SELECT count(*) AS count,COALESCE(sum(size_bytes),0) AS bytes FROM case_sources
               WHERE lifecycle_status='deleting' AND updated_at<$1`,
      analytics: "SELECT count(*) AS count,0 AS bytes FROM analytics_facts WHERE completed_at<$1",
      audit: "SELECT count(*) AS count,0 AS bytes FROM audit_events WHERE recorded_at<$1",
      session: `SELECT count(*) AS count,0 AS bytes FROM user_sessions
                WHERE expires_at<$1 OR (revoked_at IS NOT NULL AND revoked_at<$1)`,
    };
    const query = queries[category];
    if (!query) return { count: 0, bytes: 0 };
    const result = await this.handle.pool.query<CountRow>(query, [cutoffAt]);
    return result.rows[0] as CountRow;
  }

  private async terminalBatchIdsBefore(cutoffAt: string): Promise<string[]> {
    const result = await this.handle.pool.query<{ id: string }>(
      `SELECT id FROM run_batches
       WHERE status IN ('succeeded','failed','cancelled') AND updated_at<$1
       ORDER BY updated_at`,
      [cutoffAt],
    );
    return result.rows.map((row) => row.id);
  }

  private async analyticsRows(
    filter: AnalyticsFilter,
    projectIds?: readonly string[],
  ): Promise<AnalyticsFactRow[]> {
    if (projectIds?.length === 0) return [];
    const where: string[] = [];
    const values: unknown[] = [];
    const add = (column: string, value: string | undefined, operator = "=") => {
      if (value === undefined) return;
      values.push(value);
      where.push(`${column}${operator}$${values.length}`);
    };
    if (projectIds) {
      values.push([...projectIds]);
      where.push(`project_id=ANY($${values.length}::text[])`);
    }
    add("project_id", filter.projectId);
    add("suite_id", filter.suiteId);
    add("case_definition_id", filter.caseDefinitionId);
    add("runner_id", filter.runnerId);
    add("environment_version_id", filter.environmentVersionId);
    add("outcome", filter.outcome);
    add("failure_signature", filter.failureSignature);
    if (filter.tag) {
      values.push(filter.tag);
      where.push(
        `EXISTS (SELECT 1 FROM case_definitions c WHERE c.id=analytics_facts.case_definition_id AND c.tags_json::jsonb ? $${values.length})`,
      );
    }
    add("completed_at", filter.completedAfter, ">=");
    add("completed_at", filter.completedBefore, "<=");
    const result = await this.handle.pool.query<AnalyticsFactRow>(
      `SELECT analytics_facts.*,
              COALESCE(
                (SELECT c.display_name FROM case_definitions c
                 WHERE c.id=analytics_facts.case_definition_id),
                analytics_facts.case_definition_id
              ) AS case_display_name,
              (SELECT a.result_summary FROM run_attempts a
               WHERE a.id=analytics_facts.attempt_id) AS failure_description
       FROM analytics_facts ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY completed_at,attempt_id LIMIT 100000`,
      values,
    );
    return result.rows.map((row) => ({
      ...row,
      duration_ms: row.duration_ms === null ? null : Number(row.duration_ms),
    }));
  }
}

type SearchRow = { id: string; project_id: string | null; title: string; subtitle: string };

async function executePostgresRetention(
  client: PoolClient,
  input: Parameters<PlatformOperationsRepository["executeRetention"]>[0],
): Promise<{ deletedRecords: number; objectKeys: string[]; removedBatchStoreIds: string[] }> {
  if (input.category === "artifact") {
    const candidates = await client.query<{ id: string; object_key: string | null }>(
      `SELECT f.id,f.object_key FROM attempt_artifacts f JOIN run_attempts a ON a.id=f.attempt_id
       WHERE a.finished_at<$1 AND f.status='uploaded' ORDER BY a.finished_at,f.id
       FOR UPDATE OF f SKIP LOCKED LIMIT $2`,
      [input.cutoffAt, input.limit],
    );
    let deletedRecords = 0;
    const objectKeys: string[] = [];
    for (const row of candidates.rows) {
      if (row.object_key) {
        objectKeys.push(row.object_key);
        await client.query(
          `INSERT INTO cleanup_jobs
           (id,category,resource_type,resource_id,object_key,status,attempt_count,available_at,created_at,updated_at)
           VALUES ($1,'retention-artifact','attempt-artifact',$2,$3,'pending',0,$4,$4,$4)
           ON CONFLICT (category,resource_type,resource_id) DO NOTHING`,
          [`retention-artifact:${row.id}`, row.id, row.object_key, input.recordedAt],
        );
      }
      const removed = await client.query("DELETE FROM attempt_artifacts WHERE id=$1", [row.id]);
      deletedRecords += removed.rowCount ?? 0;
    }
    return {
      deletedRecords,
      objectKeys,
      removedBatchStoreIds: [],
    };
  }
  if (input.category === "source") {
    return { deletedRecords: 0, objectKeys: [], removedBatchStoreIds: [] };
  }
  if (input.category === "execution") {
    // 先 SELECT 待删批次再删除，事务提交后调用方据此移除批次日志文件。
    const candidates = await client.query<{ id: string }>(
      `SELECT id FROM run_batches WHERE status IN ('succeeded','failed','cancelled') AND updated_at<$1
       AND NOT EXISTS (
         SELECT 1 FROM execution_runs r JOIN run_attempts a ON a.execution_run_id=r.id
         JOIN attempt_artifacts f ON f.attempt_id=a.id
         WHERE r.batch_id=run_batches.id AND f.status='uploaded'
       ) ORDER BY updated_at LIMIT $2 FOR UPDATE SKIP LOCKED`,
      [input.cutoffAt, input.limit],
    );
    const batchIds = candidates.rows.map((row) => row.id);
    if (batchIds.length === 0) {
      return { deletedRecords: 0, objectKeys: [], removedBatchStoreIds: [] };
    }
    const deleted = await client.query(`DELETE FROM run_batches WHERE id=ANY($1)`, [batchIds]);
    return {
      deletedRecords: deleted.rowCount ?? 0,
      objectKeys: [],
      removedBatchStoreIds: batchIds,
    };
  }
  // log 类别仅在未接入批次日志文件 store 时走旧表删除，用于清理迁移前的历史数据。
  const statements: Partial<Record<RetentionCategory, string>> = {
    log: `DELETE FROM attempt_log_chunks WHERE (attempt_id,stream,sequence) IN (
      SELECT l.attempt_id,l.stream,l.sequence FROM attempt_log_chunks l JOIN run_attempts a ON a.id=l.attempt_id
      WHERE a.finished_at<$1 ORDER BY a.finished_at,l.sequence LIMIT $2)`,
    analytics: `DELETE FROM analytics_facts WHERE attempt_id IN (
      SELECT attempt_id FROM analytics_facts WHERE completed_at<$1 ORDER BY completed_at LIMIT $2)`,
    audit: `DELETE FROM audit_events WHERE id IN (
      SELECT id FROM audit_events WHERE recorded_at<$1 ORDER BY recorded_at LIMIT $2)`,
    session: `DELETE FROM user_sessions WHERE id IN (
      SELECT id FROM user_sessions WHERE expires_at<$1 OR (revoked_at IS NOT NULL AND revoked_at<$1)
      ORDER BY created_at LIMIT $2)`,
  };
  const statement = statements[input.category];
  if (!statement) return { deletedRecords: 0, objectKeys: [], removedBatchStoreIds: [] };
  const result = await client.query(statement, [input.cutoffAt, input.limit]);
  return { deletedRecords: result.rowCount ?? 0, objectKeys: [], removedBatchStoreIds: [] };
}

async function withTransaction<T>(
  handle: PostgresDatabaseHandle,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await handle.pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function requiredServiceAccountRow(
  queryable: Queryable,
  accountId: string,
): Promise<ServiceAccountRow> {
  const result = await queryable.query<ServiceAccountRow>(
    "SELECT * FROM service_accounts WHERE id=$1",
    [accountId],
  );
  if (!result.rows[0]) throw new DomainError("SERVICE_ACCOUNT_NOT_FOUND", "服务账号不存在。");
  return result.rows[0];
}

function searchItems(
  kind: "case" | "suite" | "batch" | "run" | "runner",
  rows: SearchRow[],
  href: (id: string) => string,
) {
  return rows.map((row) => ({
    kind,
    id: row.id,
    ...(row.project_id ? { projectId: row.project_id } : {}),
    title: row.title,
    subtitle: row.subtitle,
    href: href(row.id),
  }));
}

function normalizeName(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function scheduledLdapState(valueJson?: string): {
  nextAt?: string;
  claimId?: string;
  leaseExpiresAt?: string;
} {
  if (!valueJson) return {};
  try {
    const value = JSON.parse(valueJson) as Record<string, unknown>;
    return {
      ...(typeof value.nextAt === "string" ? { nextAt: value.nextAt } : {}),
      ...(typeof value.claimId === "string" ? { claimId: value.claimId } : {}),
      ...(typeof value.leaseExpiresAt === "string" ? { leaseExpiresAt: value.leaseExpiresAt } : {}),
    };
  } catch {
    return {};
  }
}

function databaseConflict(error: unknown, code: string, message: string): DomainError {
  return new DomainError(code, message, { cause: error instanceof Error ? error : undefined });
}

function versionConflict(): never {
  throw new DomainError("REVISION_CONFLICT", "记录已被并发修改，请刷新后重试。");
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function encodeCursor(row: NotificationRow): string {
  return Buffer.from(JSON.stringify({ createdAt: row.created_at, id: row.id })).toString(
    "base64url",
  );
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    if (typeof value.createdAt === "string" && typeof value.id === "string") {
      return { createdAt: value.createdAt, id: value.id };
    }
  } catch {
    // Stable domain error below avoids leaking parser details.
  }
  throw new DomainError("CURSOR_INVALID", "分页游标无效。");
}
