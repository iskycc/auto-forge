import { z } from "zod";

export const JOB_SCHEMA_VERSION = 1 as const;

export const jobEnvelopeSchema = z.object({
  schemaVersion: z.literal(JOB_SCHEMA_VERSION),
  messageId: z.string().min(1).max(128),
  runId: z.string().min(1).max(128),
  attempt: z.number().int().min(1).max(1_000),
  createdAt: z.iso.datetime({ offset: true }),
  priority: z.number().int().min(-1_000).max(1_000).default(0),
  deduplicationKey: z.string().min(1).max(256),
  kind: z.enum([
    "dispatch-run",
    "ldap-sync",
    "analytics-rollup",
    "retention-cleanup",
    "object-cleanup",
    "jar-import",
    "analytics-export",
  ]),
  payload: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
});

export type JobEnvelope = z.infer<typeof jobEnvelopeSchema>;
