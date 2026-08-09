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
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
});

export const updateCaseSuiteItemsInputSchema = z.object({
  caseDefinitionIds: z.array(z.string().min(1)).min(1).max(500),
});

export const runnerRegistrationInputSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().trim().min(1).max(128),
  labels: z.array(z.string().trim().min(1).max(64)).max(64),
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

export const runnerHeartbeatInputSchema = z.object({
  schemaVersion: z.literal(1),
  busySlots: z.number().int().min(0).max(64),
  labels: z.array(z.string().trim().min(1).max(64)).max(64),
  maxConcurrency: z.number().int().min(1).max(64),
  agentVersion: z.string().trim().min(1).max(64),
  terminalEnabled: z.boolean(),
});

export const runnerHeartbeatResultSchema = z.object({
  schemaVersion: z.literal(1),
  acceptedAt: z.string().datetime(),
  heartbeatIntervalSeconds: z.number().int().min(5).max(300),
  draining: z.boolean(),
  terminalConnectionToken: z.string().min(1).optional(),
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
export type RunnerRegistrationInput = z.infer<typeof runnerRegistrationInputSchema>;
export type RunnerRegistrationResult = z.infer<typeof runnerRegistrationResultSchema>;
export type RunnerHeartbeatInput = z.infer<typeof runnerHeartbeatInputSchema>;
export type RunnerHeartbeatResult = z.infer<typeof runnerHeartbeatResultSchema>;
export type CreateTerminalSessionInput = z.infer<typeof createTerminalSessionInputSchema>;
export type CreateTerminalSessionResult = z.infer<typeof createTerminalSessionResultSchema>;
