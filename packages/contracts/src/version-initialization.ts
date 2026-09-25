import { z } from "zod";

const identifier = z.string().trim().min(1).max(128);
export const versionInitializationMemberCursorSchema = z.object({
  afterCaseMemberId: identifier.optional(),
  afterDdtMemberId: identifier.optional(),
});
export const versionInitializationInputSchema = z.object({
  sourceProjectVersionId: identifier,
  step: z.enum(["stage", "runtime", "testng", "ddt", "range", "categories", "sr", "suite"]),
  sourceTestStageId: identifier.optional(),
  targetTestStageId: identifier.optional(),
  sourceSuiteId: identifier.optional(),
  sourceSuiteRevision: z.number().int().positive().optional(),
  includeCases: z.boolean().default(true),
  stageMappings: z
    .array(z.object({ sourceTestStageId: identifier, targetTestStageId: identifier }))
    .max(1_000)
    .default([]),
  cursor: z.string().min(1).max(2_048).optional(),
});

export const versionInitializationResultSchema = z.object({
  inheritedCount: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
  warnings: z.array(z.string().max(1_024)).max(50).default([]),
  nextCursor: z.string().max(2_048).optional(),
  targetTestStageId: identifier.optional(),
  targetSuiteId: identifier.optional(),
});

export type VersionInitializationInput = z.infer<typeof versionInitializationInputSchema>;
export type VersionInitializationResult = z.infer<typeof versionInitializationResultSchema>;
