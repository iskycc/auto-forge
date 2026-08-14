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

export const createCaseSuiteInputSchema = z.object({
  projectId: z.string().min(1).max(128).optional(),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
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
  priority: z.number().int().min(-100).max(100).optional(),
  concurrency: z.number().int().min(1).max(64).optional(),
  retryLimit: z.number().int().min(0).max(10).optional(),
  queueTimeoutMs: z.number().int().min(1_000).max(604_800_000).optional(),
  executionTimeoutMs: z.number().int().min(1_000).max(86_400_000).optional(),
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

const runnerHostConnectionSchema = z.object({
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

export const probeRunnerHostInputSchema = z.object({
  connection: runnerHostConnectionSchema,
});

export const runnerHostProbeResultSchema = z.object({
  hostKeySha256: z.string().regex(/^SHA256:[a-zA-Z0-9+/]{43}$/),
  operatingSystemId: z.enum(["ubuntu", "opensuse", "opensuse-leap", "opensuse-tumbleweed"]),
  operatingSystemName: z.string().min(1).max(128),
  architecture: z.enum(["amd64", "arm64"]),
  initSystem: z.literal("systemd"),
  privilegeMode: z.enum(["root", "sudo"]),
  cgroupV2Available: z.boolean(),
});

export const installRunnerAgentInputSchema = z.object({
  connection: runnerHostConnectionSchema,
  expectedHostKeySha256: z.string().regex(/^SHA256:[a-zA-Z0-9+/]{43}$/),
  name: z.string().trim().min(1).max(128),
  labels: z.array(z.string().trim().min(1).max(64)).max(64).default([]),
  maxConcurrency: z.number().int().min(1).max(64).default(1),
  terminalEnabled: z.boolean().default(false),
  runAsRoot: z.boolean().default(false),
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

export const runnerAgentInstallationResultSchema = z.object({
  installed: z.literal(true),
  host: z.string().min(1),
  operatingSystemName: z.string().min(1),
  architecture: z.enum(["amd64", "arm64"]),
  agentVersion: z.string().min(1),
  serviceName: z.literal("autoforge-agent.service"),
});

export const rollbackRunnerAgentInputSchema = z.object({
  connection: runnerHostConnectionSchema,
  expectedHostKeySha256: z.string().regex(/^SHA256:[a-zA-Z0-9+/]{43}$/),
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
  rotateCredential: z.boolean().default(false),
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
export type RunnerHostProbeResult = z.infer<typeof runnerHostProbeResultSchema>;
export type InstallRunnerAgentInput = z.infer<typeof installRunnerAgentInputSchema>;
export type RunnerAgentInstallationResult = z.infer<typeof runnerAgentInstallationResultSchema>;
export type RollbackRunnerAgentInput = z.infer<typeof rollbackRunnerAgentInputSchema>;
export type RunnerAgentRollbackResult = z.infer<typeof runnerAgentRollbackResultSchema>;
export type RunnerHeartbeatInput = z.infer<typeof runnerHeartbeatInputSchema>;
export type RunnerHeartbeatResult = z.infer<typeof runnerHeartbeatResultSchema>;
export type RotateRunnerCredentialResult = z.infer<typeof rotateRunnerCredentialResultSchema>;
export type UpdateCaseDefinitionInput = z.infer<typeof updateCaseDefinitionInputSchema>;
export type CreateTerminalSessionInput = z.infer<typeof createTerminalSessionInputSchema>;
export type CreateTerminalSessionResult = z.infer<typeof createTerminalSessionResultSchema>;
