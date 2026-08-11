import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import next from "next";

import { loadAppConfig } from "../src/lib/config.ts";
import { recordHttpRequest } from "../src/lib/runtime-metrics.ts";
import { TerminalGateway, type TerminalAuditEvent } from "./terminal-gateway.ts";

const development = process.env.NODE_ENV !== "production";
const platformConfiguration = loadAppConfig();
const hostname = platformConfiguration.web.hostname;
const port = platformConfiguration.web.port;
const webDirectory = findWebDirectory(process.cwd());

if (!development) configureStandaloneRuntime(webDirectory);

const createNext = next as unknown as typeof import("next/dist/server/next.js").default;
const app = createNext({ dev: development, dir: webDirectory, hostname, port });
await app.prepare();

const requestHandler = app.getRequestHandler();
const nextUpgradeHandler = app.getUpgradeHandler();
const terminalGateway = new TerminalGateway(
  platformConfiguration.terminalAccessToken,
  log,
  recordTerminalAudit,
);
const server = createServer((request, response) => {
  const startedAt = performance.now();
  const currentRequestId = requestId(request.headers["x-request-id"]);
  request.headers["x-request-id"] = currentRequestId;
  response.setHeader("X-Request-Id", currentRequestId);
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
  requestHandler(request, response).catch((error: unknown) => {
    log("error", "HTTP request failed", {
      requestId: currentRequestId,
      path: request.url,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    if (!response.headersSent) response.writeHead(500, { "Content-Type": "text/plain" });
    response.end("Internal Server Error");
  });
});

server.on("upgrade", (request, socket, head) => {
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
  const runtime = globalThis as typeof globalThis & {
    __autoforgeClosePlatformServices?: () => Promise<void>;
  };
  const results = await Promise.allSettled([
    app.close(),
    runtime.__autoforgeClosePlatformServices?.() ?? Promise.resolve(),
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

function configureStandaloneRuntime(directory: string): void {
  const requiredFilesPath = join(directory, ".next", "required-server-files.json");
  const requiredFiles = JSON.parse(readFileSync(requiredFilesPath, "utf8")) as {
    config?: unknown;
  };
  if (!requiredFiles.config) throw new Error("Next.js standalone configuration is missing.");
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
