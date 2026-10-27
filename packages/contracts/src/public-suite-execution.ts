import { z } from "zod";

export const executionActorSchema = z
  .object({
    id: z.string().min(1).max(128),
    username: z.string().min(1).max(256),
    source: z.enum(["local", "ldap"]),
  })
  .strict();

export const publicSuiteExecutionContextSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    publisher: executionActorSchema,
    initiator: executionActorSchema,
    requestKey: z.uuid(),
  })
  .strict();

export const storedExecutionActorSchema = executionActorSchema.extend({
  schemaVersion: z.literal(1).default(1),
});

export const publicSuiteExecutionResultSchema = z
  .object({
    batchId: z.string().min(1),
    progressPath: z.string().startsWith("/Execution?BatchId=").max(512),
  })
  .strict();

export const startPublicSuiteExecutionSchema = z
  .object({
    requestKey: z.uuid(),
    delaySeconds: z.number().int().min(0).max(604800).default(0),
  })
  .strict();

export const publicSuiteLinkQuerySchema = z
  .object({
    PublisherId: z.string().min(1).max(128),
  })
  .strict();

export const publicSuiteBatchSchema = z.object({
  id: z.string().min(1),
  sequenceNumber: z.number().int().nonnegative(),
  status: z.enum([
    "queued",
    "dispatching",
    "scheduled",
    "running",
    "succeeded",
    "failed",
    "cancelled",
  ]),
  totalRuns: z.number().int().nonnegative(),
  currentRound: z.number().int().positive(),
  requestedBy: z.string().nullable(),
  publisher: z.string().nullable(),
  terminatedBy: z.string().nullable(),
  terminationRequestedAt: z.string().nullable(),
  scheduledFor: z.string(),
  createdAt: z.string(),
  publicExecution: z.boolean(),
  progressPath: z.string().nullable(),
});

export const publicSuiteViewSchema = z.object({
  suiteId: z.string(),
  name: z.string(),
  description: z.string(),
  projectName: z.string(),
  versionName: z.string(),
  caseCount: z.number().int().nonnegative(),
  concurrency: z.number().int().positive(),
  retryLimit: z.number().int().nonnegative(),
  publisher: executionActorSchema,
  executable: z.boolean(),
  unavailableReason: z.string().nullable(),
  active: z.array(publicSuiteBatchSchema).max(10),
  recent: z.array(publicSuiteBatchSchema).max(5),
  generatedAt: z.iso.datetime(),
});

export function publicSuiteExecutionPath(suiteId: string, publisherId: string): string {
  return `/RunTask?${new URLSearchParams({ SuiteId: suiteId, PublisherId: publisherId })}`;
}

export type ExecutionActor = z.infer<typeof executionActorSchema>;
export type PublicSuiteExecutionContext = z.input<typeof publicSuiteExecutionContextSchema>;
export type StartPublicSuiteExecution = z.input<typeof startPublicSuiteExecutionSchema>;
export type PublicSuiteBatch = z.infer<typeof publicSuiteBatchSchema>;
export type PublicSuiteView = z.infer<typeof publicSuiteViewSchema>;
