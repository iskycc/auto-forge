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

import type { AttemptLogStore } from "./attempt-log-store";
import type { SqliteDatabaseHandle } from "./database";
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

type CountRow = { count: number; bytes?: number | null };

export class SqlitePlatformOperationsRepository implements PlatformOperationsRepository {
  constructor(
    private readonly handle: SqliteDatabaseHandle,
    private readonly attemptLogs?: AttemptLogStore,
  ) {}

  async readOperationalMetrics() {
    const row = this.handle.client
      .prepare(
        `SELECT
          (SELECT count(*) FROM assignment_leases WHERE status='active' AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')) AS activeLeases,
          (SELECT COALESCE(sum(max_concurrency),0) FROM runners WHERE disabled=0 AND deregistered_at IS NULL) AS runnerCapacity,
          (SELECT COALESCE(sum(busy_slots),0) FROM runners WHERE disabled=0 AND deregistered_at IS NULL) AS runnerBusySlots,
          (SELECT count(*) FROM attempt_artifacts WHERE status='uploaded') AS uploadedArtifacts,
          (SELECT count(*) FROM run_attempts WHERE status IN ('failed','timed_out')) AS failedAttempts,
          (SELECT count(*) FROM cleanup_jobs WHERE status IN ('pending','failed','leased')) AS pendingCleanupJobs,
          (SELECT count(*) FROM cleanup_jobs WHERE status='dead_letter') AS deadLetterCleanupJobs`,
      )
      .get() as {
      activeLeases: number;
      runnerCapacity: number;
      runnerBusySlots: number;
      uploadedArtifacts: number;
      failedAttempts: number;
      pendingCleanupJobs: number;
      deadLetterCleanupJobs: number;
    };
    // 用例日志保存在每批次独立 SQLite 文件中，磁盘占用按目录统计。
    return { ...row, storedLogBytes: this.attemptLogs ? this.attemptLogs.directoryBytes() : 0 };
  }

  async listServiceAccounts(): Promise<ServiceAccount[]> {
    const rows = this.handle.client
      .prepare("SELECT * FROM service_accounts ORDER BY normalized_name, id")
      .all() as ServiceAccountRow[];
    return rows.map(mapServiceAccount);
  }

