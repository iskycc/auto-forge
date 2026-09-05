import { compareBatchCase } from "./compare-batch-case";
import { createHash } from "node:crypto";

import {
  analyticsFilterSchema,
  createAnalyticsExportInputSchema,
  createServiceAccountInputSchema,
  executeRetentionInputSchema,
  issueApiTokenInputSchema,
  updateRetentionPolicyInputSchema,
  updateServiceAccountInputSchema,
  upsertCaseSuiteScheduleInputSchema,
  type AnalyticsFilter,
  type AnalyticsExportJob,
  type Notification,
  type RetentionCategory,
} from "@autoforge/contracts";
import {
  DomainError,
  hasPermission,
  isPermission,
  projectIdsForPermission,
  type AuthenticatedIdentity,
  type Permission,
} from "@autoforge/domain";

import type {
  Clock,
  IdGenerator,
  JarObjectStorePort,
  PlatformOperationsRepository,
  RunBatchRepository,
} from "./ports";
import type { JobHandler } from "./run-job-worker";
import { nextCronOccurrence, validateCronExpression } from "./schedule-expression";

const MAXIMUM_TOKEN_LIFETIME_MS = 366 * 24 * 60 * 60 * 1_000;
const ANALYTICS_EXPORT_MAXIMUM_ROWS = 25_000;
const ANALYTICS_EXPORT_MAXIMUM_BYTES = 16 * 1024 * 1024;
const ANALYTICS_OVERVIEW_MAXIMUM_FACTS = 100_000;
export const DASHBOARD_ANALYTICS_SAMPLE_LIMIT = 10_000;
const RETENTION_DEFAULTS: Record<
  RetentionCategory,
  { days: number; minimum: number; maximum: number }
> = {
  execution: { days: 365, minimum: 30, maximum: 3_650 },
  log: { days: 90, minimum: 7, maximum: 730 },
  artifact: { days: 90, minimum: 7, maximum: 730 },
  source: { days: 365, minimum: 30, maximum: 3_650 },
  analytics: { days: 730, minimum: 30, maximum: 3_650 },
  audit: { days: 730, minimum: 90, maximum: 3_650 },
  session: { days: 30, minimum: 1, maximum: 365 },
  queue: { days: 30, minimum: 1, maximum: 365 },
};

export type ApiTokenMaterial = {
  issue(): string;
  hash(token: string): string;
};

export class PlatformOperationsService {
  constructor(
    private readonly repository: PlatformOperationsRepository,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly tokenMaterial: ApiTokenMaterial,
    private readonly objectStore?: Pick<JarObjectStorePort, "delete"> &
      Partial<Pick<JarObjectStorePort, "putObject" | "read">>,
    private readonly runBatches?: Pick<RunBatchRepository, "get">,
  ) {}

  async initialize(): Promise<void> {
    const timestamp = this.clock.now().toISOString();
    await this.repository.ensureRetentionPolicies(
      Object.entries(RETENTION_DEFAULTS).map(([category, limits]) => ({
        category: category as RetentionCategory,
        retentionDays: limits.days,
        minimumDays: limits.minimum,
        maximumDays: limits.maximum,
        updatedAt: timestamp,
        revision: 1,
      })),
    );
  }

  listServiceAccounts(actor: AuthenticatedIdentity) {
    requirePermission(actor, "api_token.manage");
    return this.repository.listServiceAccounts();
  }

  async createServiceAccount(actor: AuthenticatedIdentity, input: unknown) {
    requirePermission(actor, "api_token.manage");
    const parsed = createServiceAccountInputSchema.parse(input);
    const recordedAt = this.clock.now().toISOString();
    return this.repository.createServiceAccount({
      id: this.ids.next(),
      name: parsed.name,
      description: parsed.description,
      status: "active",
      systemPermissions: validatedPermissions(parsed.systemPermissions),
      projectPermissions: validatedProjectPermissions(parsed.projectPermissions),
      createdBy: actor.user.id,
      createdAt: recordedAt,
      updatedAt: recordedAt,
      revision: 1,
    });
  }

