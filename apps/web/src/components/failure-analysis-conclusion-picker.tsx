"use client";

import type { FailureAnalysisHistoryItemView } from "@autoforge/contracts";
import { ClipboardPaste, LoaderCircle, Search, X } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";

import { readApiErrorMessage } from "@/lib/client-api";

import { Button, Input } from "./ui";

export function FailureAnalysisConclusionPicker({
  projectId,
  excludedAnalysisIds,
  onClose,
  onSelect,
}: {
  projectId: string;
  excludedAnalysisIds: ReadonlySet<string>;
  onClose: () => void;
  onSelect: (item: FailureAnalysisHistoryItemView) => void;
}) {
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<FailureAnalysisHistoryItemView[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(
    async (cursor?: string, append = false, signal?: AbortSignal) => {
      setLoading(true);
      setError("");
      try {
        const parameters = new URLSearchParams({ projectId, limit: "20" });
        if (query) parameters.set("query", query);
        if (cursor) parameters.set("cursor", cursor);
        const response = await fetch(`/api/v1/failure-analysis/conclusions?${parameters}`, {
          cache: "no-store",
          ...(signal ? { signal } : {}),
        });
        if (!response.ok) {
          throw new Error((await readApiErrorMessage(response, "读取已分析用例失败。"))!);
        }
        const page = (await response.json()) as {
          items: FailureAnalysisHistoryItemView[];
          nextCursor?: string;
        };
        const availableItems = page.items.filter((item) => !excludedAnalysisIds.has(item.claim.id));
        setItems((current) => (append ? [...current, ...availableItems] : availableItems));
        setNextCursor(page.nextCursor);
      } catch (loadError) {
        if (signal?.aborted) return;
        setError(loadError instanceof Error ? loadError.message : "读取已分析用例失败。");
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [excludedAnalysisIds, projectId, query],
  );

  useEffect(() => {
    const controller = new AbortController();
    const deferredLoad = window.setTimeout(() => void load(undefined, false, controller.signal), 0);
    return () => {
      window.clearTimeout(deferredLoad);
      controller.abort();
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
        aria-label="选择已分析用例结论"
        aria-modal="true"
        className="runner-update-dialog failure-analysis-conclusion-picker"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header className="runner-update-titlebar">
          <span>
            <ClipboardPaste size={17} />
            <strong>选择已分析用例结论</strong>
            <small>可搜索项目内已完成的分析，证明材料不会被继承</small>
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
                placeholder="用例名称、类路径、失败概要、问题单"
                value={queryInput}
              />
            </span>
            <Button disabled={loading} type="submit" variant="secondary">
              搜索
            </Button>
          </form>
          {error ? <p className="form-error">{error}</p> : null}
          {!loading && items.length === 0 ? (
            <div className="failure-analysis-history-state">没有找到可继承的已完成结论。</div>
          ) : (
            <div className="failure-analysis-conclusion-results">
              {items.map((item) => (
                <article key={item.claim.id}>
                  <div>
                    <span className="analysis-status completed">
                      {conclusionCategoryLabel(item.claim.category)}
                    </span>
                    <strong>{item.claim.caseName}</strong>
                    <code>{item.claim.className}</code>
                    <small>
                      #{item.batchSequenceNumber} {item.batchName} · {item.claim.failureSummary}
                    </small>
                  </div>
                  <Button
                    aria-label={`选择并继承 ${item.claim.caseName}`}
                    onClick={() => onSelect(item)}
                    size="compact"
                    type="button"
                    variant="primary"
                  >
                    选择并继承
                  </Button>
                </article>
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

function conclusionCategoryLabel(
  category: FailureAnalysisHistoryItemView["claim"]["category"],
): string {
  if (!category) return "已完成";
  return {
    rerun_passed: "重跑通过",
    case_fixed: "用例问题已修改",
    code_issue_filed: "代码问题已提单",
  }[category];
}
