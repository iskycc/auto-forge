"use client";

import { Alert, Tag } from "antd";
import { SearchCheck, UserRound } from "lucide-react";
import { ColorModeToggle } from "./color-mode-toggle";
import { SessionLoginButton } from "./session-login-button";
import { useLoginDialog } from "./login-dialog-provider";
import { FailureAnalysisSheet } from "./failure-analysis-sheet";
import type { FailureAnalysisSheetPage } from "@autoforge/contracts";

export function PublicFailureAnalysis({
  batchId,
  suiteName,
  sequenceNumber,
  archived,
  publisher,
  currentUser,
  initialPage,
}: {
  batchId: string;
  suiteName: string;
  sequenceNumber: number;
  archived: boolean;
  publisher: string;
  currentUser: { id: string; username: string; forcePasswordChange: boolean } | null;
  initialPage: FailureAnalysisSheetPage;
}) {
  const { session } = useLoginDialog();
  const authenticated = session.status === "authenticated" && Boolean(currentUser);
  return (
    <main className="mx-auto grid min-h-screen w-full max-w-[1920px] content-start gap-5 bg-background p-6">
      <header className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-solid border-border bg-card p-5 shadow-xs">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
            <SearchCheck size={23} />
          </span>
          <div className="min-w-0">
            <p className="mb-1 mt-0 text-xs font-semibold text-muted-foreground">
              AutoForge · 公开用例分析 · #{sequenceNumber}
            </p>
            <h1 className="m-0 break-all text-xl font-semibold">{suiteName}</h1>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Tag
            className="m-0"
            color={archived ? "default" : authenticated ? "processing" : "default"}
          >
            {archived ? "已归档 · 只读" : authenticated ? "已登录协作" : "访客 · 只读"}
          </Tag>
          {authenticated ? (
            <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
              <UserRound size={14} />
              {currentUser!.username}
            </span>
          ) : (
            <SessionLoginButton label="登录后认领与分析" />
          )}
          <ColorModeToggle />
        </div>
      </header>
      <Alert
        showIcon
        type="info"
        title={
          archived
            ? "此任务已归档，分析记录可继续查阅"
            : authenticated
              ? "认领用例后，可在工作表填写并提交分析结论"
              : "当前以只读方式浏览，登录后可在本页认领与分析"
        }
        description={`分享人：${publisher}。仅展示这一次任务的人工分析范围；拖拽填充只修改草稿，提交时逐例校验归属及证明。`}
      />
      <FailureAnalysisSheet
        key={`${batchId}:${currentUser?.id ?? "visitor"}`}
        endpoint={`/api/v1/public/failure-analysis/${encodeURIComponent(batchId)}`}
        currentUserId={currentUser?.id ?? null}
        canManage={authenticated && !archived && !currentUser!.forcePasswordChange}
        initialPage={initialPage}
      />
    </main>
  );
}
