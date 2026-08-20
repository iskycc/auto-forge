import { z } from "zod";

export const objectEntrySchema = z.object({
  objectKey: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  lastModified: z.string().datetime(),
  etag: z.string().optional(),
});

export const objectListPageSchema = z.object({
  storage: z.enum(["local", "minio"]),
  items: z.array(objectEntrySchema),
  nextCursor: z.string().optional(),
});

export const setAuthoritativeSourceInputSchema = z.object({
  authoritative: z.literal(true),
});

export const caseSuiteAdapterConfigurationSchema = z.object({
  enabled: z.boolean().default(false),
  suiteName: z.string().trim().max(512).default(""),
  testName: z.string().trim().max(512).default(""),
  environmentAddresses: z
    .array(z.string().trim().min(1).max(2_048))
    .max(128)
    .refine((addresses) => new Set(addresses).size === addresses.length, {
      message: "环境地址不能重复。",
    })
    .default([]),
});

export const createCaseSuiteInputSchema = z.object({
  projectId: z.string().min(1).max(128).optional(),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  adapter: caseSuiteAdapterConfigurationSchema.optional(),
});

export const updateCaseSuiteItemsInputSchema = z.object({
  caseDefinitionIds: z.array(z.string().min(1)).min(1).max(500),
});

// 产物 glob 在控制面侧先做有界校验：拒绝绝对路径与 .. 段，Agent 侧仍会再次收紧。
export const caseSuiteArtifactPatternSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine((pattern) => !pattern.startsWith("/") && !pattern.split("/").includes(".."), {
    message: "产物规则必须是相对路径，且不能包含 .. 段。",
  });

export const caseSuiteExecutionPolicySchema = z.object({
  executor: z.enum(["testng", "testng-container"]).optional(),
  adapter: caseSuiteAdapterConfigurationSchema.optional(),
  priority: z.number().int().min(-100).max(100).optional(),
  concurrency: z.number().int().min(1).max(64).optional(),
  retryLimit: z.number().int().min(0).max(10).optional(),
  retryMode: z.enum(["immediate", "round"]).optional(),
  queueTimeoutMs: z.number().int().min(1_000).max(604_800_000).optional(),
  claimTimeoutMs: z.number().int().min(1_000).max(3_600_000).optional(),
  uploadTimeoutMs: z.number().int().min(1_000).max(3_600_000).optional(),
  projectVersionId: z.string().trim().max(128).optional(),
  runnerIds: z
    .array(z.string().trim().min(1).max(128))
    .max(64)
    .refine((runnerIds) => new Set(runnerIds).size === runnerIds.length, {
      message: "执行机不能重复。",
    })
    .optional(),
  runnerGroupId: z.string().trim().max(128).optional(),
  runnerLabels: z.array(z.string().trim().min(1).max(64)).max(64).optional(),
  parameters: z
    .record(z.string().trim().min(1).max(128), z.string().max(1_024))
    .refine((parameters) => Object.keys(parameters).length <= 64, {
      message: "参数模板最多包含 64 个参数。",
    })
    .optional(),
  artifactPatterns: z.array(caseSuiteArtifactPatternSchema).max(32).optional(),
});

export const updateCaseSuiteInputSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).optional(),
  enabled: z.boolean().optional(),
  archived: z.boolean().optional(),
  policy: caseSuiteExecutionPolicySchema.optional(),
  expectedRevision: z.number().int().min(1),
});

export const copyCaseSuiteInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
});

export const caseSourceComparisonEntrySchema = z.object({
  className: z.string().min(1),
  caseDefinitionId: z.string().min(1).optional(),
  signature: z.string().min(1),
});

export const caseSourceComparisonSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  currentSourceId: z.string().min(1).optional(),
  candidateSourceId: z.string().min(1),
  added: z.array(caseSourceComparisonEntrySchema).max(5_000),
  changed: z.array(caseSourceComparisonEntrySchema).max(5_000),
  removed: z.array(caseSourceComparisonEntrySchema).max(5_000),
  conflicts: z.array(caseSourceComparisonEntrySchema).max(5_000),
  truncated: z.boolean(),
  createdBy: z.string().min(1).optional(),
  createdAt: z.string().datetime(),
});

export const confirmCaseSourceSyncInputSchema = z.object({
  comparisonId: z.string().min(1).max(128),
  expectedRevision: z.number().int().min(1),
});

