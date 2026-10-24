import { createHash } from "node:crypto";
import type { SecretCipherPort } from "./ports";
import type {
  VersionCopyRow,
  VersionCopyState,
  VersionCopyCollection,
  VersionCopyObjectReference,
} from "./project-version-copy-ports";
import { roundRecoverySecretPurpose } from "./round-recovery-credentials";

const RELATION_COLUMNS = new Set([
  "id",
  "source_id",
  "current_source_id",
  "candidate_source_id",
  "test_stage_id",
  "case_definition_id",
  "execution_case_definition_id",
  "ddt_case_id",
  "suite_id",
  "batch_id",
  "parent_batch_id",
  "source_execution_run_id",
  "execution_run_id",
  "attempt_id",
  "analysis_id",
  "rerun_proof_attempt_id",
  "webhook_id",
  "job_id",
  "source_file_id",
  "request_id",
  "base_id",
  "category_id",
  "tag_id",
  "rule_id",
  "jdk_asset_id",
  "jar_bundle_asset_id",
  "schedule_id",
  "run_id",
  "upload_id",
  "last_batch_id",
]);
const METADATA_ID_FIELDS = new Set([
  "id",
  "sourceId",
  "currentSourceId",
  "candidateSourceId",
  "testStageId",
  "caseDefinitionId",
  "executionCaseDefinitionId",
  "ddtCaseId",
  "suiteId",
  "batchId",
  "parentBatchId",
  "executionRunId",
  "sourceExecutionRunId",
  "attemptId",
  "analysisId",
  "ruleId",
  "sourceFileId",
  "categoryId",
  "methodId",
  "runId",
  "jdkAssetId",
  "jarBundleAssetId",
  "scheduleId",
  "webhookId",
]);
const PAYLOAD_FIELDS = new Set([
  "data",
  "parameters",
  "classData",
  "tags",
  "groups",
  "testNgResult",
  "environmentVariables",
  "systemProperties",
]);
const METADATA_JSON_COLUMNS = new Set([
  "snapshot_json",
  "policy_json",
  "adapter_runtime_json",
  "execution_spec_json",
  "inspection_json",
  "result_json",
  "uploads_json",
  "remark_images_json",
  "added_json",
  "changed_json",
  "removed_json",
  "conflicts_json",
  "payload_json",
  "details_json",
]);

