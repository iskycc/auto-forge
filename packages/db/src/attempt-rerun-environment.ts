import { sql } from "drizzle-orm";
import { caseSuiteAdapterConfigurationSchema } from "@autoforge/contracts";
import type { AttemptRerunEnvironment } from "@autoforge/application";
import { adapterEnvironmentAddress } from "./project-adapter-runtime";

export type AttemptRerunEnvironmentRow = {
  attemptStatus: AttemptRerunEnvironment["attemptStatus"];
  attemptNumber: number;
  executionRunId: string;
  adapterEnabled: boolean | number;
  assignedAddress: string | null;
  addressesJson: string | null;
  initialAddress: string | null;
  fallbackAddress: string | null;
};

/** Read only bounded environment projections, even when a batch has 100,000 members. */
export function attemptRerunEnvironmentQuery(dialect: "sqlite" | "postgres", attemptId: string) {
  const projection =
    dialect === "sqlite"
      ? sql`json_extract(assignment.execution_spec_json, '$.adapter.environmentAddress') AS "assignedAddress",
      json_extract(batch.adapter_runtime_json, '$.environmentAddresses') AS "addressesJson",
      json_extract(batch.adapter_runtime_json, '$.environmentAddressByRunId.' || json_quote(run.id)) AS "initialAddress",
      coalesce(json_extract(batch.adapter_runtime_json, '$.fallbackEnvironmentAddress'), json_extract(batch.adapter_runtime_json, '$.environmentAddress')) AS "fallbackAddress"`
      : sql`assignment.execution_spec_json::jsonb -> 'adapter' ->> 'environmentAddress' AS "assignedAddress",
      batch.adapter_runtime_json::jsonb ->> 'environmentAddresses' AS "addressesJson",
      batch.adapter_runtime_json::jsonb -> 'environmentAddressByRunId' ->> run.id AS "initialAddress",
      coalesce(batch.adapter_runtime_json::jsonb ->> 'fallbackEnvironmentAddress', batch.adapter_runtime_json::jsonb ->> 'environmentAddress') AS "fallbackAddress"`;
  return sql`SELECT attempt.status AS "attemptStatus", attempt.attempt_number AS "attemptNumber",
    run.id AS "executionRunId", (batch.adapter_runtime_json IS NOT NULL) AS "adapterEnabled", ${projection}
    FROM run_attempts attempt
    JOIN execution_runs run ON run.id=attempt.execution_run_id
    JOIN run_batches batch ON batch.id=run.batch_id
    LEFT JOIN assignments assignment ON assignment.attempt_id=attempt.id
      AND assignment.execution_run_id=run.id AND assignment.batch_id=batch.id
    WHERE attempt.id=${attemptId}
    ORDER BY assignment.created_at DESC, assignment.id DESC LIMIT 1`;
}

export function mapAttemptRerunEnvironment(
  row: AttemptRerunEnvironmentRow,
): AttemptRerunEnvironment {
  const enabled = Boolean(row.adapterEnabled);
  const addresses = caseSuiteAdapterConfigurationSchema.shape.environmentAddresses.parse(
    row.addressesJson ? JSON.parse(row.addressesJson) : [],
  );
  const fallback = adapterEnvironmentAddress(
    {
      environmentAddresses: addresses,
      environmentAddressByRunId: row.initialAddress
        ? { [row.executionRunId]: row.initialAddress }
        : {},
      fallbackEnvironmentAddress: row.fallbackAddress ?? "",
    },
    row.executionRunId,
    row.attemptNumber,
  );
  return {
    attemptStatus: row.attemptStatus,
    adapterEnabled: enabled,
    environmentIp: enabled ? row.assignedAddress || fallback || addresses[0] || null : null,
  };
}
