import type { DdtImportJobStatus, DdtSearchFilter } from "@autoforge/contracts";
import type {
  DdtCase,
  DdtCaseData,
  DdtCaseHistory,
  DdtCaseSummary,
  DdtCaseTemplate,
  DdtScope,
  DdtTemplateFieldRule,
} from "@autoforge/domain";

export type DdtCaseListQuery = DdtScope & {
  query?: string;
  srNum?: string;
  sourceName?: string;
  cursor?: string;
  limit: number;
  filters: DdtSearchFilter[];
};

export type DdtCaseListPage = {
  items: DdtCaseSummary[];
  nextCursor?: string;
};

export type DdtGroupSummary = { srNum: string; count: number };

export type DdtDashboard = {
  caseCount: number;
  groupCount: number;
  sourceCount: number;
  journeyCount: number;
  importedToday: number;
  updatedToday: number;
  groups: DdtGroupSummary[];
  timeline: Array<{ date: string; count: number }>;
};

export type DdtDeletedCase = DdtScope & {
  id: string;
  ddtCaseId: string;
  caseId: string;
  srNum: string;
  sourceName: string;
  deletedAt: string;
  deletedBy?: string;
};

export type DdtUploadReference = {
  id: string;
  fileName: string;
  objectKey: string;
  sha256: string;
  sizeBytes: number;
  mediaType: string;
};

export type DdtImportFile = {
  id: string;
  jobId: string;
  uploadId: string;
  fileName: string;
  archiveEntryName?: string;
  status: "valid" | "excluded" | "pending" | "importing" | "succeeded" | "failed" | "cancelled";
  rowCount: number;
  insertedCount: number;
  updatedCount: number;
  unchangedCount: number;
  skippedCount: number;
  errorSummary?: string;
  createdAt: string;
  updatedAt: string;
};

export type DdtImportJob = DdtScope & {
  id: string;
  status: DdtImportJobStatus;
  conflictStrategy?: "overwrite" | "skip" | "error";
  uploads: DdtUploadReference[];
  files: DdtImportFile[];
  progressPercent: number;
  totalFiles: number;
  validFiles: number;
  totalRows: number;
  insertedCount: number;
  updatedCount: number;
  unchangedCount: number;
  skippedCount: number;
  failedFiles: number;
  errorCode?: string;
  errorSummary?: string;
  requestedBy?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
};

export type DdtImportPreviewFile = {
  id: string;
  uploadId: string;
  fileName: string;
  archiveEntryName?: string;
  rowCount: number;
  insertedCount: number;
  updatedCount: number;
  unchangedCount: number;
  errorSummary?: string;
};

export type DdtImportCaseOutcome = "inserted" | "updated" | "unchanged" | "skipped";

export type DdtImportedRow = {
  id: string;
  caseId: string;
  srNum: string;
  data: DdtCaseData;
};

export type DdtImportFileResult = {
  insertedCount: number;
  updatedCount: number;
  unchangedCount: number;
  skippedCount: number;
  caseIds: Array<{ caseId: string; outcome: DdtImportCaseOutcome }>;
};

export type DdtCaseUpdateRecord = {
  scope: DdtScope;
  caseId: string;
  expectedRevision: number;
  nextData: DdtCaseData;
  history: Omit<DdtCaseHistory, "ddtCaseId" | "caseId"> & {
    id: string;
    changeType: DdtCaseHistory["changeType"];
  };
  actorId?: string;
  updatedAt: string;
};

export type DdtTemplateWriteRecord = DdtScope & {
  id: string;
  expectedRevision?: number;
  srNum: string;
  name: string;
  description: string;
  rules: DdtTemplateFieldRule[];
  actorId?: string;
  now: string;
};

export type DdtExportSelection = DdtScope & { caseIds?: string[]; srNum?: string };

export type DdtRepositoryReadModels = {
  case: DdtCase;
  template: DdtCaseTemplate;
};
