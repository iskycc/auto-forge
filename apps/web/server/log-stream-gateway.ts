import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocket, WebSocketServer } from "ws";

import { verifyLogStreamTicket } from "../src/lib/log-stream-ticket.ts";

const LOG_STREAM_PATH = "/api/v1/log-stream";
const KEEPALIVE_INTERVAL_MS = 25_000;
const MAXIMUM_GLOBAL_SUBSCRIBERS = 2_048;
const MAXIMUM_ATTEMPT_SUBSCRIBERS = 16;

type Logger = (level: "info" | "warn" | "error", message: string, fields?: object) => void;
export type LogChunk = {
  stream: "stdout" | "stderr" | "agent";
  sequence: number;
  content: string;
  recordedAt: string;
};

export class LogStreamGateway {
  private readonly server = new WebSocketServer({
    noServer: true,
    maxPayload: 8 * 1024,
    perMessageDeflate: false,
  });
  private readonly subscribers = new Map<string, Set<WebSocket>>();
  private readonly liveness = new Map<WebSocket, boolean>();
  private readonly keepalive: NodeJS.Timeout;
  private replay?: (attemptId: string) => Promise<LogChunk[]>;

  setReplay(replay: (attemptId: string) => Promise<LogChunk[]>): void {
    this.replay = replay;
  }

  constructor(
    private readonly secret: string | undefined,
    private readonly logger: Logger,
  ) {
    this.keepalive = setInterval(() => this.ping(), KEEPALIVE_INTERVAL_MS);
    this.keepalive.unref();
  }

  handles(request: IncomingMessage): boolean {
    return (
      request.url !== undefined &&
      new URL(request.url, "http://localhost").pathname === LOG_STREAM_PATH
    );
  }

  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!this.secret) {
      reject(socket, 503, "Log stream is disabled");
      return;
    }
    if (!validOrigin(request)) {
      reject(socket, 403, "Log stream origin is not allowed");
      return;
    }
    const protocol = String(request.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((value) => value.trim())
      .find((value) => value.startsWith("autoforge-log."));
    const ticket = protocol
      ? verifyLogStreamTicket(this.secret, protocol.slice("autoforge-log.".length))
      : null;
    if (!ticket) {
      reject(socket, 401, "Log stream ticket is invalid");
      return;
    }
    this.server.handleUpgrade(request, socket, head, (websocket) => {
      const peers = this.subscribers.get(ticket.attemptId) ?? new Set<WebSocket>();
      if (
        this.liveness.size >= MAXIMUM_GLOBAL_SUBSCRIBERS ||
        peers.size >= MAXIMUM_ATTEMPT_SUBSCRIBERS
      ) {
        websocket.close(1013, "Log stream subscriber limit reached");
        return;
      }
      peers.add(websocket);
      this.subscribers.set(ticket.attemptId, peers);
      this.liveness.set(websocket, true);
      websocket.on("pong", () => this.liveness.set(websocket, true));
      websocket.on("close", () => this.remove(ticket.attemptId, websocket));
      websocket.on("error", (error) => {
        this.logger("warn", "Browser log stream error", {
          attemptId: ticket.attemptId,
          actorId: ticket.actorId,
          error: error.message,
        });
      });
      websocket.send(JSON.stringify({ schemaVersion: 1, type: "ready" }));
      if (this.replay) {
        void this.replay(ticket.attemptId)
          .then((chunks) => {
            if (
              chunks.length &&
              websocket.readyState === WebSocket.OPEN &&
              websocket.bufferedAmount < 1024 * 1024
            ) {
              websocket.send(
                JSON.stringify({
                  schemaVersion: 1,
                  type: "chunks",
                  attemptId: ticket.attemptId,
                  chunks,
                }),
              );
            }
          })
          .catch((error: unknown) =>
            this.logger("warn", "Recent log cache unavailable; use persisted log pages", {
              error: error instanceof Error ? error.message : "Unknown error",
            }),
          );
      }
    });
  }

  publish(attemptId: string, chunks: LogChunk[]): void {
    const peers = this.subscribers.get(attemptId);
    if (!peers || peers.size === 0) return;
    const message = JSON.stringify({ schemaVersion: 1, type: "chunks", attemptId, chunks });
    for (const peer of peers) {
      if (peer.readyState === WebSocket.OPEN && peer.bufferedAmount < 1024 * 1024) {
        peer.send(message);
      }
    }
  }

  async close(): Promise<void> {
    clearInterval(this.keepalive);
    for (const peer of this.liveness.keys()) peer.close(1001, "Control plane is shutting down");
    this.subscribers.clear();
    this.liveness.clear();
    this.server.close();
  }

  private ping(): void {
    for (const [peer, alive] of this.liveness) {
      if (!alive) {
        peer.terminate();
        this.liveness.delete(peer);
        continue;
      }
      this.liveness.set(peer, false);
      peer.ping();
    }
  }

  private remove(attemptId: string, peer: WebSocket): void {
    this.liveness.delete(peer);
    const peers = this.subscribers.get(attemptId);
    peers?.delete(peer);
    if (peers?.size === 0) this.subscribers.delete(attemptId);
  }
}

function validOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function reject(socket: Duplex, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}