export const updateCaseSourceLifecycleInputSchema = z.object({
  archived: z.boolean(),
  expectedRevision: z.number().int().min(1),
});

export const deleteCaseSourceInputSchema = z.object({
  expectedRevision: z.number().int().min(1),
});

export const runnerRegistrationInputSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().trim().min(1).max(128),
  labels: z.array(z.string().trim().min(1).max(64)).max(64),
  capabilities: z.array(z.string().trim().min(1).max(128)).max(128).default([]),
  maxConcurrency: z.number().int().min(1).max(64),
  os: z.string().trim().min(1).max(64),
  architecture: z.string().trim().min(1).max(64),
  agentVersion: z.string().trim().min(1).max(64),
  protocolVersion: z.literal(1),
  terminalEnabled: z.boolean(),
});

export const runnerRegistrationResultSchema = z.object({
  schemaVersion: z.literal(1),
  runnerId: z.string().min(1),
  credential: z.string().min(32),
  heartbeatIntervalSeconds: z.number().int().min(5).max(300),
});

export const runnerHostConnectionSchema = z.object({
  host: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .regex(/^[a-zA-Z0-9._:-]+$/, "执行机地址只能包含主机名或 IP 地址字符。"),
  port: z.number().int().min(1).max(65_535).default(22),
  username: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9._-]+$/, "SSH 用户名包含不支持的字符。"),
  password: z.string().min(1).max(1_024),
});

export const runnerInstallationModeSchema = z.enum([
  "auto",
  "ubuntu",
  "opensuse",
  "opensuse-leap",
  "opensuse-tumbleweed",
]);

export const probeRunnerHostInputSchema = z.object({
  connection: runnerHostConnectionSchema,
  installationMode: runnerInstallationModeSchema.default("auto"),
});

export const runnerHostProbeResultSchema = z.object({
  hostKeySha256: z.string().regex(/^SHA256:[a-zA-Z0-9+/]{43}$/),
  operatingSystemId: z.enum(["ubuntu", "opensuse", "opensuse-leap", "opensuse-tumbleweed"]),
  detectedOperatingSystemId: z.string().min(1).max(128),
  operatingSystemName: z.string().min(1).max(128),
  architecture: z.enum(["amd64", "arm64"]),
  initSystem: z.literal("systemd"),
  privilegeMode: z.enum(["root", "sudo"]),
  cgroupV2Available: z.boolean(),
  bashPath: z.string().regex(/^\/[A-Za-z0-9/._-]+$/),
  forcedInstallationMode: z.boolean(),
});

// Runner 工作目录（Agent 数据目录）：身份、spool 与执行工作目录都从它派生。
// 保持可选而不填充默认值，更新动作才能区分“未提供”（沿用远端现有目录）与显式指定。
export const DEFAULT_RUNNER_DATA_DIRECTORY = "/var/lib/autoforge-agent";

export const runnerDataDirectorySchema = z
  .string()
  .trim()
  .max(4_096)
  .regex(
    /^\/(?:[\w.-]+\/)*[\w.-]+$/,
    "工作目录必须是绝对路径，且只能包含字母、数字、点、下划线、连字符和分隔符。",
  )
  .refine((value) => !value.split("/").includes(".."), "工作目录不能包含 .. 段。");

export const installRunnerAgentInputSchema = z.object({
  connection: runnerHostConnectionSchema,
  expectedHostKeySha256: z.string().regex(/^SHA256:[a-zA-Z0-9+/]{43}$/),
  name: z.string().trim().min(1).max(128),
  labels: z.array(z.string().trim().min(1).max(64)).max(64).default([]),
  maxConcurrency: z.number().int().min(1).max(64).default(1),
  terminalEnabled: z.boolean().default(false),
  runAsRoot: z.boolean().default(false),
  installationMode: runnerInstallationModeSchema.default("auto"),
  dataDirectory: runnerDataDirectorySchema.optional(),
  caCertificatePem: z
    .string()
    .max(65_536)
    .refine(
      (value) =>
        value.length === 0 ||
        (value.includes("-----BEGIN CERTIFICATE-----") &&
          value.includes("-----END CERTIFICATE-----")),
      "CA 证书必须是 PEM 格式。",
    )
    .optional(),
});

