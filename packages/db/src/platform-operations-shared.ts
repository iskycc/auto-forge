import type {
  AnalyticsSummary,
  AnalyticsExportJob,
  ApiToken,
  CaseSuiteSchedule,
  LdapSyncJob,
  Notification,
  RetentionCategory,
  ServiceAccount,
} from "@autoforge/contracts";
import {
  classifyAttemptResult,
  isRetryableRunnerFailure,
  isPermission,
  type ClassifiableAttemptResult,
  type Permission,
} from "@autoforge/domain";

export const ANALYTICS_FACT_SCHEMA_VERSION = 3;

export type ServiceAccountRow = {
  id: string;
  name: string;
  description: string;
  status: "active" | "disabled";
  system_permissions_json: string;
  project_permissions_json: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  revision: number;
};

export type ApiTokenRow = {
  id: string;
  service_account_id: string;
  name: string;
  token_prefix: string;
  scopes_json: string;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
};

export type ScheduleRow = {
  id: string;
  suite_id: string;
  project_id: string;
  cron_expression: string;
  time_zone: string;
  missed_run_policy: "skip" | "run-once";
  enabled: boolean | number;
  next_trigger_at: string;
  last_trigger_at: string | null;
  last_trigger_status?: "created" | "skipped" | "failed" | null;
  last_batch_id?: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
};

export type LdapSyncJobRow = {
  id: string;
  status: LdapSyncJob["status"];
  trigger_kind: LdapSyncJob["triggerKind"];
  checkpoint_json: string;
  processed_users: number;
  disabled_users: number;
  error_code: string | null;
  error_summary: string | null;
  requested_by: string | null;
  scheduled_at: string;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
};

export type NotificationRow = {
  id: string;
  user_id: string;
  project_id: string | null;
  kind: string;
  severity: Notification["severity"];
  title: string;
  message: string;
  resource_type: string | null;
  resource_id: string | null;
  read_at: string | null;
  created_at: string;
};

export type AnalyticsFactRow = {
  attempt_id: string;
  project_id: string;
  batch_id: string;
  run_id: string;
  suite_id: string;
  case_definition_id: string;
  case_display_name: string;
  case_version: number;
  runner_id: string;
  environment_version_id: string | null;
  outcome: string;
  result_code: string | null;
  failure_signature: string | null;
  failure_description: string | null;
  duration_ms: number | null;
  passed: number;
  failed: number;
  skipped: number;
  completed_at: string;
};

export type AnalyticsExportJobRow = {
  id: string;
  requested_by: string;
  project_ids_json: string | string[] | null;
  filter_json: string | Record<string, unknown>;
  format: AnalyticsExportJob["format"];
  status: AnalyticsExportJob["status"];
  progress_percent: number;
  row_count: number | null;
  size_bytes: number | string | null;
  sha256: string | null;
  object_key: string | null;
  file_name: string | null;
  error_code: string | null;
  error_summary: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
};

