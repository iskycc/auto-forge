import { z } from "zod";

export const logArchiveMonthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "请选择有效月份。");
export const createLogArchiveSchema = z
  .object({
    month: logArchiveMonthSchema,
    projectId: z.string().uuid().optional(),
    targetVolumeMiB: z.number().int().min(1).max(8192).default(1024),
    minimumFreeMiB: z.number().int().min(256).max(131072).default(1024),
    minimumFreePercent: z.number().int().min(1).max(50).default(10),
  })
  .strict();
export const cleanupLogArchiveSchema = z.object({ confirm: z.literal(true) }).strict();
export const LOG_ARCHIVE_DOWNLOAD_SELECTION_LIMIT = 50;
export const createLogArchiveDownloadLinksSchema = z
  .object({
    archiveIds: z
      .array(z.string().uuid())
      .min(1)
      .max(LOG_ARCHIVE_DOWNLOAD_SELECTION_LIMIT)
      .refine((ids) => new Set(ids).size === ids.length, "归档不能重复选择。"),
  })
  .strict();
export const logArchiveDownloadLinksSchema = z.object({
  expiresAt: z.string().datetime(),
  items: z
    .array(
      z.object({
        archiveId: z.string().uuid(),
        filename: z.string().min(1).max(512),
        url: z.string().url().max(8192),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        sizeBytes: z.number().int().nonnegative(),
      }),
    )
    .min(1)
    .max(LOG_ARCHIVE_DOWNLOAD_SELECTION_LIMIT),
});
export type LogArchiveDownloadLinks = z.infer<typeof logArchiveDownloadLinksSchema>;
export type LogArchiveDownloadLink = LogArchiveDownloadLinks["items"][number];
export const removeLogArchiveCopySchema = z
  .object({
    downloadedAndVerified: z.literal(true),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type LogArchiveOptions = Pick<
  z.output<typeof createLogArchiveSchema>,
  "targetVolumeMiB" | "minimumFreeMiB" | "minimumFreePercent"
>;
export type LogArchiveCopyState =
  "retained" | "delete_requested" | "deleting" | "deleted" | "delete_failed";
export const logArchiveStatuses = [
  "queued",
  "building",
  "verifying",
  "ready",
  "cleaning",
  "completed",
  "failed",
  "cancelled",
] as const;
export type LogArchiveStatus = (typeof logArchiveStatuses)[number];
export type LogArchiveJob = {
  id: string;
  month: string;
  projectId?: string;
  status: LogArchiveStatus;
  totalBatches: number;
  processedBatches: number;
  cleanedBatches: number;
  attemptCount: number;
  chunkCount: number;
  sourceBytes: number;
  archiveBytes: number;
  reclaimedBytes: number;
  filename?: string;
  sha256?: string;
  errorMessage?: string;
  cancelRequested: boolean;
  createdAt: string;
  updatedAt: string;
  groupId?: string;
  volumeNumber?: number;
  targetVolumeMiB?: number;
  minimumFreeMiB?: number;
  minimumFreePercent?: number;
  copyState?: LogArchiveCopyState;
  downloadedAt?: string;
  copyDeletedAt?: string;
  copyRemovalError?: string;
  estimatedTemporaryBytes?: number;
  diskReservedBytes?: number;
  moreVolumesPending?: boolean;
};
export type LogArchiveBatch = {
  id: string;
  projectId: string;
  projectName: string;
  projectVersionName: string;
  testStageName: string;
  suiteName: string;
  sequenceNumber: number;
  status: string;
  createdAt: string;
  finishedAt: string;
};
export type LogArchiveStream = "stdout" | "stderr" | "agent";
export type LogArchiveStreamIndex = {
  sourceHash: string;
  indexOffset: number;
  frameCount: number;
  chunkCount: number;
  rawBytes: number;
  acknowledgedSequence: number;
};
export type LogArchiveAttempt = {
  id: string;
  executionRunId: string;
  caseId: string;
  caseType: "testng" | "ddt";
  className: string;
  displayName: string;
  roundIndex: number;
  attemptNumber: number;
  status: string;
  outcome?: string;
  startedAt?: string;
  finishedAt?: string;
  streams: Record<LogArchiveStream, LogArchiveStreamIndex>;
};
export type LogArchiveCatalogFrame = {
  firstId: string;
  lastId: string;
  offset: number;
  length: number;
  count: number;
};
export type LogArchiveManifest = {
  format: "autoforge-log-archive";
  schemaVersion: 1;
  id: string;
  month: string;
  timeZone: "Asia/Shanghai";
  createdAt: string;
  platformVersion: string;
  groupId?: string;
  volumeNumber?: number;
  sourceCutoffAt?: string;
  batchCount: number;
  attemptCount: number;
  chunkCount: number;
  rawBytes: number;
  batches: LogArchiveBatch[];
  files: Array<{ path: string; sizeBytes: number; sha256: string }>;
};

export type LogArchiveObjectIndex = {
  schemaVersion: 1;
  archiveBytes: number;
  entries: Record<string, { offset: number; sizeBytes: number }>;
};

export const logArchiveObjectIndexSchema = z.object({
  schemaVersion: z.literal(1),
  archiveBytes: z.number().int().nonnegative(),
  entries: z.record(
    z.string(),
    z.object({ offset: z.number().int().nonnegative(), sizeBytes: z.number().int().nonnegative() }),
  ),
});
export const logArchiveCatalogSchema = z
  .array(
    z.object({
      firstId: z.string(),
      lastId: z.string(),
      offset: z.number().int().nonnegative(),
      length: z
        .number()
        .int()
        .positive()
        .max(9 * 1024 * 1024),
      count: z.number().int().positive().max(100),
    }),
  )
  .max(100000);

export const logArchiveViewerResourceSchema = z.object({
  schemaVersion: z.literal(1),
  version: z.string(),
  license: z.object({
    path: z.literal("viewer-licenses.txt"),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    sizeBytes: z
      .number()
      .int()
      .positive()
      .max(4 * 1024 * 1024),
  }),
  files: z
    .array(
      z.object({
        path: z.string().regex(/^viewer-(linux-(amd64|arm64)|windows-amd64\.exe)$/),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        sizeBytes: z
          .number()
          .int()
          .positive()
          .max(64 * 1024 * 1024),
      }),
    )
    .length(3)
    .refine(
      (files) => new Set(files.map((file) => file.path)).size === 3,
      "离线查看器必须同时包含三个不同平台的程序。",
    ),
});