  async updateServiceAccount(actor: AuthenticatedIdentity, accountId: string, input: unknown) {
    requirePermission(actor, "api_token.manage");
    const parsed = updateServiceAccountInputSchema.parse(input);
    return this.repository.updateServiceAccount({
      accountId,
      expectedRevision: parsed.expectedRevision,
      ...(parsed.name === undefined ? {} : { name: parsed.name }),
      ...(parsed.description === undefined ? {} : { description: parsed.description }),
      ...(parsed.status === undefined ? {} : { status: parsed.status }),
      ...(parsed.systemPermissions === undefined
        ? {}
        : { systemPermissions: validatedPermissions(parsed.systemPermissions) }),
      ...(parsed.projectPermissions === undefined
        ? {}
        : { projectPermissions: validatedProjectPermissions(parsed.projectPermissions) }),
      updatedAt: this.clock.now().toISOString(),
    });
  }

  listApiTokens(actor: AuthenticatedIdentity, accountId: string) {
    requirePermission(actor, "api_token.manage");
    return this.repository.listApiTokens(accountId);
  }

  async issueApiToken(actor: AuthenticatedIdentity, accountId: string, input: unknown) {
    requirePermission(actor, "api_token.manage");
    const parsed = issueApiTokenInputSchema.parse(input);
    const now = this.clock.now();
    const expiresAt = new Date(parsed.expiresAt);
    if (expiresAt <= now || expiresAt.getTime() - now.getTime() > MAXIMUM_TOKEN_LIFETIME_MS) {
      throw new DomainError("API_TOKEN_EXPIRY_INVALID", "API 令牌必须在未来一年内过期。");
    }
    const account = (await this.repository.listServiceAccounts()).find(
      (candidate) => candidate.id === accountId,
    );
    if (!account || account.status !== "active") {
      throw new DomainError("SERVICE_ACCOUNT_NOT_ACTIVE", "服务账号不存在或已停用。");
    }
    const allowed = new Set([
      ...account.systemPermissions,
      ...Object.values(account.projectPermissions).flat(),
    ]);
    const scopes = validatedPermissions(parsed.scopes);
    if (scopes.some((scope) => !allowed.has(scope))) {
      throw new DomainError("API_TOKEN_SCOPE_EXCEEDS_ACCOUNT", "令牌作用域不能超过服务账号权限。");
    }
    const token = this.tokenMaterial.issue();
    const tokenId = this.ids.next();
    const createdAt = now.toISOString();
    const stored = await this.repository.createApiToken({
      id: tokenId,
      serviceAccountId: accountId,
      name: parsed.name,
      prefix: token.slice(0, 12),
      scopes,
      expiresAt: expiresAt.toISOString(),
      createdAt,
      tokenHash: this.tokenMaterial.hash(token),
    });
    return { ...stored, token };
  }

  async revokeApiToken(actor: AuthenticatedIdentity, tokenId: string) {
    requirePermission(actor, "api_token.manage");
    return this.repository.revokeApiToken({ tokenId, revokedAt: this.clock.now().toISOString() });
  }

  authenticateApiToken(token: string) {
    return this.repository.authenticateApiToken({
      tokenHash: this.tokenMaterial.hash(token),
      usedAt: this.clock.now().toISOString(),
    });
  }

  listSchedules(actor: AuthenticatedIdentity) {
    requirePermissionInAnyScope(actor, "case_suite.read");
    return this.repository.listSchedules(projectIdsForPermission(actor, "case_suite.read"));
  }

  async readSuiteSchedule(actor: AuthenticatedIdentity, suite: { id: string; projectId: string }) {
    requirePermission(actor, "case_suite.read", suite.projectId);
    const schedule = await this.repository.findScheduleBySuite(suite.id);
    if (schedule && schedule.projectId !== suite.projectId) {
      throw new DomainError("CASE_SUITE_NOT_FOUND", "指定项目下的用例任务不存在。");
    }
    return schedule;
  }