  async createServiceAccount(record: ServiceAccount): Promise<ServiceAccount> {
    try {
      this.handle.client
        .prepare(
          `INSERT INTO service_accounts
           (id, name, normalized_name, description, status, system_permissions_json,
            project_permissions_json, created_by, created_at, updated_at, revision)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
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
        );
    } catch (error) {
      throw databaseConflict(error, "SERVICE_ACCOUNT_NAME_CONFLICT", "服务账号名称已存在。");
    }
    return record;
  }

  async updateServiceAccount(
    input: Parameters<PlatformOperationsRepository["updateServiceAccount"]>[0],
  ): Promise<ServiceAccount> {
    const current = this.serviceAccountRow(input.accountId);
    if (!current) throw new DomainError("SERVICE_ACCOUNT_NOT_FOUND", "服务账号不存在。");
    const next = {
      name: input.name ?? current.name,
      description: input.description ?? current.description,
      status: input.status ?? current.status,
      systemPermissionsJson:
        input.systemPermissions === undefined
          ? current.system_permissions_json
          : JSON.stringify(input.systemPermissions),
      projectPermissionsJson:
        input.projectPermissions === undefined
          ? current.project_permissions_json
          : JSON.stringify(input.projectPermissions),
    };
    try {
      const result = this.handle.client
        .prepare(
          `UPDATE service_accounts
           SET name = ?, normalized_name = ?, description = ?, status = ?,
               system_permissions_json = ?, project_permissions_json = ?, updated_at = ?,
               revision = revision + 1
           WHERE id = ? AND revision = ?`,
        )
        .run(
          next.name,
          normalizeName(next.name),
          next.description,
          next.status,
          next.systemPermissionsJson,
          next.projectPermissionsJson,
          input.updatedAt,
          input.accountId,
          input.expectedRevision,
        );
      if (result.changes !== 1) versionConflict();
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw databaseConflict(error, "SERVICE_ACCOUNT_NAME_CONFLICT", "服务账号名称已存在。");
    }
    return mapServiceAccount(this.requiredServiceAccountRow(input.accountId));
  }

  async listApiTokens(accountId: string): Promise<ApiToken[]> {
    const rows = this.handle.client
      .prepare("SELECT * FROM api_tokens WHERE service_account_id = ? ORDER BY created_at DESC, id")
      .all(accountId) as ApiTokenRow[];
    return rows.map(mapApiToken);
  }

  async createApiToken(record: ApiToken & { tokenHash: string }): Promise<ApiToken> {
    const account = this.serviceAccountRow(record.serviceAccountId);
    if (!account) throw new DomainError("SERVICE_ACCOUNT_NOT_FOUND", "服务账号不存在。");
    this.handle.client
      .prepare(
        `INSERT INTO api_tokens
         (id, service_account_id, name, token_prefix, token_hash, scopes_json, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.serviceAccountId,
        record.name,
        record.prefix,
        record.tokenHash,
        JSON.stringify(record.scopes),
        record.expiresAt,
        record.createdAt,
      );
    return record;
  }

  async revokeApiToken(input: { tokenId: string; revokedAt: string }): Promise<ApiToken> {
    const result = this.handle.client
      .prepare("UPDATE api_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?")
      .run(input.revokedAt, input.tokenId);
    if (result.changes !== 1) throw new DomainError("API_TOKEN_NOT_FOUND", "API 令牌不存在。");
    return mapApiToken(this.requiredApiTokenRow(input.tokenId));
  }

  async authenticateApiToken(
    input: Parameters<PlatformOperationsRepository["authenticateApiToken"]>[0],
  ) {
    return this.handle.client.transaction(() => {
      const row = this.handle.client
        .prepare(
          `SELECT t.* FROM api_tokens t
           JOIN service_accounts a ON a.id = t.service_account_id
           WHERE t.token_hash = ? AND t.revoked_at IS NULL AND t.expires_at > ?
             AND a.status = 'active'`,
        )
        .get(input.tokenHash, input.usedAt) as ApiTokenRow | undefined;
      if (!row) return null;
      this.handle.client
        .prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?")
        .run(input.usedAt, row.id);
      const account = mapServiceAccount(this.requiredServiceAccountRow(row.service_account_id));
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
    })();
  }

  async listSchedules(projectIds?: readonly string[]): Promise<CaseSuiteSchedule[]> {
    if (projectIds?.length === 0) return [];
    const { clause, parameters } = inClause("s.project_id", projectIds);
    return (
      this.handle.client
        .prepare(
          `SELECT s.*,
             (SELECT receipt.status FROM scheduled_trigger_receipts receipt
              WHERE receipt.schedule_id=s.id ORDER BY receipt.scheduled_for DESC LIMIT 1)
               AS last_trigger_status,
             (SELECT receipt.batch_id FROM scheduled_trigger_receipts receipt
              WHERE receipt.schedule_id=s.id ORDER BY receipt.scheduled_for DESC LIMIT 1)
               AS last_batch_id
           FROM case_suite_schedules s ${clause} ORDER BY s.next_trigger_at, s.id`,
        )
        .all(...parameters) as ScheduleRow[]
    ).map(mapSchedule);
  }

  async findScheduleBySuite(suiteId: string): Promise<CaseSuiteSchedule | null> {
    const row = this.handle.client
      .prepare("SELECT * FROM case_suite_schedules WHERE suite_id = ?")
      .get(suiteId) as ScheduleRow | undefined;
    return row ? mapSchedule(row) : null;
  }

  async upsertSchedule(record: CaseSuiteSchedule, expectedRevision?: number) {
    const current = this.handle.client
      .prepare("SELECT * FROM case_suite_schedules WHERE suite_id = ?")
      .get(record.suiteId) as ScheduleRow | undefined;
    if (!current) {
      if (expectedRevision !== undefined) versionConflict();
      this.handle.client
        .prepare(
          `INSERT INTO case_suite_schedules
           (id, suite_id, project_id, cron_expression, time_zone, missed_run_policy, enabled,
            next_trigger_at, last_trigger_at, revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          record.id,
          record.suiteId,
          record.projectId,
          record.cronExpression,
          record.timeZone,
          record.missedRunPolicy,
          record.enabled ? 1 : 0,
          record.nextTriggerAt,
          record.lastTriggerAt ?? null,
          record.createdAt,
          record.updatedAt,
        );
    } else {
      if (expectedRevision === undefined || expectedRevision !== current.revision)
        versionConflict();
      const result = this.handle.client
        .prepare(
          `UPDATE case_suite_schedules
           SET cron_expression = ?, time_zone = ?, missed_run_policy = ?, enabled = ?,
               next_trigger_at = ?, revision = revision + 1, updated_at = ?
           WHERE id = ? AND revision = ?`,
        )
        .run(
          record.cronExpression,
          record.timeZone,
          record.missedRunPolicy,
          record.enabled ? 1 : 0,
          record.nextTriggerAt,
          record.updatedAt,
          current.id,
          expectedRevision,
        );
      if (result.changes !== 1) versionConflict();
    }
    return (await this.findScheduleBySuite(record.suiteId)) as CaseSuiteSchedule;
  }

  async deleteSchedule(scheduleId: string, expectedRevision: number): Promise<void> {
    const result = this.handle.client
      .prepare("DELETE FROM case_suite_schedules WHERE id = ? AND revision = ?")
      .run(scheduleId, expectedRevision);
    if (result.changes !== 1) versionConflict();
  }

  async listDueSchedules(now: string, limit: number): Promise<CaseSuiteSchedule[]> {
    return (
      this.handle.client
        .prepare(
          `SELECT * FROM case_suite_schedules
           WHERE enabled = 1 AND next_trigger_at <= ? ORDER BY next_trigger_at, id LIMIT ?`,
        )
        .all(now, limit) as ScheduleRow[]
    ).map(mapSchedule);
  }

  async claimScheduleTrigger(
    input: Parameters<PlatformOperationsRepository["claimScheduleTrigger"]>[0],
  ): Promise<boolean> {
    const result = this.handle.client
      .prepare(
        `INSERT INTO schedule_trigger_claims
         (schedule_id,scheduled_for,claim_id,lease_expires_at,claimed_at) VALUES (?,?,?,?,?)
         ON CONFLICT(schedule_id,scheduled_for) DO UPDATE SET
           claim_id=excluded.claim_id, lease_expires_at=excluded.lease_expires_at,
           claimed_at=excluded.claimed_at
         WHERE schedule_trigger_claims.lease_expires_at <= excluded.claimed_at`,
      )
      .run(
        input.scheduleId,
        input.scheduledFor,
        input.claimId,
        input.leaseExpiresAt,
        input.claimedAt,
      );
    return result.changes === 1;
  }

  async completeScheduleTrigger(
    input: Parameters<PlatformOperationsRepository["completeScheduleTrigger"]>[0],
  ): Promise<boolean> {
    return this.handle.client.transaction(() => {
      const claim = this.handle.client
        .prepare(
          "SELECT claim_id FROM schedule_trigger_claims WHERE schedule_id=? AND scheduled_for=?",
        )
        .get(input.scheduleId, input.scheduledFor) as { claim_id: string } | undefined;
      if (claim?.claim_id !== input.claimId) return false;
      const inserted = this.handle.client
        .prepare(
          `INSERT OR IGNORE INTO scheduled_trigger_receipts
           (schedule_id, scheduled_for, batch_id, status, created_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          input.scheduleId,
          input.scheduledFor,
          input.batchId ?? null,
          input.status,
          input.recordedAt,
        );
      if (inserted.changes !== 1) return false;
      this.handle.client
        .prepare(
          `UPDATE case_suite_schedules
           SET last_trigger_at = ?, next_trigger_at = ?, revision = revision + 1, updated_at = ?
           WHERE id = ?`,
        )
        .run(input.scheduledFor, input.nextTriggerAt, input.recordedAt, input.scheduleId);
      this.handle.client
        .prepare(
          "DELETE FROM schedule_trigger_claims WHERE schedule_id=? AND scheduled_for=? AND claim_id=?",
        )
        .run(input.scheduleId, input.scheduledFor, input.claimId);
      return true;
    })();
  }

  async createLdapSyncJob(record: LdapSyncJob): Promise<LdapSyncJob> {
    this.handle.client
      .prepare(
        `INSERT INTO ldap_sync_jobs
         (id, status, trigger_kind, checkpoint_json, processed_users, disabled_users,
          error_code, error_summary, requested_by, scheduled_at, started_at, finished_at,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
      );
    return record;
  }

  async updateLdapSyncJob(
    input: Parameters<PlatformOperationsRepository["updateLdapSyncJob"]>[0],
  ): Promise<LdapSyncJob> {
    const current = this.requiredLdapSyncJobRow(input.jobId);
    this.handle.client
      .prepare(
        `UPDATE ldap_sync_jobs
         SET status = ?, checkpoint_json = ?, processed_users = ?, disabled_users = ?,
             error_code = ?, error_summary = ?, started_at = ?, finished_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
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
      );
    return mapLdapSyncJob(this.requiredLdapSyncJobRow(input.jobId));
  }

  async listLdapSyncJobs(limit: number): Promise<LdapSyncJob[]> {
    return (
      this.handle.client
        .prepare("SELECT * FROM ldap_sync_jobs ORDER BY created_at DESC, id DESC LIMIT ?")
        .all(limit) as LdapSyncJobRow[]
    ).map(mapLdapSyncJob);
  }

  async claimScheduledLdapSync(
    input: Parameters<PlatformOperationsRepository["claimScheduledLdapSync"]>[0],
  ): Promise<boolean> {
    return this.handle.client.transaction(() => {
      const row = this.handle.client
        .prepare(
          "SELECT value_json FROM system_settings WHERE setting_key='ldap.scheduled-sync.v1'",
        )
        .get() as { value_json: string } | undefined;
      const state = scheduledLdapState(row?.value_json);
      if (state.claimId && state.leaseExpiresAt && state.leaseExpiresAt > input.now) return false;
      if (state.nextAt && state.nextAt > input.now) return false;
      const value = JSON.stringify({
        claimId: input.claimId,
        leaseExpiresAt: input.leaseExpiresAt,
        nextAt: state.nextAt ?? input.now,
      });
      this.handle.client
        .prepare(
          `INSERT INTO system_settings(setting_key,value_json,updated_at,revision)
           VALUES ('ldap.scheduled-sync.v1',?,?,1)
           ON CONFLICT(setting_key) DO UPDATE SET value_json=excluded.value_json,
             updated_at=excluded.updated_at,revision=system_settings.revision+1`,
        )
        .run(value, input.now);
      return true;
    })();
  }

  async completeScheduledLdapSync(
    input: Parameters<PlatformOperationsRepository["completeScheduledLdapSync"]>[0],
  ): Promise<boolean> {
    return this.handle.client.transaction(() => {
      const row = this.handle.client
        .prepare(
          "SELECT value_json FROM system_settings WHERE setting_key='ldap.scheduled-sync.v1'",
        )
        .get() as { value_json: string } | undefined;
      if (scheduledLdapState(row?.value_json).claimId !== input.claimId) return false;
      const result = this.handle.client
        .prepare(
          `UPDATE system_settings SET value_json=?,updated_at=?,revision=revision+1
           WHERE setting_key='ldap.scheduled-sync.v1'`,
        )
        .run(JSON.stringify({ nextAt: input.nextAt }), input.completedAt);
      return result.changes === 1;
    })();
  }

  async listNotifications(input: Parameters<PlatformOperationsRepository["listNotifications"]>[0]) {
    if (input.projectIds?.length === 0) return { items: [] };
    const where = ["user_id = ?"];
    const parameters: Array<string | number> = [input.userId];
    if (input.unreadOnly) where.push("read_at IS NULL");
    if (input.projectIds) {
      where.push(
        `(project_id IS NULL OR project_id IN (${input.projectIds.map(() => "?").join(",")}))`,
      );
      parameters.push(...input.projectIds);
    }
    if (input.cursor) {
      const cursor = decodeCursor(input.cursor);
      where.push("(created_at < ? OR (created_at = ? AND id < ?))");
      parameters.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    parameters.push(input.limit + 1);
    const rows = this.handle.client
      .prepare(
        `SELECT * FROM notifications WHERE ${where.join(" AND ")}
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...parameters) as NotificationRow[];
    const page = rows.slice(0, input.limit);
    return {
      items: page.map(mapNotification),
      ...(rows.length > input.limit && page.length > 0
        ? { nextCursor: encodeCursor(page.at(-1) as NotificationRow) }
        : {}),
    };
  }

  async createNotification(record: Notification): Promise<Notification> {
    this.handle.client
      .prepare(
        `INSERT INTO notifications
         (id, user_id, project_id, kind, severity, title, message, resource_type, resource_id,
          read_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
      );
    return record;
  }

  async generateNotifications(
    input: Parameters<PlatformOperationsRepository["generateNotifications"]>[0],
  ): Promise<number> {
    return this.handle.client.transaction(() => {
      let inserted = 0;
      inserted += this.handle.client
        .prepare(
          `INSERT OR IGNORE INTO notifications
           (id,user_id,project_id,kind,severity,title,message,resource_type,resource_id,created_at)
           SELECT 'notice-batch-' || recipients.user_id || '-' || b.id,
                  recipients.user_id,b.project_id,'batch.completed',
                  CASE WHEN b.status='succeeded' THEN 'info' ELSE 'warning' END,
                  '执行批次已完成',b.suite_name || '：' || b.status,'run_batch',b.id,?
           FROM run_batches b
           JOIN (
             SELECT project_id,user_id FROM project_role_bindings
             UNION SELECT id AS project_id,owner_user_id AS user_id FROM projects WHERE owner_user_id IS NOT NULL
           ) recipients ON recipients.project_id=b.project_id
           WHERE b.status IN ('succeeded','failed','cancelled')
           ORDER BY b.updated_at DESC LIMIT ?`,
        )
        .run(input.now, input.limit).changes;
      inserted += this.handle.client
        .prepare(
          `INSERT OR IGNORE INTO notifications
           (id,user_id,kind,severity,title,message,resource_type,resource_id,created_at)
           SELECT 'notice-runner-' || u.id || '-' || r.id,u.id,'runner.offline','critical',
                  'Runner 已离线',r.name || ' 最近心跳：' || r.last_seen_at,'runner',r.id,?
           FROM runners r CROSS JOIN users u
           WHERE r.last_seen_at<? AND r.disabled=0 AND r.deregistered_at IS NULL AND u.status='active'
             AND EXISTS (
               SELECT 1 FROM user_system_roles usr JOIN roles role ON role.id=usr.role_id
               WHERE usr.user_id=u.id AND instr(role.permissions_json,'runner.read')>0
             )
           ORDER BY r.last_seen_at LIMIT ?`,
        )
        .run(input.now, input.runnerOfflineBefore, input.limit).changes;
      inserted += this.handle.client
        .prepare(
          `INSERT OR IGNORE INTO notifications
           (id,user_id,kind,severity,title,message,resource_type,resource_id,created_at)
           SELECT 'notice-ldap-' || requested_by || '-' || id,requested_by,'ldap.sync_failed','warning',
                  'LDAP 同步失败',COALESCE(error_summary,'LDAP 同步失败。'),'ldap_sync_job',id,?
           FROM ldap_sync_jobs WHERE status='failed' AND requested_by IS NOT NULL
           ORDER BY updated_at DESC LIMIT ?`,
        )
        .run(input.now, input.limit).changes;
      inserted += this.handle.client
        .prepare(
          `INSERT OR IGNORE INTO notifications
           (id,user_id,kind,severity,title,message,resource_type,resource_id,created_at)
           SELECT 'notice-cleanup-' || u.id || '-' || j.id,u.id,'cleanup.dead_letter','critical',
                  '清理任务进入死信',j.category || ' / ' || j.resource_type,'cleanup_job',j.id,?
           FROM cleanup_jobs j CROSS JOIN users u
           WHERE j.status='dead_letter' AND u.status='active' AND EXISTS (
             SELECT 1 FROM user_system_roles usr JOIN roles role ON role.id=usr.role_id
             WHERE usr.user_id=u.id AND instr(role.permissions_json,'settings.manage')>0
           ) ORDER BY j.updated_at DESC LIMIT ?`,
        )
        .run(input.now, input.limit).changes;
      return inserted;
    })();
  }

  async markNotificationRead(input: { notificationId: string; userId: string; readAt: string }) {
    const result = this.handle.client
      .prepare(
        "UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND user_id = ?",
      )
      .run(input.readAt, input.notificationId, input.userId);
    if (result.changes !== 1) {
      throw new DomainError("NOTIFICATION_NOT_FOUND", "通知不存在或不属于当前用户。");
    }
  }

  async ensureRetentionPolicies(records: RetentionPolicy[]): Promise<void> {
    const insert = this.handle.client.prepare(
      `INSERT OR IGNORE INTO retention_policies
       (category, retention_days, minimum_days, maximum_days, updated_by, updated_at, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.handle.client.transaction(() => {
      for (const record of records) {
        insert.run(
          record.category,
          record.retentionDays,
          record.minimumDays,
          record.maximumDays,
          record.updatedBy ?? null,
          record.updatedAt,
          record.revision,
        );
      }
    })();
  }

  async listRetentionPolicies(): Promise<RetentionPolicy[]> {
    const rows = this.handle.client
      .prepare("SELECT * FROM retention_policies ORDER BY category")
      .all() as Array<{
      category: RetentionCategory;
      retention_days: number;
      minimum_days: number;
      maximum_days: number;
      updated_by: string | null;
      updated_at: string;
      revision: number;
    }>;
    return rows.map((row) => ({
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
    const result = this.handle.client
      .prepare(
        `UPDATE retention_policies SET retention_days = ?, updated_by = ?, updated_at = ?,
         revision = revision + 1 WHERE category = ? AND revision = ?
         AND ? BETWEEN minimum_days AND maximum_days`,
      )
      .run(
        input.retentionDays,
        input.actorId,
        input.updatedAt,
        input.category,
        input.expectedRevision,
        input.retentionDays,
      );
    if (result.changes !== 1) versionConflict();
    return (await this.listRetentionPolicies()).find(
      (policy) => policy.category === input.category,
    ) as RetentionPolicy;
  }

  async previewRetention(category: RetentionCategory, cutoffAt: string): Promise<RetentionPreview> {
    const row = this.retentionCount(category, cutoffAt);
    return {
      category,
      cutoffAt,
      eligibleRecords: row.count,
      eligibleBytes: Number(row.bytes ?? 0),
    };
  }

  async executeRetention(input: Parameters<PlatformOperationsRepository["executeRetention"]>[0]) {
    const result = this.handle.client.transaction(() =>
      executeSqliteRetention(this.handle, input),
    )();
    // 批次日志文件在数据库事务提交后删除；缺失文件时 removeBatchStore 为幂等 noop。
    for (const batchId of result.removedBatchStoreIds) {
      this.attemptLogs?.removeBatchStore(batchId);
    }
    return { deletedRecords: result.deletedRecords, objectKeys: result.objectKeys };
  }

  async claimRetentionCleanupJobs(
    input: Parameters<PlatformOperationsRepository["claimRetentionCleanupJobs"]>[0],
  ): ReturnType<PlatformOperationsRepository["claimRetentionCleanupJobs"]> {
    return this.handle.client.transaction(() => {
      const rows = this.handle.client
        .prepare(
          `SELECT id FROM cleanup_jobs
           WHERE category LIKE 'retention-%' AND object_key IS NOT NULL AND available_at <= ?
             AND (status IN ('pending','failed') OR (status='leased' AND lease_expires_at <= ?))
           ORDER BY available_at,id LIMIT ?`,
        )
        .all(input.now, input.now, input.limit) as Array<{ id: string }>;
      const claimed: Awaited<
        ReturnType<PlatformOperationsRepository["claimRetentionCleanupJobs"]>
      > = [];
      const update = this.handle.client.prepare(
        `UPDATE cleanup_jobs SET status='leased', lease_owner=?, lease_expires_at=?,
          attempt_count=attempt_count+1, updated_at=? WHERE id=?
          AND (status IN ('pending','failed') OR (status='leased' AND lease_expires_at <= ?))
          RETURNING id,category,resource_type,resource_id,object_key,attempt_count`,
      );
      for (const row of rows) {
        const job = update.get(input.owner, input.leaseExpiresAt, input.now, row.id, input.now) as
          | {
              id: string;
              category: string;
              resource_type: string;
              resource_id: string;
              object_key: string;
              attempt_count: number;
            }
          | undefined;
        if (job) {
          claimed.push({
            id: job.id,
            category: job.category,
            resourceType: job.resource_type,
            resourceId: job.resource_id,
            objectKey: job.object_key,
            attemptCount: job.attempt_count,
          });
        }
      }
      return claimed;
    })();
  }

  async completeRetentionCleanupJob(
    input: Parameters<PlatformOperationsRepository["completeRetentionCleanupJob"]>[0],
  ): Promise<void> {
    this.handle.client
      .prepare(
        `UPDATE cleanup_jobs SET status=?, error_summary=?, available_at=?, lease_owner=NULL,
          lease_expires_at=NULL, updated_at=? WHERE id=? AND status='leased' AND lease_owner=?`,
      )
      .run(
        input.status,
        input.errorSummary ?? null,
        input.availableAt,
        input.updatedAt,
        input.id,
        input.owner,
      );
  }

  async rebuildAnalyticsFacts(limit: number): Promise<number> {
    const rows = this.handle.client
      .prepare(
        `SELECT a.id AS attempt_id, b.project_id, b.id AS batch_id, r.id AS run_id,
                b.suite_id, r.case_definition_id, r.case_version, a.runner_id,
                b.environment_version_id, a.outcome, a.result_code, a.result_summary,
                a.duration_ms, a.testng_result_json, a.finished_at
         FROM run_attempts a
         JOIN execution_runs r ON r.id = a.execution_run_id
         JOIN run_batches b ON b.id = r.batch_id
         LEFT JOIN analytics_facts f ON f.attempt_id = a.id
         WHERE (f.attempt_id IS NULL OR f.schema_version < ?)
           AND a.finished_at IS NOT NULL AND a.outcome IS NOT NULL
         ORDER BY a.finished_at, a.id LIMIT ?`,
      )
      .all(ANALYTICS_FACT_SCHEMA_VERSION, limit) as Array<{
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
    }>;
    const writeFact = this.handle.client.prepare(
      `INSERT INTO analytics_facts
       (attempt_id, project_id, batch_id, run_id, suite_id, case_definition_id, case_version,
        runner_id, environment_version_id, outcome, result_code, failure_signature, duration_ms,
        passed, failed, skipped, completed_at, schema_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(attempt_id) DO UPDATE SET
         project_id=excluded.project_id,
         batch_id=excluded.batch_id,
         run_id=excluded.run_id,
         suite_id=excluded.suite_id,
         case_definition_id=excluded.case_definition_id,
         case_version=excluded.case_version,
         runner_id=excluded.runner_id,
         environment_version_id=excluded.environment_version_id,
         outcome=excluded.outcome,
         result_code=excluded.result_code,
         failure_signature=excluded.failure_signature,
         duration_ms=excluded.duration_ms,
         passed=excluded.passed,
         failed=excluded.failed,
         skipped=excluded.skipped,
         completed_at=excluded.completed_at,
         schema_version=excluded.schema_version
       WHERE analytics_facts.schema_version < excluded.schema_version`,
    );
    return this.handle.client.transaction(() => {
      let inserted = 0;
      for (const row of rows) {
        const counts = resultCounts(row.testng_result_json);
        inserted += writeFact.run(
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
        ).changes;
      }
      return inserted;
    })();
  }

  async readAnalytics(input: Parameters<PlatformOperationsRepository["readAnalytics"]>[0]) {
    await this.rebuildAnalyticsFacts(10_000);
    return aggregateAnalytics(
      this.analyticsRows(input.filter, input.projectIds),
      input.generatedAt,
    );
  }

  async exportAnalytics(input: Parameters<PlatformOperationsRepository["exportAnalytics"]>[0]) {
    await this.rebuildAnalyticsFacts(input.maximumRows);
    return this.analyticsRows(input.filter, input.projectIds)
      .slice(0, input.maximumRows)
      .map((row) => ({ ...row }));
  }

  async createAnalyticsExportJob(
    record: Parameters<PlatformOperationsRepository["createAnalyticsExportJob"]>[0],
  ) {
    this.handle.client.transaction(() => {
      const inserted = this.handle.client
        .prepare(
          `INSERT OR IGNORE INTO analytics_export_jobs
           (id,requested_by,project_ids_json,filter_json,format,idempotency_key,status,
            progress_percent,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
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
        );
      if (inserted.changes === 0) return;
      this.handle.client
        .prepare(
          `INSERT INTO queue_jobs
           (message_id,run_id,attempt,schema_version,kind,payload_json,priority,deduplication_key,
            status,available_at,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,'available',?,?,?)`,
        )
        .run(
          record.dispatchJob.messageId,
          record.dispatchJob.runId,
          record.dispatchJob.attempt,
          record.dispatchJob.schemaVersion,
          record.dispatchJob.kind,
          JSON.stringify(record.dispatchJob.payload),
          record.dispatchJob.priority,
          record.dispatchJob.deduplicationKey,
          record.dispatchJob.createdAt,
          record.dispatchJob.createdAt,
          record.dispatchJob.createdAt,
        );
    })();
    const row = this.handle.client
      .prepare("SELECT * FROM analytics_export_jobs WHERE requested_by=? AND idempotency_key=?")
      .get(record.job.requestedBy, record.idempotencyKey) as AnalyticsExportJobRow | undefined;
    if (!row) throw new Error("Analytics export job was not persisted.");
    return mapAnalyticsExportJob(row);
  }

  async getAnalyticsExportJob(jobId: string, requestedBy: string) {
    const row = this.handle.client
      .prepare("SELECT * FROM analytics_export_jobs WHERE id=? AND requested_by=?")
      .get(jobId, requestedBy) as AnalyticsExportJobRow | undefined;
    return row ? mapAnalyticsExportJob(row) : null;
  }

  async claimAnalyticsExportJob(
    input: Parameters<PlatformOperationsRepository["claimAnalyticsExportJob"]>[0],
  ): ReturnType<PlatformOperationsRepository["claimAnalyticsExportJob"]> {
    const row = this.handle.client
      .prepare(
        `UPDATE analytics_export_jobs
         SET status='running',progress_percent=10,started_at=COALESCE(started_at,?),updated_at=?
         WHERE id=? AND status IN ('queued','failed') RETURNING *`,
      )
      .get(input.startedAt, input.startedAt, input.jobId) as AnalyticsExportJobRow | undefined;
    if (!row) return Promise.resolve(null);
    const projectIds = analyticsExportProjectIds(row);
    return Promise.resolve({
      job: mapAnalyticsExportJob(row),
      ...(projectIds === undefined ? {} : { projectIds }),
    });
  }

  async updateAnalyticsExportJob(
    input: Parameters<PlatformOperationsRepository["updateAnalyticsExportJob"]>[0],
  ) {
    const row = this.handle.client
      .prepare(
        `UPDATE analytics_export_jobs SET
           status=?, progress_percent=?, row_count=?, size_bytes=?, sha256=?, object_key=?,
           file_name=?, error_code=?, error_summary=?, updated_at=?, finished_at=?
         WHERE id=? RETURNING *`,
      )
      .get(
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
      ) as AnalyticsExportJobRow | undefined;
    if (!row) throw new DomainError("ANALYTICS_EXPORT_NOT_FOUND", "分析导出任务不存在。");
    return mapAnalyticsExportJob(row);
  }

  async requestAnalyticsExportCancellation(
    input: Parameters<PlatformOperationsRepository["requestAnalyticsExportCancellation"]>[0],
  ) {
    this.handle.client
      .prepare(
        `UPDATE analytics_export_jobs SET
           status=CASE status WHEN 'queued' THEN 'cancelled' WHEN 'running' THEN 'cancel_requested' ELSE status END,
           progress_percent=CASE status WHEN 'queued' THEN 100 ELSE progress_percent END,
           finished_at=CASE status WHEN 'queued' THEN ? ELSE finished_at END,
           updated_at=?
         WHERE id=? AND requested_by=? AND status IN ('queued','running')`,
      )
      .run(input.updatedAt, input.updatedAt, input.jobId, input.requestedBy);
    const job = await this.getAnalyticsExportJob(input.jobId, input.requestedBy);
    if (!job) throw new DomainError("ANALYTICS_EXPORT_NOT_FOUND", "分析导出任务不存在。");
    return job;
  }

  async resolveAnalyticsExportObject(
    input: Parameters<PlatformOperationsRepository["resolveAnalyticsExportObject"]>[0],
  ) {
    const row = this.handle.client
      .prepare(
        `SELECT * FROM analytics_export_jobs
         WHERE id=? AND requested_by=? AND status='succeeded' AND object_key IS NOT NULL`,
      )
      .get(input.jobId, input.requestedBy) as AnalyticsExportJobRow | undefined;
    return row && row.object_key
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
    if (input.projectIds?.length === 0) return { items: [] };
    const search = input.query.toLocaleLowerCase("en-US");
    const projectFilter = input.projectIds
      ? ` AND project_id IN (${input.projectIds.map(() => "?").join(",")})`
      : "";
    const parameters = (prefix: Array<string | number>) => [
      ...prefix,
      ...(input.projectIds ?? []),
      input.limit,
    ];
    const cases = this.handle.client
      .prepare(
        `SELECT id, project_id, display_name AS title, class_name AS subtitle
         FROM case_definitions WHERE archived = 0
           AND (instr(lower(display_name), ?) > 0 OR instr(lower(class_name), ?) > 0)
           ${projectFilter} ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(...parameters([search, search])) as SearchRow[];
    const suites = this.handle.client
      .prepare(
        `SELECT id, project_id, name AS title, COALESCE(description, '') AS subtitle
         FROM case_suites WHERE status = 'active' AND instr(lower(name), ?) > 0
           ${projectFilter} ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(...parameters([search])) as SearchRow[];
    const batches = this.handle.client
      .prepare(
        `SELECT id, project_id, suite_name AS title, status AS subtitle
         FROM run_batches WHERE (instr(lower(suite_name), ?) > 0 OR instr(lower(id), ?) > 0)
           ${projectFilter} ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...parameters([search, search])) as SearchRow[];
    const runs = this.handle.client
      .prepare(
        `SELECT r.id, b.project_id, r.display_name AS title, r.status AS subtitle
         FROM execution_runs r JOIN run_batches b ON b.id = r.batch_id
         WHERE (instr(lower(r.display_name), ?) > 0 OR instr(lower(r.id), ?) > 0)
           ${input.projectIds ? `AND b.project_id IN (${input.projectIds.map(() => "?").join(",")})` : ""}
         ORDER BY r.created_at DESC LIMIT ?`,
      )
      .all(...parameters([search, search])) as SearchRow[];
    const runnerRows = input.projectIds
      ? []
      : (this.handle.client
          .prepare(
            `SELECT id, NULL AS project_id, name AS title,
                    os || ' · ' || architecture || ' · ' || agent_version AS subtitle
             FROM runners WHERE deregistered_at IS NULL AND instr(lower(name), ?) > 0
             ORDER BY updated_at DESC LIMIT ?`,
          )
          .all(search, input.limit) as SearchRow[]);
    return {
      items: [
        ...searchItems("case", cases, (id) => `/cases/${encodeURIComponent(id)}`),
        ...searchItems("suite", suites, (id) => `/case-suites/${encodeURIComponent(id)}`),
        ...searchItems("batch", batches, (id) => `/run-batches/${encodeURIComponent(id)}`),
        ...searchItems("run", runs, (id) => `/run-batches?runId=${encodeURIComponent(id)}`),
        ...searchItems("runner", runnerRows, () => "/runners"),
      ].slice(0, input.limit),
    };
  }

  private serviceAccountRow(accountId: string): ServiceAccountRow | undefined {
    return this.handle.client
      .prepare("SELECT * FROM service_accounts WHERE id = ?")
      .get(accountId) as ServiceAccountRow | undefined;
  }

  private requiredServiceAccountRow(accountId: string): ServiceAccountRow {
    const row = this.serviceAccountRow(accountId);
    if (!row) throw new DomainError("SERVICE_ACCOUNT_NOT_FOUND", "服务账号不存在。");
    return row;
  }

  private requiredApiTokenRow(tokenId: string): ApiTokenRow {
    const row = this.handle.client.prepare("SELECT * FROM api_tokens WHERE id = ?").get(tokenId) as
      ApiTokenRow | undefined;
    if (!row) throw new DomainError("API_TOKEN_NOT_FOUND", "API 令牌不存在。");
    return row;
  }

  private requiredLdapSyncJobRow(jobId: string): LdapSyncJobRow {
    const row = this.handle.client
      .prepare("SELECT * FROM ldap_sync_jobs WHERE id = ?")
      .get(jobId) as LdapSyncJobRow | undefined;
    if (!row) throw new DomainError("LDAP_SYNC_JOB_NOT_FOUND", "LDAP 同步任务不存在。");
    return row;
  }

  private retentionCount(category: RetentionCategory, cutoffAt: string): CountRow {
    if (category === "log") {
      // 日志已迁移到每批次独立 SQLite 文件：按终态批次汇总文件大小。
      const batchIds = this.terminalBatchIdsBefore(cutoffAt);
      const stats = this.attemptLogs
        ? this.attemptLogs.batchStoreStats(batchIds)
        : new Map<string, number>();
      let bytes = 0;
      for (const value of stats.values()) bytes += value;
      return { count: batchIds.length, bytes };
    }
    const queries: Record<Exclude<RetentionCategory, "log">, string> = {
      execution:
        "SELECT count(*) AS count, 0 AS bytes FROM run_batches WHERE status IN ('succeeded','failed','cancelled') AND updated_at < ?",
      artifact: `SELECT count(*) AS count, COALESCE(sum(size_bytes), 0) AS bytes
                 FROM attempt_artifacts f JOIN run_attempts a ON a.id = f.attempt_id
                 WHERE a.finished_at < ? AND f.status = 'uploaded'`,
      source: `SELECT count(*) AS count, COALESCE(sum(size_bytes), 0) AS bytes
               FROM case_sources WHERE lifecycle_status = 'deleting' AND updated_at < ?`,
      analytics: "SELECT count(*) AS count, 0 AS bytes FROM analytics_facts WHERE completed_at < ?",
      audit: "SELECT count(*) AS count, 0 AS bytes FROM audit_events WHERE recorded_at < ?",
      session:
        "SELECT count(*) AS count, 0 AS bytes FROM user_sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)",
      queue:
        "SELECT count(*) AS count, 0 AS bytes FROM queue_jobs WHERE status IN ('completed','dead_letter') AND updated_at < ?",
    };
    const parameters = category === "session" ? [cutoffAt, cutoffAt] : [cutoffAt];
    return this.handle.client.prepare(queries[category]).get(...parameters) as CountRow;
  }

  private terminalBatchIdsBefore(cutoffAt: string): string[] {
    const rows = this.handle.client
      .prepare(
        `SELECT id FROM run_batches
         WHERE status IN ('succeeded','failed','cancelled') AND updated_at < ?
         ORDER BY updated_at`,
      )
      .all(cutoffAt) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  private analyticsRows(
    filter: AnalyticsFilter,
    projectIds?: readonly string[],
  ): AnalyticsFactRow[] {
    if (projectIds?.length === 0) return [];
    const where: string[] = [];
    const parameters: Array<string | number> = [];
    const add = (column: string, value: string | undefined, operator = "=") => {
      if (value === undefined) return;
      where.push(`${column} ${operator} ?`);
      parameters.push(value);
    };
    if (projectIds) {
      where.push(`project_id IN (${projectIds.map(() => "?").join(",")})`);
      parameters.push(...projectIds);
    }
    add("project_id", filter.projectId);
    add("suite_id", filter.suiteId);
    add("case_definition_id", filter.caseDefinitionId);
    add("runner_id", filter.runnerId);
    add("environment_version_id", filter.environmentVersionId);
    add("outcome", filter.outcome);
    add("failure_signature", filter.failureSignature);
    if (filter.tag) {
      where.push(
        "EXISTS (SELECT 1 FROM case_definitions c, json_each(c.tags_json) tag WHERE c.id = analytics_facts.case_definition_id AND tag.value = ?)",
      );
      parameters.push(filter.tag);
    }
    add("completed_at", filter.completedAfter, ">=");
    add("completed_at", filter.completedBefore, "<=");
    return this.handle.client
      .prepare(
        `SELECT analytics_facts.*,
                COALESCE(
                  (SELECT c.display_name FROM case_definitions c
                   WHERE c.id=analytics_facts.case_definition_id),
                  analytics_facts.case_definition_id
                ) AS case_display_name,
                (SELECT a.result_summary FROM run_attempts a
                 WHERE a.id=analytics_facts.attempt_id) AS failure_description
         FROM analytics_facts ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY completed_at, attempt_id LIMIT 100000`,
      )
      .all(...parameters) as AnalyticsFactRow[];
  }
}

type SearchRow = {
  id: string;
  project_id: string | null;
  title: string;
  subtitle: string;
};

function executeSqliteRetention(
  handle: SqliteDatabaseHandle,
  input: Parameters<PlatformOperationsRepository["executeRetention"]>[0],
): { deletedRecords: number; objectKeys: string[]; removedBatchStoreIds: string[] } {
  const keys: string[] = [];
  const removedBatchStoreIds: string[] = [];
  let deletedRecords = 0;
  if (input.category === "artifact") {
    const rows = handle.client
      .prepare(
        `SELECT f.id, f.object_key FROM attempt_artifacts f
         JOIN run_attempts a ON a.id = f.attempt_id
         WHERE a.finished_at < ? AND f.status = 'uploaded' ORDER BY a.finished_at LIMIT ?`,
      )
      .all(input.cutoffAt, input.limit) as Array<{ id: string; object_key: string | null }>;
    const enqueue = handle.client.prepare(
      `INSERT OR IGNORE INTO cleanup_jobs
       (id,category,resource_type,resource_id,object_key,status,attempt_count,available_at,created_at,updated_at)
       VALUES (?,'retention-artifact','attempt-artifact',?,?, 'pending',0,?,?,?)`,
    );
    const remove = handle.client.prepare("DELETE FROM attempt_artifacts WHERE id = ?");
    for (const row of rows) {
      if (row.object_key) {
        keys.push(row.object_key);
        enqueue.run(
          `retention-artifact:${row.id}`,
          row.id,
          row.object_key,
          input.recordedAt,
          input.recordedAt,
          input.recordedAt,
        );
      }
      deletedRecords += remove.run(row.id).changes;
    }
  } else if (input.category === "source") {
    // 来源对象由业务删除时创建的 case-source 清理任务负责，避免与引用守卫竞争。
    return { deletedRecords: 0, objectKeys: [], removedBatchStoreIds };
  } else if (input.category === "log") {
    // 日志保存在每批次独立 SQLite 文件中；按批次文件整体回收，主库无日志行可删。
    const batchIds = (
      handle.client
        .prepare(
          `SELECT id FROM run_batches
           WHERE status IN ('succeeded','failed','cancelled') AND updated_at < ?
           ORDER BY updated_at LIMIT ?`,
        )
        .all(input.cutoffAt, input.limit) as Array<{ id: string }>
    ).map((row) => row.id);
    removedBatchStoreIds.push(...batchIds);
    deletedRecords = batchIds.length;
  } else if (input.category === "execution") {
    const rows = handle.client
      .prepare(
        `SELECT id FROM run_batches WHERE status IN ('succeeded','failed','cancelled')
         AND updated_at < ? AND NOT EXISTS (
           SELECT 1 FROM execution_runs r JOIN run_attempts a ON a.execution_run_id=r.id
           JOIN attempt_artifacts f ON f.attempt_id=a.id
           WHERE r.batch_id=run_batches.id AND f.status='uploaded'
         ) ORDER BY updated_at LIMIT ?`,
      )
      .all(input.cutoffAt, input.limit) as Array<{ id: string }>;
    if (rows.length > 0) {
      const ids = rows.map((row) => row.id);
      deletedRecords = handle.client
        .prepare(`DELETE FROM run_batches WHERE id IN (${ids.map(() => "?").join(",")})`)
        .run(...ids).changes;
      // attempt/run 行由外键级联删除；批次日志文件在事务提交后移除。
      removedBatchStoreIds.push(...ids);
    }
  } else {
    const statements: Partial<
      Record<Exclude<RetentionCategory, "artifact" | "source" | "log" | "execution">, string>
    > = {
      analytics: `DELETE FROM analytics_facts WHERE attempt_id IN (
        SELECT attempt_id FROM analytics_facts WHERE completed_at < ? ORDER BY completed_at LIMIT ?)`,
      audit: `DELETE FROM audit_events WHERE id IN (
        SELECT id FROM audit_events WHERE recorded_at < ? ORDER BY recorded_at LIMIT ?)`,
      session: `DELETE FROM user_sessions WHERE id IN (
        SELECT id FROM user_sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)
        ORDER BY created_at LIMIT ?)`,
      queue: `DELETE FROM queue_jobs WHERE message_id IN (
        SELECT message_id FROM queue_jobs WHERE status IN ('completed','dead_letter') AND updated_at < ?
        ORDER BY updated_at LIMIT ?)`,
    };
    const sql = statements[input.category];
    if (!sql) return { deletedRecords: 0, objectKeys: [], removedBatchStoreIds };
    const parameters =
      input.category === "session"
        ? [input.cutoffAt, input.cutoffAt, input.limit]
        : [input.cutoffAt, input.limit];
    deletedRecords = handle.client.prepare(sql).run(...parameters).changes;
  }
  return { deletedRecords, objectKeys: keys, removedBatchStoreIds };
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

function inClause(column: string, values?: readonly string[]) {
  return values
    ? { clause: `WHERE ${column} IN (${values.map(() => "?").join(",")})`, parameters: [...values] }
    : { clause: "", parameters: [] };
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
