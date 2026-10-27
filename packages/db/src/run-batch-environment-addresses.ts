import { caseSuiteAdapterConfigurationSchema } from "@autoforge/contracts";
import type { RunBatchExecutionPolicy } from "@autoforge/domain";

/** Project only the bounded address list, keeping runtime assets out of public reads. */
export function batchEnvironmentAddresses(encoded: string | null | undefined): string[] {
  return caseSuiteAdapterConfigurationSchema.shape.environmentAddresses.parse(
    encoded ? JSON.parse(encoded) : [],
  );
}

export function batchSnapshotEnvironmentAddresses(
  policyJson: string | null,
  runtimeJson: string | null,
): string[] {
  const policy: unknown = policyJson ? JSON.parse(policyJson) : null;
  if (policy && typeof policy === "object" && "environmentAddresses" in policy)
    return caseSuiteAdapterConfigurationSchema.shape.environmentAddresses.parse(
      policy.environmentAddresses,
    );
  const runtime: unknown = runtimeJson ? JSON.parse(runtimeJson) : null;
  return caseSuiteAdapterConfigurationSchema
    .pick({ environmentAddresses: true })
    .parse(runtime ?? {}).environmentAddresses;
}

export function serializeBatchPolicy(
  policy: RunBatchExecutionPolicy | undefined,
  environmentAddresses: readonly string[],
): string | null {
  // Keep polling projections in the small policy JSON; old batches use the runtime fallback.
  return policy ? JSON.stringify({ ...policy, environmentAddresses }) : null;
}