  async upsertSchedule(
    actor: AuthenticatedIdentity,
    suite: { id: string; projectId: string },
    input: unknown,
  ) {
    requirePermission(actor, "case_suite.manage", suite.projectId);
    const parsed = upsertCaseSuiteScheduleInputSchema.parse(input);
    validateCronExpression(parsed.cronExpression, parsed.timeZone);
    const now = this.clock.now();
    const current = await this.repository.findScheduleBySuite(suite.id);
    return this.repository.upsertSchedule(
      {
        id: current?.id ?? this.ids.next(),
        suiteId: suite.id,
        projectId: suite.projectId,
        cronExpression: parsed.cronExpression,
        timeZone: parsed.timeZone,
        missedRunPolicy: parsed.missedRunPolicy,
        enabled: parsed.enabled,
        nextTriggerAt: nextCronOccurrence(
          parsed.cronExpression,
          parsed.timeZone,
          now,
        ).toISOString(),
        ...(current?.lastTriggerAt ? { lastTriggerAt: current.lastTriggerAt } : {}),
        revision: current ? current.revision + 1 : 1,
        createdAt: current?.createdAt ?? now.toISOString(),
        updatedAt: now.toISOString(),
      },
      parsed.expectedRevision,
    );
  }

  async deleteSchedule(
    actor: AuthenticatedIdentity,
    schedule: { id: string; projectId: string; revision: number },
  ) {
    requirePermission(actor, "case_suite.manage", schedule.projectId);
    await this.repository.deleteSchedule(schedule.id, schedule.revision);
  }

  async triggerDueSchedules(
    createBatch: (schedule: { suiteId: string; projectId: string }) => Promise<string>,
    limit = 50,
  ): Promise<number> {
    const now = this.clock.now();
    const due = await this.repository.listDueSchedules(now.toISOString(), limit);
    let created = 0;
    for (const schedule of due) {
      const scheduledFor = schedule.nextTriggerAt;
      const claimId = this.ids.next();
      if (
        !(await this.repository.claimScheduleTrigger({
          scheduleId: schedule.id,
          scheduledFor,
          claimId,
          claimedAt: now.toISOString(),
          leaseExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
        }))
      ) {
        continue;
      }
      const nextTriggerAt = nextCronOccurrence(
        schedule.cronExpression,
        schedule.timeZone,
        new Date(scheduledFor),
      ).toISOString();
      if (
        schedule.missedRunPolicy === "skip" &&
        now.getTime() - new Date(scheduledFor).getTime() > 5 * 60_000
      ) {
        await this.repository.completeScheduleTrigger({
          scheduleId: schedule.id,
          scheduledFor,
          claimId,
          status: "skipped",
          nextTriggerAt,
          recordedAt: now.toISOString(),
        });
        continue;
      }
      try {
        const batchId = await createBatch(schedule);
        if (
          await this.repository.completeScheduleTrigger({
            scheduleId: schedule.id,
            scheduledFor,
            claimId,
            batchId,
            status: "created",
            nextTriggerAt,
            recordedAt: now.toISOString(),
          })
        ) {
          created += 1;
        }
      } catch {
        await this.repository.completeScheduleTrigger({
          scheduleId: schedule.id,
          scheduledFor,
          claimId,
          status: "failed",
          nextTriggerAt,
          recordedAt: now.toISOString(),
        });
      }
    }
    return created;
  }

  listNotifications(
    actor: AuthenticatedIdentity,
    input: { unreadOnly: boolean; cursor?: string; limit: number },
  ) {
    const projectIds = accessibleProjectIds(actor);
    return this.repository.listNotifications({
      userId: actor.user.id,
      ...(projectIds ? { projectIds } : {}),
      unreadOnly: input.unreadOnly,
      ...(input.cursor ? { cursor: input.cursor } : {}),
      limit: input.limit,
    });
  }

  countUnreadNotifications(actor: AuthenticatedIdentity) {
    const projectIds = accessibleProjectIds(actor);
    return this.repository.countUnreadNotifications({
      userId: actor.user.id,
      ...(projectIds ? { projectIds } : {}),
    });
  }

