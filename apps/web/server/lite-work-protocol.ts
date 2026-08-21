export type LiteWorkerConfiguration = {
  databasePath: string;
  migrationsFolder: string;
  attemptLogsDirectory: string;
  dataDirectory: string;
  caseExecutionTimeoutSeconds: number;
  artifactCollectionEnabled: boolean;
  scheduler: {
    maximumCpuUtilizationPercent: number;
    maximumMemoryUtilizationPercent: number;
    maximumLoadPerCpu: number;
    metricsMaximumAgeSeconds: number;
    projectMaximumConcurrency: number;
    priorityAgingIntervalMinutes: number;
  };
};

export type LiteWorkerTask =
  | { kind: "schedule-batch"; batchId: string }
  | { kind: "schedule-runner"; runnerId: string; batchLimit: number }
  | { kind: "claim-assignments"; runnerId: string; input: unknown }
  | { kind: "renew-lease"; leaseId: string; input: unknown }
  | { kind: "complete-attempt"; attemptId: string; input: unknown }
  | { kind: "declare-artifacts"; attemptId: string; input: unknown }
  | { kind: "recover-expired"; input: unknown }
  | { kind: "terminate-batch"; batchId: string; input: unknown }
  | { kind: "append-attempt-log-chunks"; attemptId: string; input: unknown };

export type LiteWorkerRequest = { id: number; task: LiteWorkerTask };

export type LiteWorkerResponse =
  | { id: number; ok: true; value: unknown }
  | {
      id: number;
      ok: false;
      error: { name: string; message: string; code?: string; details?: unknown; stack?: string };
    };
