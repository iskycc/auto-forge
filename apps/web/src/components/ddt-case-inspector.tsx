"use client";

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
      <header className="ddt-detail-toolbar">
        <span>用例详情与操作</span>
        <Button variant="secondary" onClick={onClose}>
          <ArrowLeft size={15} /> 返回用例字段
        </Button>
      </header>
      <div className="ddt-case-detail-scroll ddt-execution-inspector" aria-label="用例详情与操作">
        {error ? (
          <div className="ddt-detail-error" role="alert">
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
          <div className="case-inspector-content">
            <header className="case-inspector-header">
              <div>
                <span className="eyebrow">DDT 用例 · SR {detail.item.srNum}</span>
                <h2>{detail.item.caseId}</h2>
                <span>执行类 · {execution.definition.displayName}</span>
                <code>{execution.definition.className}</code>
              </div>
              <div className="case-inspector-header-actions">
                <span className="storage-pill">
                  DDT r{detail.item.revision} · 类 v{execution.definition.currentVersion}
                </span>
                {execution.canRun &&
                execution.executable &&
                execution.definition.enabled &&
                !execution.definition.archived ? (
                  <OpenRunDialogButton
                    ddtCase={detail.item}
                    className="button button-primary compact-button"
                  >
                    立即执行
                  </OpenRunDialogButton>
                ) : null}
              </div>
            </header>
            <p className="inline-notice">
              执行与分析历史仅属于当前 DDT 用例；源码、测试方法及类版本信息来自关联执行类。
            </p>
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
