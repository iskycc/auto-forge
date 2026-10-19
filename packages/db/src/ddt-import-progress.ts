import { ddtImportFileSummarySchema, ddtImportJobSummarySchema } from "@autoforge/contracts";

// Progress polling must never hydrate uploads or the complete file manifest.
export const ddtImportJobSummaryColumns = `id, project_id, project_version_id, test_stage_id,
  status, progress_percent, total_files, valid_files, total_rows, inserted_count,
  updated_count, unchanged_count, skipped_count, failed_files, error_summary, created_at, updated_at`;

export type DdtImportJobSummaryRow = {
  id: string;
  project_id: string;
  project_version_id: string;
  test_stage_id: string;
  status: string;
  progress_percent: number;
  total_files: number;
  valid_files: number;
  total_rows: number;
  inserted_count: number;
  updated_count: number;
  unchanged_count: number;
  skipped_count: number;
  failed_files: number;
  error_summary: string | null;
  created_at: string;
  updated_at: string;
};

export function mapDdtImportJobSummary(row: DdtImportJobSummaryRow) {
  return ddtImportJobSummarySchema.parse({
    id: row.id,
    projectId: row.project_id,
    projectVersionId: row.project_version_id,
    testStageId: row.test_stage_id,
    status: row.status,
    progressPercent: row.progress_percent,
    totalFiles: row.total_files,
    validFiles: row.valid_files,
    totalRows: row.total_rows,
    insertedCount: row.inserted_count,
    updatedCount: row.updated_count,
    unchangedCount: row.unchanged_count,
    skippedCount: row.skipped_count,
    failedFiles: row.failed_files,
    ...(row.error_summary ? { errorSummary: row.error_summary } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export type DdtImportFileSummaryRow = {
  id: string;
  file_name: string;
  archive_entry_name: string | null;
  status: string;
  row_count: number;
  inserted_count: number;
  updated_count: number;
  unchanged_count: number;
  skipped_count: number;
  error_summary: string | null;
  created_at: string;
  updated_at: string;
};

export function mapDdtImportFileSummary(row: DdtImportFileSummaryRow) {
  return ddtImportFileSummarySchema.parse({
    id: row.id,
    fileName: row.file_name,
    ...(row.archive_entry_name ? { archiveEntryName: row.archive_entry_name } : {}),
    status: row.status,
    rowCount: row.row_count,
    insertedCount: row.inserted_count,
    updatedCount: row.updated_count,
    unchangedCount: row.unchanged_count,
    skippedCount: row.skipped_count,
    ...(row.error_summary ? { errorSummary: row.error_summary } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}
