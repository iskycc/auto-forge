import { createHash } from "node:crypto";

import type { JobEnvelope } from "@autoforge/contracts";
import {
  DomainError,
  ddtCaseCell,
  normalizeDdtCaseData,
  validateDdtCaseAgainstTemplate,
  type DdtCaseData,
  type DdtCaseTemplate,
  type DdtScope,
} from "@autoforge/domain";

import type { DdtImportJob, DdtImportPreviewFile, DdtUploadReference } from "./ddt-types";
import type { Clock, DdtRepository, IdGenerator, JarObjectStorePort } from "./ports";

export type DdtUpload = {
  fileName: string;
  mediaType: string;
  content: Uint8Array;
};

export type ParsedDdtFile = {
  fileName: string;
  archiveEntryName?: string;
  rows: DdtCaseData[];
};

export interface DdtSpreadsheetPort {
  parseUpload(upload: DdtUpload): Promise<ParsedDdtFile[]>;
}

export class DdtImportService {
  constructor(
    private readonly repository: DdtRepository,
    private readonly objectStore: JarObjectStorePort,
    private readonly spreadsheets: DdtSpreadsheetPort,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async preview(scope: DdtScope, uploads: DdtUpload[], actorId?: string): Promise<DdtImportJob> {
    if (uploads.length === 0) throw new DomainError("DDT_FILE_REQUIRED", "请选择 DDT 表格或 ZIP。");
    const jobId = this.ids.next();
    const now = this.clock.now().toISOString();
    const storedUploads: DdtUploadReference[] = [];
    const previewFiles: DdtImportPreviewFile[] = [];
    const seenCaseIds = new Set<string>();
    const templates = new Map(
      (await this.repository.listTemplates(scope)).map((template) => [
        template.srNum.toLocaleLowerCase("en-US"),
        template,
      ]),
    );
    try {
      for (const upload of uploads) {
        const uploadReference = await this.storeUpload(scope.projectId, jobId, upload);
        storedUploads.push(uploadReference);
        let parsedFiles: ParsedDdtFile[];
        try {
          parsedFiles = await this.spreadsheets.parseUpload(upload);
        } catch (error) {
          previewFiles.push({
            id: this.ids.next(),
            uploadId: uploadReference.id,
            fileName: upload.fileName,
            rowCount: 0,
            insertedCount: 0,
            updatedCount: 0,
            unchangedCount: 0,
            errorSummary: errorMessage(error),
          });
          continue;
        }
        for (const parsed of parsedFiles) {
          previewFiles.push(
            await this.previewParsedFile(scope, uploadReference.id, parsed, seenCaseIds, templates),
          );
        }
      }
      const validFiles = previewFiles.filter((file) => !file.errorSummary);
      const job: Omit<DdtImportJob, "files"> = {
        ...scope,
        id: jobId,
        status: "previewed",
        uploads: storedUploads,
        progressPercent: 0,
        totalFiles: previewFiles.length,
        validFiles: validFiles.length,
        totalRows: validFiles.reduce((total, file) => total + file.rowCount, 0),
        insertedCount: 0,
        updatedCount: 0,
        unchangedCount: 0,
        skippedCount: 0,
        failedFiles: previewFiles.length - validFiles.length,
        ...(actorId ? { requestedBy: actorId } : {}),
        createdAt: now,
        updatedAt: now,
      };
      return await this.repository.createImportPreview({ job, files: previewFiles });
    } catch (error) {
      await Promise.allSettled(
        storedUploads.map((upload) => this.objectStore.delete(upload.objectKey)),
      );
      throw error;
    }
  }

  async confirm(
    jobId: string,
    conflictStrategy: "overwrite" | "skip" | "error",
    projectIds?: readonly string[],
  ): Promise<DdtImportJob> {
    const now = this.clock.now().toISOString();
    return this.repository.confirmImport({
      jobId,
      conflictStrategy,
      dispatchJob: this.jobEnvelope(jobId, now),
      updatedAt: now,
      ...(projectIds ? { projectIds } : {}),
    });
  }

  get(jobId: string, projectIds?: readonly string[]) {
    return this.repository.getImportJob(jobId, projectIds);
  }

  list(scope: DdtScope, cursor?: string, limit = 50) {
    return this.repository.listImportJobs({
      ...scope,
      ...(cursor ? { cursor } : {}),
      limit,
    });
  }

  async cancel(jobId: string, projectIds?: readonly string[]): Promise<DdtImportJob> {
    return this.repository.requestImportCancellation(
      jobId,
      this.clock.now().toISOString(),
      projectIds,
    );
  }

  caseIds(jobId: string, projectIds?: readonly string[]) {
    return this.repository.listImportCaseIds(jobId, projectIds);
  }

  jobHandler() {
    return async (envelope: JobEnvelope, signal: AbortSignal): Promise<void> => {
      const jobId = envelope.payload.jobId;
      if (typeof jobId !== "string") throw new Error("DDT import jobId is invalid.");
      const startedAt = this.clock.now().toISOString();
      const job = await this.repository.claimImportJob(jobId, startedAt);
      if (!job) return;
      try {
        await this.executeClaimedJob(job, signal);
      } catch (error) {
        if (signal.aborted && !(error instanceof DdtImportCancellationError)) throw error;
        const finishedAt = this.clock.now().toISOString();
        const cancelled = error instanceof DdtImportCancellationError;
        await this.repository.updateImportJob({
          jobId,
          status: cancelled ? "cancelled" : "failed",
          progressPercent: 100,
          ...(!cancelled
            ? {
                errorCode: error instanceof DomainError ? error.code : "DDT_IMPORT_FAILED",
                errorSummary: errorMessage(error),
              }
            : {}),
          updatedAt: finishedAt,
          finishedAt,
        });
        if (!cancelled) throw error;
      }
    };
  }

  private async executeClaimedJob(job: DdtImportJob, signal: AbortSignal): Promise<void> {
    if (!job.conflictStrategy) throw new Error("DDT import strategy is missing.");
    const templates = new Map(
      (await this.repository.listTemplates(job)).map((template) => [
        template.srNum.toLocaleLowerCase("en-US"),
        template,
      ]),
    );
    const parsedByFile = await this.parseJobUploads(job);
    if (job.conflictStrategy === "error") {
      const allCaseIds = job.files.flatMap((file) =>
        ["valid", "importing"].includes(file.status)
          ? (parsedByFile.get(file.id)?.rows ?? []).map((row) => String(ddtCaseCell(row, "CaseID")))
          : [],
      );
      if ((await this.repository.findCaseData(job, allCaseIds)).size > 0) {
        throw new DomainError(
          "DDT_IMPORT_CONFLICT",
          "冲突策略为“遇到冲突终止”，当前范围已存在相同 CaseID。",
        );
      }
    }
    const completedFiles = job.files.filter((file) => file.status === "succeeded");
    let insertedCount = sum(completedFiles, (file) => file.insertedCount);
    let updatedCount = sum(completedFiles, (file) => file.updatedCount);
    let unchangedCount = sum(completedFiles, (file) => file.unchangedCount);
    let skippedCount = sum(completedFiles, (file) => file.skippedCount);
    let failedFiles = job.files.filter((file) =>
      ["excluded", "failed"].includes(file.status),
    ).length;
    let succeededFiles = completedFiles.length;
    const candidates = job.files.filter((file) => ["valid", "importing"].includes(file.status));
    for (let index = 0; index < candidates.length; index += 1) {
      await this.throwIfCancelled(job.id, signal);
      const file = candidates[index]!;
      const parsed = parsedByFile.get(file.id);
      if (!parsed) {
        failedFiles += 1;
        await this.repository.updateImportFile({
          fileId: file.id,
          status: "failed",
          errorSummary: "确认导入时未找到预检通过的表格内容。",
          updatedAt: this.clock.now().toISOString(),
        });
        continue;
      }
      try {
        const rows = parsed.rows.map((row) => {
          const normalized = normalizeDdtCaseData(row);
          const template = templates.get(
            String(ddtCaseCell(normalized, "srNum")).toLocaleLowerCase("en-US"),
          );
          const validated = validateDdtCaseAgainstTemplate(normalized, template);
          if (validated.errors.length > 0) {
            throw new DomainError(
              "DDT_TEMPLATE_VALIDATION_FAILED",
              `${String(ddtCaseCell(normalized, "CaseID"))}：${validated.errors
                .map((issue) => issue.message)
                .join("；")}`,
            );
          }
          return {
            id: this.ids.next(),
            caseId: String(ddtCaseCell(validated.data, "CaseID")),
            srNum: String(ddtCaseCell(validated.data, "srNum")),
            data: validated.data,
          };
        });
        await this.repository.updateImportFile({
          fileId: file.id,
          status: "importing",
          updatedAt: this.clock.now().toISOString(),
        });
        const result = await this.repository.importFile({
          jobId: job.id,
          fileId: file.id,
          scope: job,
          sourceName: file.fileName,
          rows,
          conflictStrategy: job.conflictStrategy,
          ...(job.requestedBy ? { actorId: job.requestedBy } : {}),
          importedAt: this.clock.now().toISOString(),
          historyIds: rows.map(() => this.ids.next()),
        });
        insertedCount += result.insertedCount;
        updatedCount += result.updatedCount;
        unchangedCount += result.unchangedCount;
        skippedCount += result.skippedCount;
        succeededFiles += 1;
        await this.repository.updateImportFile({
          fileId: file.id,
          status: "succeeded",
          result,
          updatedAt: this.clock.now().toISOString(),
        });
      } catch (error) {
        if (signal.aborted) throw error;
        failedFiles += 1;
        await this.repository.updateImportFile({
          fileId: file.id,
          status: "failed",
          errorSummary: errorMessage(error),
          updatedAt: this.clock.now().toISOString(),
        });
        if (
          job.conflictStrategy === "error" &&
          error instanceof DomainError &&
          error.code === "DDT_IMPORT_CONFLICT"
        ) {
          throw error;
        }
      }
      await this.repository.updateImportJob({
        jobId: job.id,
        status: "running",
        progressPercent: Math.max(1, Math.round(((index + 1) / candidates.length) * 95)),
        insertedCount,
        updatedCount,
        unchangedCount,
        skippedCount,
        failedFiles,
        updatedAt: this.clock.now().toISOString(),
      });
    }
    const finishedAt = this.clock.now().toISOString();
    await this.repository.updateImportJob({
      jobId: job.id,
      status:
        failedFiles === 0 ? "succeeded" : succeededFiles > 0 ? "partially_succeeded" : "failed",
      progressPercent: 100,
      insertedCount,
      updatedCount,
      unchangedCount,
      skippedCount,
      failedFiles,
      ...(succeededFiles === 0 && failedFiles > 0
        ? { errorCode: "DDT_IMPORT_ALL_FILES_FAILED", errorSummary: "所有表格均导入失败。" }
        : {}),
      updatedAt: finishedAt,
      finishedAt,
    });
  }

  private async previewParsedFile(
    scope: DdtScope,
    uploadId: string,
    parsed: ParsedDdtFile,
    seenCaseIds: Set<string>,
    templates: ReadonlyMap<string, DdtCaseTemplate>,
  ): Promise<DdtImportPreviewFile> {
    const id = this.ids.next();
    try {
      const rows = parsed.rows.map((row) => {
        const normalized = normalizeDdtCaseData(row);
        const template = templates.get(
          String(ddtCaseCell(normalized, "srNum")).toLocaleLowerCase("en-US"),
        );
        const validation = validateDdtCaseAgainstTemplate(normalized, template);
        if (validation.errors.length > 0) {
          throw new DomainError(
            "DDT_TEMPLATE_VALIDATION_FAILED",
            validation.errors.map((issue) => issue.message).join("；"),
          );
        }
        return validation.data;
      });
      const normalizedIds = rows.map((row) =>
        String(ddtCaseCell(row, "CaseID")).toLocaleLowerCase("en-US"),
      );
      const duplicate = normalizedIds.find((caseId) => seenCaseIds.has(caseId));
      if (duplicate) {
        throw new DomainError(
          "DDT_IMPORT_DUPLICATE_CASE_ID",
          `CaseID“${String(ddtCaseCell(rows[normalizedIds.indexOf(duplicate)]!, "CaseID"))}”在多个表格中重复。`,
        );
      }
      const existing = await this.repository.findCaseData(
        scope,
        rows.map((row) => String(ddtCaseCell(row, "CaseID"))),
      );
      let updatedCount = 0;
      let unchangedCount = 0;
      for (const row of rows) {
        const caseId = String(ddtCaseCell(row, "CaseID")).toLocaleLowerCase("en-US");
        const current = existing.get(caseId);
        if (!current) continue;
        if (JSON.stringify(current) === JSON.stringify(row)) unchangedCount += 1;
        else updatedCount += 1;
      }
      normalizedIds.forEach((caseId) => seenCaseIds.add(caseId));
      return {
        id,
        uploadId,
        fileName: parsed.fileName,
        ...(parsed.archiveEntryName ? { archiveEntryName: parsed.archiveEntryName } : {}),
        rowCount: rows.length,
        insertedCount: rows.length - existing.size,
        updatedCount,
        unchangedCount,
      };
    } catch (error) {
      return {
        id,
        uploadId,
        fileName: parsed.fileName,
        ...(parsed.archiveEntryName ? { archiveEntryName: parsed.archiveEntryName } : {}),
        rowCount: 0,
        insertedCount: 0,
        updatedCount: 0,
        unchangedCount: 0,
        errorSummary: errorMessage(error),
      };
    }
  }

  private async parseJobUploads(job: DdtImportJob): Promise<Map<string, ParsedDdtFile>> {
    const parsedByFile = new Map<string, ParsedDdtFile>();
    for (const upload of job.uploads) {
      const content = await this.objectStore.read(upload.objectKey);
      const parsed = await this.spreadsheets.parseUpload({
        fileName: upload.fileName,
        mediaType: upload.mediaType,
        content,
      });
      const expected = job.files.filter((file) => file.uploadId === upload.id);
      for (const file of expected) {
        const match = parsed.find(
          (candidate) =>
            candidate.fileName === file.fileName &&
            candidate.archiveEntryName === file.archiveEntryName,
        );
        if (match) parsedByFile.set(file.id, match);
      }
    }
    return parsedByFile;
  }

  private async throwIfCancelled(jobId: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason ?? new Error("DDT import worker was interrupted.");
    const job = await this.repository.getImportJob(jobId);
    if (job?.status === "cancel_requested" || job?.status === "cancelled") {
      throw new DdtImportCancellationError();
    }
  }

  private async storeUpload(
    projectId: string,
    jobId: string,
    upload: DdtUpload,
  ): Promise<DdtUploadReference> {
    const id = this.ids.next();
    const sha256 = createHash("sha256").update(upload.content).digest("hex");
    const extension = safeExtension(upload.fileName);
    const objectKey = `projects/${projectId}/ddt-imports/${jobId}/${id}-${sha256.slice(0, 16)}${extension}`;
    await this.objectStore.putObject({
      objectKey,
      sha256,
      sizeBytes: upload.content.byteLength,
      mediaType: upload.mediaType || "application/octet-stream",
      content: oneChunk(upload.content),
    });
    return {
      id,
      fileName: upload.fileName,
      objectKey,
      sha256,
      sizeBytes: upload.content.byteLength,
      mediaType: upload.mediaType || "application/octet-stream",
    };
  }

  private jobEnvelope(jobId: string, createdAt: string): JobEnvelope {
    const messageId = this.ids.next();
    return {
      schemaVersion: 1,
      messageId,
      runId: jobId,
      attempt: 1,
      createdAt,
      priority: 0,
      deduplicationKey: `ddt-import:${jobId}:${messageId}`,
      kind: "ddt-import",
      payload: { jobId },
    };
  }
}

async function* oneChunk(content: Uint8Array): AsyncGenerator<Uint8Array> {
  yield content;
}

function safeExtension(fileName: string): string {
  const match = /\.[A-Za-z0-9]{1,8}$/.exec(fileName);
  return match ? match[0].toLocaleLowerCase("en-US") : ".bin";
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : "DDT 导入失败。").slice(0, 1_000);
}

class DdtImportCancellationError extends Error {}

function sum<Item>(items: readonly Item[], value: (item: Item) => number): number {
  return items.reduce((total, item) => total + value(item), 0);
}