  createNotification(input: Omit<Notification, "id" | "createdAt">) {
    return this.repository.createNotification({
      ...input,
      id: this.ids.next(),
      createdAt: this.clock.now().toISOString(),
    });
  }

  generateNotifications(limit = 500) {
    const now = this.clock.now();
    return this.repository.generateNotifications({
      now: now.toISOString(),
      runnerOfflineBefore: new Date(now.getTime() - 90_000).toISOString(),
      limit,
    });
  }

  markNotificationRead(actor: AuthenticatedIdentity, notificationId: string) {
    return this.repository.markNotificationRead({
      notificationId,
      userId: actor.user.id,
      readAt: this.clock.now().toISOString(),
    });
  }

  listRetentionPolicies(actor: AuthenticatedIdentity) {
    requirePermission(actor, "settings.read");
    return this.repository.listRetentionPolicies();
  }

  async updateRetentionPolicy(
    actor: AuthenticatedIdentity,
    category: RetentionCategory,
    input: unknown,
  ) {
    requirePermission(actor, "settings.manage");
    const parsed = updateRetentionPolicyInputSchema.parse(input);
    const current = (await this.repository.listRetentionPolicies()).find(
      (policy) => policy.category === category,
    );
    if (!current) throw new DomainError("RETENTION_POLICY_NOT_FOUND", "保留策略不存在。");
    if (parsed.retentionDays < current.minimumDays || parsed.retentionDays > current.maximumDays) {
      throw new DomainError(
        "RETENTION_DAYS_OUT_OF_RANGE",
        `保留天数必须在 ${current.minimumDays} 至 ${current.maximumDays} 之间。`,
      );
    }
    return this.repository.updateRetentionPolicy({
      category,
      retentionDays: parsed.retentionDays,
      expectedRevision: parsed.expectedRevision,
      actorId: actor.user.id,
      updatedAt: this.clock.now().toISOString(),
    });
  }

  async previewRetention(actor: AuthenticatedIdentity, category: RetentionCategory) {
    requirePermission(actor, "settings.read");
    const policy = (await this.repository.listRetentionPolicies()).find(
      (candidate) => candidate.category === category,
    );
    if (!policy) throw new DomainError("RETENTION_POLICY_NOT_FOUND", "保留策略不存在。");
    return this.repository.previewRetention(
      category,
      cutoff(this.clock.now(), policy.retentionDays),
    );
  }

  async executeRetentionNow(
    actor: AuthenticatedIdentity,
    category: RetentionCategory,
    input: unknown,
  ) {
    requirePermission(actor, "settings.manage");
    const parsed = executeRetentionInputSchema.parse(input);
    if (parsed.confirmation !== category) {
      throw new DomainError("RETENTION_CONFIRMATION_MISMATCH", "清理确认类别与请求类别不一致。");
    }
    const result = await this.executeRetention(category, parsed.limit);
    const completedObjectDeletes = await this.processRetentionCleanupJobs(parsed.limit);
    return {
      category,
      deletedRecords: result.deletedRecords,
      queuedObjectDeletes: result.objectKeys.length,
      completedObjectDeletes,
    };
  }

  async executeRetention(category: RetentionCategory, limit = 1_000) {
    const policy = (await this.repository.listRetentionPolicies()).find(
      (candidate) => candidate.category === category,
    );
    if (!policy) throw new DomainError("RETENTION_POLICY_NOT_FOUND", "保留策略不存在。");
    const recordedAt = this.clock.now().toISOString();
    return this.repository.executeRetention({
      category,
      cutoffAt: cutoff(this.clock.now(), policy.retentionDays),
      limit,
      recordedAt,
    });
  }

