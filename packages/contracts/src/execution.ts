import { z } from "zod";

export const RUNNER_PROTOCOL_VERSION = 1 as const;

const protocolVersionSchema = z.literal(RUNNER_PROTOCOL_VERSION);
const identifierSchema = z.string().trim().min(1).max(128);
const isoTimestampSchema = z.iso.datetime({ offset: true });
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const workspaceRelativePathSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/)
  .refine(
    (value) => !value.split("/").some((segment) => segment === "." || segment === ".."),
    "路径必须保持在 attempt 工作目录内。",
  );

export const executionInputSchema = z.object({
  inputId: identifierSchema,
  kind: z.literal("test-jar"),
  targetPath: workspaceRelativePathSchema,
  mediaType: z.literal("application/java-archive"),
  sizeBytes: z.number().int().positive().max(2_147_483_648),
  sha256: sha256Schema,
});

export const executionEnvironmentSchema = z
  .array(
    z.object({
      name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
      value: z.string().max(4_096),
      secret: z.boolean().default(false),
    }),
  )
  .max(128)
  .superRefine((entries, context) => {
    const names = entries.map((entry) => entry.name);
    if (new Set(names).size !== names.length) {
      context.addIssue({ code: "custom", message: "执行环境变量名不能重复。" });
    }
  });

export const executionSpecSchema = z.object({
  schemaVersion: protocolVersionSchema,
  executor: z.literal("testng"),
  attemptId: identifierSchema,
  executionRunId: identifierSchema,
  batchId: identifierSchema,
  className: z.string().trim().min(1).max(1_024),
  methodDescriptors: z.array(z.string().min(1).max(2_048)).max(1_024).default([]),
  inputs: z.array(executionInputSchema).length(1),
  environment: executionEnvironmentSchema.default([]),
  requiredLabels: z.array(z.string().trim().min(1).max(64)).max(64).default([]),
  requiredCapabilities: z.array(z.string().trim().min(1).max(128)).max(64).default([]),
  timeoutMs: z.number().int().min(1_000).max(86_400_000),
  uploadTimeoutMs: z.number().int().min(1_000).max(3_600_000),
  resourceLimits: z.object({
    cpuMillicores: z.number().int().min(1).max(1_000_000),
    memoryBytes: z
      .number()
      .int()
      .min(16 * 1_024 * 1_024)
      .max(1_099_511_627_776),
    diskBytes: z
      .number()
      .int()
      .min(16 * 1_024 * 1_024)
      .max(10_995_116_277_760),
    processCount: z.number().int().min(1).max(4_096),
    logBytes: z.number().int().min(1_024).max(10_737_418_240),
    artifactBytes: z.number().int().min(1_024).max(109_951_162_777_600),
  }),
});

export const assignmentSchema = z.object({
  schemaVersion: protocolVersionSchema,
  assignmentId: identifierSchema,
  attemptId: identifierSchema,
  runnerId: identifierSchema,
  priority: z.number().int().min(-1_000).max(1_000),
  availableAt: isoTimestampSchema,
  claimDeadlineAt: isoTimestampSchema,
  createdAt: isoTimestampSchema,
  executionSpec: executionSpecSchema,
});

export const claimAssignmentsInputSchema = z.object({
  schemaVersion: protocolVersionSchema,
  requestId: identifierSchema,
  availableSlots: z.number().int().min(0).max(1_024),
  labels: z.array(z.string().trim().min(1).max(64)).max(128).default([]),
  capabilities: z.array(z.string().trim().min(1).max(128)).max(128).default([]),
  waitSeconds: z.number().int().min(0).max(30).default(20),
});

export const leaseSchema = z.object({
  leaseId: identifierSchema,
  token: z.string().min(32).max(256),
  version: z.number().int().positive(),
  expiresAt: isoTimestampSchema,
});

export const claimedAssignmentSchema = z.object({
  assignment: assignmentSchema,
  lease: leaseSchema,
});

export const claimAssignmentsResponseSchema = z.object({
  schemaVersion: protocolVersionSchema,
  requestId: identifierSchema,
  assignments: z.array(claimedAssignmentSchema).max(1_024),
  retryAfterMs: z.number().int().min(100).max(60_000),
});

export const renewLeaseInputSchema = z.object({
  schemaVersion: protocolVersionSchema,
  requestId: identifierSchema,
  leaseToken: z.string().min(32).max(256),
  leaseVersion: z.number().int().positive(),
});

export const renewLeaseResponseSchema = z.object({
  schemaVersion: protocolVersionSchema,
  acceptedAt: isoTimestampSchema,
  leaseVersion: z.number().int().positive(),
  expiresAt: isoTimestampSchema,
  instruction: z.enum(["continue", "cancel", "drain"]),
});

