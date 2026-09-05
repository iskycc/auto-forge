import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import next from "next";

import { platformClockNow } from "../src/lib/platform-clock-runtime.ts";
import { loadAppConfig } from "../src/lib/config.ts";
import { registerWorkDispatcher, unregisterWorkDispatcher } from "../src/lib/work-runtime.ts";
import { recordHttpRequest } from "../src/lib/runtime-metrics.ts";
import { TerminalGateway, type TerminalAuditEvent } from "./terminal-gateway.ts";
import { rejectH2cUpgrade } from "./http-upgrade.ts";
import { LogStreamGateway } from "./log-stream-gateway.ts";
import { LogStreamRelay } from "./log-stream-relay.ts";
import { WorkerPool } from "./worker-pool.ts";
import {
  FastPathUnavailable,
  handleRunnerFastPath,
  matchRunnerFastPath,
} from "./runner-fast-path.ts";

const development = process.env.NODE_ENV !== "production";
const platformConfiguration = loadAppConfig();
const hostname = platformConfiguration.web.hostname;
const port = platformConfiguration.web.port;
const webDirectory = findWebDirectory(process.cwd());
// Lite 把同步 SQLite Runner 控制事务卸载到工作线程；Full 的 Runner 写路径保留
// 在主线程，只把补位调度交给少量工作线程，避免重复扫描阻塞 HTTP 事件循环。
const workPool = new WorkerPool(
  {
    mode: platformConfiguration.mode,
    migrationsFolder: platformConfiguration.migrationsFolder,
    attemptLogsDirectory: join(platformConfiguration.dataDirectory, "attempt-logs"),
    dataDirectory: platformConfiguration.dataDirectory,
    caseExecutionTimeoutSeconds: platformConfiguration.caseExecutionTimeoutSeconds,
    artifactCollectionEnabled: platformConfiguration.artifactCollectionEnabled,
    scheduler: { ...platformConfiguration.scheduler },
    ...(platformConfiguration.mode === "lite"
      ? { sqlite: { databasePath: platformConfiguration.databasePath } }
      : {
          full: {
            ...(platformConfiguration.distributed
              ? {
                  nodeId: platformConfiguration.nodeId!,
                  masterKey: platformConfiguration.masterKey,
                }
              : {}),
            databaseUrl: platformConfiguration.databaseUrl,
            // WorkerPool 会把这一总预算均分给 Full 调度车道，不为每条车道重复
            // 创建同样大的连接池。
            databasePoolMax: platformConfiguration.databasePoolMax,
            minio: { ...platformConfiguration.minio },
          },
        }),
  },
  platformConfiguration.worker.concurrency,
  platformConfiguration.worker.shutdownGraceMs,
);
registerWorkDispatcher(workPool);
// 后台预热工作线程（建池、迁移校验、连接预热），不阻塞端口监听；预热失败时
// 首个真实任务退回冷启动，行为与未预热一致。
void workPool.warmup();

if (!development) configureProductionRuntime(webDirectory);

const createNext = next as unknown as typeof import("next/dist/server/next.js").default;
const app = createNext({ dev: development, dir: webDirectory, hostname, port });
await app.prepare();

const requestHandler = app.getRequestHandler();
const nextUpgradeHandler = app.getUpgradeHandler();
const terminalGateway = new TerminalGateway(
  platformConfiguration.terminalAccessToken,
  log,
  recordTerminalAudit,
  platformClockNow,
);
const logStreamGateway = new LogStreamGateway(
  platformConfiguration.terminalAccessToken,
  log,
  platformClockNow,
);
const logStreamRelay = await LogStreamRelay.create({
  mode: platformConfiguration.mode,
  ...(platformConfiguration.mode === "full" ? { redisUrl: platformConfiguration.redisUrl } : {}),
  gateway: logStreamGateway,
  logger: log,
});
const runtime = globalThis as typeof globalThis & {
  __autoforgePublishAttemptLogs?: Parameters<LogStreamGateway["publish"]> extends [
    infer AttemptId,
    infer Chunks,
  ]
    ? (attemptId: AttemptId, chunks: Chunks) => void
    : never;
};
runtime.__autoforgePublishAttemptLogs = (attemptId, chunks) =>
  logStreamRelay.publish(attemptId, chunks);