  async processRetentionCleanupJobs(limit = 100): Promise<number> {
    if (!this.objectStore) return 0;
    const owner = `retention-${this.ids.next()}`;
    const now = this.clock.now();
    const jobs = await this.repository.claimRetentionCleanupJobs({
      owner,
      now: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
      limit,
    });
    let completed = 0;
    for (const job of jobs) {
      try {
        await this.objectStore.delete(job.objectKey);
        await this.repository.completeRetentionCleanupJob({
          id: job.id,
          owner,
          status: "succeeded",
          availableAt: now.toISOString(),
          updatedAt: this.clock.now().toISOString(),
        });
        completed += 1;
      } catch (error) {
        const attemptCount = job.attemptCount;
        await this.repository.completeRetentionCleanupJob({
          id: job.id,
          owner,
          status: attemptCount >= 10 ? "dead_letter" : "failed",
          errorSummary: error instanceof Error ? error.message.slice(0, 1_000) : "对象清理失败。",
          availableAt: new Date(
            this.clock.now().getTime() + Math.min(3_600_000, 1_000 * 2 ** attemptCount),
          ).toISOString(),
          updatedAt: this.clock.now().toISOString(),
        });
      }
    }
    return completed;
  }

  async runRetentionCycle(limitPerCategory = 1_000): Promise<number> {
    let deleted = 0;
    for (const category of [
      "artifact",
      "log",
      "analytics",
      "execution",
      "source",
      "session",
      "queue",
      "audit",
    ] as const) {
      deleted += (await this.executeRetention(category, limitPerCategory)).deletedRecords;
    }
    await this.processRetentionCleanupJobs(100);
    return deleted;
  }

  async analytics(actor: AuthenticatedIdentity, filterInput: AnalyticsFilter) {
    requireScopedPermission(actor, "run.read", filterInput.projectId);
    const filter = analyticsFilterSchema.parse(filterInput);
    const projectIds = projectIdsForPermission(actor, "run.read");
    return this.repository.readAnalytics({
      filter,
      ...(projectIds ? { projectIds } : {}),
      generatedAt: this.clock.now().toISOString(),
    });
  }

  async analyticsOverview(
    actor: AuthenticatedIdentity,
    filterInput: AnalyticsFilter,
    options: { maximumFacts?: number } = {},
  ) {
    requireScopedPermission(actor, "run.read", filterInput.projectId);
    const filter = analyticsFilterSchema.parse(filterInput);
    const projectIds = projectIdsForPermission(actor, "run.read");
    const maximumFacts = analyticsOverviewMaximumFacts(options.maximumFacts);
    return this.repository.readAnalyticsOverview({
      filter,
      ...(projectIds ? { projectIds } : {}),
      generatedAt: this.clock.now().toISOString(),
      ...(maximumFacts === undefined ? {} : { maximumFacts }),
    });
  }

  operationalMetrics(actor: AuthenticatedIdentity) {
    requirePermission(actor, "settings.read");
    return this.repository.readOperationalMetrics();
  }

  async exportAnalytics(
    actor: AuthenticatedIdentity,
    filterInput: AnalyticsFilter,
    maximumRows = 25_000,
  ) {
    requireScopedPermission(actor, "run.read", filterInput.projectId);
    const projectIds = projectIdsForPermission(actor, "run.read");
    return this.repository.exportAnalytics({
      filter: analyticsFilterSchema.parse(filterInput),
      ...(projectIds ? { projectIds } : {}),
      maximumRows,
    });
  }

  async enqueueAnalyticsExport(
    actor: AuthenticatedIdentity,
    input: unknown,
    idempotencyKey: string,
  ): Promise<AnalyticsExportJob> {
    const parsed = createAnalyticsExportInputSchema.parse(input);
    requireScopedPermission(actor, "run.read", parsed.filter.projectId);
    if (!idempotencyKey || idempotencyKey.length > 256) {
      throw new DomainError("IDEMPOTENCY_KEY_INVALID", "导出幂等键必须为 1 至 256 个字符。");
    }
    const now = this.clock.now().toISOString();
    const jobId = this.ids.next();
    const projectIds = projectIdsForPermission(actor, "run.read");
    return this.repository.createAnalyticsExportJob({
      job: {
        id: jobId,
        requestedBy: actor.user.id,
        filter: parsed.filter,
        format: parsed.format,
        status: "queued",
        progressPercent: 0,
        createdAt: now,
        updatedAt: now,
      },
      ...(projectIds ? { projectIds } : {}),
      idempotencyKey,
      dispatchJob: {
        schemaVersion: 1,
        messageId: this.ids.next(),
        runId: jobId,
        attempt: 1,
        createdAt: now,
        priority: 0,
        deduplicationKey: `analytics-export:${jobId}:1`,
        kind: "analytics-export",
        payload: { exportId: jobId },
      },
    });
  }