export const installRunnerAgentFromProfileInputSchema = z.object({
  profileId: z.string().min(1),
  name: z.string().trim().min(1).max(128),
  labels: z.array(z.string().trim().min(1).max(64)).max(64).default([]),
  maxConcurrency: z.number().int().min(1).max(64).default(1),
  terminalEnabled: z.boolean().default(false),
});

export const installRunnerAgentRequestSchema = z.union([
  installRunnerAgentInputSchema,
  installRunnerAgentFromProfileInputSchema,
]);

export const updateRunnerAgentInputSchema = installRunnerAgentInputSchema.omit({
  name: true,
  labels: true,
  maxConcurrency: true,
  terminalEnabled: true,
});

export const runnerAgentInstallationResultSchema = z.object({
  installed: z.literal(true),
  host: z.string().min(1),
  operatingSystemName: z.string().min(1),
  architecture: z.enum(["amd64", "arm64"]),
  agentVersion: z.string().min(1),
  serviceName: z.literal("autoforge-agent.service"),
  profileId: z.string().min(1).optional(),
});

export const runnerInstallationProfileSchema = z.object({
  id: z.string().min(1),
  runnerId: z.string().min(1).optional(),
  runnerName: z.string().min(1).max(128),
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65_535),
  username: z.string().min(1).max(64),
  expectedHostKeySha256: z.string().regex(/^SHA256:[a-zA-Z0-9+/]{43}$/),
  installationMode: runnerInstallationModeSchema,
  runAsRoot: z.boolean(),
  dataDirectory: runnerDataDirectorySchema.optional(),
  hasStoredPassword: z.literal(true),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const runnerInstallationProfileListSchema = z.object({
  items: z.array(runnerInstallationProfileSchema).max(500),
});

export const updateRunnerAgentFromProfileInputSchema = z.object({
  profileId: z.string().min(1),
});

export const updateRunnerAgentRequestSchema = z.union([
  updateRunnerAgentInputSchema,
  updateRunnerAgentFromProfileInputSchema,
]);

export const batchUpdateRunnerAgentsInputSchema = z.object({
  runnerIds: z
    .array(z.string().min(1))
    .min(1)
    .max(50)
    .transform((ids) => [...new Set(ids)]),
});

export const batchUpdateRunnerAgentsResultSchema = z.object({
  items: z.array(
    z.object({
      runnerId: z.string().min(1),
      runnerName: z.string().min(1),
      status: z.enum(["updated", "missing_profile", "failed"]),
      message: z.string().min(1),
      agentVersion: z.string().min(1).optional(),
    }),
  ),
});

export const rollbackRunnerAgentInputSchema = z.object({
  connection: runnerHostConnectionSchema,
  expectedHostKeySha256: z.string().regex(/^SHA256:[a-zA-Z0-9+/]{43}$/),
  installationMode: runnerInstallationModeSchema.default("auto"),
});

export const runnerAgentRollbackResultSchema = z.object({
  rolledBack: z.literal(true),
  host: z.string().min(1),
  agentVersion: z.string().min(1),
  serviceName: z.literal("autoforge-agent.service"),
});

export const runnerHeartbeatInputSchema = z.object({
  schemaVersion: z.literal(1),
  busySlots: z.number().int().min(0).max(64),
  labels: z.array(z.string().trim().min(1).max(64)).max(64),
  capabilities: z.array(z.string().trim().min(1).max(128)).max(128).default([]),
  maxConcurrency: z.number().int().min(1).max(64),
  agentVersion: z.string().trim().min(1).max(64),
  terminalEnabled: z.boolean(),
  /** Agent 本机仍可复用的批次目录；控制面返回其中不再可能派发任务的 ID。 */
  cachedBatchIds: z.array(z.string().trim().min(1).max(128)).max(1_024).optional(),
  resourceSnapshot: z
    .object({
      cpuUtilizationPercent: z.number().finite().min(0).max(100),
      memoryUtilizationPercent: z.number().finite().min(0).max(100),
      loadAverage1m: z.number().finite().nonnegative().max(100_000),
      logicalCpuCount: z.number().int().min(1).max(4_096),
      observedAt: z.string().datetime(),
    })
    .optional(),
});

export const runnerHeartbeatResultSchema = z.object({
  schemaVersion: z.literal(1),
  acceptedAt: z.string().datetime(),
  heartbeatIntervalSeconds: z.number().int().min(5).max(300),
  draining: z.boolean(),
  disabled: z.boolean().default(false),
  rotateCredential: z.boolean().default(false),
  closedBatchIds: z.array(z.string().trim().min(1).max(128)).max(1_024).default([]),
  terminalConnectionToken: z.string().min(1).optional(),
});

export const updateRunnerLifecycleInputSchema = z.object({
  state: z.enum(["active", "draining", "disabled"]),
});

export const rotateRunnerCredentialResultSchema = z.object({
  schemaVersion: z.literal(1),
  credential: z.string().min(32),
  credentialVersion: z.number().int().min(1),
  previousCredentialValidUntil: z.string().datetime(),
});

export const updateCaseDefinitionInputSchema = z.object({
  displayName: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).optional(),
  tags: z.array(z.string().trim().min(1).max(64)).max(32).optional(),
  enabled: z.boolean().optional(),
  archived: z.boolean().optional(),
  expectedRevision: z.number().int().min(1),
});

