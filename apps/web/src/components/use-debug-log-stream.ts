"use client";

import { useEffect, useEffectEvent } from "react";
import { z } from "zod";
import type { LogChunk } from "@autoforge/contracts";

import { parseManualLogFrame } from "@/lib/manual-live-log";
import { debugLogWindow } from "@/lib/case-debug-log-window";

/** The persisted pager remains the recovery path when live delivery is unavailable. */
export function useDebugLogStream({
  attemptId,
  enabled,
  onChunks,
  onConnected,
}: {
  attemptId: string;
  enabled: boolean;
  onChunks: (chunks: LogChunk[], truncatedStreams: LogChunk["stream"][]) => void;
  onConnected: () => void;
}) {
  const receive = useEffectEvent(onChunks);
  const connected = useEffectEvent(onConnected);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let generation = 0;
    let failures = 0;
    let socket: WebSocket | undefined;
    let request: AbortController | undefined;
    let reconnectTimer: number | undefined;
    let handshakeTimer: number | undefined;
    let renderTimer: number | undefined;
    let pending: Record<LogChunk["stream"], LogChunk[]> = { stdout: [], stderr: [], agent: [] };
    const truncatedStreams = new Set<LogChunk["stream"]>();

    const disconnect = () => {
      generation += 1;
      request?.abort();
      window.clearTimeout(reconnectTimer);
      window.clearTimeout(handshakeTimer);
      window.clearTimeout(renderTimer);
      renderTimer = undefined;
      pending = { stdout: [], stderr: [], agent: [] };
      truncatedStreams.clear();
      socket?.close(1000, "Debug log subscription changed");
    };
    const reconnect = () => {
      if (disposed || document.hidden || failures >= 8) return;
      reconnectTimer = window.setTimeout(
        () => void connect(),
        Math.min(30_000, 1_000 * 2 ** failures++),
      );
    };
    const connect = async () => {
      if (disposed || document.hidden) return;
      const current = ++generation;
      request = new AbortController();
      const stale = () => disposed || current !== generation;
      try {
        const response = await fetch(
          `/api/v1/run-attempts/${encodeURIComponent(attemptId)}/log-stream-ticket`,
          {
            method: "POST",
            cache: "no-store",
            signal: AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]),
          },
        );
        if (stale()) return;
        // Permission failures are final; ordinary persisted reads surface the error.
        if ([400, 401, 403, 404].includes(response.status)) return;
        if (!response.ok) throw new Error(`Log subscription rejected: ${response.status}`);
        const { ticket } = z.object({ ticket: z.string().min(1) }).parse(await response.json());
        if (stale()) return;
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const connection = new WebSocket(
          `${protocol}//${window.location.host}/api/v1/log-stream`,
          `autoforge-log.${ticket}`,
        );
        socket = connection;
        handshakeTimer = window.setTimeout(() => {
          if (!stale() && connection.readyState === WebSocket.CONNECTING) connection.close();
        }, 10_000);
        connection.onopen = () => {
          if (stale()) return;
          window.clearTimeout(handshakeTimer);
          connected();
        };
        connection.onmessage = (event) => {
          if (stale()) return;
          const chunks = parseManualLogFrame(event.data, attemptId);
          if (!chunks) return;
          for (const stream of ["stdout", "stderr", "agent"] as const) {
            const window = debugLogWindow(
              pending[stream],
              chunks.filter((chunk) => chunk.stream === stream),
            );
            pending[stream] = window.items;
            if (window.trimmed) truncatedStreams.add(stream);
          }
          if (renderTimer === undefined)
            renderTimer = window.setTimeout(() => {
              renderTimer = undefined;
              if (!stale()) receive(Object.values(pending).flat(), [...truncatedStreams]);
              pending = { stdout: [], stderr: [], agent: [] };
              truncatedStreams.clear();
            }, 100);
        };
        connection.onclose = () => {
          if (stale()) return;
          disconnect();
          reconnect();
        };
        connection.onerror = () => connection.close();
      } catch {
        // Recovery is bounded; HTTP polling continues even after retries are exhausted.
        if (!stale()) reconnect();
      }
    };
    const visibilityChanged = () => {
      disconnect();
      if (!document.hidden) {
        failures = 0;
        void connect();
      }
    };
    document.addEventListener("visibilitychange", visibilityChanged);
    void connect();
    return () => {
      disposed = true;
      disconnect();
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [attemptId, enabled]);
}
