"use client";

import { Button } from "@/components/ui";

import { apiErrorSchema, createTerminalSessionResultSchema } from "@autoforge/contracts";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import { LoaderCircle, Maximize2, ShieldCheck, TerminalSquare, X } from "lucide-react";
import { FormEvent, useEffect, useRef, useState } from "react";

type ConnectionState = "authorization" | "connecting" | "connected" | "closed";

type RunnerTerminalProps = {
  runnerId: string;
  runnerName: string;
  platformEnabled: boolean;
  runnerEnabled: boolean;
  runnerOnline: boolean;
};

export function RunnerTerminal({
  runnerId,
  runnerName,
  platformEnabled,
  runnerEnabled,
  runnerOnline,
}: RunnerTerminalProps) {
  const [open, setOpen] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>("authorization");
  const [error, setError] = useState<string | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);

  const available = platformEnabled && runnerEnabled && runnerOnline;
  const unavailableReason = !platformEnabled
    ? "平台未启用终端网关"
    : !runnerEnabled
      ? "Agent 未启用直连终端"
      : !runnerOnline
        ? "执行机当前离线"
        : undefined;

  useEffect(() => {
    if (!open || !viewportRef.current) return;
    let disposed = false;
    let resizeObserver: ResizeObserver | undefined;
    let inputDisposable: { dispose(): void } | undefined;

    void Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]).then(
      ([{ Terminal: XtermTerminal }, { FitAddon: XtermFitAddon }]) => {
        if (disposed || !viewportRef.current) return;
        const terminal = new XtermTerminal({
          allowTransparency: false,
          convertEol: false,
          cursorBlink: true,
          cursorStyle: "bar",
          fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
          fontSize: 13,
          lineHeight: 1.2,
          scrollback: 3_000,
          screenReaderMode: true,
          theme: {
            background: "#111318",
            foreground: "#e8eaed",
            cursor: "#7db1ff",
            selectionBackground: "#315f91aa",
            black: "#111318",
            red: "#ff6b6b",
            green: "#69db7c",
            yellow: "#ffd43b",
            blue: "#74c0fc",
            magenta: "#da77f2",
            cyan: "#66d9e8",
            white: "#f1f3f5",
          },
        });
        const fitAddon = new XtermFitAddon();
        terminal.loadAddon(fitAddon);
        terminal.open(viewportRef.current);
        fitAddon.fit();
        terminal.writeln("\x1b[38;5;110mAutoForge Runner Terminal\x1b[0m");
        terminal.writeln("终端仅在当前浮窗和 Agent 出站 WebSocket 存活期间保持连接。\r\n");
        terminalRef.current = terminal;
        fitAddonRef.current = fitAddon;
        inputDisposable = terminal.onData((input) => {
          const socket = socketRef.current;
          if (socket?.readyState !== WebSocket.OPEN) return;
          socket.send(
            JSON.stringify({ schemaVersion: 1, type: "input", data: encodeBase64(input) }),
          );
        });
        resizeObserver = new ResizeObserver(() => {
          fitAddon.fit();
          const socket = socketRef.current;
          if (socket?.readyState === WebSocket.OPEN) {
            socket.send(
              JSON.stringify({
                schemaVersion: 1,
                type: "resize",
                columns: terminal.cols,
                rows: terminal.rows,
              }),
            );
          }
        });
        resizeObserver.observe(viewportRef.current);
      },
    );

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      inputDisposable?.dispose();
      socketRef.current?.close(1000, "Terminal window closed");
      socketRef.current = null;
      terminalRef.current?.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeTerminal();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  });

  async function connect(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal || !fitAddon) {
      setError("终端组件仍在初始化，请稍后重试。");
      return;
    }
    setConnectionState("connecting");
    setError(null);
    fitAddon.fit();
    try {
      const response = await fetch("/api/v1/terminal-sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runnerId, columns: terminal.cols, rows: terminal.rows }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const parsedError = apiErrorSchema.safeParse(payload);
        throw new Error(
          parsedError.success
            ? parsedError.data.error.message
            : `创建终端会话失败（HTTP ${response.status}）。`,
        );
      }
      const session = createTerminalSessionResultSchema.parse(payload);
      openWebSocket(session.websocketPath, session.connectionToken);
    } catch (caught) {
      setConnectionState("authorization");
      setError(caught instanceof Error ? caught.message : "创建终端会话失败。");
    }
  }

  function openWebSocket(path: string, connectionToken: string): void {
    const endpoint = new URL(path, window.location.href);
    endpoint.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(endpoint, [
      "autoforge-terminal-v1",
      `autoforge-ticket.${connectionToken}`,
    ]);
    socketRef.current = socket;
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const message = parseTerminalEvent(event.data);
      if (!message) {
        socket.close(1007, "Invalid terminal event");
        return;
      }
      if (message.type === "ready") {
        setConnectionState("connected");
        terminalRef.current?.focus();
      } else if (message.type === "output") {
        terminalRef.current?.write(decodeBase64(message.data));
      } else if (message.type === "error") {
        setError(message.message);
        terminalRef.current?.writeln(`\r\n\x1b[31m${message.message}\x1b[0m`);
      } else {
        const status = message.signal
          ? `signal ${message.signal}`
          : `exit ${message.exitCode ?? "unknown"}`;
        terminalRef.current?.writeln(`\r\n\x1b[90m[terminal ${status}]\x1b[0m`);
      }
    });
    socket.addEventListener("error", () => {
      setError("终端 WebSocket 连接失败，请确认反向代理允许 Upgrade 请求。");
    });
    socket.addEventListener("close", () => {
      socketRef.current = null;
      setConnectionState((current) => (current === "authorization" ? "authorization" : "closed"));
    });
  }

  function closeTerminal(): void {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ schemaVersion: 1, type: "close" }));
    }
    socket?.close(1000, "Terminal window closed");
    setOpen(false);
    setConnectionState("authorization");
    setError(null);
  }

  return (
    <>
      <Button
        className="button button-secondary"
        type="button"
        disabled={!available}
        title={unavailableReason}
        onClick={() => setOpen(true)}
      >
        <TerminalSquare size={15} /> 终端浮窗
      </Button>
      {open && (
        <div className="terminal-backdrop" role="presentation" onMouseDown={closeTerminal}>
          <section
            className="terminal-window"
            role="dialog"
            aria-modal="true"
            aria-label={`${runnerName} 直连终端`}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="terminal-titlebar">
              <span className="terminal-window-controls" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span className="terminal-title">
                <TerminalSquare size={15} />
                <strong>{runnerName}</strong>
                <small>Agent WebSocket</small>
              </span>
              <span className={`terminal-connection terminal-connection-${connectionState}`}>
                <i />
                {connectionLabel(connectionState)}
              </span>
              <Maximize2 aria-hidden="true" size={14} />
              <Button type="button" aria-label="关闭终端" onClick={closeTerminal}>
                <X size={16} />
              </Button>
            </header>
            <div className="terminal-stage">
              <div className="terminal-viewport" ref={viewportRef} />
              {(connectionState === "authorization" || connectionState === "connecting") && (
                <form className="terminal-auth-card" onSubmit={connect}>
                  <span className="terminal-auth-icon">
                    <ShieldCheck size={20} />
                  </span>
                  <strong>打开受控终端</strong>
                  <p>将使用当前登录会话和独立终端权限换取一次性短时票据。</p>
                  {error && <span className="terminal-auth-error">{error}</span>}
                  <Button
                    className="button button-primary"
                    type="submit"
                    disabled={connectionState === "connecting"}
                  >
                    {connectionState === "connecting" ? (
                      <LoaderCircle className="spin" size={15} />
                    ) : (
                      <TerminalSquare size={15} />
                    )}
                    {connectionState === "connecting" ? "正在连接" : "连接终端"}
                  </Button>
                </form>
              )}
              {connectionState === "closed" && (
                <div className="terminal-closed-card">
                  <strong>终端连接已结束</strong>
                  <p>{error ?? "关闭浮窗后可重新创建受控会话。"}</p>
                  <Button className="button button-secondary" type="button" onClick={closeTerminal}>
                    关闭
                  </Button>
                </div>
              )}
            </div>
          </section>
        </div>
      )}
    </>
  );
}

type TerminalEvent =
  | { type: "ready" }
  | { type: "output"; data: string }
  | { type: "error"; message: string }
  | { type: "exit"; exitCode?: number; signal?: string };

function parseTerminalEvent(raw: string): TerminalEvent | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const candidate = value as Record<string, unknown>;
    if (candidate.schemaVersion !== 1) return null;
    if (candidate.type === "ready") return { type: "ready" };
    if (candidate.type === "output" && typeof candidate.data === "string") {
      return { type: "output", data: candidate.data };
    }
    if (candidate.type === "error" && typeof candidate.message === "string") {
      return { type: "error", message: candidate.message };
    }
    if (candidate.type === "exit") {
      return {
        type: "exit",
        ...(typeof candidate.exitCode === "number" ? { exitCode: candidate.exitCode } : {}),
        ...(typeof candidate.signal === "string" ? { signal: candidate.signal } : {}),
      };
    }
    return null;
  } catch {
    return null;
  }
}

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return window.btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function connectionLabel(state: ConnectionState): string {
  if (state === "connected") return "已连接";
  if (state === "connecting") return "连接中";
  if (state === "closed") return "已断开";
  return "待连接";
}
