import { z } from "zod";

export const RUNNER_PROTOCOL_VERSION = 1 as const;

/** 执行机协议高频写请求的正文上限（字节），路由层与组合根快路径共用。 */
export const RUNNER_CLAIM_BODY_LIMIT_BYTES = 64 * 1024;
export const RUNNER_COMPLETE_BODY_LIMIT_BYTES = 512 * 1024;
export const RUNNER_LOG_UPLOAD_BODY_LIMIT_BYTES = 2 * 1024 * 1024;

const protocolVersionSchema = z.literal(RUNNER_PROTOCOL_VERSION);
const identifierSchema = z.string().trim().min(1).max(128);
const isoTimestampSchema = z.iso.datetime({ offset: true });
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const workspaceRelativePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => {
    if (
      value.startsWith("/") ||
      value.endsWith("/") ||
      value.includes("\\") ||
      /[\u0000-\u001f\u007f:*?"<>|]/u.test(value)
    ) {
      return false;
    }
    return value
      .split("/")
      .every(
        (segment) =>
          segment.length > 0 &&
          segment !== "." &&
          segment !== ".." &&
          !segment.endsWith(".") &&
          !segment.endsWith(" "),
      );
  }, "路径必须保持在 attempt 工作目录内。");
const artifactPatternSchema = z
  .string()
  .regex(/^[A-Za-z0-9*?][A-Za-z0-9._/*?-]{0,511}$/)
  .refine(
    (value) => !value.split("/").some((segment) => segment === "." || segment === ".."),
    "产物规则必须保持在 attempt 工作目录内。",
  );
const jvmMethodSelectorSchema = z
  .string()
  .min(4)
  .max(2_048)
  .refine(isJvmMethodSelector, "方法选择器必须包含方法名和有效的 JVM descriptor。");

export const executionInputSchema = z
  .object({
    inputId: identifierSchema,
    kind: z.enum(["test-jar", "dependency-jar", "jdk-archive", "jar-bundle"]),
    targetPath: workspaceRelativePathSchema,
    mediaType: z.enum(["application/java-archive", "application/zip", "application/gzip"]),
    sizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    sha256: sha256Schema,
    downloadUrl: z
      .url()
      .max(2_048)
      .refine((value) => {
        const url = new URL(value);
        return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
      })
      .optional(),
  })
  .superRefine((input, context) => {
    const lowerPath = input.targetPath.toLowerCase();
    if (["test-jar", "dependency-jar"].includes(input.kind)) {
      if (!lowerPath.endsWith(".jar") || input.mediaType !== "application/java-archive") {
        context.addIssue({ code: "custom", message: "JAR 输入的路径和媒体类型不匹配。" });
      }
      return;
    }
    const archiveMatches =
      (lowerPath.endsWith(".zip") && input.mediaType === "application/zip") ||
      ((lowerPath.endsWith(".tar.gz") || lowerPath.endsWith(".tgz")) &&
        input.mediaType === "application/gzip");
    if (!archiveMatches) {
      context.addIssue({ code: "custom", message: "运行时压缩包的路径和媒体类型不匹配。" });
    }
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

export const executionSecretReferenceSchema = z.object({
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
  secretId: identifierSchema,
  secretVersionId: identifierSchema,
});

const testNgParametersSchema = z
  .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/), z.string().max(4_096))
  .refine((parameters) => Object.keys(parameters).length <= 128, "TestNG 参数不能超过 128 项。");

const runtimeRequirementsSchema = z.object({
  os: z.literal("linux").default("linux"),
  architectures: z
    .array(z.enum(["amd64", "arm64"]))
    .min(1)
    .max(2)
    .refine((architectures) => new Set(architectures).size === architectures.length)
    .default(["amd64", "arm64"]),
  minimumJavaMajorVersion: z.number().int().min(11).max(100).default(11),
  testNgVersion: z
    .string()
    .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
    .default("7.11.0"),
});

export const executionSpecSchema = z
  .object({
    schemaVersion: protocolVersionSchema,
    executor: z.enum(["testng", "testng-container"]),
    attemptId: identifierSchema,
    executionRunId: identifierSchema,
    batchId: identifierSchema,
    className: z.string().trim().min(1).max(1_024),
    methodDescriptors: z.array(jvmMethodSelectorSchema).max(1_024).default([]),
    parameters: testNgParametersSchema.default({}),
    adapter: z
      .object({
        suiteName: z.string().max(512).default(""),
        testName: z.string().max(512).default(""),
        environmentAddress: z.string().max(2_048).default(""),
        // 用例执行超时（秒）：由 adapter 自身看门狗强制中断执行；可选新增字段，
        // 历史规格缺失时回落到平台默认值 600 秒。
        caseTimeoutSeconds: z.number().int().min(1).max(86_400).default(600),
      })
      .optional(),
    inputs: z.array(executionInputSchema).min(1).max(128),
    environment: executionEnvironmentSchema.default([]),
    secretReferences: z.array(executionSecretReferenceSchema).max(64).default([]),
    runtimeRequirements: runtimeRequirementsSchema.default({
      os: "linux",
      architectures: ["amd64", "arm64"],
      minimumJavaMajorVersion: 11,
      testNgVersion: "7.11.0",
    }),
    requiredLabels: z.array(z.string().trim().min(1).max(64)).max(64).default([]),
    requiredCapabilities: z
      .array(z.string().trim().min(1).max(128))
      .max(64)
      .default([])
      .transform((capabilities) =>
        capabilities.filter((capability) => capability !== "isolation:cgroup-v2"),
      ),
    artifactRules: z
      .array(
        z.object({
          pattern: artifactPatternSchema,
          required: z.boolean().default(false),
          mediaType: z.string().trim().min(1).max(255).optional(),
        }),
      )
      .max(64)
      .default([]),
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
      fileCount: z.number().int().min(16).max(1_000_000).default(10_000),
      logBytes: z.number().int().min(1_024).max(10_737_418_240),
      artifactBytes: z.number().int().min(1_024).max(109_951_162_777_600),
    }),
  })
  .superRefine((specification, context) => {
    const environmentNames = [
      ...specification.environment.map((entry) => entry.name),
      ...specification.secretReferences.map((entry) => entry.name),
    ];
    if (new Set(environmentNames).size !== environmentNames.length) {
      context.addIssue({
        code: "custom",
        path: ["secretReferences"],
        message: "执行变量名不能重复。",
      });
    }
    if (specification.inputs.filter((input) => input.kind === "test-jar").length !== 1) {
      context.addIssue({
        code: "custom",
        path: ["inputs"],
        message: "TestNG 执行必须且只能包含一个权威 test JAR。",
      });
    }
    for (const kind of ["jdk-archive", "jar-bundle"] as const) {
      if (specification.inputs.filter((input) => input.kind === kind).length > 1) {
        context.addIssue({
          code: "custom",
          path: ["inputs"],
          message: `执行输入最多包含一个 ${kind}。`,
        });
      }
    }
    for (const field of ["inputId", "targetPath"] as const) {
      const values = specification.inputs.map((input) => input[field]);
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: "custom",
          path: ["inputs"],
          message: `执行输入 ${field} 不能重复。`,
        });
      }
    }
    const totalInputBytes = specification.inputs.reduce(
      (total, input) => total + input.sizeBytes,
      0,
    );
    if (totalInputBytes > specification.resourceLimits.diskBytes) {
      context.addIssue({
        code: "custom",
        path: ["inputs"],
        message: "执行输入总大小超过 attempt 磁盘限制。",
      });
    }
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
  /** Agent 本机已空闲但仍保留共享输入的批次；控制面返回其中不可再复用的 ID。 */
  cachedBatchIds: z.array(identifierSchema).max(1_024).optional(),
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
  closedBatchIds: z.array(identifierSchema).max(1_024).default([]),
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

export const uploadLogChunksResponseSchema = z.object({
  schemaVersion: protocolVersionSchema,
  acknowledgedSequence: z.object({
    stdout: z.number().int().min(-1),
    stderr: z.number().int().min(-1),
    agent: z.number().int().min(-1),
  }),
});

export const attemptLogQuerySchema = z.object({
  stream: z.enum(["stdout", "stderr", "agent"]).default("stdout"),
  afterSequence: z.coerce.number().int().min(-1).default(-1),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  query: z.string().trim().min(1).max(256).optional(),
  recordedAfter: isoTimestampSchema.optional(),
  recordedBefore: isoTimestampSchema.optional(),
});

export const attemptLogPageSchema = z.object({
  items: z.array(logChunkSchema).max(500),
  acknowledgedSequence: z.number().int().min(-1),
  nextSequence: z.number().int().min(0).optional(),
  truncated: z.boolean(),
});

export const attemptEventQuerySchema = z.object({
  afterEventId: identifierSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const attemptStateEventSchema = z.object({
  eventId: identifierSchema,
  attemptId: identifierSchema,
  eventType: z.string().trim().min(1).max(128),
  fromStatus: z.string().max(64).optional(),
  toStatus: z.string().max(64).optional(),
  reasonCode: z.string().max(128).optional(),
  actorType: z.enum(["user", "runner", "system"]),
  actorId: identifierSchema.optional(),
  details: z.record(z.string(), z.unknown()),
  recordedAt: isoTimestampSchema,
});

export const attemptEventPageSchema = z.object({
  items: z.array(attemptStateEventSchema).max(200),
  nextEventId: identifierSchema.optional(),
});

export const artifactDeclarationSchema = z.object({
  artifactId: identifierSchema,
  relativePath: workspaceRelativePathSchema,
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

export const declareArtifactsResponseSchema = z.object({
  schemaVersion: protocolVersionSchema,
  artifacts: z
    .array(
      artifactDeclarationSchema.extend({
        uploadPath: z.string().min(1).max(1_024),
        uploadMethod: z.enum(["control-plane", "direct"]).default("control-plane"),
        finalizePath: z.string().min(1).max(1_024).optional(),
        status: z.enum(["declared", "uploaded"]),
      }),
    )
    .max(256),
});

export const attemptArtifactListSchema = z.object({
  items: z.array(
    artifactDeclarationSchema.extend({
      status: z.enum(["declared", "uploaded", "rejected"]),
      downloadPath: z.string().min(1).optional(),
    }),
  ),
});

const testNgCountsSchema = z.object({
  total: z.number().int().min(0).max(1_000_000),
  passed: z.number().int().min(0).max(1_000_000),
  failed: z.number().int().min(0).max(1_000_000),
  skipped: z.number().int().min(0).max(1_000_000),
  configurationFailures: z.number().int().min(0).max(1_000_000),
});

const testNgMethodResultSchema = z.object({
  name: z.string().trim().min(1).max(256),
  signature: z.string().trim().max(512).optional(),
  status: z.enum(["passed", "failed", "skipped"]),
  configuration: z.boolean(),
  durationMs: z.number().int().min(0).max(86_400_000),
});

const testNgClassResultSchema = testNgCountsSchema.extend({
  name: z.string().trim().min(1).max(512),
  durationMs: z.number().int().min(0).max(86_400_000),
  methods: z.array(testNgMethodResultSchema).max(256),
});

const testNgTestResultSchema = testNgCountsSchema.extend({
  name: z.string().trim().min(1).max(512),
  durationMs: z.number().int().min(0).max(86_400_000),
  classes: z.array(testNgClassResultSchema).max(128),
});

const testNgSuiteResultSchema = testNgCountsSchema.extend({
  name: z.string().trim().min(1).max(512),
  durationMs: z.number().int().min(0).max(86_400_000),
  tests: z.array(testNgTestResultSchema).max(64),
});

export const testNgResultDetailsSchema = testNgCountsSchema
  .extend({
    detailsTruncated: z.boolean(),
    suites: z.array(testNgSuiteResultSchema).max(32),
  })
  .superRefine((result, context) => {
    let tests = 0;
    let classes = 0;
    let methods = 0;
    validateTestNgCounts(result, context, ["testNg"]);
    for (const [suiteIndex, suite] of result.suites.entries()) {
      validateTestNgCounts(suite, context, ["testNg", "suites", suiteIndex]);
      tests += suite.tests.length;
      for (const [testIndex, test] of suite.tests.entries()) {
        validateTestNgCounts(test, context, ["testNg", "suites", suiteIndex, "tests", testIndex]);
        classes += test.classes.length;
        for (const [classIndex, classResult] of test.classes.entries()) {
          validateTestNgCounts(classResult, context, [
            "testNg",
            "suites",
            suiteIndex,
            "tests",
            testIndex,
            "classes",
            classIndex,
          ]);
          methods += classResult.methods.length;
        }
      }
    }
    if (tests > 64 || classes > 128 || methods > 256) {
      context.addIssue({
        code: "custom",
        path: ["testNg", "suites"],
        message: "TestNG 结构化结果超过明细上限。",
      });
    }
  });

export const completionResultSchema = z.object({
  status: z.enum(["succeeded", "failed", "timed_out", "cancelled"]),
  resultCode: z.string().trim().min(1).max(128),
  summary: z.string().max(4_096),
  durationMs: z.number().int().min(0).max(86_400_000),
  exitCode: z.number().int().min(-1).max(255).optional(),
  testNg: testNgResultDetailsSchema.optional(),
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
  /** 批次 ID：供调用方在完成被接受后触发补调度；可选新增，旧实现可不返回。 */
  batchId: identifierSchema.optional(),
  /** 批次是否已进入终态：Agent 据此回收批次级共享输入目录。 */
  batchClosed: z.boolean().optional(),
  /**
   * 提交完成上报时是否存在可调度（queued 且未扣留）的 run。false 表示路由层
   * 无需触发补调度；缺省（重复/迟到上报等）时调用方应保守触发。可选新增。
   */
  hasSchedulableRuns: z.boolean().optional(),
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
export type TestNgResultDetails = z.infer<typeof testNgResultDetailsSchema>;
export type CompleteAttemptInput = z.infer<typeof completeAttemptInputSchema>;
export type CompleteAttemptResponse = z.infer<typeof completeAttemptResponseSchema>;
export type ReconcileAttemptsInput = z.infer<typeof reconcileAttemptsInputSchema>;
export type ReconcileAttemptsResponse = z.infer<typeof reconcileAttemptsResponseSchema>;
export type LogChunk = z.infer<typeof logChunkSchema>;
export type UploadLogChunksInput = z.infer<typeof uploadLogChunksInputSchema>;
export type UploadLogChunksResponse = z.infer<typeof uploadLogChunksResponseSchema>;
export type AttemptLogQuery = z.infer<typeof attemptLogQuerySchema>;
export type AttemptLogPage = z.infer<typeof attemptLogPageSchema>;
export type AttemptEventQuery = z.infer<typeof attemptEventQuerySchema>;
export type AttemptStateEvent = z.infer<typeof attemptStateEventSchema>;
export type AttemptEventPage = z.infer<typeof attemptEventPageSchema>;
export type ArtifactDeclaration = z.infer<typeof artifactDeclarationSchema>;
export type DeclareArtifactsInput = z.infer<typeof declareArtifactsInputSchema>;
export type DeclareArtifactsResponse = z.infer<typeof declareArtifactsResponseSchema>;
export type AttemptArtifactList = z.infer<typeof attemptArtifactListSchema>;

function validateTestNgCounts(
  counts: z.infer<typeof testNgCountsSchema>,
  context: z.RefinementCtx,
  path: Array<string | number>,
): void {
  if (counts.total !== counts.passed + counts.failed + counts.skipped) {
    context.addIssue({
      code: "custom",
      path,
      message: "TestNG 结果计数不一致。",
    });
  }
}

function isJvmMethodSelector(value: string): boolean {
  const descriptorStart = value.indexOf("(");
  if (descriptorStart < 1 || !isJvmMethodName(value.slice(0, descriptorStart))) return false;
  const descriptor = value.slice(descriptorStart);
  let position = 1;
  while (position < descriptor.length && descriptor[position] !== ")") {
    const next = consumeJvmType(descriptor, position, false);
    if (next === null) return false;
    position = next;
  }
  if (descriptor[position] !== ")") return false;
  const returnEnd = consumeJvmType(descriptor, position + 1, true);
  return returnEnd === descriptor.length;
}

function isJvmMethodName(value: string): boolean {
  return value.length <= 256 && !/[.;[/<>\s\p{Cc}]/u.test(value);
}

function consumeJvmType(descriptor: string, start: number, allowVoid: boolean): number | null {
  let position = start;
  while (descriptor[position] === "[") position += 1;
  const arrayDepth = position - start;
  if (arrayDepth > 255 || position >= descriptor.length) return null;
  const marker = descriptor[position];
  if (marker && "BCDFIJSZ".includes(marker)) return position + 1;
  if (marker === "V") return allowVoid && arrayDepth === 0 ? position + 1 : null;
  if (marker !== "L") return null;
  const end = descriptor.indexOf(";", position + 1);
  if (end <= position + 1) return null;
  const className = descriptor.slice(position + 1, end);
  if (className.split("/").some((segment) => !segment || /[.;[]/.test(segment))) return null;
  return end + 1;
}