export const createTerminalSessionInputSchema = z.object({
  runnerId: z.string().min(1),
  columns: z.number().int().min(20).max(500),
  rows: z.number().int().min(5).max(200),
});

export const createTerminalSessionResultSchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: z.string().min(1),
  connectionToken: z.string().min(1),
  websocketPath: z.literal("/api/v1/terminal-stream"),
  expiresAt: z.string().datetime(),
});

export type ObjectEntry = z.infer<typeof objectEntrySchema>;
export type ObjectListPage = z.infer<typeof objectListPageSchema>;
export type CreateCaseSuiteInput = z.infer<typeof createCaseSuiteInputSchema>;
export type CaseSuiteAdapterConfigurationInput = z.infer<
  typeof caseSuiteAdapterConfigurationSchema
>;
export type CaseSuiteExecutionPolicyInput = z.infer<typeof caseSuiteExecutionPolicySchema>;
export type UpdateCaseSuiteInput = z.infer<typeof updateCaseSuiteInputSchema>;
export type CopyCaseSuiteInput = z.infer<typeof copyCaseSuiteInputSchema>;
export type CaseSourceComparisonResult = z.infer<typeof caseSourceComparisonSchema>;
export type ConfirmCaseSourceSyncInput = z.infer<typeof confirmCaseSourceSyncInputSchema>;
export type UpdateCaseSourceLifecycleInput = z.infer<typeof updateCaseSourceLifecycleInputSchema>;
export type DeleteCaseSourceInput = z.infer<typeof deleteCaseSourceInputSchema>;
export type RunnerRegistrationInput = z.infer<typeof runnerRegistrationInputSchema>;
export type RunnerRegistrationResult = z.infer<typeof runnerRegistrationResultSchema>;
export type ProbeRunnerHostInput = z.infer<typeof probeRunnerHostInputSchema>;
export type RunnerHostConnection = z.infer<typeof runnerHostConnectionSchema>;
export type RunnerInstallationMode = z.infer<typeof runnerInstallationModeSchema>;
export type RunnerHostProbeResult = z.infer<typeof runnerHostProbeResultSchema>;
export type InstallRunnerAgentInput = z.infer<typeof installRunnerAgentInputSchema>;
export type UpdateRunnerAgentInput = z.infer<typeof updateRunnerAgentInputSchema>;
export type RunnerAgentInstallationResult = z.infer<typeof runnerAgentInstallationResultSchema>;
export type RunnerInstallationProfile = z.infer<typeof runnerInstallationProfileSchema>;
export type BatchUpdateRunnerAgentsResult = z.infer<typeof batchUpdateRunnerAgentsResultSchema>;
export type RollbackRunnerAgentInput = z.infer<typeof rollbackRunnerAgentInputSchema>;
export type RunnerAgentRollbackResult = z.infer<typeof runnerAgentRollbackResultSchema>;
export type RunnerHeartbeatInput = z.infer<typeof runnerHeartbeatInputSchema>;
export type RunnerHeartbeatResult = z.infer<typeof runnerHeartbeatResultSchema>;
export type RotateRunnerCredentialResult = z.infer<typeof rotateRunnerCredentialResultSchema>;
export type UpdateCaseDefinitionInput = z.infer<typeof updateCaseDefinitionInputSchema>;
export type CreateTerminalSessionInput = z.infer<typeof createTerminalSessionInputSchema>;
export type CreateTerminalSessionResult = z.infer<typeof createTerminalSessionResultSchema>;
