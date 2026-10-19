"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui";
import { LinkButton } from "@/components/ui/link-button";

type SessionCheckState =
  { status: "checking" | "anonymous" } | { status: "failed"; message: string };

/** Cross-site navigation omits Strict cookies; a same-origin probe can recover the existing session. */
export function SharedLogSessionAction({ className }: { className: string }) {
  const router = useRouter();
  const [state, setState] = useState<SessionCheckState>({ status: "checking" });
  const [attempt, setAttempt] = useState(0);
  const [refreshing, startRefresh] = useTransition();

  useEffect(() => {
    const controller = new AbortController();
    async function checkSession(): Promise<void> {
      try {
        const response = await fetch("/api/v1/auth/session", {
          cache: "no-store",
          credentials: "same-origin",
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (!response.ok && response.status !== 401) {
          throw new Error(`确认登录状态失败（HTTP ${response.status}）。`);
        }
        if (response.ok) startRefresh(() => router.refresh());
        setState({ status: "anonymous" });
      } catch (cause) {
        if (!controller.signal.aborted) {
          setState({
            status: "failed",
            message: cause instanceof Error ? cause.message : "无法确认登录状态，请重试。",
          });
        }
      }
    }
    void checkSession();
    return () => controller.abort();
  }, [attempt, router]);

  if (state.status === "checking" || refreshing) {
    return (
      <Button className={className} disabled loading type="button">
        正在确认登录状态…
      </Button>
    );
  }
  if (state.status === "failed") {
    return (
      <Button
        className={className}
        onClick={() => {
          setState({ status: "checking" });
          setAttempt((previous) => previous + 1);
        }}
        type="button"
        title={state.message}
      >
        登录状态确认失败，重试
      </Button>
    );
  }
  return (
    <LinkButton className={className} href="/login" variant="primary">
      登录后执行此用例
    </LinkButton>
  );
}
