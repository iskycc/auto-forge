import { z } from "zod";

export const createProjectVersionCopySchema = z
  .object({
    sourceProjectId: z.string().min(1).max(128),
    sourceVersionId: z.string().min(1).max(128),
    targetProjectId: z.string().min(1).max(128),
    targetVersionName: z.string().trim().min(1).max(120).optional(),
    targetVersionId: z.string().min(1).max(128).optional(),
    requestKey: z.string().min(1).max(128),
  })
  .strict()
  .refine((input) => Boolean(input.targetVersionName) !== Boolean(input.targetVersionId), {
    message: "请选择已有空版本，或填写新版本名称，两者不能同时提供。",
    path: ["targetVersionId"],
  });

export const projectVersionCopyTargetsSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      status: z.enum(["active", "archived"]),
      empty: z.boolean(),
    }),
  ),
  nextCursor: z.string().optional(),
});
export type ProjectVersionCopyTargets = z.infer<typeof projectVersionCopyTargetsSchema>;

export const projectVersionCopySchema = z.object({
  id: z.string(),
  sourceProjectId: z.string(),
  sourceVersionId: z.string(),
  sourceVersionName: z.string(),
  targetProjectId: z.string(),
  targetVersionName: z.string(),
  targetMode: z.enum(["new", "existing"]),
  targetVersionId: z.string().optional(),
  status: z.enum(["queued", "running", "cancelling", "completed", "failed", "cancelled"]),
  phase: z.enum(["snapshot", "files", "records", "logs", "verify", "cleanup", "done"]),
  totalRows: z.number().int().nonnegative(),
  copiedRows: z.number().int().nonnegative(),
  totalObjects: z.number().int().nonnegative(),
  copiedObjects: z.number().int().nonnegative(),
  totalAttempts: z.number().int().nonnegative(),
  copiedAttempts: z.number().int().nonnegative(),
  progressPercent: z.number().int().min(0).max(100),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  requestedBy: z.string(),
});

export type CreateProjectVersionCopy = z.infer<typeof createProjectVersionCopySchema>;
export type ProjectVersionCopy = z.infer<typeof projectVersionCopySchema>;

export const projectVersionCopySnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  objectKey: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  sizeBytes: z.number().int().nonnegative(),
});

export const projectVersionCopyManifestSchema = z.object({
  schemaVersion: z.literal(1),
  collections: z.array(
    z.object({
      name: z.string(),
      primaryKey: z.array(z.string()),
      count: z.number().int().nonnegative(),
    }),
  ),
  rows: z.number().int().nonnegative(),
  objects: z.number().int().nonnegative(),
  attempts: z.number().int().nonnegative(),
});
