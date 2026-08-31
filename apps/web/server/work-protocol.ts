/**
 * Web 进程内执行工作线程的配置与消息协议。Lite 与 Full 共用同一线程池，
 * Lite 把 Runner 控制事务与补位调度从 Web 事件循环卸载到工作线程；Full 仅
 * 卸载补位调度，Runner 写事务仍复用主进程仓储。模式差异只体现在本配置的
 * 数据库/对象存储字段。
 */
export type WorkThreadConfiguration = {
  mode: "lite" | "full";
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
  sqlite?: { databasePath: string };
  full?: {
    databaseUrl: string;
    /** Full 调度工作线程的总连接预算；线程池按实际车道数均分。 */
    databasePoolMax: number;
    minio: {
      endPoint: string;
      port?: number;
      useSSL: boolean;
      accessKey: string;
      secretKey: string;
      bucket: string;
      region: string;
    };
  };
};

export type WorkTask =
  | { kind: "warmup" }
  | { kind: "schedule-batch"; batchId: string }
  | {
      kind: "schedule-runner";
      runnerId: string;
      batchLimit: number;
      liveAvailableSlots?: number;
    }
  | { kind: "claim-assignments"; runnerId: string; input: unknown }
  | { kind: "renew-lease"; leaseId: string; input: unknown }
  | { kind: "complete-attempt"; attemptId: string; input: unknown }
  | { kind: "declare-artifacts"; attemptId: string; input: unknown }
  | { kind: "recover-expired"; input: unknown }
  | { kind: "resolve-attempt-contexts"; attemptIds: string[] }
  | { kind: "terminate-batch"; batchId: string; input: unknown }
  | { kind: "append-attempt-log-chunks"; attemptId: string; input: unknown };

export type WorkRequest = { id: number; task: WorkTask };

export type WorkResponse =
  | { id: number; ok: true; value: unknown }
  | {
      id: number;
      ok: false;
      error: { name: string; message: string; code?: string; details?: unknown; stack?: string };
    };
