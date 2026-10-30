import { z } from "zod";
import { caseSuiteAdapterConfigurationSchema } from "./management";

export const publicSuiteEnvironmentAddressesSchema = z
  .array(
    z
      .string()
      .trim()
      .max(45)
      .pipe(z.union([z.ipv4(), z.ipv6()])),
  )
  .min(1)
  .max(128)
  .refine(
    (addresses) =>
      new Set(addresses.map((address) => address.toLowerCase())).size === addresses.length,
    {
      message: "环境 IP 不能重复。",
    },
  );

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
    environmentAddresses: publicSuiteEnvironmentAddressesSchema.optional(),
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
    environmentAddresses: publicSuiteEnvironmentAddressesSchema.optional(),
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
  pauseRequestedAt: z.string().nullable().optional(),
  terminationRequestedAt: z.string().nullable(),
  scheduledFor: z.string(),
  createdAt: z.string(),
  publicExecution: z.boolean(),
  progressPath: z.string().nullable(),
  environmentAddresses: caseSuiteAdapterConfigurationSchema.shape.environmentAddresses,
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
  adapterEnabled: z.boolean().default(false),
  environmentAddresses: caseSuiteAdapterConfigurationSchema.shape.environmentAddresses,
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
