/**
 * Web 进程内执行工作线程的配置与消息协议。Lite 与 Full 共用同一线程池，
 * 把高频 Runner 控制事务（领取、续租、完成、日志追加）与补位调度从 Web
 * 事件循环卸载到工作线程；模式差异只体现在本配置的数据库/对象存储字段。
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
    /** 每个车道独占一个连接池；Full 车道内并发执行事务，池需覆盖车道内并发往返。 */
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
  | { kind: "schedule-runner"; runnerId: string; batchLimit: number }
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
