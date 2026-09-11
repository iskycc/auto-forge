"use client";

import {
  failureAnalysisCaseConclusionPageSchema,
  type FailureAnalysisCaseConclusionView,
  type FailureAnalysisHistoryItemView,
} from "@autoforge/contracts";
import { ClipboardPaste, LoaderCircle, Search, X } from "lucide-react";
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
    <div
      className="runner-update-overlay failure-analysis-confirm-overlay"
      onClick={onClose}
      role="presentation"
    >
      <section
        aria-label="本任务近 5 次批跑结论"
        aria-modal="true"
        className="runner-update-dialog failure-analysis-conclusion-picker"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header className="runner-update-titlebar">
          <span>
            <ClipboardPaste size={17} />
            <strong>本任务近 5 次批跑结论</strong>
            <small>此前最近 5 次已结束批跑 · 每个用例默认显示最近结论，可展开其他结论</small>
          </span>
          <Button aria-label="关闭结论选择弹窗" onClick={onClose} type="button">
            <X size={16} />
          </Button>
        </header>
        <div className="runner-update-body failure-analysis-conclusion-picker-body">
          <form className="failure-analysis-conclusion-search" onSubmit={submitSearch}>
            <span className="failure-analysis-search-control">
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
            <div className="failure-analysis-conclusion-load-error" role="alert">
              <p>{error}</p>
              <Button onClick={() => void load()} type="button">
                重试
              </Button>
            </div>
          ) : null}
          {!loading && !error && items.length === 0 ? (
            <div className="failure-analysis-history-state">没有找到可继承的已完成结论。</div>
          ) : (
            <div className="failure-analysis-conclusion-results">
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
                <div className="failure-analysis-history-state" role="status">
                  <LoaderCircle className="spin" size={16} /> 正在读取已分析用例…
                </div>
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
      </section>
    </div>
  );
}