  async getAnalyticsExport(actor: AuthenticatedIdentity, exportId: string) {
    requirePermissionInAnyScope(actor, "run.read");
    const job = await this.repository.getAnalyticsExportJob(exportId, actor.user.id);
    if (!job) throw new DomainError("ANALYTICS_EXPORT_NOT_FOUND", "分析导出任务不存在。");
    return job;
  }

  async cancelAnalyticsExport(actor: AuthenticatedIdentity, exportId: string) {
    requirePermissionInAnyScope(actor, "run.read");
    return this.repository.requestAnalyticsExportCancellation({
      jobId: exportId,
      requestedBy: actor.user.id,
      updatedAt: this.clock.now().toISOString(),
    });
  }

  async downloadAnalyticsExport(actor: AuthenticatedIdentity, exportId: string) {
    requirePermissionInAnyScope(actor, "run.read");
    if (!this.objectStore?.read) {
      throw new DomainError("ANALYTICS_EXPORT_UNAVAILABLE", "当前运行时未配置导出对象读取能力。");
    }
    const resolved = await this.repository.resolveAnalyticsExportObject({
      jobId: exportId,
      requestedBy: actor.user.id,
    });
    if (!resolved) {
      throw new DomainError("ANALYTICS_EXPORT_NOT_READY", "分析导出尚未完成或不存在。");
    }
    const content = await this.objectStore.read(resolved.objectKey);
    if (
      content.byteLength !== resolved.job.sizeBytes ||
      createHash("sha256").update(content).digest("hex") !== resolved.job.sha256
    ) {
      throw new DomainError("ANALYTICS_EXPORT_CORRUPT", "导出文件大小或摘要校验失败。");
    }
    return { ...resolved, content };
  }

  analyticsExportJobHandler(): JobHandler {
    return async (message) => {
      const exportId = message.payload.exportId;
      if (typeof exportId !== "string") {
        throw new DomainError("ANALYTICS_EXPORT_JOB_INVALID", "分析导出任务缺少 exportId。");
      }
      if (!this.objectStore?.putObject) {
        throw new DomainError("ANALYTICS_EXPORT_UNAVAILABLE", "当前运行时未配置导出对象写入能力。");
      }
      const startedAt = this.clock.now().toISOString();
      const claimed = await this.repository.claimAnalyticsExportJob({ jobId: exportId, startedAt });
      if (!claimed) return;
      let generatedObjectKey: string | undefined;
      try {
        const rows = await this.repository.exportAnalytics({
          filter: claimed.job.filter,
          ...(claimed.projectIds ? { projectIds: claimed.projectIds } : {}),
          maximumRows: ANALYTICS_EXPORT_MAXIMUM_ROWS,
        });
        if (await this.finishCancelledExport(claimed.job)) return;
        const content = serializeAnalyticsExport(rows, claimed.job.format);
        if (content.byteLength > ANALYTICS_EXPORT_MAXIMUM_BYTES) {
          throw new DomainError(
            "ANALYTICS_EXPORT_TOO_LARGE",
            `导出文件超过 ${ANALYTICS_EXPORT_MAXIMUM_BYTES} 字节限制。`,
          );
        }
        const sha256 = createHash("sha256").update(content).digest("hex");
        const scopeDigest = createHash("sha256")
          .update(JSON.stringify(claimed.projectIds ?? ["system"]))
          .digest("hex")
          .slice(0, 32);
        const fileName = `autoforge-analytics-${claimed.job.id}.${claimed.job.format}`;
        const objectKey = `tenants/${scopeDigest}/analytics-exports/${claimed.job.requestedBy}/${claimed.job.id}.${claimed.job.format}`;
        await this.objectStore.putObject({
          objectKey,
          sha256,
          sizeBytes: content.byteLength,
          mediaType: claimed.job.format === "json" ? "application/json" : "text/csv; charset=utf-8",
          content: oneChunk(content),
        });
        generatedObjectKey = objectKey;
        if (await this.finishCancelledExport(claimed.job, objectKey)) return;
        const finishedAt = this.clock.now().toISOString();
        await this.repository.updateAnalyticsExportJob({
          jobId: exportId,
          status: "succeeded",
          progressPercent: 100,
          rowCount: rows.length,
          sizeBytes: content.byteLength,
          sha256,
          objectKey,
          fileName,
          updatedAt: finishedAt,
          finishedAt,
        });
      } catch (error) {
        if (generatedObjectKey) {
          await this.objectStore.delete(generatedObjectKey).catch(() => undefined);
        }
        const finishedAt = this.clock.now().toISOString();
        await this.repository.updateAnalyticsExportJob({
          jobId: exportId,
          status: "failed",
          progressPercent: 100,
          errorCode: error instanceof DomainError ? error.code : "ANALYTICS_EXPORT_FAILED",
          errorSummary:
            error instanceof Error ? error.message.slice(0, 1_000) : "分析导出生成失败。",
          updatedAt: finishedAt,
          finishedAt,
        });
        throw error;
      }
    };
  }

