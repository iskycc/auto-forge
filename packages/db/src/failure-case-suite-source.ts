import { sql } from "drizzle-orm";
import type { FailureCaseSuiteSource } from "@autoforge/application";
import { caseSuiteExecutionPolicySchema } from "@autoforge/contracts";
import {
  defaultCaseSuiteExecutionPolicy,
  mergeCaseSuiteExecutionPolicy,
  normalizeStoredRetryConcurrencyRules,
  type RunBatch,
} from "@autoforge/domain";

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
  const suitePolicy = caseSuiteExecutionPolicySchema.parse(JSON.parse(row.suitePolicyJson));
  const executionPolicy = caseSuiteExecutionPolicySchema.parse(JSON.parse(row.batchPolicyJson));
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
