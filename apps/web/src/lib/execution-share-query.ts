import { z } from "zod";

export type ExecutionShareAccess = {
  accessToken?: string | undefined;
  publicAccess?: boolean | undefined;
};

export const executionShareQuerySchema = z.object({
  public: z.literal("1").optional(),
  access_token: z.string().min(1).max(4096).optional(),
});

export function executionShareAccess(query: z.infer<typeof executionShareQuerySchema>) {
  return { accessToken: query.access_token, publicAccess: query.public === "1" };
}

export function hasExecutionShareAccess(access: ExecutionShareAccess): boolean {
  return Boolean(access.accessToken || access.publicAccess);
}

export function executionShareQuery(access: ExecutionShareAccess, batchId?: string): string {
  const query = new URLSearchParams();
  if (access.accessToken) query.set("access_token", access.accessToken);
  else if (access.publicAccess) query.set("public", "1");
  if (query.size && batchId) query.set("batchId", batchId);
  return query.toString();
}
