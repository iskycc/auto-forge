"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { BrowserPlatformClock } from "@/lib/browser-platform-clock";

function createTimeStore(serverTimeMs: number) {
  const clock = new BrowserPlatformClock(serverTimeMs, () => performance.now());
  const listeners = new Set<() => void>();
  let snapshot = serverTimeMs;
  let timer: ReturnType<typeof setInterval> | undefined;
  const publish = () => {
    snapshot = clock.now();
    for (const listener of listeners) listener();
  };
  return {
    clock,
    publish,
    getSnapshot: () => snapshot,
    getServerSnapshot: () => serverTimeMs,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      publish();
      timer ??= setInterval(publish, 1_000);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          clearInterval(timer);
          timer = undefined;
        }
      };
    },
  };
}

const PlatformTimeContext = createContext<ReturnType<typeof createTimeStore> | null>(null);
const inactiveSubscription = () => () => {};

export function PlatformTimeProvider({
  serverTime,
  children,
}: {
  serverTime: string;
  children: ReactNode;
}) {
  const [store] = useState(() => createTimeStore(Date.parse(serverTime)));
  useEffect(() => {
    const lifetime = new AbortController();
    let pending = false;
    const synchronize = async () => {
      if (pending || document.visibilityState === "hidden") return;
      pending = true;
      const requestedAtMs = performance.now();
      try {
        const response = await fetch("/api/v1/time", {
          cache: "no-store",
          signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(5_000)]),
        });
        if (!response.ok) throw new Error("平台时间暂不可用。");
        const payload: unknown = await response.json();
        if (
          !payload ||
          typeof payload !== "object" ||
          !("schemaVersion" in payload) ||
          payload.schemaVersion !== 1 ||
          !("serverTime" in payload) ||
          typeof payload.serverTime !== "string"
        ) {
          throw new Error("平台时间响应格式错误。");
        }
        store.clock.synchronize(Date.parse(payload.serverTime), requestedAtMs, performance.now());
        store.publish();
      } catch {
        // Display only: retain the last platform anchor while offline. The server
        // independently rejects authoritative work when its own time source expires.
        store.publish();
      } finally {
        pending = false;
      }
    };
    void synchronize();
    const timer = setInterval(() => void synchronize(), 30_000);
    const onVisible = () => void synchronize();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      lifetime.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [store]);
  return <PlatformTimeContext.Provider value={store}>{children}</PlatformTimeContext.Provider>;
}

export function usePlatformNow(active = true): number {
  const store = useContext(PlatformTimeContext);
  if (!store) throw new Error("PlatformTimeProvider is required.");
  return useSyncExternalStore(
    active ? store.subscribe : inactiveSubscription,
    store.getSnapshot,
    store.getServerSnapshot,
  );
}
