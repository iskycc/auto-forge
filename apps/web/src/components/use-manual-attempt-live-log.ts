"use client";

import {
  attemptLogPageSchema,
  type LogChunk,
  type SharedAttemptLogOutcome,
} from "@autoforge/contracts";
import { isTerminalAttemptStatus } from "@autoforge/domain";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { readApiErrorMessage } from "@/lib/client-api";
import { mergeManualLogWindow, parseManualLogFrame } from "@/lib/manual-live-log";

const STATUS_REFRESH_MS = 5_000;
const MAXIMUM_RECONNECTS = 8;
const MAXIMUM_SNAPSHOT_PAGES = 8;
const stateSchema = z.object({
  attemptId: z.string(),
  status: z.enum(["assigned", "running", "succeeded", "failed", "timed_out", "cancelled"]),
});

/** Visible, authorized manual executions use one socket and a minimal serial state probe. */
export function useManualAttemptLiveLog({
  attemptId,
  enabled,
  initialStatus,
  initialText,
  onFinished,
}: {
  attemptId: string;
  enabled: boolean;
  initialStatus: SharedAttemptLogOutcome;
  initialText: string;
  onFinished: () => void;
}) {
  const [observedStatus, setObservedStatus] = useState(initialStatus);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState("");
  const [visible, setVisible] = useState(true);
  const [retrySequence, setRetrySequence] = useState(0);
  const [snapshotLoaded, setSnapshotLoaded] = useState(false);
  const windowRef = useRef({ chunks: [] as LogChunk[], truncated: false });
  const [logWindow, setLogWindow] = useState({ chunks: [] as LogChunk[], truncated: false });
  const status = isTerminalAttemptStatus(initialStatus) ? initialStatus : observedStatus;
  const terminal = isTerminalAttemptStatus(status);
  const retry = useCallback(() => setRetrySequence((value) => value + 1), []);

  useEffect(() => {
    if (!enabled || terminal) return;
    const updateVisibility = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", updateVisibility);
    const timer = window.setTimeout(updateVisibility, 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", updateVisibility);
    };
  }, [enabled, terminal]);

  useEffect(() => {
    if (!enabled || terminal || !visible || document.hidden) return;
    const controller = new AbortController();
    let disposed = false;
    let stopped = false;
    let socket: WebSocket | undefined;
    let reconnectTimer: number | undefined;
    let stateTimer: number | undefined;
    let renderTimer: number | undefined;
    let handshakeTimer: number | undefined;
    let snapshotInFlight = false;
    let snapshotRequested = false;
    let reconnects = 0;
    let stateFailures = 0;
    const basePath = `/api/v1/run-attempts/${encodeURIComponent(attemptId)}`;

    const request = async (path: string, method = "GET") => {
      const response = await fetch(path, {
        method,
        cache: "no-store",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
      });
      if (!response.ok) {
        if ([400, 401, 403, 404].includes(response.status)) stopped = true;
        throw new Error((await readApiErrorMessage(response, "实时日志读取失败。"))!);
      }
      return response;
    };
    const appendChunks = (chunks: LogChunk[]) => {
      if (disposed) return;
      const next = mergeManualLogWindow(windowRef.current.chunks, chunks);
      windowRef.current = {
        chunks: next.chunks,
        truncated: windowRef.current.truncated || next.truncated,
      };
      // Batch bursts to at most ten log renders per second; the retained window is already bounded.
      if (renderTimer === undefined)
        renderTimer = window.setTimeout(() => {
          renderTimer = undefined;
          if (!disposed) setLogWindow(windowRef.current);
        }, 100);
    };
    const loadPersisted = async () => {
      if (snapshotInFlight) {
        snapshotRequested = true;
        return;
      }
      snapshotInFlight = true;
      try {
        const watermarks = Object.fromEntries(
          ["stdout", "stderr"].map((stream) => [
            stream,
            windowRef.current.chunks.reduce(
              (maximum, chunk) =>
                chunk.stream === stream ? Math.max(maximum, chunk.sequence) : maximum,
              -1,
            ),
          ]),
        );
        for (const stream of ["stdout", "stderr"] as const) {
          let afterSequence = watermarks[stream]!;
          for (let pageIndex = 0; pageIndex < MAXIMUM_SNAPSHOT_PAGES; pageIndex += 1) {
            const response = await request(
              `${basePath}/logs?stream=${stream}&afterSequence=${afterSequence}&limit=200`,
            );
            const page = attemptLogPageSchema.parse(await response.json());
            if (disposed) return;
            appendChunks(page.items);
            if (
              page.truncated ||
              (pageIndex === MAXIMUM_SNAPSHOT_PAGES - 1 && page.nextSequence !== undefined)
            ) {
              windowRef.current = { ...windowRef.current, truncated: true };
              setLogWindow(windowRef.current);
            }
            if (page.nextSequence === undefined || page.nextSequence <= afterSequence) break;
            afterSequence = page.nextSequence;
          }
        }
        if (!disposed) {
          setLogWindow(windowRef.current);
          setSnapshotLoaded(true);
        }
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : "持久日志同步失败。");
      } finally {
        snapshotInFlight = false;
        if (snapshotRequested && !disposed && !stopped) {
          snapshotRequested = false;
          void loadPersisted();
        }
      }
    };
    const scheduleReconnect = () => {
      if (disposed || stopped) return;
      reconnects += 1;
      if (reconnects > MAXIMUM_RECONNECTS) {
        setError("实时日志连接多次中断，请点击重连；已加载日志仍可查看。");
        return;
      }
      reconnectTimer = window.setTimeout(
        () => void connect(),
        Math.min(30_000, 1_000 * 2 ** (reconnects - 1)),
      );
    };
    const connect = async () => {
      try {
        const response = await request(`${basePath}/log-stream-ticket?manualOnly=1`, "POST");
        const payload = z.object({ ticket: z.string().min(1) }).parse(await response.json());
        if (disposed || stopped) return;
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        socket = new WebSocket(
          `${protocol}//${window.location.host}/api/v1/log-stream`,
          `autoforge-log.${payload.ticket}`,
        );
        handshakeTimer = window.setTimeout(() => {
          if (!disposed && socket?.readyState === WebSocket.CONNECTING) socket.close();
        }, 10_000);
        socket.onopen = () => {
          if (handshakeTimer !== undefined) window.clearTimeout(handshakeTimer);
          if (disposed || stopped) {
            socket?.close();
            return;
          }
          setConnected(true);
          setError("");
          void loadPersisted();
        };
        socket.onmessage = (event) => {
          const chunks = parseManualLogFrame(event.data, attemptId);
          if (chunks) appendChunks(chunks);
        };
        socket.onclose = () => {
          if (handshakeTimer !== undefined) window.clearTimeout(handshakeTimer);
          if (!disposed) setConnected(false);
          scheduleReconnect();
        };
        socket.onerror = () => socket?.close();
      } catch (cause) {
        if (disposed) return;
        setConnected(false);
        setError(cause instanceof Error ? cause.message : "实时日志连接失败。");
        scheduleReconnect();
      }
    };
    const readState = async () => {
      try {
        const response = await request(`${basePath}/manual-state`);
        const state = stateSchema.parse(await response.json());
        if (disposed || state.attemptId !== attemptId) return;
        setObservedStatus(state.status);
        stateFailures = 0;
        if (isTerminalAttemptStatus(state.status)) {
          stopped = true;
          if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
          socket?.close(1000, "Manual execution finished");
          setConnected(false);
          onFinished();
          return;
        }
      } catch (cause) {
        if (disposed) return;
        stateFailures += 1;
        setError(cause instanceof Error ? cause.message : "手动执行状态读取失败。");
        if (stopped || stateFailures >= 3) {
          stopped = true;
          socket?.close(1000, "State unavailable");
          return;
        }
      }
      if (!disposed && !stopped)
        stateTimer = window.setTimeout(() => void readState(), STATUS_REFRESH_MS);
    };
    void connect();
    void readState();
    return () => {
      disposed = true;
      controller.abort();
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      if (stateTimer !== undefined) window.clearTimeout(stateTimer);
      if (renderTimer !== undefined) window.clearTimeout(renderTimer);
      if (handshakeTimer !== undefined) window.clearTimeout(handshakeTimer);
      socket?.close(1000, "Log detail hidden or changed");
      setConnected(false);
    };
  }, [attemptId, enabled, onFinished, retrySequence, terminal, visible]);

  const logText = useMemo(
    () => (snapshotLoaded ? logWindow.chunks.map((chunk) => chunk.content).join("") : initialText),
    [snapshotLoaded, logWindow.chunks, initialText],
  );
  return {
    status,
    connected: connected && visible && !terminal,
    error,
    retry,
    logText,
    truncated: logWindow.truncated,
  };
}
