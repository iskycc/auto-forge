"use client";

import { readModelStatusSchema, type ReadModelStatus } from "@autoforge/contracts";
import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "./ui";
import { useToast } from "./ui-feedback";
import { formatPlatformDateTime } from "@/lib/platform-date-time";

export function ReadModelStatusBar({
  snapshots: initialSnapshots,
}: {
  snapshots: ReadModelStatus[];
}) {
  const [snapshots, setSnapshots] = useState(initialSnapshots);
  const [previousSnapshots, setPreviousSnapshots] = useState(initialSnapshots);
  if (previousSnapshots !== initialSnapshots) {
    setPreviousSnapshots(initialSnapshots);
    setSnapshots(initialSnapshots);
  }
  const container = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const toast = useToast();
  const [refreshing, setRefreshing] = useState(false);
  const [offline, setOffline] = useState(false);
  const signature = initialSnapshots
    .map((snapshot) => `${snapshot.id}:${snapshot.generation ?? ""}`)
    .join(",");
  const ids = snapshots.map((snapshot) => snapshot.id).join(",");
  const pending = initialSnapshots.some((snapshot) => snapshot.generation === null);
  const unsettled = snapshots.some((snapshot) => snapshot.state !== "ready");
  const failed = snapshots.some((snapshot) => snapshot.state === "failed");
  const generatedAt = initialSnapshots
    .flatMap((snapshot) => (snapshot.generatedAt ? [snapshot.generatedAt] : []))
    .sort()[0];

  useEffect(() => {
    if (!ids) return;
    const controller = new AbortController();
    let running = false;
    async function inspect() {
      if (
        running ||
        document.visibilityState !== "visible" ||
        !container.current?.getClientRects().length
      )
        return;
      running = true;
      try {
        const response = await fetch(`/api/v1/read-models/status?ids=${encodeURIComponent(ids)}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (response.status === 401) {
          window.location.replace("/login");
          return;
        }
        if (response.status === 403 || response.status === 404) {
          router.refresh();
          return;
        }
        if (!response.ok) throw new Error("无法读取更新状态。");
        const received = readModelStatusSchema
          .array()
          .parse(((await response.json()) as { items: unknown }).items);
        setOffline(false);
        setSnapshots(received);
        const nextSignature = received
          .map((snapshot) => `${snapshot.id}:${snapshot.generation ?? ""}`)
          .join(",");
        if (
          nextSignature !== signature &&
          !document.querySelector('[role="dialog"][aria-modal="true"]')
        )
          router.refresh();
      } catch {
        if (!controller.signal.aborted) setOffline(true);
      } finally {
        running = false;
      }
    }
    const timer = setInterval(
      () => void inspect(),
      unsettled && !failed && !offline ? 1_000 : 30_000,
    );
    const initial = setTimeout(() => void inspect(), 0);
    document.addEventListener("visibilitychange", inspect);
    return () => {
      controller.abort();
      clearInterval(timer);
      clearTimeout(initial);
      document.removeEventListener("visibilitychange", inspect);
    };
  }, [ids, unsettled, failed, offline, router, signature]);

  async function refresh() {
    setRefreshing(true);
    try {
      const response = await fetch("/api/v1/read-models/status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: snapshots.map((snapshot) => snapshot.id) }),
      });
      if (!response.ok) throw new Error("请求更新失败，请稍后重试。");
      toast.info("已请求后台更新，当前内容仍可继续查看。");
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "请求更新失败。");
    } finally {
      setRefreshing(false);
    }
  }

  if (!snapshots.length) return null;
  return (
    <div className="read-model-status" ref={container}>
      <span aria-live="polite">
        {offline
          ? "连接暂时不可用，保留已加载的数据。"
          : failed
            ? "后台更新暂未完成，可稍后重试。"
            : pending
              ? "正在后台准备数据，完成后会自动显示。"
              : generatedAt
                ? `数据更新于 ${formatPlatformDateTime(generatedAt)} · 后台自动更新`
                : "后台自动更新"}
      </span>
      <Button disabled={refreshing} onClick={() => void refresh()} type="button">
        <RefreshCw size={14} />
        刷新数据
      </Button>
    </div>
  );
}

export function ReadModelPendingPage({
  title,
  snapshots,
}: {
  title: string;
  snapshots: ReadModelStatus[];
}) {
  return (
    <div className="page-stack">
      <section className="page-hero">
        <div>
          <h1>{title}</h1>
          <p>首次准备当前范围的数据。完成后会自动显示，再次访问将复用已保存的结果。</p>
        </div>
      </section>
      <ReadModelStatusBar snapshots={snapshots} />
    </div>
  );
}