/** Stable application-generated UUIDv7 IDs make redelivery safe, including deleted-case identities. */
export function versionCopyId(
  job: Pick<VersionCopyState, "id" | "sourceVersionId" | "targetVersionId">,
  original: string,
): string {
  if (original === job.sourceVersionId) return job.targetVersionId;
  const bytes = createHash("sha256").update(`${job.id}\0${original}`).digest().subarray(0, 16);
  Buffer.from(job.id.replaceAll("-", "").slice(0, 12), "hex").copy(bytes, 0, 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function versionCopyObjectKey(
  job: Pick<VersionCopyState, "id" | "targetProjectId">,
  original: string,
): string {
  const digest = createHash("sha256").update(original).digest("hex");
  const extension = /\.[a-z0-9]{1,8}$/iu.exec(original)?.[0] ?? "";
  return `projects/${job.targetProjectId}/version-copies/${job.id}/objects/${digest}${extension}`;
}

export function versionCopyPrimaryKey(
  job: VersionCopyState,
  collection: VersionCopyCollection,
  row: VersionCopyRow,
): VersionCopyRow {
  return Object.fromEntries(
    collection.primaryKey.map((column) => {
      const value = row[column] ?? null;
      if (column === "project_id") return [column, job.targetProjectId];
      if (column === "project_version_id") return [column, job.targetVersionId];
      return [
        column,
        typeof value === "string" && RELATION_COLUMNS.has(column)
          ? versionCopyId(job, value)
          : value,
      ];
    }),
  );
}

export function copyVersionRecord(input: {
  job: VersionCopyState;
  collection: string;
  row: VersionCopyRow;
  cipher: SecretCipherPort;
  sourceSuiteId?: string;
}): VersionCopyRow {
  const { job, collection, row, cipher } = input;
  const mapId = (value: string) => versionCopyId(job, value);
  const objectKey = (value: string) => versionCopyObjectKey(job, value);
  const suiteId =
    input.sourceSuiteId ??
    (collection === "case_suites" ? String(row.id) : String(row.suite_id ?? ""));
  const reencrypt = (value: string, ruleId: string) =>
    cipher.encrypt(
      cipher.decrypt(value, roundRecoverySecretPurpose(suiteId, ruleId)),
      roundRecoverySecretPurpose(mapId(suiteId), mapId(ruleId)),
    );
  const rewriteMetadata = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewriteMetadata);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => {
        if (PAYLOAD_FIELDS.has(key)) return [key, child];
        if (["caseDefinitionIds", "ddtCaseIds"].includes(key) && Array.isArray(child))
          return [
            key,
            child.map((id) => (typeof id === "string" ? mapId(id) : rewriteMetadata(id))),
          ];
        if (key === "roundRecoveryCredentials" && child && typeof child === "object")
          return [
            key,
            Object.fromEntries(
              Object.entries(child).map(([rule, ciphertext]) => [
                mapId(rule),
                reencrypt(String(ciphertext), rule),
              ]),
            ),
          ];
        if (typeof child === "string") {
          if (key === "projectId") return [key, job.targetProjectId];
          if (key === "projectVersionId") return [key, job.targetVersionId];
          if (METADATA_ID_FIELDS.has(key)) return [key, mapId(child)];
          if (key === "objectKey" || key.endsWith("ObjectKey")) return [key, objectKey(child)];
        }
        return [key, rewriteMetadata(child)];
      }),
    );
  };
  const copied: VersionCopyRow = {};
  for (const [column, value] of Object.entries(row)) {
    if (column === "project_id") copied[column] = job.targetProjectId;
    else if (column === "project_version_id") copied[column] = job.targetVersionId;
    else if (column === "inherited_from_project_version_id") copied[column] = null;
    else if (typeof value === "string" && RELATION_COLUMNS.has(column))
      copied[column] = mapId(value);
    else if (
      typeof value === "string" &&
      (column === "object_key" || column.endsWith("_object_key"))
    )
      copied[column] = objectKey(value);
    else if (column === "api_key_ciphertext" && typeof value === "string")
      copied[column] = reencrypt(value, String(row.rule_id));
    else if (typeof value === "string" && METADATA_JSON_COLUMNS.has(column))
      copied[column] = JSON.stringify(rewriteMetadata(JSON.parse(value)));
    else copied[column] = value;
  }
  // A copied schedule/configuration must never trigger real executions or notifications by itself.
  if (["case_suites", "case_suite_schedules", "webhook_configurations"].includes(collection))
    copied.enabled = false;
  if (collection === "test_stages" && row.project_version_id !== job.sourceVersionId) {
    copied.name = `${String(row.name)}（历史来源 ${String(row.project_version_id)}）`;
    copied.normalized_name = String(copied.name).normalize("NFKC").trim().toLowerCase();
  }
  if (collection === "webhook_configurations") {
    copied.name = `${String(row.name)} · ${job.targetVersionName} · ${job.id.slice(-8)}`;
    copied.normalized_name = String(copied.name).normalize("NFKC").toLowerCase();
  }
  if (columnPresent(row, "lease_owner")) copied.lease_owner = null;
  if (columnPresent(row, "lease_expires_at")) copied.lease_expires_at = null;
  if (collection === "case_import_jobs") copied.idempotency_key = `${job.id}:${String(row.id)}`;
  if (collection === "run_batches")
    copied.attempt_logs_path = `attempt-logs/${mapId(String(row.id))}.sqlite`;
  if (collection === "failure_analysis_claims" && typeof row.rerun_proof_attempt_id === "string")
    copied.rerun_proof_url = `/CaseLog?ExecutionId=${encodeURIComponent(mapId(row.rerun_proof_attempt_id))}`;
  if (
    collection === "webhook_deliveries" &&
    ["pending", "delivering"].includes(String(row.status))
  ) {
    copied.status = "failed";
    copied.error_message = "版本复制保留的待发送通知；为避免重复发送，已停止此通知。";
  }
  return copied;
}

function columnPresent(row: VersionCopyRow, column: string): boolean {
  return Object.hasOwn(row, column);
}

/** Inspect only storage metadata; arbitrary DDT values and invocation parameters are never rewritten. */
export function versionCopyObjectReferences(
  collection: string,
  row: VersionCopyRow,
): VersionCopyObjectReference[] {
  const references: VersionCopyObjectReference[] = [];
  const add = (objectKey: string, sha256: unknown, sizeBytes: unknown) =>
    references.push({
      objectKey,
      ...(typeof sha256 === "string" && /^[a-f0-9]{64}$/iu.test(sha256)
        ? { sha256: sha256.toLowerCase() }
        : {}),
      ...(typeof sizeBytes === "number" && sizeBytes >= 0 ? { sizeBytes } : {}),
    });
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const metadata = value as Record<string, unknown>;
    for (const [key, child] of Object.entries(metadata)) {
      if (PAYLOAD_FIELDS.has(key)) continue;
      if (
        (key === "objectKey" || key.endsWith("ObjectKey")) &&
        typeof child === "string" &&
        child
      ) {
        const prefix = key === "objectKey" ? "" : key.slice(0, -"ObjectKey".length);
        add(
          child,
          metadata[prefix ? `${prefix}Sha256` : "sha256"],
          metadata[prefix ? `${prefix}SizeBytes` : "sizeBytes"],
        );
      } else visit(child);
    }
  };
  for (const [column, value] of Object.entries(row)) {
    if (typeof value !== "string" || !value) continue;
    if (column === "object_key" || column.endsWith("_object_key")) {
      if (
        collection !== "attempt_artifacts" ||
        row.status === "available" ||
        row.status === "uploaded"
      ) {
        const prefix = column === "object_key" ? "" : column.slice(0, -"object_key".length);
        add(value, row[`${prefix}sha256`], row[`${prefix}size_bytes`]);
      }
    } else if (METADATA_JSON_COLUMNS.has(column)) visit(JSON.parse(value));
  }
  return references;
}