export const logChunkSchema = z.object({
  stream: z.enum(["stdout", "stderr", "agent"]),
  sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  content: z.string().max(262_144),
  recordedAt: isoTimestampSchema,
});

export const uploadLogChunksInputSchema = z.object({
  schemaVersion: protocolVersionSchema,
  requestId: identifierSchema,
  leaseToken: z.string().min(32).max(256),
  chunks: z.array(logChunkSchema).min(1).max(256),
});

export const artifactDeclarationSchema = z.object({
  artifactId: identifierSchema,
  relativePath: z.string().min(1).max(1_024),
  mediaType: z.string().min(1).max(255),
  sizeBytes: z.number().int().min(0).max(109_951_162_777_600),
  sha256: sha256Schema,
  required: z.boolean(),
});

export const declareArtifactsInputSchema = z.object({
  schemaVersion: protocolVersionSchema,
  requestId: identifierSchema,
  leaseToken: z.string().min(32).max(256),
  artifacts: z.array(artifactDeclarationSchema).max(256),
});

export const completionResultSchema = z.object({
  status: z.enum(["succeeded", "failed", "timed_out", "cancelled"]),
  resultCode: z.string().trim().min(1).max(128),
  summary: z.string().max(4_096),
  durationMs: z.number().int().min(0).max(86_400_000),
  exitCode: z.number().int().min(-1).max(255).optional(),
  logWatermarks: z
    .object({
      stdout: z.number().int().min(-1),
      stderr: z.number().int().min(-1),
      agent: z.number().int().min(-1),
    })
    .optional(),
  artifacts: z.array(artifactDeclarationSchema).max(256).default([]),
});

export const completeAttemptInputSchema = z.object({
  schemaVersion: protocolVersionSchema,
  completionId: identifierSchema,
  leaseToken: z.string().min(32).max(256),
  result: completionResultSchema,
});

export const completeAttemptResponseSchema = z.object({
  schemaVersion: protocolVersionSchema,
  completionId: identifierSchema,
  acceptedAt: isoTimestampSchema,
  disposition: z.enum(["accepted", "duplicate", "late"]),
  retryScheduled: z.boolean(),
});

export const reconcileAttemptsInputSchema = z.object({
  schemaVersion: protocolVersionSchema,
  requestId: identifierSchema,
  attempts: z
    .array(
      z.object({
        attemptId: identifierSchema,
        leaseId: identifierSchema.optional(),
        leaseVersion: z.number().int().positive().optional(),
        localState: z.enum(["claimed", "running", "finishing", "completed"]),
        lastLogSequence: z
          .object({
            stdout: z.number().int().min(-1),
            stderr: z.number().int().min(-1),
            agent: z.number().int().min(-1),
          })
          .optional(),
      }),
    )
    .max(256),
});

export const reconcileAttemptsResponseSchema = z.object({
  schemaVersion: protocolVersionSchema,
  decisions: z
    .array(
      z.object({
        attemptId: identifierSchema,
        action: z.enum(["continue", "cancel", "retransmit", "clean"]),
        acknowledgedLogSequence: z
          .object({
            stdout: z.number().int().min(-1),
            stderr: z.number().int().min(-1),
            agent: z.number().int().min(-1),
          })
          .optional(),
      }),
    )
    .max(256),
});

export const cancelExecutionInputSchema = z.object({
  reason: z.string().trim().min(1).max(1_024),
});

export type ExecutionSpec = z.infer<typeof executionSpecSchema>;
export type ExecutionInput = z.infer<typeof executionInputSchema>;
export type AssignmentDto = z.infer<typeof assignmentSchema>;
export type ClaimAssignmentsInput = z.infer<typeof claimAssignmentsInputSchema>;
export type ClaimAssignmentsResponse = z.infer<typeof claimAssignmentsResponseSchema>;
export type RenewLeaseInput = z.infer<typeof renewLeaseInputSchema>;
export type RenewLeaseResponse = z.infer<typeof renewLeaseResponseSchema>;
export type CompletionResult = z.infer<typeof completionResultSchema>;
export type CompleteAttemptInput = z.infer<typeof completeAttemptInputSchema>;
export type CompleteAttemptResponse = z.infer<typeof completeAttemptResponseSchema>;
export type ReconcileAttemptsInput = z.infer<typeof reconcileAttemptsInputSchema>;
export type ReconcileAttemptsResponse = z.infer<typeof reconcileAttemptsResponseSchema>;
