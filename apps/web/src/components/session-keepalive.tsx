"use client";

import { useEffect, useRef } from "react";

const SESSION_REFRESH_INTERVAL_MS = 5 * 60_000;

/**
 * 前台页面活动期间续期服务端会话和 HttpOnly Cookie。隐藏页面不会续期，超过
 * 服务端空闲期限后仍需重新登录，因而不会把无人使用的会话无限保活。
 */
export function SessionKeepalive() {
  const requestInFlight = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    let lastAttemptAt = 0;

    async function refreshSession(force = false): Promise<void> {
      const now = Date.now();
      if (
        requestInFlight.current ||
        document.visibilityState !== "visible" ||
        (!force && now - lastAttemptAt < SESSION_REFRESH_INTERVAL_MS)
      ) {
        return;
      }
      lastAttemptAt = now;
      requestInFlight.current = true;
      try {
        const response = await fetch("/api/v1/auth/session/refresh", {
          method: "POST",
          cache: "no-store",
          credentials: "same-origin",
          signal: controller.signal,
        });
        if (!response.ok && response.status !== 401) {
          throw new Error(`Session refresh failed with HTTP ${response.status}.`);
        }
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          // 允许网络恢复或窗口重新获得焦点时立即重试，但不以辅助心跳打断当前操作。
          lastAttemptAt = 0;
        }
      } finally {
        requestInFlight.current = false;
      }
    }

    void refreshSession(true);
    const interval = window.setInterval(() => void refreshSession(), SESSION_REFRESH_INTERVAL_MS);
    const refreshAfterReturn = () => void refreshSession();
    window.addEventListener("focus", refreshAfterReturn);
    document.addEventListener("visibilitychange", refreshAfterReturn);
    return () => {
      controller.abort();
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshAfterReturn);
      document.removeEventListener("visibilitychange", refreshAfterReturn);
    };
  }, []);

  return null;
}
