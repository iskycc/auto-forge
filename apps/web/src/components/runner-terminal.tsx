"use client";
import { Dialog } from "@/components/ui/dialog";

import "@xterm/xterm/css/xterm.css";
import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import { Button } from "@/components/ui";

import { apiErrorSchema, createTerminalSessionResultSchema } from "@autoforge/contracts";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import { LoaderCircle, Maximize2, Minimize2, ShieldCheck, TerminalSquare, X } from "lucide-react";
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
  const [expanded, setExpanded] = useState(false);
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
        const tokens = getComputedStyle(viewportRef.current);
        const terminalColor = (name: string) =>
          tokens.getPropertyValue(`--terminal-${name}`).trim();
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
            background: terminalColor("background"),
            foreground: terminalColor("foreground"),
            cursor: terminalColor("cursor"),
            selectionBackground: terminalColor("selection"),
            black: terminalColor("background"),
            red: terminalColor("red"),
            green: terminalColor("green"),
            yellow: terminalColor("yellow"),
            blue: terminalColor("blue"),
            magenta: terminalColor("magenta"),
            cyan: terminalColor("cyan"),
            white: terminalColor("white"),
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
    setExpanded(false);
    setConnectionState("authorization");
    setError(null);
  }

  function toggleExpanded(): void {
    setExpanded((current) => !current);
    window.requestAnimationFrame(() => fitAddonRef.current?.fit());
  }

  function retryTerminalConnection(): void {
    socketRef.current?.close(1000, "Retrying terminal connection");
    socketRef.current = null;
    setConnectionState("authorization");
    setError(null);
  }

  return (
    <>
      <Button
        className={cn(
          "button button-secondary",
          uiPatterns["button"],
          uiPatterns["button-secondary"],
        )}
        type="button"
        disabled={!available}
        title={unavailableReason}
        onClick={() => setOpen(true)}
      >
        <TerminalSquare size={15} /> 终端浮窗
      </Button>
      {open && (
        <Dialog
          open
          title={`${runnerName} 直连终端`}
          onClose={closeTerminal}
          onEscape={() => {
            if (expanded) setExpanded(false);
            else closeTerminal();
          }}
          className={cn(
            "terminal-window",
            runnerTerminalStyles["terminal-window"],
            expanded && "terminal-window-expanded",
            expanded && runnerTerminalStyles["terminal-window-expanded"],
          )}
          backdropClassName="terminal-backdrop"
        >
          <header className={cn("terminal-titlebar", runnerTerminalStyles["terminal-titlebar"])}>
            <span className={cn("terminal-title", runnerTerminalStyles["terminal-title"])}>
              <TerminalSquare size={15} />
              <strong>{runnerName}</strong>
              <small>Agent WebSocket</small>
            </span>
            <span
              className={cn(
                runnerTerminalStyles["terminal-connection"],
                `terminal-connection terminal-connection terminal-connection-${connectionState}`,
              )}
            >
              <i />
              {connectionLabel(connectionState)}
            </span>
            <Button
              aria-label={expanded ? "还原终端窗口" : "放大终端窗口"}
              aria-pressed={expanded}
              onClick={toggleExpanded}
              title={expanded ? "还原窗口" : "铺满窗口"}
              type="button"
              variant="ghost"
            >
              {expanded ? (
                <Minimize2 aria-hidden="true" size={14} />
              ) : (
                <Maximize2 aria-hidden="true" size={14} />
              )}
            </Button>
            <Button type="button" aria-label="关闭终端" onClick={closeTerminal}>
              <X size={16} />
            </Button>
          </header>
          <div className={cn("terminal-stage", runnerTerminalStyles["terminal-stage"])}>
            <div
              className={cn("terminal-viewport", runnerTerminalStyles["terminal-viewport"])}
              ref={viewportRef}
            />
            {(connectionState === "authorization" || connectionState === "connecting") && (
              <form
                className={cn("terminal-auth-card", runnerTerminalStyles["terminal-auth-card"])}
                onSubmit={connect}
              >
                <span
                  className={cn("terminal-auth-icon", runnerTerminalStyles["terminal-auth-icon"])}
                >
                  <ShieldCheck size={20} />
                </span>
                <strong>打开受控终端</strong>
                <p>将使用当前登录会话和独立终端权限换取一次性短时票据。</p>
                {error && (
                  <span
                    className={cn(
                      "terminal-auth-error",
                      runnerTerminalStyles["terminal-auth-error"],
                    )}
                  >
                    {error}
                  </span>
                )}
                <Button
                  className={cn(
                    "button button-primary",
                    uiPatterns["button"],
                    uiPatterns["button-primary"],
                  )}
                  type="submit"
                  disabled={connectionState === "connecting"}
                >
                  {connectionState === "connecting" ? (
                    <LoaderCircle className={cn("spin", uiPatterns["spin"])} size={15} />
                  ) : (
                    <TerminalSquare size={15} />
                  )}
                  {connectionState === "connecting" ? "正在连接" : "连接终端"}
                </Button>
              </form>
            )}
            {connectionState === "closed" && (
              <div
                className={cn("terminal-closed-card", runnerTerminalStyles["terminal-closed-card"])}
              >
                <strong>终端连接已结束</strong>
                <p>{error ?? "关闭浮窗后可重新创建受控会话。"}</p>
                <Button
                  className={cn(
                    "button button-primary",
                    uiPatterns["button"],
                    uiPatterns["button-primary"],
                  )}
                  type="button"
                  onClick={retryTerminalConnection}
                >
                  重新连接
                </Button>
                <Button
                  className={cn(
                    "button button-secondary",
                    uiPatterns["button"],
                    uiPatterns["button-secondary"],
                  )}
                  type="button"
                  onClick={closeTerminal}
                >
                  关闭
                </Button>
              </div>
            )}
          </div>
        </Dialog>
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

const terminalPromptSurface =
  "absolute left-1/2 top-1/2 z-10 flex w-[min(380px,calc(100%-3rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-xl border border-border bg-card p-6 text-card-foreground shadow-lg [&_strong]:text-lg [&_p]:text-sm [&_p]:leading-6 [&_p]:text-muted-foreground [&_.button]:self-start";

const runnerTerminalStyles = {
  "terminal-auth-card": `${terminalPromptSurface} [&_label]:grid [&_label]:gap-2 [&_label]:text-sm [&_label]:font-medium`,
  "terminal-auth-error": "text-destructive text-sm leading-6",
  "terminal-auth-icon": "grid w-10.5 h-10.5 place-items-center rounded-lg bg-muted text-foreground",

  "terminal-closed-card": terminalPromptSurface,
  "terminal-connection":
    "inline-flex items-center gap-1.5 text-muted-foreground text-xs font-semibold [&_i]:w-[7px] [&_i]:h-[7px] [&_i]:rounded-full [&_i]:bg-border [&.terminal-connection-connected]:text-success [&.terminal-connection-connected]:[&_i]:bg-success/10 [&.terminal-connection-connected]:[&_i]:shadow-xs [&.terminal-connection-connecting]:[&_i]:bg-destructive/10 [&.terminal-connection-connecting]:[&_i]:animate-pulse [&.terminal-connection-connecting]:[&_i]:motion-reduce:animate-none",
  "terminal-stage": "relative min-h-0 overflow-hidden",
  "terminal-title":
    "flex min-w-0 items-center justify-center gap-2 text-xs [&_strong]:overflow-hidden [&_strong]:max-w-[240px] [&_strong]:text-ellipsis [&_strong]:whitespace-nowrap [&_small]:text-muted-foreground [&_small]:text-xs",
  "terminal-titlebar":
    "grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-3 border-b border-border bg-card px-4 text-foreground select-none [&>button]:size-8 [&>button]:border-0 [&>button]:bg-transparent [&>button]:p-0 [&>button]:text-muted-foreground [&>button:hover]:bg-accent [&>button:hover]:text-foreground",
  "terminal-viewport":
    "absolute [inset:0] py-3.5 px-3 bg-[var(--terminal-background)] [&_.xterm]:h-full [&_.xterm-viewport]:[scrollbar-color:var(--log-border)_transparent] [&_.xterm-viewport]:[scrollbar-width:thin]",
  "terminal-window":
    "grid w-[min(1120px,_92vw)] h-[min(760px,_84vh)] min-h-[430px] [grid-template-rows:48px_minmax(0,_1fr)] overflow-hidden border border-solid border-border rounded-xl bg-[var(--terminal-background)] shadow-lg transition-colors duration-150 motion-reduce:transition-none",
  "terminal-window-controls":
    "inline-flex gap-[7px] [&_i]:w-2.5 [&_i]:h-2.5 [&_i]:rounded-full [&_i]:bg-destructive/10 [&_i:nth-child(2)]:bg-destructive/10 [&_i:nth-child(3)]:bg-success/10",
  "terminal-window-expanded":
    "w-[calc(100vw_-_24px)] h-[calc(100vh_-_24px)] max-w-[calc(100vw-24px)] max-h-[calc(100dvh-24px)] rounded-lg",
} as const;
