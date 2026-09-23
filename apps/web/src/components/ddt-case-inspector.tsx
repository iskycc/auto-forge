"use client";
import { Notice } from "@/components/ui/notice";

import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import { useEffect, useState } from "react";
import type { DdtScope } from "@autoforge/domain";
import { ArrowLeft, AlertCircle } from "lucide-react";
import { Button } from "./ui";
import { LoadingState } from "./loading-state";
import { CaseDetailContent } from "./case-detail-content";
import { OpenRunDialogButton } from "./global-run-dialog";
import { readApiError } from "@/lib/client-api";
import type { DdtCaseDetailView } from "@/lib/ddt-case-detail-view";

export function DdtCaseInspector({
  scope,
  caseId,
  onClose,
}: {
  scope: DdtScope;
  caseId: string;
  onClose(): void;
}) {
  const [detail, setDetail] = useState<DdtCaseDetailView>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const endpoint = `/api/v1/ddt/cases/${encodeURIComponent(caseId)}/workspace?${new URLSearchParams(scope)}`;
  useEffect(() => {
    const controller = new AbortController();
    void fetch(endpoint, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const problem = await readApiError(response, "读取 DDT 用例执行详情失败。");
        if (problem) throw problem;
        const next = (await response.json()) as DdtCaseDetailView;
        if (!controller.signal.aborted) setDetail(next);
      })
      .catch((problem: unknown) => {
        if (!controller.signal.aborted)
          setError(problem instanceof Error ? problem.message : "读取 DDT 用例执行详情失败。");
      });
    return () => controller.abort();
  }, [endpoint, retry]);
  const execution = detail?.executionDetail;
  return (
    <>
      <header className={cn("ddt-detail-toolbar", ddtCaseInspectorStyles["ddt-detail-toolbar"])}>
        <span>用例详情与操作</span>
        <Button variant="secondary" onClick={onClose}>
          <ArrowLeft size={15} /> 返回用例字段
        </Button>
      </header>
      <div
        className={cn(
          "ddt-case-detail-scroll ddt-execution-inspector",
          ddtCaseInspectorStyles["ddt-case-detail-scroll"],
          ddtCaseInspectorStyles["ddt-execution-inspector"],
        )}
        aria-label="用例详情与操作"
      >
        {error ? (
          <div
            className={cn("ddt-detail-error", ddtCaseInspectorStyles["ddt-detail-error"])}
            role="alert"
          >
            <AlertCircle size={22} />
            <p>{error}</p>
            <Button
              onClick={() => {
                setError("");
                setRetry((value) => value + 1);
              }}
            >
              重试读取详情
            </Button>
          </div>
        ) : detail && execution ? (
          <div
            className={cn(
              "case-inspector-content",
              ddtCaseInspectorStyles["case-inspector-content"],
            )}
          >
            <header
              className={cn(
                "case-inspector-header",
                ddtCaseInspectorStyles["case-inspector-header"],
              )}
            >
              <div>
                <span className={cn("eyebrow", uiPatterns["eyebrow"])}>
                  DDT 用例 · SR {detail.item.srNum}
                </span>
                <h2>{detail.item.caseId}</h2>
                <span>执行类 · {execution.definition.displayName}</span>
                <code>{execution.definition.className}</code>
              </div>
              <div className={"case-inspector-header-actions"}>
                <span className={cn("storage-pill", ddtCaseInspectorStyles["storage-pill"])}>
                  DDT r{detail.item.revision} · 类 v{execution.definition.currentVersion}
                </span>
                {execution.canRun &&
                execution.executable &&
                execution.definition.enabled &&
                !execution.definition.archived ? (
                  <OpenRunDialogButton
                    ddtCase={detail.item}
                    className={cn(
                      "button button-primary compact-button",
                      uiPatterns["button"],
                      uiPatterns["button-primary"],
                      uiPatterns["compact-button"],
                    )}
                  >
                    立即执行
                  </OpenRunDialogButton>
                ) : null}
              </div>
            </header>
            <Notice tone="info" className={cn("inline-notice", uiPatterns["inline-notice"])}>
              执行与分析历史仅属于当前 DDT 用例；源码、测试方法及类版本信息来自关联执行类。
            </Notice>
            <CaseDetailContent detail={execution} presentation="inspector" />
          </div>
        ) : (
          <LoadingState
            label="正在读取用例详情"
            description="正在加载当前 DDT 用例的执行、分析历史和关联测试类。"
          />
        )}
      </div>
    </>
  );
}

const ddtCaseInspectorStyles = {
  "case-inspector-content":
    "grid gap-3 p-4 [&_>_*]:min-w-0 [&_.case-execution-history_.data-table]:min-w-[760px]",
  "case-inspector-header":
    "flex min-w-0 items-start justify-between gap-4 border-b border-solid border-border [padding:2px_2px_16px] [&_>_div]:grid [&_>_div]:min-w-0 [&_>_div]:gap-[5px] [&_h2]:m-0 [&_h2]:text-2xl [&_h2]:[overflow-wrap:anywhere] [&_code]:text-muted-foreground [&_code]:[overflow-wrap:anywhere] [&_.case-inspector-header-actions]:justify-items-end [&_.case-inspector-header-actions]:[flex:0_0_auto]",
  "ddt-case-detail-scroll":
    "min-h-0 flex-1 overflow-auto py-2 px-3 [container-type:inline-size] [&_.ddt-execution-class-summary]:grid-cols-[auto_minmax(0,_1fr)] [&_.ddt-execution-class-summary]:gap-[4px_8px] [&_.ddt-execution-class-summary]:mb-3 [&_.ddt-execution-class-summary]:py-2 [&_.ddt-execution-class-summary]:px-3 [&_.ddt-execution-class-summary_>_small]:col-span-full [&_.ddt-history]:block",
  "ddt-detail-error": "overflow-auto p-5",
  "ddt-detail-toolbar":
    "flex min-h-[calc(20px_*_2)] [flex:0_0_auto] items-center justify-between gap-2 border-b border-solid border-border py-2 px-3 flex-wrap [&_>_span]:flex [&_>_span]:min-w-0 [&_>_span]:items-center [&_>_span]:gap-1 [&_>_span]:flex-1 [&_>_span]:whitespace-nowrap [&_>_div]:flex [&_>_div]:min-w-0 [&_>_div]:items-center [&_>_div]:gap-1 [&_>_span_>_strong]:max-w-[24ch] [&_>_span_>_strong]:overflow-hidden [&_>_span_>_strong]:text-ellipsis [&_>_span_>_strong]:whitespace-nowrap [&_>_span_>_svg]:[flex:0_0_auto]",
  "ddt-execution-inspector":
    "[&_.case-inspector-content]:p-0 [&_.case-inspector-header]:flex-wrap [&_.case-inspector-header-actions]:justify-items-start",
  "storage-pill":
    "inline-flex items-center gap-2 border border-solid border-border rounded-full py-[9px] px-[13px] bg-card text-muted-foreground text-xs font-semibold shadow-xs",
} as const;
