import { z } from "zod";
import { ddtCaseListInputSchema, ddtScopeSchema, ddtCategoryIdsSchema } from "@autoforge/contracts";
import type { DdtRepository } from "@autoforge/application";

export const ddtExportSelectionSchema = z.object({
  categoryIds: ddtCategoryIdsSchema.optional(),
  caseIds: z.array(z.string().min(1).max(512)).max(5_000).optional(),
  srNum: z.string().trim().min(1).max(512).optional(),
});

const readSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("listCases"), input: ddtCaseListInputSchema }).strict(),
  z
    .object({
      method: z.literal("readExportCasesPage"),
      input: ddtScopeSchema
        .extend({
          ...ddtExportSelectionSchema.shape,
          cursor: z.string().max(1_024).optional(),
        })
        .strict(),
    })
    .strict(),
]);

/** Only bounded, read-only DDT operations may enter the disposable reader. */
export function readDdtCases(repository: DdtRepository, value: unknown): Promise<unknown> {
  const request = readSchema.parse(value);
  const input = request.input;
  const selection = {
    projectId: input.projectId,
    projectVersionId: input.projectVersionId,
    testStageId: input.testStageId,
    ...(input.caseIds !== undefined ? { caseIds: input.caseIds } : {}),
    ...(input.categoryIds !== undefined ? { categoryIds: input.categoryIds } : {}),
    ...(input.srNum !== undefined ? { srNum: input.srNum } : {}),
    ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
  };
  if (request.method === "readExportCasesPage") return repository.readExportCasesPage(selection);
  const query = request.input;
  return repository.listCases({
    ...selection,
    limit: query.limit,
    filters: query.filters,
    ...(query.query !== undefined ? { query: query.query } : {}),
    ...(query.queryMatch !== undefined ? { queryMatch: query.queryMatch } : {}),
    ...(query.sourceName !== undefined ? { sourceName: query.sourceName } : {}),
  });
}