export function mapAnalyticsExportJob(row: AnalyticsExportJobRow): AnalyticsExportJob {
  return {
    id: row.id,
    requestedBy: row.requested_by,
    filter: objectValue(row.filter_json),
    format: row.format,
    status: row.status,
    progressPercent: row.progress_percent,
    ...(row.row_count === null ? {} : { rowCount: row.row_count }),
    ...(row.size_bytes === null ? {} : { sizeBytes: Number(row.size_bytes) }),
    ...(row.sha256 ? { sha256: row.sha256 } : {}),
    ...(row.file_name ? { fileName: row.file_name } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.error_summary ? { errorSummary: row.error_summary } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
  } as AnalyticsExportJob;
}

export function analyticsExportProjectIds(row: AnalyticsExportJobRow): string[] | undefined {
  if (row.project_ids_json === null) return undefined;
  const value =
    typeof row.project_ids_json === "string"
      ? (JSON.parse(row.project_ids_json) as unknown)
      : row.project_ids_json;
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function mapServiceAccount(row: ServiceAccountRow): ServiceAccount {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    systemPermissions: permissionArray(row.system_permissions_json),
    projectPermissions: projectPermissionRecord(row.project_permissions_json),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision,
  };
}

export function mapApiToken(row: ApiTokenRow): ApiToken {
  return {
    id: row.id,
    serviceAccountId: row.service_account_id,
    name: row.name,
    prefix: row.token_prefix,
    scopes: permissionArray(row.scopes_json),
    expiresAt: row.expires_at,
    ...(row.last_used_at ? { lastUsedAt: row.last_used_at } : {}),
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
    createdAt: row.created_at,
  };
}

export function mapSchedule(row: ScheduleRow): CaseSuiteSchedule {
  return {
    id: row.id,
    suiteId: row.suite_id,
    projectId: row.project_id,
    cronExpression: row.cron_expression,
    timeZone: row.time_zone,
    missedRunPolicy: row.missed_run_policy,
    enabled: Boolean(row.enabled),
    nextTriggerAt: row.next_trigger_at,
    ...(row.last_trigger_at ? { lastTriggerAt: row.last_trigger_at } : {}),
    ...(row.last_trigger_status ? { lastTriggerStatus: row.last_trigger_status } : {}),
    ...(row.last_batch_id ? { lastBatchId: row.last_batch_id } : {}),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapLdapSyncJob(row: LdapSyncJobRow): LdapSyncJob {
  return {
    id: row.id,
    status: row.status,
    triggerKind: row.trigger_kind,
    checkpoint: objectRecord(row.checkpoint_json),
    processedUsers: row.processed_users,
    disabledUsers: row.disabled_users,
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.error_summary ? { errorSummary: row.error_summary } : {}),
    ...(row.requested_by ? { requestedBy: row.requested_by } : {}),
    scheduledAt: row.scheduled_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapNotification(row: NotificationRow): Notification {
  return {
    id: row.id,
    userId: row.user_id,
    ...(row.project_id ? { projectId: row.project_id } : {}),
    kind: row.kind,
    severity: row.severity,
    title: row.title,
    message: row.message,
    ...(row.resource_type ? { resourceType: row.resource_type } : {}),
    ...(row.resource_id ? { resourceId: row.resource_id } : {}),
    ...(row.read_at ? { readAt: row.read_at } : {}),
    createdAt: row.created_at,
  };
}

export function aggregateAnalytics(
  rows: AnalyticsFactRow[],
  generatedAt: string,
): AnalyticsSummary {
  // 可自动换机恢复的 Runner/传输异常不是 TestNG 质量结果；它们由执行详情的
  // “执行机异常事件”承载，不能污染通过率、失败洞察或不稳定用例。
  const qualityRows = rows.filter((row) => !isRetryableRunnerFailure(row.result_code));
  const passed = sum(qualityRows, "passed");
  const failed = sum(qualityRows, "failed");
  const skipped = sum(qualityRows, "skipped");
  const methodSamples = passed + failed + skipped;
  const durations = qualityRows
    .map((row) => row.duration_ms)
    .filter((value): value is number => value !== null && value >= 0)
    .sort((left, right) => left - right);
  const failureGroups = new Map<
    string,
    { description: string; resultCode?: string; count: number; lastSeenAt: string }
  >();
  const caseOutcomes = new Map<
    string,
    { displayName: string; samples: number; passed: number; failed: number }
  >();
  const trend = new Map<
    string,
    { total: number; passed: number; failed: number; skipped: number }
  >();
  for (const row of qualityRows) {
    const category = attemptResultCategory(row.outcome, row.result_code);
    if (row.failure_signature && category !== "succeeded" && row.outcome !== "cancelled") {
      const current = failureGroups.get(row.failure_signature);
      const latest = !current || row.completed_at > current.lastSeenAt;
      failureGroups.set(row.failure_signature, {
        description: latest ? failureDescription(row.failure_description) : current.description,
        ...(latest && row.result_code
          ? { resultCode: row.result_code }
          : current?.resultCode
            ? { resultCode: current.resultCode }
            : {}),
        count: (current?.count ?? 0) + 1,
        lastSeenAt: latest ? row.completed_at : current.lastSeenAt,
      });
    }
    if (category === "succeeded" || category === "failed") {
      const outcome = caseOutcomes.get(row.case_definition_id) ?? {
        displayName: row.case_display_name,
        samples: 0,
        passed: 0,
        failed: 0,
      };
      outcome.samples += 1;
      if (category === "succeeded") outcome.passed += 1;
      if (category === "failed") outcome.failed += 1;
      caseOutcomes.set(row.case_definition_id, outcome);
    }

    const methodCount = row.passed + row.failed + row.skipped;
    if (methodCount > 0) {
      const bucket = `${row.completed_at.slice(0, 10)}T00:00:00.000Z`;
      const daily = trend.get(bucket) ?? { total: 0, passed: 0, failed: 0, skipped: 0 };
      daily.total += methodCount;
      daily.passed += row.passed;
      daily.failed += row.failed;
      daily.skipped += row.skipped;
      trend.set(bucket, daily);
    }
  }
  return {
    sampleCount: qualityRows.length,
    passed,
    failed,
    skipped,
    successRate: ratio(passed, methodSamples),
    failureRate: ratio(failed, methodSamples),
    skippedRate: ratio(skipped, methodSamples),
    ...(durations.length > 0
      ? { durationP50Ms: percentile(durations, 0.5), durationP95Ms: percentile(durations, 0.95) }
      : {}),
    generatedAt,
    dimensions: {
      projects: dimensions(qualityRows, "project_id"),
      suites: dimensions(qualityRows, "suite_id"),
      runners: dimensions(qualityRows, "runner_id"),
      outcomes: dimensions(qualityRows, "outcome"),
    },
    trend: [...trend.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([bucket, values]) => ({ bucket, ...values })),
    failures: [...failureGroups.entries()]
      .map(([signature, values]) => ({ signature, ...values }))
      .sort(
        (left, right) => right.count - left.count || left.signature.localeCompare(right.signature),
      )
      .slice(0, 20),
    flakyCases: [...caseOutcomes.entries()]
      .filter(([, values]) => values.samples >= 5 && values.passed > 0 && values.failed > 0)
      .map(([caseDefinitionId, values]) => ({
        caseDefinitionId,
        ...values,
        confidence: rounded(1 - 1 / Math.sqrt(values.samples)),
      }))
      .sort((left, right) => right.confidence - left.confidence)
      .slice(0, 20),
  };
}

export function resultCounts(testNgResultJson: string | null): {
  passed: number;
  failed: number;
  skipped: number;
} {
  if (!testNgResultJson) return { passed: 0, failed: 0, skipped: 0 };
  try {
    const result = JSON.parse(testNgResultJson) as {
      passed?: unknown;
      failed?: unknown;
      skipped?: unknown;
      summary?: { passed?: unknown; failed?: unknown; skipped?: unknown };
    };
    const counts =
      result.passed !== undefined || result.failed !== undefined || result.skipped !== undefined
        ? result
        : result.summary;
    return {
      passed: nonnegativeInteger(counts?.passed),
      failed: nonnegativeInteger(counts?.failed),
      skipped: nonnegativeInteger(counts?.skipped),
    };
  } catch {
    return { passed: 0, failed: 0, skipped: 0 };
  }
}

export function failureSignature(
  outcome: string,
  resultCode: string | null,
  summary: string | null,
): string | null {
  if (isRetryableRunnerFailure(resultCode)) return null;
  const category = attemptResultCategory(outcome, resultCode);
  if (category === "succeeded" || outcome === "cancelled") return null;
  const normalized = failureDescription(summary)
    .toLocaleLowerCase("en-US")
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, "<id>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  return normalized || null;
}

function failureDescription(summary: string | null): string {
  return summary?.trim().slice(0, 4_096) || "执行失败，但执行机未提供错误描述。";
}

function attemptResultCategory(
  outcome: string,
  resultCode: string | null,
): ReturnType<typeof classifyAttemptResult> | null {
  if (!isAttemptOutcome(outcome)) return null;
  return classifyAttemptResult({
    outcome,
    ...(resultCode ? { resultCode } : {}),
  });
}

function isAttemptOutcome(value: string): value is ClassifiableAttemptResult["outcome"] {
  return ["succeeded", "failed", "timed_out", "cancelled"].includes(value);
}

export const RETENTION_TABLES: Partial<Record<RetentionCategory, string>> = {
  analytics: "analytics_facts",
  audit: "audit_events",
  session: "user_sessions",
};

function permissionArray(json: string): Permission[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) return [];
  return [
    ...new Set(
      parsed.filter(
        (value): value is Permission => typeof value === "string" && isPermission(value),
      ),
    ),
  ].sort();
}

function projectPermissionRecord(json: string): Record<string, Permission[]> {
  const parsed: unknown = JSON.parse(json);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return Object.fromEntries(
    Object.entries(parsed)
      .filter(([, value]) => Array.isArray(value))
      .map(([projectId, value]) => [projectId, permissionArray(JSON.stringify(value))]),
  );
}

function objectRecord(json: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(json);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function objectValue(value: string | Record<string, unknown>): Record<string, unknown> {
  if (typeof value !== "string") return value;
  return objectRecord(value);
}

function sum(rows: AnalyticsFactRow[], field: "passed" | "failed" | "skipped"): number {
  return rows.reduce((total, row) => total + row[field], 0);
}

function ratio(value: number, total: number): number {
  return total === 0 ? 0 : rounded(value / total);
}

function rounded(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function percentile(sorted: number[], percentileValue: number): number {
  return Math.round(
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1)] ?? 0,
  );
}

function dimensions(
  rows: AnalyticsFactRow[],
  field: "project_id" | "suite_id" | "runner_id" | "outcome",
) {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row[field], (counts.get(row[field]) ?? 0) + 1);
  return [...counts.entries()]
    .map(([id, count]) => ({ id, count }))
    .sort((left, right) => right.count - left.count || left.id.localeCompare(right.id));
}

function nonnegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}
