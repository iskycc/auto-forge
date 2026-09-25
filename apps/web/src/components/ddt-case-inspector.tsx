"use client";
import { Notice } from "@/components/ui/notice";

import { Tabs } from "@/components/ui/tabs";
import { TabContent } from "@/components/ui/tab-content";
import { Badge } from "@/components/ui/badge";

import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import { useEffect, useState } from "react";
import type { DdtScope } from "@autoforge/domain";
import { ArrowLeft, AlertCircle } from "lucide-react";
import { Button } from "./ui";
import { LoadingState } from "./loading-state";
import { CaseDetailContent, CaseHistoryContent } from "./case-detail-content";
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
  const [definitionOpened, setDefinitionOpened] = useState(false);
  const [section, setSection] = useState<"history" | "definition">("history");
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
          <Notice
            tone="error"
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
          </Notice>
        ) : detail ? (
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
                <code title={execution?.definition.className}>
                  {execution
                    ? `执行类 · ${execution.definition.className}`
                    : "尚未关联执行类 · 可查看历史，执行前请配置 SR 测试类关联"}
                </code>
              </div>
              <div className={"case-inspector-header-actions"}>
                <Badge variant="secondary">
                  DDT r{detail.item.revision}
                  {execution ? ` · 类 v${execution.definition.currentVersion}` : ""}
                </Badge>
                {execution?.canRun &&
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
            <Tabs
              label="DDT 用例详情内容"
              value={section}
              onChange={(nextSection) => {
                setSection(nextSection);
                if (nextSection === "definition") setDefinitionOpened(true);
              }}
              items={[
                { key: "history", label: "执行与分析" },
                { key: "definition", label: "测试类详情", disabled: !execution },
              ]}
            />
            <TabContent activeKey={section} className="gap-3">
              {section === "definition" ? (
                <p className="m-0 text-xs text-muted-foreground">
                  源码、测试方法与类版本来自当前关联的执行类。
                </p>
              ) : null}
              <div hidden={section !== "history"} className="grid min-w-0 gap-3 [&[hidden]]:hidden">
                <CaseHistoryContent
                  compact
                  detail={(execution ?? detail.historyDetail)!}
                  caseDefinitionId={detail.item.id}
                  projectId={scope.projectId}
                  presentation="inspector"
                />
              </div>
              {execution && definitionOpened ? (
                <div
                  hidden={section !== "definition"}
                  className="grid min-w-0 gap-3 [&[hidden]]:hidden"
                >
                  <CaseDetailContent
                    detail={execution}
                    presentation="inspector"
                    section="definition"
                  />
                </div>
              ) : null}
            </TabContent>
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
    "flex min-w-0 items-start justify-between gap-4 border-b border-solid border-border pb-3 [&_>_div]:grid [&_>_div]:min-w-0 [&_>_div]:gap-1 [&_h2]:m-0 [&_h2]:text-lg [&_h2]:[overflow-wrap:anywhere] [&_code]:text-muted-foreground [&_code]:[overflow-wrap:anywhere] [&_.case-inspector-header-actions]:justify-items-end [&_.case-inspector-header-actions]:[flex:0_0_auto]",
  "ddt-case-detail-scroll":
    "min-h-0 flex-1 overflow-auto py-2 px-3 [container-type:inline-size] [&_.ddt-execution-class-summary]:grid-cols-[auto_minmax(0,_1fr)] [&_.ddt-execution-class-summary]:gap-[4px_8px] [&_.ddt-execution-class-summary]:mb-3 [&_.ddt-execution-class-summary]:py-2 [&_.ddt-execution-class-summary]:px-3 [&_.ddt-execution-class-summary_>_small]:col-span-full [&_.ddt-history]:block",
  "ddt-detail-error": "overflow-auto p-5",
  "ddt-detail-toolbar":
    "flex min-h-[calc(20px_*_2)] [flex:0_0_auto] items-center justify-between gap-2 border-b border-solid border-border py-2 px-3 flex-wrap [&_>_span]:flex [&_>_span]:min-w-0 [&_>_span]:items-center [&_>_span]:gap-1 [&_>_span]:flex-1 [&_>_span]:whitespace-nowrap [&_>_div]:flex [&_>_div]:min-w-0 [&_>_div]:items-center [&_>_div]:gap-1 [&_>_span_>_strong]:max-w-[24ch] [&_>_span_>_strong]:overflow-hidden [&_>_span_>_strong]:text-ellipsis [&_>_span_>_strong]:whitespace-nowrap [&_>_span_>_svg]:[flex:0_0_auto]",
  "ddt-execution-inspector":
    "[&_.case-inspector-content]:p-0 [&_.case-inspector-header]:flex-wrap [&_.case-inspector-header-actions]:justify-items-start",
} as const;
