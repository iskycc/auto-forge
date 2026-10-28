import { sql } from "drizzle-orm";
import type { FailureCaseSuiteSource } from "@autoforge/application";
import {
  caseSuiteExecutionPolicySchema,
  caseSuiteAdapterConfigurationSchema,
} from "@autoforge/contracts";
import {
  DomainError,
  defaultCaseSuiteExecutionPolicy,
  mergeCaseSuiteExecutionPolicy,
  normalizeStoredRetryConcurrencyRules,
  type RunBatch,
} from "@autoforge/domain";

// Stored batch metadata has an address projection; it is not a new task policy input.
const batchCopyPolicySchema = caseSuiteExecutionPolicySchema.safeExtend({
  environmentAddresses: caseSuiteAdapterConfigurationSchema.shape.environmentAddresses
    .removeDefault()
    .optional(),
});

type SnapshotIssue = {
  code: string;
  message: string;
  path: readonly PropertyKey[];
  minimum?: number | bigint;
  maximum?: number | bigint;
};

function readCopyPolicy<Policy>(
  encoded: string,
  schema: {
    safeParse(
      input: unknown,
    ):
      | { success: true; data: Policy }
      | { success: false; error: Error & { issues: readonly SnapshotIssue[] } };
  },
  source: "task_snapshot" | "batch_snapshot",
): Policy {
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(encoded);
  } catch (cause) {
    throw new DomainError(
      "CASE_SUITE_EXECUTION_SNAPSHOT_INVALID",
      "执行配置快照损坏，无法复制任务。",
      {
        cause,
        details: {
          source,
          issues: [
            {
              field: "configuration",
              message: "保存的配置不是有效 JSON，请联系管理员检查该批次快照。",
            },
          ],
        },
      },
    );
  }
  const parsed = schema.safeParse(snapshot);
  if (parsed.success) return parsed.data;
  throw new DomainError(
    "CASE_SUITE_EXECUTION_SNAPSHOT_INVALID",
    "执行配置快照校验失败，无法复制任务，请查看具体字段。",
    {
      cause: parsed.error,
      details: {
        source,
        issues: parsed.error.issues.slice(0, 10).map((issue) => ({
          field: issue.path.map(String).join(".") || "configuration",
          message: snapshotIssueMessage(issue),
        })),
      },
    },
  );
}

function snapshotIssueMessage(issue: SnapshotIssue): string {
  if (issue.code === "too_small") return `不能小于 ${issue.minimum}。`;
  if (issue.code === "too_big") return `不能大于 ${issue.maximum}。`;
  if (issue.code === "invalid_type") return "配置字段类型不正确。";
  if (issue.code === "invalid_value") return "配置值不在支持范围内。";
  if (issue.code === "invalid_format") return "配置字段格式不正确。";
  if (issue.code === "unrecognized_keys") return "包含当前版本不支持的配置字段。";
  if (issue.code === "custom") return issue.message;
  return "配置字段不符合任务规则，请联系管理员检查该字段。";
}

export type FailureCaseSuiteSourceRow = {
  suiteId: string;
  suiteName: string;
  projectId: string;
  status: RunBatch["status"];
  kind: RunBatch["kind"];
  description: string | null;
  suitePolicyJson: string | null;
  batchPolicyJson: string | null;
  priority: number;
  retryLimit: number;
  retryMode: "immediate" | "round";
  queueTimeoutMs: number;
  claimTimeoutMs: number;
  uploadTimeoutMs: number;
};

export type FailureCaseSuiteRecovery = {
  ruleId: string;
  afterRound: number;
  jenkinsJobUrl: string;
  waitMinutes: number;
  apiKeyCiphertext: string;
};

export function toFailureCaseSuiteSource(
  row: FailureCaseSuiteSourceRow,
  recoveries: readonly FailureCaseSuiteRecovery[],
): FailureCaseSuiteSource {
  const source: FailureCaseSuiteSource = {
    suiteId: row.suiteId,
    suiteName: row.suiteName,
    projectId: row.projectId,
    status: row.status,
    kind: row.kind,
    ...(row.description ? { description: row.description } : {}),
    roundRecoveryCredentials: Object.fromEntries(
      recoveries.map((rule) => [rule.ruleId, rule.apiKeyCiphertext]),
    ),
  };
  if (!row.suitePolicyJson || !row.batchPolicyJson) return source;
  const suitePolicy = readCopyPolicy(
    row.suitePolicyJson,
    caseSuiteExecutionPolicySchema,
    "task_snapshot",
  );
  const { environmentAddresses, ...executionPolicy } = readCopyPolicy(
    row.batchPolicyJson,
    batchCopyPolicySchema,
    "batch_snapshot",
  );
  source.policy = mergeCaseSuiteExecutionPolicy(
    mergeCaseSuiteExecutionPolicy(defaultCaseSuiteExecutionPolicy, {
      ...suitePolicy,
      retryConcurrencyRules: normalizeStoredRetryConcurrencyRules(
        suitePolicy.retryConcurrencyRules,
      ),
      roundRecoveryRules: [],
    }),
    {
      ...executionPolicy,
      ...(environmentAddresses !== undefined
        ? {
            adapter: {
              ...(executionPolicy.adapter ??
                suitePolicy.adapter ??
                defaultCaseSuiteExecutionPolicy.adapter),
              environmentAddresses,
            },
          }
        : {}),
      retryConcurrencyRules: normalizeStoredRetryConcurrencyRules(
        executionPolicy.retryConcurrencyRules,
      ),
      priority: row.priority,
      retryLimit: row.retryLimit,
      retryMode: row.retryMode,
      queueTimeoutMs: row.queueTimeoutMs,
      claimTimeoutMs: row.claimTimeoutMs,
      uploadTimeoutMs: row.uploadTimeoutMs,
      roundRecoveryRules: recoveries.map(({ ruleId, afterRound, jenkinsJobUrl, waitMinutes }) => ({
        id: ruleId,
        afterRound,
        jenkinsJobUrl,
        waitMinutes,
        apiKeyConfigured: true,
      })),
    },
  );
  return source;
}

export function failureSuiteRecoveryQuery(batchId: string) {
  return sql`SELECT rule_id AS "ruleId", after_round AS "afterRound",
    jenkins_job_url AS "jenkinsJobUrl", wait_minutes AS "waitMinutes",
    api_key_ciphertext AS "apiKeyCiphertext"
    FROM run_batch_round_recoveries WHERE batch_id = ${batchId}
    ORDER BY after_round, rule_id`;
}
