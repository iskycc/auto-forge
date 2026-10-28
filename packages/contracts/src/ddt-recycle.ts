import { z } from "zod";
import { ddtScopeSchema } from "./ddt";

export const DDT_RECYCLE_PURGE_PAGE_SIZE = 200;

const pageQuery = {
  cursor: z.string().max(512).optional(),
  limit: z.number().int().min(1).max(100).default(30),
};
export const ddtRecycleGroupsInputSchema = ddtScopeSchema.extend(pageQuery).strict();
export const ddtRecycleCasesInputSchema = ddtScopeSchema
  .extend({
    ...pageQuery,
    limit: pageQuery.limit.removeDefault().default(60),
    srNum: z.string().max(512).optional(),
    query: z.string().trim().max(512).optional(),
  })
  .strict();
export const ddtRecycleGroupPageSchema = z.object({
  items: z.array(z.object({ srNum: z.string(), count: z.number().int().nonnegative() })),
  nextCursor: z.string().optional(),
  totalCases: z.number().int().nonnegative(),
  totalGroups: z.number().int().nonnegative(),
});
export const ddtRecycleCasePageSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().min(1),
      caseId: z.string(),
      srNum: z.string(),
      sourceName: z.string(),
      deletedAt: z.iso.datetime(),
    }),
  ),
  nextCursor: z.string().optional(),
});
export const ddtRecyclePurgeInputSchema = z
  .object({
    deletedBefore: z.iso.datetime().optional(),
  })
  .strict();
export const ddtRecyclePurgePageSchema = z.object({
  deletedBefore: z.iso.datetime(),
  deletedCount: z.number().int().min(0).max(DDT_RECYCLE_PURGE_PAGE_SIZE),
  hasMore: z.boolean(),
});
export type DdtRecycleGroupsInput = z.infer<typeof ddtRecycleGroupsInputSchema>;
export type DdtRecycleCasesInput = z.infer<typeof ddtRecycleCasesInputSchema>;
export type DdtRecycleGroupPage = z.infer<typeof ddtRecycleGroupPageSchema>;
export type DdtRecyclePurgePage = z.infer<typeof ddtRecyclePurgePageSchema>;
