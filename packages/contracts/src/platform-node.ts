import { z } from "zod";

export const platformNodeIdSchema = z.string().uuid();
export const platformNodeAddressSchema = z
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
    );
  }, "请输入节点的 HTTP(S) 地址和端口，不包含路径、凭据或查询参数。");

export const platformNodeSchema = z.object({
  id: platformNodeIdSchema,
  name: z.string().trim().min(1).max(120),
  internalBaseUrl: platformNodeAddressSchema.nullable(),
  revision: z.number().int().positive(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type PlatformNode = z.infer<typeof platformNodeSchema>;
export const updatePlatformNodeSchema = platformNodeSchema.pick({
  name: true,
  internalBaseUrl: true,
  revision: true,
});

const batchId = z.string().uuid();
const attemptId = z.string().min(1).max(128);
const stream = z.enum(["stdout", "stderr", "agent"]);
const chunk = z.object({
  stream,
  sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  content: z.string().max(262144),
  recordedAt: z.iso.datetime({ offset: true }),
});
export const nodeLogWatermarksSchema = z.object({
  stdout: z.number().int().min(-1),
  stderr: z.number().int().min(-1),
  agent: z.number().int().min(-1),
});
export const nodeLogRequestSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("append"),
    batchId,
    attemptId,
    receivedAt: z.iso.datetime({ offset: true }),
    chunks: z.array(chunk).min(1).max(256),
  }),
  z.object({
    operation: z.literal("list"),
    batchId,
    attemptId,
    stream,
    afterSequence: z.number().int().min(-1),
    limit: z.number().int().min(1).max(100),
    query: z.string().max(1000).optional(),
    recordedAfter: z.iso.datetime({ offset: true }).optional(),
    recordedBefore: z.iso.datetime({ offset: true }).optional(),
  }),
  z.object({ operation: z.literal("remove"), batchId }),
]);
export type NodeLogRequest = z.infer<typeof nodeLogRequestSchema>;
export const nodeLogResponseSchema = z.object({
  schemaVersion: z.literal(1),
  nodeId: platformNodeIdSchema,
  watermarks: nodeLogWatermarksSchema.optional(),
  page: z.object({ items: z.array(chunk).max(100), hasMore: z.boolean() }).optional(),
});
export type NodeLogResponse = z.infer<typeof nodeLogResponseSchema>;