  private async finishCancelledExport(
    job: AnalyticsExportJob,
    objectKey?: string,
  ): Promise<boolean> {
    const current = await this.repository.getAnalyticsExportJob(job.id, job.requestedBy);
    if (current?.status !== "cancel_requested" && current?.status !== "cancelled") return false;
    if (objectKey) await this.objectStore?.delete(objectKey);
    const finishedAt = this.clock.now().toISOString();
    await this.repository.updateAnalyticsExportJob({
      jobId: job.id,
      status: "cancelled",
      progressPercent: 100,
      updatedAt: finishedAt,
      finishedAt,
    });
    return true;
  }

  async compareBatches(actor: AuthenticatedIdentity, leftBatchId: string, rightBatchId: string) {
    requirePermissionInAnyScope(actor, "run.read");
    if (!this.runBatches) {
      throw new DomainError("ANALYTICS_COMPARISON_UNAVAILABLE", "当前运行时未配置批次对比仓储。");
    }
    const projectIds = projectIdsForPermission(actor, "run.read");
    const [left, right] = await Promise.all([
      this.runBatches.get(leftBatchId, projectIds),
      this.runBatches.get(rightBatchId, projectIds),
    ]);
    if (!left || !right) {
      throw new DomainError("RUN_BATCH_NOT_FOUND", "对比批次不存在或当前身份无权访问。");
    }
    const leftCases = comparisonCases(left);
    const rightCases = comparisonCases(right);
    const caseIds = [...new Set([...leftCases.keys(), ...rightCases.keys()])].sort();
    const commonCaseCount = caseIds.filter(
      (caseDefinitionId) => leftCases.has(caseDefinitionId) && rightCases.has(caseDefinitionId),
    ).length;
    return {
      left: batchSnapshot(left),
      right: batchSnapshot(right),
      commonCaseCount,
      onlyLeftCaseCount: leftCases.size - commonCaseCount,
      onlyRightCaseCount: rightCases.size - commonCaseCount,
      comparableScope: leftCases.size === rightCases.size && commonCaseCount === leftCases.size,
      cases: caseIds.map((caseDefinitionId) =>
        compareBatchCase(
          caseDefinitionId,
          leftCases.get(caseDefinitionId),
          rightCases.get(caseDefinitionId),
        ),
      ),
    };
  }

  async globalSearch(actor: AuthenticatedIdentity, query: string, limit: number) {
    requirePermissionInAnyScope(actor, "case.read");
    const projectIds = mergeProjectScopes(
      projectIdsForPermission(actor, "case.read"),
      projectIdsForPermission(actor, "run.read"),
    );
    return this.repository.globalSearch({ query, limit, ...(projectIds ? { projectIds } : {}) });
  }
}