const server = createServer((request, response) => {
  const startedAt = performance.now();
  const currentRequestId = requestId(request.headers["x-request-id"]);
  request.headers["x-request-id"] = currentRequestId;
  response.setHeader("X-Request-Id", currentRequestId);
  if (platformConfiguration.mode === "full" && platformConfiguration.nodeId) {
    response.setHeader("X-Autoforge-Node", platformConfiguration.nodeId);
  }
  response.once("finish", () => {
    const path = request.url ? new URL(request.url, "http://localhost").pathname : "/";
    const durationMs = Math.round(performance.now() - startedAt);
    recordHttpRequest(request.method ?? "OTHER", path, response.statusCode, durationMs);
    log("info", "HTTP request completed", {
      requestId: currentRequestId,
      method: request.method ?? "OTHER",
      path,
      statusCode: response.statusCode,
      durationMs,
    });
  });
  const fastPathRoute = matchRunnerFastPath(request.method, request.url);
  if (fastPathRoute) {
    // 执行机协议高频写路径绕过 Next.js 路由，直接复用同一份应用服务；
    // 服务尚未就绪时回退 Next.js 路由，行为与纯路由模式一致。
    handleRunnerFastPath(fastPathRoute, request, response, currentRequestId).catch(
      (error: unknown) => {
        if (error instanceof FastPathUnavailable) {
          forwardToNext();
          return;
        }
        logFastPathFailure(error);
        if (!response.headersSent) response.writeHead(500, { "Content-Type": "text/plain" });
        response.end("Internal Server Error");
      },
    );
    return;
  }
  forwardToNext();

  function forwardToNext(): void {
    requestHandler(request, response).catch((error: unknown) => {
      logFastPathFailure(error);
      if (!response.headersSent) response.writeHead(500, { "Content-Type": "text/plain" });
      response.end("Internal Server Error");
    });
  }

  function logFastPathFailure(error: unknown): void {
    log("error", "HTTP request failed", {
      requestId: currentRequestId,
      path: request.url,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

server.on("upgrade", (request, socket, head) => {
  if (rejectH2cUpgrade(request, socket)) {
    log("warn", "Rejected unsupported plaintext HTTP/2 upgrade", { path: request.url });
    return;
  }
  if (logStreamGateway.handles(request)) {
    logStreamGateway.upgrade(request, socket, head);
    return;
  }
  if (terminalGateway.handles(request)) {
    terminalGateway.upgrade(request, socket, head);
    return;
  }
  nextUpgradeHandler(request, socket, head).catch((error: unknown) => {
    log("error", "Next.js WebSocket upgrade failed", {
      path: request.url,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    socket.destroy();
  });
});

server.listen(port, hostname, () => {
  log("info", "AutoForge control plane listening", { hostname, port });
});

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void shutdown(signal));
}

async function shutdown(signal: "SIGINT" | "SIGTERM"): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", "AutoForge control plane draining", { signal });
  await terminalGateway.close();
  await logStreamRelay.close();
  await logStreamGateway.close();
  delete runtime.__autoforgePublishAttemptLogs;
  unregisterWorkDispatcher(workPool);
  server.closeIdleConnections();
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      server.closeAllConnections();
      resolve();
    }, 30_000);
    timeout.unref();
    server.close(() => {
      clearTimeout(timeout);
      resolve();
    });
  });
  const serviceRuntime = globalThis as typeof globalThis & {
    __autoforgeClosePlatformServices?: () => Promise<void>;
  };
  const results = await Promise.allSettled([
    app.close(),
    workPool.close(),
    serviceRuntime.__autoforgeClosePlatformServices?.() ?? Promise.resolve(),
  ]);
  const failures = results.filter((result) => result.status === "rejected");
  for (const failure of failures) {
    log("error", "AutoForge shutdown step failed", {
      error: failure.status === "rejected" ? errorMessage(failure.reason) : "Unknown error",
    });
  }
  process.exit(failures.length === 0 ? 0 : 1);
}

function findWebDirectory(startDirectory: string): string {
  for (const candidate of [resolve(startDirectory), resolve(startDirectory, "apps", "web")]) {
    if (existsSync(join(candidate, "next.config.ts")) || existsSync(join(candidate, ".next"))) {
      return candidate;
    }
  }
  throw new Error("Unable to locate the AutoForge Next.js application directory.");
}

function configureProductionRuntime(directory: string): void {
  const requiredFilesPath = join(directory, ".next", "required-server-files.json");
  const requiredFiles = JSON.parse(readFileSync(requiredFilesPath, "utf8")) as {
    config?: unknown;
  };
  if (!requiredFiles.config) throw new Error("Next.js production configuration is missing.");
  process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(requiredFiles.config);
}

function log(level: "info" | "warn" | "error", message: string, fields: object = {}): void {
  const entry = JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...fields });
  if (level === "error") process.stderr.write(`${entry}\n`);
  else process.stdout.write(`${entry}\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function requestId(value: string | string[] | undefined): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && /^[A-Za-z0-9._:-]{8,128}$/.test(candidate) ? candidate : randomUUID();
}

async function recordTerminalAudit(event: TerminalAuditEvent): Promise<void> {
  const runtime = globalThis as typeof globalThis & {
    __autoforgeRecordTerminalAudit?: (auditEvent: TerminalAuditEvent) => Promise<void>;
  };
  if (!runtime.__autoforgeRecordTerminalAudit) {
    throw new Error("Terminal audit port is not initialized.");
  }
  await runtime.__autoforgeRecordTerminalAudit(event);
}
