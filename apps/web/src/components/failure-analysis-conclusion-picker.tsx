"use client";
import { LoadingStateMessage } from "@/components/ui/loading-state-message";

import { EmptyState } from "@/components/ui/empty-state";

import { LoadingIcon } from "@/components/ui/loading-icon";

import { Notice } from "@/components/ui/notice";

import { Dialog } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

import {
  failureAnalysisCaseConclusionPageSchema,
  type FailureAnalysisCaseConclusionView,
  type FailureAnalysisHistoryItemView,
} from "@autoforge/contracts";
import { ClipboardPaste, Search, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import { readApiErrorMessage } from "@/lib/client-api";

import { Button, Input } from "./ui";
import { FailureAnalysisConclusionCard } from "./failure-analysis-conclusion-card";

export function FailureAnalysisConclusionPicker({
  projectId,
  batchId,
  caseDefinitionId,
  excludedAnalysisIds,
  onClose,
  onSelect,
}: {
  projectId: string;
  batchId: string;
  caseDefinitionId: string;
  excludedAnalysisIds: ReadonlySet<string>;
  onClose: () => void;
  onSelect: (item: FailureAnalysisHistoryItemView) => void;
}) {
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<FailureAnalysisCaseConclusionView[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const activeRequest = useRef<AbortController | null>(null);

  const load = useCallback(
    async (cursor?: string, append = false) => {
      activeRequest.current?.abort();
      const controller = new AbortController();
      activeRequest.current = controller;
      const { signal } = controller;
      if (!append) {
        setItems([]);
        setNextCursor(undefined);
      }
      setLoading(true);
      setError("");
      try {
        const parameters = new URLSearchParams({
          projectId,
          batchId,
          caseDefinitionId,
          limit: "20",
          scope: "task_recent_batches",
          view: "cases",
        });
        if (query) parameters.set("query", query);
        if (cursor) parameters.set("cursor", cursor);
        const response = await fetch(`/api/v1/failure-analysis/conclusions?${parameters}`, {
          cache: "no-store",
          signal,
        });
        if (!response.ok) {
          throw new Error((await readApiErrorMessage(response, "读取已分析用例失败。"))!);
        }
        const page = failureAnalysisCaseConclusionPageSchema.parse(await response.json());
        if (signal.aborted) return;
        const availableItems = page.items.filter(
          (item) => !excludedAnalysisIds.has(item.latest.claim.id),
        );
        setItems((current) => {
          if (!append) return availableItems;
          const loadedCaseIds = new Set(current.map((item) => item.latest.claim.caseDefinitionId));
          const newCases = availableItems.filter((item) => {
            const caseId = item.latest.claim.caseDefinitionId;
            if (loadedCaseIds.has(caseId)) return false;
            loadedCaseIds.add(caseId);
            return true;
          });
          return [...current, ...newCases];
        });
        setNextCursor(page.nextCursor);
      } catch (loadError) {
        if (signal.aborted) return;
        setError(loadError instanceof Error ? loadError.message : "读取已分析用例失败。");
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [batchId, caseDefinitionId, excludedAnalysisIds, projectId, query],
  );

  useEffect(() => {
    const deferredLoad = window.setTimeout(() => void load(), 0);
    return () => {
      window.clearTimeout(deferredLoad);
      activeRequest.current?.abort();
    };
  }, [load]);

  function submitSearch(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const nextQuery = queryInput.trim();
    if (nextQuery === query) void load();
    else setQuery(nextQuery);
  }

  return (
    <Dialog
      open
      title={"本任务近 5 次批跑结论"}
      onClose={onClose}
      className={cn(
        "runner-update-dialog failure-analysis-conclusion-picker",
        failureAnalysisConclusionPickerStyles["runner-update-dialog"],
        failureAnalysisConclusionPickerStyles["failure-analysis-conclusion-picker"],
      )}
      backdropClassName="runner-update-overlay failure-analysis-confirm-overlay"
    >
      <header
        className={cn(
          "runner-update-titlebar",
          failureAnalysisConclusionPickerStyles["runner-update-titlebar"],
        )}
      >
        <span>
          <ClipboardPaste size={17} />
          <strong>本任务近 5 次批跑结论</strong>
          <small>此前最近 5 次已结束批跑 · 每个用例默认显示最近结论，可展开其他结论</small>
        </span>
        <Button aria-label="关闭结论选择弹窗" onClick={onClose} type="button">
          <X size={16} />
        </Button>
      </header>
      <div
        className={cn(
          "runner-update-body failure-analysis-conclusion-picker-body",
          failureAnalysisConclusionPickerStyles["runner-update-body"],
          failureAnalysisConclusionPickerStyles["failure-analysis-conclusion-picker-body"],
        )}
      >
        <form
          className={cn(
            "failure-analysis-conclusion-search",
            failureAnalysisConclusionPickerStyles["failure-analysis-conclusion-search"],
          )}
          onSubmit={submitSearch}
        >
          <span
            className={cn(
              "failure-analysis-search-control",
              failureAnalysisConclusionPickerStyles["failure-analysis-search-control"],
            )}
          >
            <Search aria-hidden="true" size={15} />
            <Input
              aria-label="搜索已分析用例"
              autoFocus
              maxLength={200}
              onChange={(event) => setQueryInput(event.target.value)}
              placeholder="用例名称、执行类、失败概要、问题说明、问题单"
              value={queryInput}
            />
          </span>
          <Button disabled={loading} type="submit" variant="secondary">
            搜索
          </Button>
        </form>
        {error ? (
          <Notice
            tone="error"
            className={cn(
              "failure-analysis-conclusion-load-error",
              failureAnalysisConclusionPickerStyles["failure-analysis-conclusion-load-error"],
            )}
            role="alert"
          >
            <p>{error}</p>
            <Button onClick={() => void load()} type="button">
              重试
            </Button>
          </Notice>
        ) : null}
        {!loading && !error && items.length === 0 ? (
          <EmptyState
            className={cn(
              "failure-analysis-history-state",
              failureAnalysisConclusionPickerStyles["failure-analysis-history-state"],
            )}
          >
            没有找到可继承的已完成结论。
          </EmptyState>
        ) : (
          <div
            className={cn(
              "failure-analysis-conclusion-results",
              failureAnalysisConclusionPickerStyles["failure-analysis-conclusion-results"],
            )}
          >
            {items.map((group) => (
              <FailureAnalysisConclusionCard
                key={`${group.latest.claim.caseDefinitionId}:${group.latest.claim.id}`}
                group={group}
                projectId={projectId}
                batchId={batchId}
                onSelect={onSelect}
              />
            ))}
            {loading ? (
              <LoadingStateMessage
                className={cn(
                  "failure-analysis-history-state",
                  failureAnalysisConclusionPickerStyles["failure-analysis-history-state"],
                )}
                role="status"
              >
                <LoadingIcon size={16} /> 正在读取已分析用例…
              </LoadingStateMessage>
            ) : null}
          </div>
        )}
        {nextCursor ? (
          <Button
            disabled={loading}
            onClick={() => void load(nextCursor, true)}
            type="button"
            variant="secondary"
          >
            加载更多
          </Button>
        ) : null}
      </div>
    </Dialog>
  );
}

const failureAnalysisConclusionPickerStyles = {
  "failure-analysis-conclusion-load-error": "flex items-center gap-2 text-destructive",
  "failure-analysis-conclusion-picker":
    "w-[min(820px,_calc(100vw_-_56px))] max-h-[calc(100vh_-_56px)] min-w-0 [&_.runner-update-titlebar_>_span]:min-w-0 [&_.runner-update-titlebar_>_span]:flex-wrap [&_.runner-update-titlebar_small]:whitespace-normal [&_.runner-update-titlebar_small]:[overflow-wrap:anywhere]",
  "failure-analysis-conclusion-picker-body": "grid min-h-0 gap-2 min-w-0",
  "failure-analysis-conclusion-results":
    "grid min-h-0 gap-2 overflow-y-auto [overscroll-behavior:contain] min-w-0",
  "failure-analysis-conclusion-search": "grid grid-cols-[minmax(0,_1fr)_auto] gap-2",
  "failure-analysis-confirm-overlay": "z-[240]",
  "failure-analysis-history-state":
    "flex min-h-13.5 items-center justify-center gap-[7px] border border-dashed border-border rounded-lg text-muted-foreground text-sm [&.error]:[border-color:color-mix(in_srgb,_var(--destructive)_28%,_var(--border))] [&.error]:text-destructive",
  "failure-analysis-search-control":
    "relative block [&_>_svg]:absolute [&_>_svg]:z-1 [&_>_svg]:top-1/2 [&_>_svg]:left-3 [&_>_svg]:text-muted-foreground [&_>_svg]:[transform:translateY(-50%)] [&_.ui-input]:pl-9!",
  "runner-update-body": "grid gap-4 p-4.5 overflow-y-auto",
  "runner-update-dialog":
    "grid w-[min(640px,_92vw)] max-h-[86vh] [grid-template-rows:auto_minmax(0,_1fr)] overflow-hidden border border-solid border-border rounded-xl bg-card shadow-lg",

  "runner-update-titlebar":
    "flex items-center justify-between gap-3 py-3.5 px-4.5 border-b border-solid border-border [&_>_span]:flex [&_>_span]:items-center [&_>_span]:gap-2.5 [&_small]:text-muted-foreground",
} as const;