function batchSnapshot(batch: import("@autoforge/domain").RunBatchDetails) {
  return {
    batchId: batch.id,
    projectId: batch.projectId,
    suiteId: batch.suiteId,
    suiteVersion: batch.suiteVersion,
    selectedRunnerIds: [...batch.selectedRunnerIds],
    caseCount: batch.runs.length,
  };
}

function comparisonCases(batch: import("@autoforge/domain").RunBatchDetails) {
  const latestAttempt = new Map<string, import("@autoforge/domain").RunAttempt>();
  for (const attempt of batch.attempts) {
    const current = latestAttempt.get(attempt.executionRunId);
    if (!current || attempt.attemptNumber > current.attemptNumber) {
      latestAttempt.set(attempt.executionRunId, attempt);
    }
  }
  return new Map(
    batch.runs.map((run) => {
      const attempt = latestAttempt.get(run.id);
      return [
        run.caseDefinitionId,
        {
          displayName: run.displayName,
          version: run.caseVersion,
          outcome: attempt?.outcome ?? run.terminalOutcome,
          durationMs: attempt?.durationMs,
        },
      ];
    }),
  );
}

function validatedPermissions(values: readonly string[]): Permission[] {
  const invalid = values.find((value) => !isPermission(value));
  if (invalid) throw new DomainError("PERMISSION_UNKNOWN", `未知权限：${invalid}`);
  return [...new Set(values as readonly Permission[])].sort();
}

function analyticsOverviewMaximumFacts(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1 || value > ANALYTICS_OVERVIEW_MAXIMUM_FACTS) {
    throw new DomainError(
      "ANALYTICS_OVERVIEW_LIMIT_INVALID",
      `工作台分析样本上限必须为 1 至 ${ANALYTICS_OVERVIEW_MAXIMUM_FACTS} 的整数。`,
    );
  }
  return value;
}

function validatedProjectPermissions(
  values: Record<string, string[]>,
): Record<string, Permission[]> {
  return Object.fromEntries(
    Object.entries(values)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([projectId, permissions]) => [projectId, validatedPermissions(permissions)]),
  );
}

function requirePermission(
  actor: AuthenticatedIdentity,
  permission: Permission,
  projectId?: string,
): void {
  if (!hasPermission(actor, permission, projectId)) {
    throw new DomainError("AUTH_FORBIDDEN", "当前身份没有执行此操作的权限。");
  }
}

function requirePermissionInAnyScope(actor: AuthenticatedIdentity, permission: Permission): void {
  const projectIds = projectIdsForPermission(actor, permission);
  if (projectIds?.length === 0) {
    throw new DomainError("AUTH_FORBIDDEN", "当前身份没有执行此操作的权限。");
  }
}

function requireScopedPermission(
  actor: AuthenticatedIdentity,
  permission: Permission,
  projectId?: string,
): void {
  if (projectId) {
    requirePermission(actor, permission, projectId);
    return;
  }
  requirePermissionInAnyScope(actor, permission);
}

function accessibleProjectIds(actor: AuthenticatedIdentity): string[] | undefined {
  if (actor.systemPermissions.length > 0) return undefined;
  return Object.keys(actor.projectPermissions).sort();
}

function mergeProjectScopes(
  left: string[] | undefined,
  right: string[] | undefined,
): string[] | undefined {
  if (left === undefined || right === undefined) return undefined;
  return [...new Set([...left, ...right])].sort();
}

function cutoff(now: Date, retentionDays: number): string {
  return new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
}

function serializeAnalyticsExport(
  rows: Array<Record<string, string | number | null>>,
  format: "csv" | "json",
): Uint8Array {
  if (format === "json") return new TextEncoder().encode(`${JSON.stringify(rows)}\n`);
  if (rows.length === 0) return new Uint8Array();
  const headers = Object.keys(rows[0] ?? {}).sort();
  const text = [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(",")),
  ].join("\n");
  return new TextEncoder().encode(text);
}

function csvCell(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? "" : String(value);
  const protectedText = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${protectedText.replaceAll('"', '""')}"`;
}

async function* oneChunk(content: Uint8Array): AsyncIterable<Uint8Array> {
  yield content;
}
