import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocket, WebSocketServer } from "ws";

import { verifyTerminalTicket, type TerminalTicket } from "../src/lib/terminal-ticket.ts";
import {
  parseAgentMessage,
  parseBrowserMessage,
  type AgentCommand,
  type BrowserEvent,
} from "./terminal-protocol.ts";

const TERMINAL_PATH = "/api/v1/terminal-stream";
const MAXIMUM_BUFFERED_BYTES = 1024 * 1024;
const KEEPALIVE_INTERVAL_MS = 25_000;
const UPGRADE_WINDOW_MS = 60_000;
const MAXIMUM_UPGRADES_PER_WINDOW = 120;

type Logger = (level: "info" | "warn" | "error", message: string, fields?: object) => void;

type Session = {
  runnerId: string;
  actorId: string;
  browser: WebSocket;
  agent: WebSocket;
};

type UpgradeWindow = { startedAt: number; attempts: number };

export class TerminalGateway {
  private readonly server = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024,
    perMessageDeflate: false,
  });
  private readonly agents = new Map<string, WebSocket>();
  private readonly sessions = new Map<string, Session>();
  private readonly peerLiveness = new Map<WebSocket, boolean>();
  private readonly consumedNonces = new Map<string, number>();
  private readonly upgradeWindows = new Map<string, UpgradeWindow>();
  private readonly keepalive: NodeJS.Timeout;
  private readonly secret: string | undefined;
  private readonly logger: Logger;

  constructor(secret: string | undefined, logger: Logger) {
    this.secret = secret;
    this.logger = logger;
    this.keepalive = setInterval(() => this.pingPeers(), KEEPALIVE_INTERVAL_MS);
    this.keepalive.unref();
  }

  handles(request: IncomingMessage): boolean {
    return (
      request.url !== undefined &&
      new URL(request.url, "http://localhost").pathname === TERMINAL_PATH
    );
  }

  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!this.allowUpgrade(request.socket.remoteAddress ?? "unknown")) {
      rejectUpgrade(socket, 429, "Too many terminal upgrade attempts");
      return;
    }
    if (!this.secret) {
      rejectUpgrade(socket, 503, "Terminal gateway is disabled");
      return;
    }
    const ticket = this.authenticate(request);
    if (!ticket || !this.consumeNonce(ticket)) {
      rejectUpgrade(socket, 401, "Terminal ticket is invalid");
      return;
    }
    if (ticket.role === "browser" && !validBrowserOrigin(request)) {
      rejectUpgrade(socket, 403, "Terminal origin is not allowed");
      return;
    }
    this.server.handleUpgrade(request, socket, head, (websocket) => {
      this.peerLiveness.set(websocket, true);
      websocket.on("pong", () => this.peerLiveness.set(websocket, true));
      if (ticket.role === "agent") this.acceptAgent(ticket, websocket);
      else this.acceptBrowser(ticket, websocket);
    });
  }

  close(): void {
    clearInterval(this.keepalive);
    for (const peer of this.peerLiveness.keys()) {
      peer.close(1001, "Control plane is shutting down");
    }
    this.peerLiveness.clear();
    this.agents.clear();
    this.sessions.clear();
    this.server.close();
  }

  private authenticate(request: IncomingMessage): TerminalTicket | null {
    const authorization = request.headers.authorization ?? "";
    if (authorization.startsWith("Bearer ")) {
      const ticket = verifyTerminalTicket(this.secret!, authorization.slice(7).trim());
      return ticket?.role === "agent" ? ticket : null;
    }
    const protocols = String(request.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((value) => value.trim());
    const encodedTicket = protocols
      .find((value) => value.startsWith("autoforge-ticket."))
      ?.slice("autoforge-ticket.".length);
    if (!encodedTicket) return null;
    const ticket = verifyTerminalTicket(this.secret!, encodedTicket);
    return ticket?.role === "browser" ? ticket : null;
  }

  private allowUpgrade(remoteAddress: string): boolean {
    const now = Date.now();
    for (const [address, window] of this.upgradeWindows) {
      if (window.startedAt + UPGRADE_WINDOW_MS <= now) this.upgradeWindows.delete(address);
    }
    const current = this.upgradeWindows.get(remoteAddress);
    if (!current) {
      this.upgradeWindows.set(remoteAddress, { startedAt: now, attempts: 1 });
      return true;
    }
    current.attempts += 1;
    return current.attempts <= MAXIMUM_UPGRADES_PER_WINDOW;
  }

  private consumeNonce(ticket: TerminalTicket): boolean {
    const now = Math.floor(Date.now() / 1000);
    for (const [nonce, expiresAt] of this.consumedNonces) {
      if (expiresAt <= now) this.consumedNonces.delete(nonce);
    }
    if (this.consumedNonces.has(ticket.nonce)) return false;
    this.consumedNonces.set(ticket.nonce, ticket.expiresAtEpochSeconds);
    return true;
  }

  private acceptAgent(ticket: TerminalTicket, websocket: WebSocket): void {
    const existing = this.agents.get(ticket.runnerId);
    if (existing && existing !== websocket) {
      existing.close(4001, "Runner opened a replacement terminal channel");
    }
    this.agents.set(ticket.runnerId, websocket);
    this.logger("info", "Runner terminal channel connected", { runnerId: ticket.runnerId });
    websocket.on("message", (data, binary) => {
      if (binary || !(data instanceof Buffer)) {
        websocket.close(1003, "Text JSON messages are required");
        return;
      }
      const message = parseAgentMessage(data);
      if (!message) {
        websocket.close(1007, "Agent terminal message is invalid");
        return;
      }
      const session = this.sessions.get(message.sessionId);
      if (!session || session.agent !== websocket || session.runnerId !== ticket.runnerId) return;
      if (message.type === "ready") {
        this.send(session.browser, { schemaVersion: 1, type: "ready" });
        return;
      }
      if (message.type === "output") {
        this.send(session.browser, { schemaVersion: 1, type: "output", data: message.data });
        return;
      }
      if (message.type === "error") {
        this.send(session.browser, { schemaVersion: 1, type: "error", message: message.message });
        this.finishSession(message.sessionId, 1011, "Runner terminal failed");
        return;
      }
      this.send(session.browser, {
        schemaVersion: 1,
        type: "exit",
        ...(message.exitCode === undefined ? {} : { exitCode: message.exitCode }),
        ...(message.signal === undefined ? {} : { signal: message.signal }),
      });
      this.finishSession(message.sessionId, 1000, "Terminal process exited");
    });
    websocket.on("close", () => {
      this.peerLiveness.delete(websocket);
      if (this.agents.get(ticket.runnerId) === websocket) this.agents.delete(ticket.runnerId);
      for (const [sessionId, session] of this.sessions) {
        if (session.agent === websocket) {
          this.send(session.browser, {
            schemaVersion: 1,
            type: "error",
            message: "执行机终端通道已断开。",
          });
          this.finishSession(sessionId, 1011, "Runner disconnected");
        }
      }
      this.logger("warn", "Runner terminal channel disconnected", { runnerId: ticket.runnerId });
    });
    websocket.on("error", (error) => {
      this.logger("warn", "Runner terminal channel error", {
        runnerId: ticket.runnerId,
        error: error.message,
      });
    });
  }

  private acceptBrowser(ticket: TerminalTicket, websocket: WebSocket): void {
    const sessionId = ticket.sessionId!;
    const agent = this.agents.get(ticket.runnerId);
    if (!agent || agent.readyState !== WebSocket.OPEN) {
      this.send(websocket, {
        schemaVersion: 1,
        type: "error",
        message: "执行机终端通道尚未就绪，请确认 Agent 在线后重试。",
      });
      websocket.close(4004, "Runner terminal channel is unavailable");
      return;
    }
    if (this.sessions.has(sessionId)) {
      websocket.close(4009, "Terminal session already exists");
      return;
    }
    this.sessions.set(sessionId, {
      runnerId: ticket.runnerId,
      actorId: ticket.actorId!,
      browser: websocket,
      agent,
    });
    websocket.on("message", (data, binary) => {
      if (binary || !(data instanceof Buffer)) {
        websocket.close(1003, "Text JSON messages are required");
        return;
      }
      const message = parseBrowserMessage(data);
      if (!message) {
        websocket.close(1007, "Browser terminal message is invalid");
        return;
      }
      if (message.type === "close") {
        this.finishSession(sessionId, 1000, "Browser closed terminal");
        return;
      }
      this.send(agent, { ...message, sessionId } satisfies AgentCommand);
    });
    websocket.on("close", () => {
      this.peerLiveness.delete(websocket);
      const active = this.sessions.get(sessionId);
      if (!active || active.browser !== websocket) return;
      this.sessions.delete(sessionId);
      this.send(agent, { schemaVersion: 1, type: "close", sessionId });
      this.logger("info", "Browser terminal session disconnected", {
        runnerId: ticket.runnerId,
        sessionId,
        actorId: ticket.actorId,
      });
    });
    websocket.on("error", (error) => {
      this.logger("warn", "Browser terminal channel error", {
        runnerId: ticket.runnerId,
        sessionId,
        error: error.message,
      });
    });
    this.send(agent, {
      schemaVersion: 1,
      type: "open",
      sessionId,
      columns: ticket.columns!,
      rows: ticket.rows!,
    });
    this.logger("info", "Browser terminal session connected", {
      runnerId: ticket.runnerId,
      sessionId,
      actorId: ticket.actorId,
    });
  }

  private finishSession(sessionId: string, code: number, reason: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    this.send(session.agent, { schemaVersion: 1, type: "close", sessionId });
    if (session.browser.readyState === WebSocket.OPEN) session.browser.close(code, reason);
    this.logger("info", "Browser terminal session finished", {
      runnerId: session.runnerId,
      sessionId,
      actorId: session.actorId,
      reason,
    });
  }

  private send(peer: WebSocket, message: AgentCommand | BrowserEvent): void {
    if (peer.readyState !== WebSocket.OPEN) return;
    if (peer.bufferedAmount > MAXIMUM_BUFFERED_BYTES) {
      peer.close(1013, "Terminal peer cannot keep up");
      return;
    }
    peer.send(JSON.stringify(message));
  }

  private pingPeers(): void {
    for (const peer of this.peerLiveness.keys()) {
      if (!this.peerLiveness.get(peer)) {
        peer.terminate();
        this.peerLiveness.delete(peer);
        continue;
      }
      this.peerLiveness.set(peer, false);
      peer.ping();
    }
  }
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  socket.write(
    `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: 0\r\n\r\n`,
  );
  socket.destroy();
}

function validBrowserOrigin(request: IncomingMessage): boolean {
  const originHeader = request.headers.origin;
  if (!originHeader) return false;
  try {
    const origin = new URL(originHeader);
    const forwardedHost = firstHeaderValue(request.headers["x-forwarded-host"]);
    const expectedHost = forwardedHost ?? request.headers.host;
    const forwardedProtocol = firstHeaderValue(request.headers["x-forwarded-proto"]);
    const encrypted = "encrypted" in request.socket && request.socket.encrypted === true;
    const expectedProtocol = `${forwardedProtocol ?? (encrypted ? "https" : "http")}:`;
    return origin.host === expectedHost && origin.protocol === expectedProtocol;
  } catch {
    return false;
  }
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value?.split(",")[0];
  return first?.trim() || undefined;
}
