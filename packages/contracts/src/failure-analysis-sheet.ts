import { z } from "zod";
import {
  completeFailureAnalysisInputSchema,
  failureAnalysisCandidateSchema,
  failureAnalysisClaimSchema,
  failureAnalysisSortSchema,
} from "./failure-analysis";

export function publicFailureAnalysisPath(batchId: string): string {
  return `/CaseAnalysis?BatchId=${encodeURIComponent(batchId)}`;
}

export const failureAnalysisSheetQuerySchema = z.object({
  view: z.enum(["all", "mine"]).default("all"),
  query: z.string().trim().max(240).optional(),
  sort: failureAnalysisSortSchema.default("class_path"),
  direction: z.enum(["asc", "desc"]).default("asc"),
  cursor: z.string().max(1_024).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const failureAnalysisSheetRowSchema = failureAnalysisCandidateSchema.extend({
  analysis: failureAnalysisClaimSchema.optional(),
});

export const failureAnalysisSheetPageSchema = z.object({
  items: z.array(failureAnalysisSheetRowSchema),
  nextCursor: z.string().optional(),
});

// Scope and ownership always come from the route and authenticated session.
export const completeFailureAnalysisSheetInputSchema = completeFailureAnalysisInputSchema
  .omit({ projectId: true, inheritedFromAnalysisId: true, inheritanceScope: true })
  .extend({ expectedUpdatedAt: z.string().datetime().optional() })
  .strict();

export const failureAnalysisSheetSelectionSchema = z
  .object({
    executionRunIds: z.array(z.string().min(1).max(200)).min(1).max(100),
  })
  .strict();

export type FailureAnalysisSheetRow = z.infer<typeof failureAnalysisSheetRowSchema>;
export type FailureAnalysisSheetPage = z.infer<typeof failureAnalysisSheetPageSchema>;
export type FailureAnalysisSheetQuery = z.infer<typeof failureAnalysisSheetQuerySchema>;
export type CompleteFailureAnalysisSheetInput = z.infer<
  typeof completeFailureAnalysisSheetInputSchema
>;
