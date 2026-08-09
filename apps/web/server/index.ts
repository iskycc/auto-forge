import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import next from "next";

import { TerminalGateway } from "./terminal-gateway.ts";

const development = process.env.NODE_ENV !== "production";
const hostname = process.env.HOSTNAME || "0.0.0.0";
const port = parsePort(process.env.PORT);
const webDirectory = findWebDirectory(process.cwd());

if (!development) configureStandaloneRuntime(webDirectory);

const createNext = next as unknown as typeof import("next/dist/server/next.js").default;
const app = createNext({ dev: development, dir: webDirectory, hostname, port });
await app.prepare();

const requestHandler = app.getRequestHandler();
const nextUpgradeHandler = app.getUpgradeHandler();
const terminalGateway = new TerminalGateway(terminalAccessToken(process.env), log);
const server = createServer((request, response) => {
  requestHandler(request, response).catch((error: unknown) => {
    log("error", "HTTP request failed", {
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

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    terminalGateway.close();
    server.close(() => {
      app
        .close()
        .catch((error: unknown) => {
          log("error", "Next.js shutdown failed", {
            error: error instanceof Error ? error.message : "Unknown error",
          });
        })
        .finally(() => process.exit(0));
    });
  });
}

function parsePort(raw: string | undefined): number {
  const parsed = Number(raw ?? 3000);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("PORT must be an integer from 1 to 65535.");
  }
  return parsed;
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

function terminalAccessToken(environment: NodeJS.ProcessEnv): string | undefined {
  const token = environment.AUTOFORGE_TERMINAL_ACCESS_TOKEN;
  if (!token) return undefined;
  if (Buffer.byteLength(token) < 32) {
    throw new Error("AUTOFORGE_TERMINAL_ACCESS_TOKEN must contain at least 32 bytes.");
  }
  return token;
}

function log(level: "info" | "warn" | "error", message: string, fields: object = {}): void {
  const entry = JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...fields });
  if (level === "error") process.stderr.write(`${entry}\n`);
  else process.stdout.write(`${entry}\n`);
}
