import { DomainError, overlappingEnvironmentAddresses } from "@autoforge/domain";
import { sql } from "drizzle-orm";
import { batchEnvironmentAddresses } from "./run-batch-environment-addresses";

export type PublicSuiteEnvironmentRow = {
  id: string;
  sequence_number: number;
  environment_addresses_json: string | null;
};

/** Bounded pages read only address projections while the caller holds the task/write lock. */
export function publicSuiteEnvironmentPageQuery(
  dialect: "sqlite" | "postgres",
  suiteId: string,
  afterId: string,
) {
  const addresses =
    dialect === "sqlite"
      ? "COALESCE(json_extract(policy_json,'$.environmentAddresses'),json_extract(adapter_runtime_json,'$.environmentAddresses'))"
      : "COALESCE(policy_json::jsonb->>'environmentAddresses',adapter_runtime_json::jsonb->>'environmentAddresses')";
  return sql`SELECT id,sequence_number,${sql.raw(addresses)} AS environment_addresses_json FROM run_batches
    WHERE suite_id=${suiteId}
      AND id>${afterId}
      AND status IN ('queued','dispatching','scheduled','running') AND batch_kind<>'case_log_rerun'
    ORDER BY id LIMIT 100`;
}

export function assertPublicSuiteEnvironmentAvailable(
  requested: readonly string[],
  occupied: PublicSuiteEnvironmentRow,
): void {
  const addresses = batchEnvironmentAddresses(occupied.environment_addresses_json);
  // Unknown/empty pools cannot establish independent environments; retain the existing guard.
  const unknown = requested.length === 0 || addresses.length === 0;
  const conflicts = overlappingEnvironmentAddresses(requested, addresses);
  if (!unknown && conflicts.length === 0) return;
  throw new DomainError(
    "PUBLIC_SUITE_EXECUTION_ACTIVE",
    unknown
      ? `批次 #${occupied.sequence_number} 尚未结束，环境 IP 未配置，无法确认环境隔离；请等待结束后再执行。`
      : `与未结束批次 #${occupied.sequence_number} 的环境 IP 重叠：${conflicts.slice(0, 4).join("、")}${conflicts.length > 4 ? "等" : ""}。请修改本次环境 IP 后再执行。`,
    {
      details: {
        batchId: occupied.id,
        sequenceNumber: occupied.sequence_number,
        conflictingAddresses: conflicts,
      },
    },
  );
}
