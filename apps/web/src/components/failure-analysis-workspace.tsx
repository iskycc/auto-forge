"use client";

import {
  failureAnalysisRerunProofLookupResultSchema,
  type ClaimFailureAnalysisResult,
  type FailureAnalysisCandidate,
  type FailureAnalysisCandidatePage,
  type FailureAnalysisClaimReleaseView,
  type FailureAnalysisClaimView,
  type FailureAnalysisCompletionOrder,
  type FailureAnalysisHistoryItemView,
  type FailureAnalysisRerunProofLookupResult,
  type FailureAnalysisSort,
} from "@autoforge/contracts";
import type { FailureAnalysisCategory } from "@autoforge/domain";
import {
  AlertTriangle,
  ArrowDownAZ,
  ArrowUpAZ,
  ArrowUpDown,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Copy,
  ClipboardPaste,
  ExternalLink,
  FileCheck2,
  History,
  LoaderCircle,
  Maximize2,
  Minus,
  Plus,
  RotateCcw,
  Search,
  SearchCheck,
  SquareActivity,
  UserMinus,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { AttemptLogViewer } from "@/components/attempt-log-viewer";
import { FailureAnalysisConclusionPicker } from "@/components/failure-analysis-conclusion-picker";
import { LoadingState } from "@/components/loading-state";
import { Button, Input, Select, Textarea } from "@/components/ui";
import { readApiErrorMessage } from "@/lib/client-api";
import { copyRichTextToClipboard } from "@/lib/client-clipboard";
import { formatFailureAnalysisClipboard } from "@/lib/failure-analysis-clipboard";
import {
  readFailureAnalysisPreferences,
  resolveFailureAnalysisPreferences,
  writeFailureAnalysisPreferences,
} from "@/lib/failure-analysis-preferences";
import { formatPlatformDateTime } from "@/lib/platform-date-time";
import { useToast } from "@/components/ui-feedback";

type WorkspaceView = "claim" | "workbench";

export type FailureAnalysisWorkspaceFilters = {
  candidateQuery: string;
  candidateSort: FailureAnalysisSort;
  candidateDirection: "asc" | "desc";
  analysisQuery: string;
  analysisSort: FailureAnalysisSort;
  analysisDirection: "asc" | "desc";
  completionOrder: FailureAnalysisCompletionOrder;
  includeCompleted: boolean;
};

const CLAIM_SORT_OPTIONS: ReadonlyArray<{ value: FailureAnalysisSort; label: string }> = [
  { value: "class_path", label: "类路径" },
  { value: "case_name", label: "用例名称" },
  { value: "failure_summary", label: "失败堆栈" },
  { value: "claim_status", label: "分析状态" },
];

const CATEGORY_OPTIONS: Array<{
  value: FailureAnalysisCategory;
  label: string;
  description: string;
}> = [
  {
    value: "rerun_passed",
    label: "重跑通过",
    description: "先查找从公开日志页发起的成功重跑；查不到时必须按 Ctrl+V 粘贴通过截图。",
  },
  {
    value: "case_fixed",
    label: "用例问题已修改",
    description: "必须填写问题说明与用例修改证明，并再次确认问题确实由用例引起。",
  },
  {
    value: "code_issue_filed",
    label: "代码问题已提单",
    description: "必须填写问题说明，以及问题单链接或问题单号。",
  },
];

export function FailureAnalysisWorkspace({
  canManage,
  projectId,
  projectVersionId,
  initialCandidatePage,
  initialClaimPage,
  initialMyClaimCount,
  initialBatchId,
  initialFilters,
  initialView,
  onClaimCountDelta,
  onCompletedCountDelta,
}: {
  canManage: boolean;
  projectId: string;
  projectVersionId: string;
  initialCandidatePage: FailureAnalysisCandidatePage | null | undefined;
  initialClaimPage: { items: FailureAnalysisClaimView[]; nextCursor?: string } | undefined;
  initialMyClaimCount: number;
  initialBatchId: string;
  initialFilters: FailureAnalysisWorkspaceFilters;
  initialView: WorkspaceView;
  onClaimCountDelta: (delta: number) => void;
  onCompletedCountDelta: (delta: number) => void;
}) {
  const toast = useToast();
  const [view, setView] = useState<WorkspaceView>(initialView);
  const [candidates, setCandidates] = useState<FailureAnalysisCandidate[]>(
    initialCandidatePage?.items ?? [],
  );
  const [candidateCursor, setCandidateCursor] = useState<string | undefined>(
    initialCandidatePage?.nextCursor,
  );
  const [candidateCursorHistory, setCandidateCursorHistory] = useState<Array<string | undefined>>(
    [],
  );
  const [candidatePageCursor, setCandidatePageCursor] = useState<string>();
  const [claims, setClaims] = useState<FailureAnalysisClaimView[]>(initialClaimPage?.items ?? []);
  const [myClaimCount, setMyClaimCount] = useState(initialMyClaimCount);
  const [claimsCursor, setClaimsCursor] = useState<string | undefined>(
    initialClaimPage?.nextCursor,
  );
  const [claimsPageCursor, setClaimsPageCursor] = useState<string>();
  const [claimsCursorHistory, setClaimsCursorHistory] = useState<Array<string | undefined>>([]);
  const [selectedRunIds, setSelectedRunIds] = useState<Set<string>>(() => new Set());
  const [selectedAnalysisIds, setSelectedAnalysisIds] = useState<Set<string>>(() => new Set());
  const [dialogClaims, setDialogClaims] = useState<FailureAnalysisClaimView[]>();
  const [releaseDialogClaim, setReleaseDialogClaim] = useState<FailureAnalysisClaimView>();
  const [sort, setSort] = useState<FailureAnalysisSort>(initialFilters.candidateSort);
  const [direction, setDirection] = useState<"asc" | "desc">(initialFilters.candidateDirection);
  const [claimSort, setClaimSort] = useState<FailureAnalysisSort>(initialFilters.analysisSort);
  const [claimDirection, setClaimDirection] = useState<"asc" | "desc">(
    initialFilters.analysisDirection,
  );
  const [completionOrder, setCompletionOrder] = useState<FailureAnalysisCompletionOrder>(
    initialFilters.completionOrder,
  );
  const [includeCompleted, setIncludeCompleted] = useState(initialFilters.includeCompleted);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [queryInput, setQueryInput] = useState(initialFilters.candidateQuery);
  const [query, setQuery] = useState(initialFilters.candidateQuery);
  const [analysisQueryInput, setAnalysisQueryInput] = useState(initialFilters.analysisQuery);
  const [analysisQuery, setAnalysisQuery] = useState(initialFilters.analysisQuery);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [loadingClaims, setLoadingClaims] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const candidateRequestSequence = useRef(0);
  const claimsRequestSequence = useRef(0);
  const skipInitialCandidateLoad = useRef(
    initialView === "claim" && initialCandidatePage !== undefined,
  );
  const skipInitialClaimsLoad = useRef(
    initialView === "workbench" && initialClaimPage !== undefined,
  );

  useEffect(() => {
    const restorePreferences = window.setTimeout(() => {
      const resolved = resolveFailureAnalysisPreferences(
        {
          candidateSort: initialFilters.candidateSort,
          candidateDirection: initialFilters.candidateDirection,
          analysisSort: initialFilters.analysisSort,
          analysisDirection: initialFilters.analysisDirection,
          completionOrder: initialFilters.completionOrder,
          includeCompleted: initialFilters.includeCompleted,
        },
        readRememberedFailureAnalysisPreferences(),
        window.location.search,
      );
      setSort(resolved.candidateSort);
      setDirection(resolved.candidateDirection);
      setClaimSort(resolved.analysisSort);
      setClaimDirection(resolved.analysisDirection);
      setCompletionOrder(resolved.completionOrder);
      setIncludeCompleted(resolved.includeCompleted);
      setPreferencesReady(true);
    }, 0);
    return () => window.clearTimeout(restorePreferences);
  }, [initialFilters]);

  useEffect(() => {
    if (!preferencesReady) return;
    persistFailureAnalysisPreferences({
      candidateSort: sort,
      candidateDirection: direction,
      analysisSort: claimSort,
      analysisDirection: claimDirection,
      completionOrder,
      includeCompleted,
    });
  }, [
    claimDirection,
    claimSort,
    completionOrder,
    direction,
    includeCompleted,
    preferencesReady,
    sort,
  ]);

  const loadCandidates = useCallback(
    async (cursor?: string, signal?: AbortSignal) => {
      const requestSequence = ++candidateRequestSequence.current;
      setLoadingCandidates(true);
      setError("");
      try {
        const parameters = new URLSearchParams({
          projectId,
          projectVersionId,
          batchId: initialBatchId,
          sort,
          direction,
          limit: "50",
        });
        if (query) parameters.set("query", query);
        if (cursor) parameters.set("cursor", cursor);
        const response = await fetch(`/api/v1/failure-analysis/candidates?${parameters}`, {
          cache: "no-store",
          ...(signal ? { signal } : {}),
        });
        if (!response.ok)
          throw new Error((await readApiErrorMessage(response, "读取失败用例失败。"))!);
        const page = (await response.json()) as FailureAnalysisCandidatePage | null;
        if (requestSequence !== candidateRequestSequence.current) return;
        setCandidates(page?.items ?? []);
        setCandidateCursor(page?.nextCursor);
        setSelectedRunIds(new Set());
      } catch (loadError) {
        if (signal?.aborted || requestSequence !== candidateRequestSequence.current) return;
        setError(loadError instanceof Error ? loadError.message : "读取失败用例失败。");
      } finally {
        if (requestSequence === candidateRequestSequence.current) setLoadingCandidates(false);
      }
    },
    [direction, initialBatchId, projectId, projectVersionId, query, sort],
  );

  const loadClaims = useCallback(
    async (cursor?: string, signal?: AbortSignal) => {
      const requestSequence = ++claimsRequestSequence.current;
      setLoadingClaims(true);
      setError("");
      try {
        const parameters = new URLSearchParams({
          projectId,
          projectVersionId,
          batchId: initialBatchId,
          sort: claimSort,
          direction: claimDirection,
          completionOrder,
          includeCompleted: String(includeCompleted),
          limit: "50",
        });
        if (analysisQuery) parameters.set("query", analysisQuery);
        if (cursor) parameters.set("cursor", cursor);
        const response = await fetch(`/api/v1/failure-analysis/claims?${parameters}`, {
          cache: "no-store",
          ...(signal ? { signal } : {}),
        });
        if (!response.ok)
          throw new Error((await readApiErrorMessage(response, "读取已认领用例失败。"))!);
        const page = (await response.json()) as {
          items: FailureAnalysisClaimView[];
          nextCursor?: string;
        };
        if (requestSequence !== claimsRequestSequence.current) return;
        setClaims(page.items);
        setClaimsCursor(page.nextCursor);
        setSelectedAnalysisIds(new Set());
      } catch (loadError) {
        if (signal?.aborted || requestSequence !== claimsRequestSequence.current) return;
        setError(loadError instanceof Error ? loadError.message : "读取已认领用例失败。");
      } finally {
        if (requestSequence === claimsRequestSequence.current) setLoadingClaims(false);
      }
    },
    [
      claimDirection,
      claimSort,
      completionOrder,
      includeCompleted,
      analysisQuery,
      initialBatchId,
      projectId,
      projectVersionId,
    ],
  );

  useEffect(() => {
    if (view !== "claim") return;
    if (skipInitialCandidateLoad.current) {
      skipInitialCandidateLoad.current = false;
      return;
    }
    const controller = new AbortController();
    const deferredLoad = window.setTimeout(
      () => void loadCandidates(undefined, controller.signal),
      0,
    );
    return () => {
      window.clearTimeout(deferredLoad);
      controller.abort();
    };
  }, [loadCandidates, view]);

  useEffect(() => {
    if (view !== "workbench") return;
    if (skipInitialClaimsLoad.current) {
      skipInitialClaimsLoad.current = false;
      return;
    }
    const controller = new AbortController();
    const deferredLoad = window.setTimeout(() => void loadClaims(undefined, controller.signal), 0);
    return () => {
      window.clearTimeout(deferredLoad);
      controller.abort();
    };
  }, [loadClaims, view]);

  useEffect(() => {
    if (!preferencesReady) return;
    const parameters = new URLSearchParams({ view });
    if (query) parameters.set("candidateQuery", query);
    if (sort !== "class_path") parameters.set("candidateSort", sort);
    if (direction !== "asc") parameters.set("candidateDirection", direction);
    if (analysisQuery) parameters.set("analysisQuery", analysisQuery);
    if (claimSort !== "class_path") parameters.set("analysisSort", claimSort);
    if (claimDirection !== "asc") parameters.set("analysisDirection", claimDirection);
    if (completionOrder !== "pending_first") parameters.set("completionOrder", completionOrder);
    if (!includeCompleted) parameters.set("includeCompleted", "false");
    window.history.replaceState(
      null,
      "",
      `/case-analysis/${encodeURIComponent(initialBatchId)}?${parameters}`,
    );
  }, [
    analysisQuery,
    claimDirection,
    claimSort,
    completionOrder,
    direction,
    includeCompleted,
    initialBatchId,
    query,
    sort,
    view,
    preferencesReady,
  ]);

  const availableItems = useMemo(
    () => candidates.filter((candidate) => !candidate.claim),
    [candidates],
  );
  const selectableClaims = useMemo(
    () => claims.filter((claim) => claim.status !== "completed"),
    [claims],
  );
  const allAvailableSelected =
    availableItems.length > 0 &&
    availableItems.every((candidate) => selectedRunIds.has(candidate.executionRunId));
  const allClaimsSelected =
    selectableClaims.length > 0 &&
    selectableClaims.every((claim) => selectedAnalysisIds.has(claim.id));
  const claimGroups = useMemo(() => {
    const pending = claims.filter((claim) => claim.status !== "completed");
    const completed = claims.filter((claim) => claim.status === "completed");
    return completionOrder === "pending_first"
      ? [
          { key: "pending", label: "未完成分析", claims: pending },
          { key: "completed", label: "已完成分析", claims: completed },
        ]
      : [
          { key: "completed", label: "已完成分析", claims: completed },
          { key: "pending", label: "未完成分析", claims: pending },
        ];
  }, [claims, completionOrder]);
  const modalOpen = Boolean(dialogClaims?.length || releaseDialogClaim);

  useEffect(() => {
    if (!modalOpen) return;
    const previousOverflow = document.body.style.overflow;
    const previousOverscrollBehavior = document.body.style.overscrollBehavior;
    document.body.style.overflow = "hidden";
    document.body.style.overscrollBehavior = "none";
    return () => {
      document.body.style.overflow = previousOverflow;
      document.body.style.overscrollBehavior = previousOverscrollBehavior;
    };
  }, [modalOpen]);

  function changeView(nextView: WorkspaceView): void {
    setView(nextView);
  }

  function changeSort(nextSort: FailureAnalysisSort): void {
    setCandidateCursorHistory([]);
    setCandidatePageCursor(undefined);
    if (sort === nextSort) setDirection((current) => (current === "asc" ? "desc" : "asc"));
    else {
      setSort(nextSort);
      setDirection("asc");
    }
  }

  function changeClaimSort(nextSort: FailureAnalysisSort): void {
    if (claimSort === nextSort) return;
    setClaimsCursorHistory([]);
    setClaimsPageCursor(undefined);
    setClaimSort(nextSort);
    setClaimDirection("asc");
  }

  function toggleClaimDirection(): void {
    setClaimsCursorHistory([]);
    setClaimsPageCursor(undefined);
    setClaimDirection((current) => (current === "asc" ? "desc" : "asc"));
  }

  function changeCompletionOrder(nextOrder: FailureAnalysisCompletionOrder): void {
    setClaimsCursorHistory([]);
    setClaimsPageCursor(undefined);
    setCompletionOrder(nextOrder);
  }

  function changeIncludeCompleted(nextIncludeCompleted: boolean): void {
    setClaimsCursorHistory([]);
    setClaimsPageCursor(undefined);
    setIncludeCompleted(nextIncludeCompleted);
  }

  function toggleSelection(setter: typeof setSelectedRunIds, id: string, checked: boolean): void {
    setter((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function claimSelected(): Promise<void> {
    if (!canManage || selectedRunIds.size === 0 || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/v1/failure-analysis/claims", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId,
          projectVersionId,
          batchId: initialBatchId,
          executionRunIds: [...selectedRunIds],
        }),
      });
      if (!response.ok)
        throw new Error((await readApiErrorMessage(response, "认领失败用例失败。"))!);
      const result = (await response.json()) as ClaimFailureAnalysisResult;
      const claimMessage =
        result.conflicts.length > 0
          ? `已认领 ${result.claimed.length} 个用例，另有 ${result.conflicts.length} 个已被其他用户认领。`
          : `已认领 ${result.claimed.length} 个用例，可以开始分析。`;
      if (result.conflicts.length > 0) toast.warning(claimMessage);
      else toast.success(claimMessage);
      setSelectedRunIds(new Set());
      setMyClaimCount((current) => current + result.claimed.length);
      setView("workbench");
      setClaimsCursorHistory([]);
      setClaimsPageCursor(undefined);
      onClaimCountDelta(result.claimed.length);
    } catch (claimError) {
      setError(claimError instanceof Error ? claimError.message : "认领失败用例失败。");
    } finally {
      setSubmitting(false);
    }
  }

  async function moveCandidatePage(nextCursor: string | undefined, forward: boolean) {
    setCandidateCursorHistory((history) =>
      forward ? [...history, candidatePageCursor] : history.slice(0, -1),
    );
    setCandidatePageCursor(nextCursor);
    await loadCandidates(nextCursor);
  }

  async function moveClaimsPage(nextCursor: string | undefined, forward: boolean) {
    setClaimsCursorHistory((history) =>
      forward ? [...history, claimsPageCursor] : history.slice(0, -1),
    );
    setClaimsPageCursor(nextCursor);
    await loadClaims(nextCursor);
  }

  function submitSearch(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setCandidateCursorHistory([]);
    setCandidatePageCursor(undefined);
    const nextQuery = queryInput.trim();
    if (nextQuery === query) void loadCandidates();
    else setQuery(nextQuery);
  }

  function submitAnalysisSearch(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setClaimsCursorHistory([]);
    setClaimsPageCursor(undefined);
    const nextQuery = analysisQueryInput.trim();
    if (nextQuery === analysisQuery) void loadClaims();
    else setAnalysisQuery(nextQuery);
  }

  function clearCandidateSearch(): void {
    setCandidateCursorHistory([]);
    setCandidatePageCursor(undefined);
    setQueryInput("");
    setQuery("");
  }

  function clearAnalysisSearch(): void {
    setClaimsCursorHistory([]);
    setClaimsPageCursor(undefined);
    setAnalysisQueryInput("");
    setAnalysisQuery("");
  }

  function applyCompletedClaims(updatedClaims: FailureAnalysisClaimView[]): void {
    const updates = new Map(updatedClaims.map((claim) => [claim.id, claim]));
    setClaims((current) => current.map((claim) => updates.get(claim.id) ?? claim));
    setCandidates((current) =>
      current.map((candidate) => {
        const updated = candidate.claim ? updates.get(candidate.claim.id) : undefined;
        if (!updated) return candidate;
        return {
          ...candidate,
          claim: {
            id: updated.id,
            status: updated.status,
            claimantId: updated.claimantId,
            claimantUsername: updated.claimantUsername,
            claimantDisplayName: updated.claimantDisplayName,
            claimedAt: updated.claimedAt,
            updatedAt: updated.updatedAt,
            ...(updated.category ? { category: updated.category } : {}),
            ...(updated.analysisStartedAt ? { analysisStartedAt: updated.analysisStartedAt } : {}),
            ...(updated.completedAt ? { completedAt: updated.completedAt } : {}),
          },
        };
      }),
    );
    setDialogClaims(undefined);
    setSelectedAnalysisIds(new Set());
    onCompletedCountDelta(
      updatedClaims.filter((updated) => {
        const previous = claims.find((claim) => claim.id === updated.id);
        return previous?.status !== "completed" && updated.status === "completed";
      }).length,
    );
    setClaimsCursorHistory([]);
    setClaimsPageCursor(undefined);
    void loadClaims();
    toast.success(`已完成 ${updatedClaims.length} 个用例的分析并永久保存。`);
  }

  function applyReleasedClaim(released: FailureAnalysisClaimReleaseView): void {
    setClaims((current) => current.filter((claim) => claim.id !== released.analysisId));
    setCandidates((current) =>
      current.map((candidate) => {
        if (candidate.claim?.id !== released.analysisId) return candidate;
        const availableCandidate: FailureAnalysisCandidate = { ...candidate };
        delete availableCandidate.claim;
        return availableCandidate;
      }),
    );
    setSelectedAnalysisIds((current) => {
      const next = new Set(current);
      next.delete(released.analysisId);
      return next;
    });
    setMyClaimCount((current) => Math.max(0, current - 1));
    setReleaseDialogClaim(undefined);
    onClaimCountDelta(-1);
    toast.success("已取消认领，该用例已回到待认领列表。");
  }

  return (
    <>
      <section
        aria-hidden={modalOpen ? true : undefined}
        className="content-card failure-analysis-shell"
        inert={modalOpen ? true : undefined}
      >
        <div className="failure-analysis-tabs" role="tablist" aria-label="用例分析步骤">
          <Button
            aria-selected={view === "claim"}
            className={view === "claim" ? "is-active" : ""}
            onClick={() => changeView("claim")}
            role="tab"
            type="button"
          >
            认领失败用例
          </Button>
          <Button
            aria-selected={view === "workbench"}
            className={view === "workbench" ? "is-active" : ""}
            onClick={() => changeView("workbench")}
            role="tab"
            type="button"
          >
            我的分析 <span>{myClaimCount}</span>
          </Button>
        </div>

        {error ? <p className="form-error">{error}</p> : null}

        {view === "claim" ? (
          <div className="failure-analysis-claim-view" role="tabpanel">
            <form className="failure-analysis-filter" onSubmit={submitSearch}>
              <label>
                类路径、用例名称或失败堆栈
                <span className="failure-analysis-search-control">
                  <Search aria-hidden="true" size={15} />
                  <Input
                    aria-label="搜索待认领用例"
                    maxLength={240}
                    onChange={(event) => setQueryInput(event.target.value)}
                    placeholder="输入关键字筛选"
                    value={queryInput}
                  />
                </span>
              </label>
              <Button type="submit" variant="secondary">
                筛选
              </Button>
            </form>
            {loadingCandidates ? (
              <LoadingState
                label="正在读取最终失败用例"
                description="正在按当前筛选与排序条件整理可认领用例。"
              />
            ) : candidates.length === 0 ? (
              <div className="failure-analysis-empty">
                <CheckCircle2 size={24} />
                <strong>
                  {query ? "没有匹配的待认领用例" : "当前任务没有可认领的最终失败用例"}
                </strong>
                {query ? (
                  <Button onClick={clearCandidateSearch} type="button" variant="secondary">
                    清除搜索条件
                  </Button>
                ) : (
                  <span>只统计任务最后一轮仍然失败的用例。</span>
                )}
              </div>
            ) : (
              <CandidateTable
                allAvailableSelected={allAvailableSelected}
                canManage={canManage}
                candidates={candidates}
                direction={direction}
                onSelectAll={(checked) =>
                  setSelectedRunIds(
                    checked
                      ? new Set(availableItems.map((item) => item.executionRunId))
                      : new Set(),
                  )
                }
                onSort={changeSort}
                onToggle={(id, checked) => toggleSelection(setSelectedRunIds, id, checked)}
                selectedRunIds={selectedRunIds}
                sort={sort}
              />
            )}
            <Pagination
              count={candidates.length}
              currentHistory={candidateCursorHistory}
              loading={loadingCandidates}
              nextCursor={candidateCursor}
              onMove={moveCandidatePage}
              unit="失败用例"
            />
          </div>
        ) : (
          <div className="failure-analysis-workbench" role="tabpanel">
            <div className="failure-analysis-workbench-heading">
              <div>
                <span className="eyebrow">My analysis</span>
                <h2>我的分析队列</h2>
                <p>勾选多个用例可批量填写相同分析结论；所有状态与证明均由服务端持久化。</p>
              </div>
              <div className="failure-analysis-workbench-actions">
                <label className="failure-analysis-order-control">
                  <span>排列方式</span>
                  <Select
                    aria-label="我的分析排序字段"
                    disabled={loadingClaims}
                    onChange={(event) => changeClaimSort(event.target.value as FailureAnalysisSort)}
                    value={claimSort}
                  >
                    {CLAIM_SORT_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="failure-analysis-order-control">
                  <span>状态分组</span>
                  <Select
                    aria-label="分析完成状态分组"
                    disabled={loadingClaims}
                    onChange={(event) =>
                      changeCompletionOrder(event.target.value as FailureAnalysisCompletionOrder)
                    }
                    value={completionOrder}
                  >
                    <option value="pending_first">未完成在前</option>
                    <option value="completed_first">已完成在前</option>
                  </Select>
                </label>
                <label className="failure-analysis-completed-filter">
                  <Input
                    checked={includeCompleted}
                    disabled={loadingClaims}
                    onChange={(event) => changeIncludeCompleted(event.target.checked)}
                    type="checkbox"
                  />
                  <span>显示已完成分析</span>
                </label>
                <Button
                  aria-label={`当前${claimDirection === "asc" ? "升序" : "降序"}，点击切换为${claimDirection === "asc" ? "降序" : "升序"}`}
                  disabled={loadingClaims}
                  onClick={toggleClaimDirection}
                  size="compact"
                  title={claimDirection === "asc" ? "切换为降序" : "切换为升序"}
                  type="button"
                  variant="secondary"
                >
                  {claimDirection === "asc" ? (
                    <ArrowUpAZ aria-hidden="true" size={15} />
                  ) : (
                    <ArrowDownAZ aria-hidden="true" size={15} />
                  )}
                  {claimDirection === "asc" ? "升序" : "降序"}
                </Button>
                <Button
                  onClick={() => changeView("claim")}
                  size="compact"
                  type="button"
                  variant="secondary"
                >
                  返回继续认领
                </Button>
              </div>
            </div>
            <form className="failure-analysis-filter" onSubmit={submitAnalysisSearch}>
              <label>
                用例名称、类路径或失败堆栈
                <span className="failure-analysis-search-control">
                  <Search aria-hidden="true" size={15} />
                  <Input
                    aria-label="搜索我的分析"
                    maxLength={240}
                    onChange={(event) => setAnalysisQueryInput(event.target.value)}
                    placeholder="输入关键字搜索已认领用例"
                    value={analysisQueryInput}
                  />
                </span>
              </label>
              <Button type="submit" variant="secondary">
                搜索
              </Button>
            </form>
            {loadingClaims ? (
              <LoadingState
                label="正在读取分析队列"
                description="正在恢复你的认领状态、分析结论和证明材料。"
              />
            ) : claims.length === 0 ? (
              <div className="failure-analysis-empty">
                <ClipboardCheck size={25} />
                <strong>
                  {analysisQuery
                    ? "没有匹配的已认领用例"
                    : includeCompleted
                      ? "当前任务还没有你认领的用例"
                      : "当前没有未完成的分析"}
                </strong>
                {analysisQuery ? (
                  <Button onClick={clearAnalysisSearch} type="button" variant="secondary">
                    清除搜索条件
                  </Button>
                ) : includeCompleted ? (
                  <Button onClick={() => changeView("claim")} type="button" variant="primary">
                    去认领失败用例
                  </Button>
                ) : (
                  <Button
                    onClick={() => changeIncludeCompleted(true)}
                    type="button"
                    variant="secondary"
                  >
                    显示已完成分析
                  </Button>
                )}
              </div>
            ) : (
              <>
                <label className="failure-analysis-select-all">
                  <Input
                    checked={allClaimsSelected}
                    disabled={!canManage || selectableClaims.length === 0}
                    onChange={(event) =>
                      setSelectedAnalysisIds(
                        event.target.checked
                          ? new Set(selectableClaims.map((claim) => claim.id))
                          : new Set(),
                      )
                    }
                    type="checkbox"
                  />
                  <span>
                    选择本页全部未完成分析
                    <small>{selectableClaims.length} 个可分析用例</small>
                  </span>
                </label>
                <div className="failure-analysis-grouped-list">
                  {claimGroups.map((group) =>
                    group.claims.length > 0 ? (
                      <section className="failure-analysis-claim-group" key={group.key}>
                        <h3>
                          {group.label} <span>本页 {group.claims.length}</span>
                        </h3>
                        <div className="failure-analysis-card-list">
                          {group.claims.map((claim) => (
                            <article className="failure-analysis-card" key={claim.id}>
                              <Input
                                aria-label={`选择分析 ${claim.caseName}`}
                                checked={selectedAnalysisIds.has(claim.id)}
                                disabled={!canManage || claim.status === "completed"}
                                onChange={(event) =>
                                  toggleSelection(
                                    setSelectedAnalysisIds,
                                    claim.id,
                                    event.target.checked,
                                  )
                                }
                                type="checkbox"
                              />
                              <div className="failure-analysis-card-main">
                                <div className="failure-analysis-card-title">
                                  <h3>{claim.caseName}</h3>
                                  <span className={`analysis-status ${claim.status}`}>
                                    {statusLabel(claim.status)}
                                  </span>
                                </div>
                                <code>{claim.className}</code>
                                <p title={claim.failureSummary}>{claim.failureSummary}</p>
                              </div>
                              <dl>
                                <div>
                                  <dt>认领时间</dt>
                                  <dd>{formatPlatformDateTime(claim.claimedAt)}</dd>
                                </div>
                                <div>
                                  <dt>分析结论</dt>
                                  <dd>{categoryLabel(claim.category) ?? "尚未选择"}</dd>
                                </div>
                              </dl>
                              <div className="failure-analysis-card-actions">
                                <Button
                                  disabled={!canManage}
                                  onClick={() => setDialogClaims([claim])}
                                  size="compact"
                                  type="button"
                                  variant="secondary"
                                >
                                  {claim.status === "completed" ? "查看分析详情" : "开始分析"}
                                </Button>
                                {claim.status !== "completed" ? (
                                  <Button
                                    className="failure-analysis-release-trigger"
                                    disabled={!canManage}
                                    onClick={() => setReleaseDialogClaim(claim)}
                                    size="compact"
                                    type="button"
                                    variant="ghost"
                                  >
                                    <UserMinus aria-hidden="true" size={14} /> 取消认领
                                  </Button>
                                ) : null}
                              </div>
                            </article>
                          ))}
                        </div>
                      </section>
                    ) : null,
                  )}
                </div>
              </>
            )}
            <Pagination
              count={claims.length}
              currentHistory={claimsCursorHistory}
              loading={loadingClaims}
              nextCursor={claimsCursor}
              onMove={moveClaimsPage}
              unit="分析任务"
            />
          </div>
        )}
      </section>

      {canManage && !modalOpen && view === "claim" && selectedRunIds.size > 0 ? (
        <FloatingAction
          count={selectedRunIds.size}
          label="认领并进入分析"
          loading={submitting}
          onClick={() => void claimSelected()}
        />
      ) : null}
      {canManage && !modalOpen && view === "workbench" && selectedAnalysisIds.size > 0 ? (
        <FloatingAction
          count={selectedAnalysisIds.size}
          label="批量分析"
          loading={false}
          onClick={() =>
            setDialogClaims(claims.filter((claim) => selectedAnalysisIds.has(claim.id)))
          }
        />
      ) : null}

      {dialogClaims?.length ? (
        <CompleteAnalysisDialog
          claims={dialogClaims}
          onClose={() => setDialogClaims(undefined)}
          onCompleted={applyCompletedClaims}
          projectId={projectId}
          readOnly={dialogClaims.every((claim) => claim.status === "completed")}
        />
      ) : null}
      {releaseDialogClaim ? (
        <ReleaseClaimDialog
          claim={releaseDialogClaim}
          onClose={() => setReleaseDialogClaim(undefined)}
          onReleased={applyReleasedClaim}
          projectId={projectId}
        />
      ) : null}
    </>
  );
}

function ReleaseClaimDialog({
  claim,
  projectId,
  onClose,
  onReleased,
}: {
  claim: FailureAnalysisClaimView;
  projectId: string;
  onClose: () => void;
  onReleased: (released: FailureAnalysisClaimReleaseView) => void;
}) {
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const normalizedReason = reason.trim();

  async function releaseClaim(): Promise<void> {
    if (!normalizedReason || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch(
        `/api/v1/failure-analysis/claims/${encodeURIComponent(claim.id)}/release`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId, reason: normalizedReason }),
        },
      );
      if (!response.ok) {
        throw new Error(
          (await readApiErrorMessage(response, "取消认领失败，请确认该用例仍由当前账号持有。"))!,
        );
      }
      onReleased((await response.json()) as FailureAnalysisClaimReleaseView);
    } catch (releaseError) {
      setError(releaseError instanceof Error ? releaseError.message : "取消认领失败。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="runner-update-overlay failure-analysis-confirm-overlay"
      onClick={onClose}
      role="presentation"
    >
      <section
        aria-label={`取消认领 ${claim.caseName}`}
        aria-modal="true"
        className="runner-update-dialog failure-analysis-release-dialog"
        onClick={(event) => event.stopPropagation()}
        role="alertdialog"
      >
        <header>
          <span className="failure-analysis-release-icon" aria-hidden="true">
            <UserMinus size={21} />
          </span>
          <div>
            <strong>确认取消认领？</strong>
            <p>“{claim.caseName}”将重新回到待认领列表，其他分析人员可以立即认领该用例。</p>
          </div>
        </header>
        <label className="failure-analysis-field">
          <span>
            取消原因 <strong>*</strong>
          </span>
          <Textarea
            autoFocus
            maxLength={1_000}
            onChange={(event) => setReason(event.target.value)}
            placeholder="请说明误领、任务调整或交接原因"
            rows={4}
            value={reason}
          />
          <small>{reason.length}/1000</small>
        </label>
        <p className="failure-analysis-release-note">
          取消原因会永久记录；当前未提交的分析内容不会带给下一位认领人。
        </p>
        {error ? <p className="form-error">{error}</p> : null}
        <div className="dialog-actions">
          <Button disabled={submitting} onClick={onClose} type="button" variant="secondary">
            返回
          </Button>
          <Button
            className="failure-analysis-confirm-action"
            disabled={!normalizedReason || submitting}
            onClick={() => void releaseClaim()}
            type="button"
            variant="danger"
          >
            {submitting ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <UserMinus aria-hidden="true" size={16} />
            )}
            确认取消认领
          </Button>
        </div>
      </section>
    </div>
  );
}

function CandidateTable({
  candidates,
  canManage,
  sort,
  direction,
  selectedRunIds,
  allAvailableSelected,
  onSort,
  onToggle,
  onSelectAll,
}: {
  candidates: FailureAnalysisCandidate[];
  canManage: boolean;
  sort: FailureAnalysisSort;
  direction: "asc" | "desc";
  selectedRunIds: Set<string>;
  allAvailableSelected: boolean;
  onSort: (sort: FailureAnalysisSort) => void;
  onToggle: (id: string, checked: boolean) => void;
  onSelectAll: (checked: boolean) => void;
}) {
  return (
    <div className="failure-analysis-table-wrap">
      <table className="failure-analysis-table">
        <colgroup>
          <col className="failure-analysis-select-column" />
          <col className="failure-analysis-name-column" />
          <col className="failure-analysis-path-column" />
          <col className="failure-analysis-stack-column" />
          <col className="failure-analysis-status-column" />
        </colgroup>
        <thead>
          <tr>
            <th>
              <Input
                aria-label="选择本页全部未认领用例"
                checked={allAvailableSelected}
                disabled={!canManage || candidates.every((candidate) => Boolean(candidate.claim))}
                onChange={(event) => onSelectAll(event.target.checked)}
                type="checkbox"
              />
            </th>
            <SortableHeading
              active={sort === "case_name"}
              direction={direction}
              label="用例"
              onClick={() => onSort("case_name")}
            />
            <SortableHeading
              active={sort === "class_path"}
              direction={direction}
              label="类路径"
              onClick={() => onSort("class_path")}
            />
            <SortableHeading
              active={sort === "failure_summary"}
              direction={direction}
              label="失败堆栈"
              onClick={() => onSort("failure_summary")}
            />
            <SortableHeading
              active={sort === "claim_status"}
              direction={direction}
              label="认领状态"
              onClick={() => onSort("claim_status")}
            />
          </tr>
        </thead>
        <tbody>
          {candidates.map((candidate) => (
            <tr key={candidate.executionRunId}>
              <td>
                <Input
                  aria-label={`认领 ${candidate.caseName}`}
                  checked={selectedRunIds.has(candidate.executionRunId)}
                  disabled={!canManage || Boolean(candidate.claim)}
                  onChange={(event) => onToggle(candidate.executionRunId, event.target.checked)}
                  type="checkbox"
                />
              </td>
              <td>
                <strong className="failure-analysis-case-name" title={candidate.caseName}>
                  {candidate.caseName}
                </strong>
                <small>最终失败 · 第 {candidate.attemptNumber} 次尝试</small>
              </td>
              <td>
                <code className="failure-analysis-class-path" title={candidate.className}>
                  {candidate.className}
                </code>
              </td>
              <td>
                <span className="failure-analysis-stack" title={candidate.failureSummary}>
                  {candidate.failureSummary}
                </span>
              </td>
              <td>
                {candidate.claim ? (
                  <span className={`analysis-status ${candidate.claim.status}`}>
                    {statusLabel(candidate.claim.status)}
                    <small>{candidate.claim.claimantDisplayName}</small>
                  </span>
                ) : (
                  <span className="analysis-status available">待认领</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Pagination({
  count,
  currentHistory,
  loading,
  nextCursor,
  onMove,
  unit,
}: {
  count: number;
  currentHistory: Array<string | undefined>;
  loading: boolean;
  nextCursor: string | undefined;
  onMove: (cursor: string | undefined, forward: boolean) => Promise<void>;
  unit: string;
}) {
  return (
    <div className="failure-analysis-pagination">
      <Button
        disabled={currentHistory.length === 0 || loading}
        onClick={() => void onMove(currentHistory.at(-1), false)}
        type="button"
        variant="secondary"
      >
        <ChevronLeft size={15} /> 上一页
      </Button>
      <span>
        本页 {count} 个{unit}
      </span>
      <Button
        disabled={!nextCursor || loading}
        onClick={() => void onMove(nextCursor, true)}
        type="button"
        variant="secondary"
      >
        下一页 <ChevronRight size={15} />
      </Button>
    </div>
  );
}

function FloatingAction({
  count,
  label,
  loading,
  onClick,
}: {
  count: number;
  label: string;
  loading: boolean;
  onClick: () => void;
}) {
  return (
    <div className="failure-analysis-floating-action">
      <span>已选择 {count} 个用例</span>
      <Button disabled={loading} onClick={onClick} type="button" variant="primary">
        {loading ? <LoaderCircle className="spin" size={16} /> : <ClipboardCheck size={16} />}
        {label}
      </Button>
    </div>
  );
}

function SortableHeading({
  label,
  active,
  direction,
  onClick,
}: {
  label: string;
  active: boolean;
  direction: "asc" | "desc";
  onClick: () => void;
}) {
  return (
    <th>
      <Button
        className={active ? "is-active" : ""}
        onClick={onClick}
        size="compact"
        type="button"
        variant="ghost"
      >
        {label}
        {active ? (
          direction === "desc" ? (
            <ArrowDownAZ size={14} />
          ) : (
            <ArrowUpAZ size={14} />
          )
        ) : (
          <ArrowUpDown className="failure-analysis-sort-idle" size={13} />
        )}
      </Button>
    </th>
  );
}

function CompleteAnalysisDialog({
  claims,
  projectId,
  readOnly,
  onClose,
  onCompleted,
}: {
  claims: FailureAnalysisClaimView[];
  projectId: string;
  readOnly: boolean;
  onClose: () => void;
  onCompleted: (claims: FailureAnalysisClaimView[]) => void;
}) {
  const toast = useToast();
  const initial = claims.length === 1 ? claims[0] : undefined;
  const [category, setCategory] = useState<FailureAnalysisCategory | undefined>(initial?.category);
  const [issueDescription, setIssueDescription] = useState(initial?.issueDescription ?? "");
  const [caseFixEvidence, setCaseFixEvidence] = useState(initial?.caseFixEvidence ?? "");
  const [ticketReference, setTicketReference] = useState(initial?.ticketReference ?? "");
  const [remark, setRemark] = useState(initial?.remark ?? "");
  const [uploadedClaims, setUploadedClaims] = useState(claims);
  const [logClaim, setLogClaim] = useState<FailureAnalysisClaimView>();
  const [previewClaim, setPreviewClaim] = useState<FailureAnalysisClaimView>();
  const [imageZoomPercent, setImageZoomPercent] = useState(100);
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [lookingUpRerunProofs, setLookingUpRerunProofs] = useState(false);
  const [rerunProofLookup, setRerunProofLookup] = useState<FailureAnalysisRerunProofLookupResult>();
  const [showCaseConfirmation, setShowCaseConfirmation] = useState(false);
  const [historyItems, setHistoryItems] = useState<FailureAnalysisHistoryItemView[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState("");
  const [showConclusionPicker, setShowConclusionPicker] = useState(false);
  const [inheritanceCandidate, setInheritanceCandidate] =
    useState<FailureAnalysisHistoryItemView>();
  const [copying, setCopying] = useState(false);
  const [error, setError] = useState("");
  const imageCloseButtonRef = useRef<HTMLButtonElement>(null);
  const imagePreviewTriggerRef = useRef<HTMLButtonElement>(null);
  const screenshotUploadInFlightRef = useRef(false);
  const screenshotClaims = uniqueScreenshotClaims(uploadedClaims);
  const screenshotAnalysisIds = new Set(
    uploadedClaims.filter((claim) => claim.screenshot).map((claim) => claim.id),
  );
  const foundRerunProofs = rerunProofLookup?.items.filter((item) => item.status === "found") ?? [];
  const missingRerunProofs =
    rerunProofLookup?.items.filter((item) => item.status === "missing") ?? [];
  const rerunProofReady = Boolean(
    rerunProofLookup &&
    missingRerunProofs.every((item) => screenshotAnalysisIds.has(item.analysisId)),
  );
  const caseDefinitionIds = useMemo(
    () => [...new Set(claims.map((claim) => claim.caseDefinitionId))],
    [claims],
  );
  const currentAnalysisIds = useMemo(() => new Set(claims.map((claim) => claim.id)), [claims]);
  const historyLimitPerCase = claims.length > 20 ? 1 : claims.length > 5 ? 2 : 5;
  const closeScreenshotPreview = useCallback(() => {
    setPreviewClaim(undefined);
    window.requestAnimationFrame(() => imagePreviewTriggerRef.current?.focus());
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const parameters = new URLSearchParams({
      projectId,
      limitPerCase: String(historyLimitPerCase),
    });
    for (const caseDefinitionId of caseDefinitionIds) {
      parameters.append("caseDefinitionId", caseDefinitionId);
    }
    void fetch(`/api/v1/failure-analysis/history?${parameters}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error((await readApiErrorMessage(response, "读取历史分析结论失败。"))!);
        }
        return (await response.json()) as { items: FailureAnalysisHistoryItemView[] };
      })
      .then((payload) => {
        setHistoryItems(payload.items.filter((item) => !currentAnalysisIds.has(item.claim.id)));
      })
      .catch((loadError: unknown) => {
        if (loadError instanceof DOMException && loadError.name === "AbortError") return;
        setHistoryError(loadError instanceof Error ? loadError.message : "读取历史分析结论失败。");
      })
      .finally(() => {
        if (!controller.signal.aborted) setHistoryLoading(false);
      });
    return () => controller.abort();
  }, [caseDefinitionIds, currentAnalysisIds, historyLimitPerCase, projectId]);

  useEffect(() => {
    if (!previewClaim) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeScreenshotPreview();
    };
    window.addEventListener("keydown", closeOnEscape);
    imageCloseButtonRef.current?.focus();
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [closeScreenshotPreview, previewClaim]);

  function openScreenshotPreview(
    claim: FailureAnalysisClaimView,
    trigger: HTMLButtonElement,
  ): void {
    imagePreviewTriggerRef.current = trigger;
    setImageZoomPercent(100);
    setPreviewClaim(claim);
  }

  async function openPublicLog(claim: FailureAnalysisClaimView): Promise<void> {
    const openedWindow = window.open("", "_blank");
    setError("");
    try {
      const response = await fetch(
        `/api/v1/run-attempts/${encodeURIComponent(claim.attemptId)}/log-share`,
        { method: "POST" },
      );
      if (!response.ok)
        throw new Error((await readApiErrorMessage(response, "创建公开日志失败。"))!);
      const { shareUrl } = (await response.json()) as { shareUrl: string };
      if (openedWindow) {
        openedWindow.opener = null;
        openedWindow.location.href = shareUrl;
      } else window.location.assign(shareUrl);
    } catch (shareError) {
      openedWindow?.close();
      setError(shareError instanceof Error ? shareError.message : "创建公开日志失败。");
    }
  }

  const savePastedScreenshot = useCallback(
    async (file: File): Promise<void> => {
      if (screenshotUploadInFlightRef.current || readOnly) return;
      screenshotUploadInFlightRef.current = true;
      setUploading(true);
      setError("");
      try {
        const parameters = new URLSearchParams({
          projectId,
          fileName: file.name || "rerun-proof.png",
        });
        for (const claim of claims) parameters.append("analysisId", claim.id);
        const response = await fetch(`/api/v1/failure-analysis/claims/evidence?${parameters}`, {
          method: "POST",
          headers: { "content-type": file.type || "application/octet-stream" },
          body: file,
        });
        if (!response.ok)
          throw new Error((await readApiErrorMessage(response, "上传重跑证明失败。"))!);
        const payload = (await response.json()) as { items: FailureAnalysisClaimView[] };
        setUploadedClaims(payload.items);
      } catch (uploadError) {
        setError(uploadError instanceof Error ? uploadError.message : "上传重跑证明失败。");
      } finally {
        screenshotUploadInFlightRef.current = false;
        setUploading(false);
      }
    },
    [claims, projectId, readOnly],
  );

  useEffect(() => {
    if (
      category !== "rerun_passed" ||
      readOnly ||
      logClaim ||
      previewClaim ||
      showCaseConfirmation ||
      showConclusionPicker ||
      inheritanceCandidate
    ) {
      return;
    }
    const handlePaste = (event: globalThis.ClipboardEvent): void => {
      if (!event.clipboardData) return;
      const clipboardItems = [...event.clipboardData.items];
      const image = pastedImage(clipboardItems);
      if (!image) {
        if (clipboardItems.some((item) => item.kind === "file" && item.type.startsWith("image/"))) {
          event.preventDefault();
          setError("剪贴板图片格式不受支持，请粘贴 PNG、JPEG 或 WebP 截图。");
        } else if (!isTextPasteTarget(event.target)) {
          setError("剪贴板中没有可粘贴的 PNG、JPEG 或 WebP 图片。");
        }
        return;
      }
      event.preventDefault();
      void savePastedScreenshot(image);
    };
    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [
    category,
    inheritanceCandidate,
    logClaim,
    previewClaim,
    readOnly,
    savePastedScreenshot,
    showCaseConfirmation,
    showConclusionPicker,
  ]);

  async function complete(caseIssueConfirmed: boolean): Promise<void> {
    if (!category || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/v1/failure-analysis/claims/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId,
          analysisIds: claims.map((claim) => claim.id),
          category,
          issueDescription,
          caseFixEvidence,
          ticketReference,
          remark,
          caseIssueConfirmed,
        }),
      });
      if (!response.ok)
        throw new Error((await readApiErrorMessage(response, "提交用例分析失败。"))!);
      const payload = (await response.json()) as { items: FailureAnalysisClaimView[] };
      onCompleted(payload.items);
    } catch (completeError) {
      setError(completeError instanceof Error ? completeError.message : "提交用例分析失败。");
      setShowCaseConfirmation(false);
    } finally {
      setSubmitting(false);
    }
  }

  async function lookupRerunProofs(): Promise<void> {
    if (category !== "rerun_passed" || lookingUpRerunProofs || readOnly) return;
    setLookingUpRerunProofs(true);
    setError("");
    try {
      const response = await fetch("/api/v1/failure-analysis/claims/rerun-proofs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId,
          analysisIds: claims.map((claim) => claim.id),
        }),
      });
      if (!response.ok) {
        throw new Error((await readApiErrorMessage(response, "查找重跑通过记录失败。"))!);
      }
      const lookup = failureAnalysisRerunProofLookupResultSchema.parse(await response.json());
      setRerunProofLookup(lookup);
      const missingCount = lookup.items.filter((item) => item.status === "missing").length;
      if (missingCount > 0) {
        toast.warning(
          `已查找：${lookup.items.length - missingCount} 个用例有成功重跑，${missingCount} 个用例需要截图。`,
        );
      } else {
        toast.success(`已找到 ${lookup.items.length} 个用例的重跑通过日志。`);
      }
    } catch (lookupError) {
      setRerunProofLookup(undefined);
      setError(lookupError instanceof Error ? lookupError.message : "查找重跑通过记录失败。");
    } finally {
      setLookingUpRerunProofs(false);
    }
  }

  function requestCompletion(): void {
    setError("");
    if (category === "rerun_passed") {
      if (!rerunProofLookup) {
        setError("请先查找重跑通过记录，再根据结果提交日志链接或截图证明。");
        return;
      }
      const missingScreenshot = missingRerunProofs.find(
        (item) => !screenshotAnalysisIds.has(item.analysisId),
      );
      if (missingScreenshot) {
        const claim = claims.find((candidate) => candidate.id === missingScreenshot.analysisId);
        setError(`“${claim?.caseName ?? "所选用例"}”未找到成功重跑记录，必须粘贴通过截图。`);
        return;
      }
    }
    if (category === "case_fixed") {
      if (!issueDescription.trim() || !caseFixEvidence.trim()) {
        setError("用例问题已修改必须填写问题说明和用例已修改证明。");
        return;
      }
      setShowCaseConfirmation(true);
      return;
    }
    if (category === "code_issue_filed" && (!issueDescription.trim() || !ticketReference.trim())) {
      setError("代码问题已提单必须填写问题说明和问题单链接或问题单号。");
      return;
    }
    void complete(false);
  }

  function inheritConclusion(): void {
    if (!inheritanceCandidate) return;
    setCategory(inheritanceCandidate.claim.category);
    setRerunProofLookup(undefined);
    setIssueDescription(inheritanceCandidate.claim.issueDescription ?? "");
    setCaseFixEvidence(inheritanceCandidate.claim.caseFixEvidence ?? "");
    setTicketReference(inheritanceCandidate.claim.ticketReference ?? "");
    setRemark(inheritanceCandidate.claim.remark ?? "");
    setInheritanceCandidate(undefined);
  }

  async function copyCaseInformation(): Promise<void> {
    if (copying) return;
    setCopying(true);
    try {
      await copyRichTextToClipboard(
        formatFailureAnalysisClipboard(claims, {
          ...(category ? { category } : {}),
          ...(issueDescription ? { issueDescription } : {}),
          ...(caseFixEvidence ? { caseFixEvidence } : {}),
          ...(ticketReference ? { ticketReference } : {}),
          ...(remark ? { remark } : {}),
        }),
      );
      toast.success(`已复制 ${claims.length} 个用例的信息和当前分析结论。`);
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : "复制用例信息失败。");
    } finally {
      setCopying(false);
    }
  }

  return (
    <>
      <div
        className="runner-update-overlay failure-analysis-overlay"
        role="presentation"
        onClick={onClose}
      >
        <section
          aria-label={
            claims.length > 1 ? `批量分析 ${claims.length} 个用例` : `分析 ${claims[0]?.caseName}`
          }
          aria-modal="true"
          aria-hidden={
            logClaim ||
            previewClaim ||
            showCaseConfirmation ||
            showConclusionPicker ||
            inheritanceCandidate
              ? true
              : undefined
          }
          className="runner-update-dialog failure-analysis-dialog failure-analysis-completion-dialog"
          data-read-only={readOnly ? "true" : undefined}
          onClick={(event) => event.stopPropagation()}
          role="dialog"
        >
          <header className="runner-update-titlebar">
            <span>
              <ClipboardCheck size={17} />
              <strong>
                {readOnly
                  ? "用例分析详情"
                  : claims.length > 1
                    ? `批量分析 ${claims.length} 个用例`
                    : "用例分析"}
              </strong>
              <small>
                {claims.length > 1 ? "相同结论将应用到所有选中用例" : claims[0]?.caseName}
              </small>
            </span>
            <div className="failure-analysis-titlebar-actions">
              <Button
                disabled={copying}
                onClick={() => void copyCaseInformation()}
                size="compact"
                type="button"
                variant="secondary"
              >
                {copying ? <LoaderCircle className="spin" size={14} /> : <Copy size={14} />}
                复制用例信息
              </Button>
              <Button aria-label="关闭分析弹窗" onClick={onClose} type="button">
                <X size={16} />
              </Button>
            </div>
          </header>
          <div className="runner-update-body failure-analysis-dialog-body">
            <section className="failure-analysis-case-summary">
              <div>
                <span className="eyebrow">用例基本信息</span>
                <h3>
                  {claims.length > 1 ? `${claims.length} 个最终失败用例` : claims[0]?.caseName}
                </h3>
                <p>可直接查看弹窗日志，或打开永久公开日志页重新执行该用例。</p>
              </div>
              <div className="failure-analysis-case-list">
                {claims.map((claim) => (
                  <article key={claim.id}>
                    <div>
                      <strong>{claim.caseName}</strong>
                      <code>{claim.className}</code>
                      <small>
                        第 {claim.attemptNumber} 次尝试 · {claim.failureSummary}
                      </small>
                    </div>
                    <span>
                      <Button
                        onClick={() => setLogClaim(claim)}
                        size="compact"
                        type="button"
                        variant="secondary"
                      >
                        <SquareActivity size={14} /> 弹窗日志
                      </Button>
                      <Button
                        onClick={() => void openPublicLog(claim)}
                        size="compact"
                        type="button"
                        variant="secondary"
                      >
                        <ExternalLink size={14} /> 公开日志
                      </Button>
                    </span>
                  </article>
                ))}
              </div>
            </section>

            <AnalysisHistoryPanel
              historyError={historyError}
              historyItems={historyItems}
              historyLoading={historyLoading}
              historyLimitPerCase={historyLimitPerCase}
              canInherit={!readOnly}
              onBrowse={() => setShowConclusionPicker(true)}
              onInherit={setInheritanceCandidate}
              onPreview={(claim, trigger) => openScreenshotPreview(claim, trigger)}
              selectedCaseCount={claims.length}
            />

            <fieldset
              className="failure-analysis-category-options"
              data-read-only={readOnly ? "true" : undefined}
              disabled={readOnly}
            >
              <legend>{readOnly ? "分析结论" : "选择失败类别"}</legend>
              {CATEGORY_OPTIONS.filter((option) => !readOnly || option.value === category).map(
                (option) => (
                  <label
                    className={category === option.value ? "is-selected" : ""}
                    key={option.value}
                  >
                    <Input
                      checked={category === option.value}
                      name="failure-category"
                      onChange={() => {
                        setCategory(option.value);
                        setRerunProofLookup(undefined);
                        setError("");
                      }}
                      type="radio"
                      value={option.value}
                    />
                    <span>
                      <strong>{option.label}</strong>
                      <small>{option.description}</small>
                    </span>
                  </label>
                ),
              )}
            </fieldset>

            {category === "rerun_passed" ? (
              <section className="failure-analysis-proof-panel">
                <div>
                  <FileCheck2 size={18} />
                  <span>
                    <strong>重跑通过证明</strong>
                    <small>
                      请先主动查找这些用例从公开日志页发起的成功重跑；查不到的用例必须粘贴通过截图。
                    </small>
                  </span>
                </div>
                {!readOnly ? (
                  <div className="failure-analysis-proof-lookup">
                    <Button
                      disabled={lookingUpRerunProofs || uploading}
                      onClick={() => void lookupRerunProofs()}
                      type="button"
                      variant="secondary"
                    >
                      {lookingUpRerunProofs ? (
                        <LoaderCircle className="spin" size={15} />
                      ) : (
                        <SearchCheck size={15} />
                      )}
                      {lookingUpRerunProofs ? "正在查找…" : "查找重跑通过记录"}
                    </Button>
                    {!rerunProofLookup ? (
                      <small>尚未查找，提交分析暂不可用。</small>
                    ) : (
                      <div className="failure-analysis-proof-lookup-result" role="status">
                        {foundRerunProofs.map((item) => {
                          const claim = claims.find(
                            (candidate) => candidate.id === item.analysisId,
                          );
                          return (
                            <a
                              href={item.url}
                              key={item.analysisId}
                              rel="noreferrer"
                              target="_blank"
                            >
                              <CheckCircle2 size={14} />
                              {claim?.caseName ?? item.analysisId} · 查看重跑通过日志
                            </a>
                          );
                        })}
                        {missingRerunProofs.length > 0 ? (
                          <span className="failure-analysis-proof-missing">
                            <AlertTriangle size={15} />
                            {missingRerunProofs.length} 个用例未找到成功重跑记录，必须提交截图。
                          </span>
                        ) : (
                          <span className="failure-analysis-proof-found">
                            <CheckCircle2 size={15} /> 全部用例均已找到重跑通过日志。
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                ) : null}
                {uploadedClaims.some((claim) => claim.screenshot) ? (
                  <>
                    <div className="failure-analysis-uploaded-proof">
                      <CheckCircle2 size={17} />
                      <span>
                        通过截图已上传到平台对象存储
                        {claims.length > 1 ? "，并关联到全部选中用例" : ""}。
                      </span>
                    </div>
                    <div className="failure-analysis-proof-gallery" aria-label="重跑通过截图">
                      {screenshotClaims.map((claim) => (
                        <Button
                          aria-label={`放大查看截图 ${claim.screenshot!.fileName}`}
                          className="failure-analysis-proof-thumbnail"
                          key={claim.screenshot!.sha256}
                          onClick={(event) => openScreenshotPreview(claim, event.currentTarget)}
                          type="button"
                          variant="ghost"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element -- authenticated evidence must load directly with the browser session */}
                          <img
                            alt={`重跑通过截图：${claim.screenshot!.fileName}`}
                            loading="lazy"
                            src={failureAnalysisEvidenceUrl(claim, projectId)}
                          />
                          <span>
                            <strong>{claim.screenshot!.fileName}</strong>
                            <small>点击放大 · {formatFileSize(claim.screenshot!.sizeBytes)}</small>
                          </span>
                          <Maximize2 aria-hidden="true" size={16} />
                        </Button>
                      ))}
                    </div>
                  </>
                ) : null}
                {!readOnly && rerunProofLookup && missingRerunProofs.length > 0 ? (
                  <div
                    aria-busy={uploading}
                    aria-label="使用 Ctrl+V 粘贴重跑通过截图"
                    className="failure-analysis-paste-zone"
                    role="group"
                    tabIndex={0}
                  >
                    <ClipboardPaste size={24} />
                    <strong>
                      {uploading ? "正在保存粘贴的截图…" : "直接按 Ctrl + V 粘贴执行通过截图"}
                    </strong>
                    <span>无需点击选择文件；弹窗内任意位置均可粘贴，最大 10 MB</span>
                    <span className="failure-analysis-paste-shortcut" aria-hidden="true">
                      <kbd>Ctrl</kbd>
                      <b>+</b>
                      <kbd>V</kbd>
                      <small>macOS 使用 ⌘ + V</small>
                    </span>
                  </div>
                ) : null}
                {readOnly && initial?.rerunProofUrl ? (
                  <a
                    className="ui-button ui-button-secondary"
                    href={initial.rerunProofUrl}
                    rel="noreferrer"
                    target="_blank"
                  >
                    <ExternalLink size={14} /> 查看重跑通过永久日志
                  </a>
                ) : null}
              </section>
            ) : null}

            {category === "case_fixed" || category === "code_issue_filed" ? (
              <label className="failure-analysis-field">
                <span>
                  问题说明 <strong>*</strong>
                </span>
                <Textarea
                  disabled={readOnly}
                  onChange={(event) => setIssueDescription(event.target.value)}
                  placeholder={
                    category === "case_fixed"
                      ? "说明用例自身存在的问题及影响"
                      : "说明确认的代码问题及影响"
                  }
                  rows={4}
                  value={issueDescription}
                />
              </label>
            ) : null}
            {category === "case_fixed" ? (
              <label className="failure-analysis-field">
                <span>
                  用例已修改证明 <strong>*</strong>
                </span>
                <Textarea
                  disabled={readOnly}
                  onChange={(event) => setCaseFixEvidence(event.target.value)}
                  placeholder="填写提交记录、变更链接、修改说明等可追溯证明"
                  rows={3}
                  value={caseFixEvidence}
                />
              </label>
            ) : null}
            {category === "code_issue_filed" ? (
              <label className="failure-analysis-field">
                <span>
                  问题单链接或问题单号 <strong>*</strong>
                </span>
                <Input
                  disabled={readOnly}
                  onChange={(event) => setTicketReference(event.target.value)}
                  placeholder="例如 BUG-1024 或 https://tracker.example/BUG-1024"
                  value={ticketReference}
                />
              </label>
            ) : null}
            {category ? (
              <label className="failure-analysis-field">
                <span>
                  备注说明 <small>选填</small>
                </span>
                <Textarea
                  disabled={readOnly}
                  onChange={(event) => setRemark(event.target.value)}
                  placeholder="补充上下文、后续动作或其他说明"
                  rows={3}
                  value={remark}
                />
              </label>
            ) : null}

            {error ? <p className="form-error">{error}</p> : null}
            <div className="dialog-actions">
              <Button onClick={onClose} type="button" variant="secondary">
                {readOnly ? "关闭" : "取消"}
              </Button>
              {!readOnly ? (
                <Button
                  disabled={
                    !category ||
                    submitting ||
                    uploading ||
                    lookingUpRerunProofs ||
                    (category === "rerun_passed" && !rerunProofReady)
                  }
                  onClick={requestCompletion}
                  type="button"
                  variant="primary"
                >
                  {submitting ? (
                    <LoaderCircle className="spin" size={16} />
                  ) : (
                    <CheckCircle2 size={16} />
                  )}
                  提交分析
                </Button>
              ) : null}
            </div>
          </div>
        </section>
      </div>
      {logClaim ? (
        <AttemptLogViewer
          attemptId={logClaim.attemptId}
          attemptStatus="failed"
          canCreateRuns={false}
          canReadLogs
          onClose={() => setLogClaim(undefined)}
        />
      ) : null}
      {previewClaim?.screenshot ? (
        <div
          className="failure-analysis-image-overlay"
          onClick={closeScreenshotPreview}
          role="presentation"
        >
          <section
            aria-label={`图片预览 ${previewClaim.screenshot.fileName}`}
            aria-modal="true"
            className="failure-analysis-image-dialog"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
          >
            <header>
              <span>
                <strong>{previewClaim.screenshot.fileName}</strong>
                <small>{formatFileSize(previewClaim.screenshot.sizeBytes)}</small>
              </span>
              <div className="failure-analysis-image-controls" aria-label="图片缩放控制">
                <Button
                  aria-label="缩小图片"
                  disabled={imageZoomPercent <= 50}
                  onClick={() => setImageZoomPercent((current) => Math.max(50, current - 25))}
                  size="compact"
                  type="button"
                  variant="secondary"
                >
                  <Minus size={15} />
                </Button>
                <output aria-label="当前图片缩放比例">{imageZoomPercent}%</output>
                <Button
                  aria-label="放大图片"
                  disabled={imageZoomPercent >= 300}
                  onClick={() => setImageZoomPercent((current) => Math.min(300, current + 25))}
                  size="compact"
                  type="button"
                  variant="secondary"
                >
                  <Plus size={15} />
                </Button>
                <Button
                  aria-label="重置图片大小"
                  disabled={imageZoomPercent === 100}
                  onClick={() => setImageZoomPercent(100)}
                  size="compact"
                  type="button"
                  variant="secondary"
                >
                  <RotateCcw size={15} />
                </Button>
                <Button
                  aria-label="关闭图片预览"
                  onClick={closeScreenshotPreview}
                  ref={imageCloseButtonRef}
                  size="compact"
                  type="button"
                >
                  <X size={16} />
                </Button>
              </div>
            </header>
            <div className="failure-analysis-image-viewport">
              {/* eslint-disable-next-line @next/next/no-img-element -- authenticated evidence must load directly with the browser session */}
              <img
                alt={`重跑通过截图大图：${previewClaim.screenshot.fileName}`}
                src={failureAnalysisEvidenceUrl(previewClaim, projectId)}
                style={{ width: `${imageZoomPercent}%` }}
              />
            </div>
          </section>
        </div>
      ) : null}
      {showCaseConfirmation ? (
        <div
          className="runner-update-overlay failure-analysis-confirm-overlay"
          role="presentation"
          onClick={() => setShowCaseConfirmation(false)}
        >
          <section
            aria-label="确认用例问题"
            aria-modal="true"
            className="runner-update-dialog failure-analysis-confirm-dialog"
            onClick={(event) => event.stopPropagation()}
            role="alertdialog"
          >
            <header>
              <AlertTriangle size={24} />
              <div>
                <strong>请再次确认这是用例问题</strong>
                <p>
                  为了避免引发质量风险，请责任人确认问题确实由用例本身引起。不要为了让执行结果通过而修改正确的校验逻辑。
                </p>
              </div>
            </header>
            <div className="dialog-actions">
              <Button
                onClick={() => setShowCaseConfirmation(false)}
                type="button"
                variant="secondary"
              >
                返回检查
              </Button>
              <Button
                className="failure-analysis-confirm-action"
                disabled={submitting}
                onClick={() => void complete(true)}
                type="button"
                variant="danger"
              >
                我已核实，确认提交
              </Button>
            </div>
          </section>
        </div>
      ) : null}
      {showConclusionPicker ? (
        <FailureAnalysisConclusionPicker
          excludedAnalysisIds={currentAnalysisIds}
          onClose={() => setShowConclusionPicker(false)}
          onSelect={(item) => {
            setShowConclusionPicker(false);
            setInheritanceCandidate(item);
          }}
          projectId={projectId}
        />
      ) : null}
      {inheritanceCandidate ? (
        <div
          className="runner-update-overlay failure-analysis-confirm-overlay"
          role="presentation"
          onClick={() => setInheritanceCandidate(undefined)}
        >
          <section
            aria-label={
              inheritanceCandidate.claim.category === "code_issue_filed"
                ? "确认继承未闭环代码问题"
                : "确认继承分析结论"
            }
            aria-modal="true"
            className="runner-update-dialog failure-analysis-confirm-dialog"
            onClick={(event) => event.stopPropagation()}
            role="alertdialog"
          >
            <header>
              <AlertTriangle size={24} />
              <div>
                <strong>
                  {inheritanceCandidate.claim.category === "code_issue_filed"
                    ? "确认问题单尚未闭环"
                    : "确认沿用该分析结论"}
                </strong>
                {inheritanceCandidate.claim.category === "code_issue_filed" ? (
                  <p>
                    请确认问题单“{inheritanceCandidate.claim.ticketReference}
                    ”尚未闭环，且当前失败仍由同一代码问题引起。若问题已修复或失败根因发生变化，请返回重新分析。
                  </p>
                ) : (
                  <p>
                    将继承“{inheritanceCandidate.claim.caseName}
                    ”的结论和说明。请确认当前失败根因一致；重跑证明不会被继承。
                  </p>
                )}
              </div>
            </header>
            <div className="dialog-actions">
              <Button
                onClick={() => setInheritanceCandidate(undefined)}
                type="button"
                variant="secondary"
              >
                返回重新分析
              </Button>
              <Button
                className="failure-analysis-confirm-action"
                onClick={inheritConclusion}
                type="button"
                variant="danger"
              >
                {inheritanceCandidate.claim.category === "code_issue_filed"
                  ? "问题仍存在，继承结论"
                  : "确认继承结论"}
              </Button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}

function AnalysisHistoryPanel({
  historyItems,
  historyLoading,
  historyError,
  historyLimitPerCase,
  canInherit,
  selectedCaseCount,
  onInherit,
  onBrowse,
  onPreview,
}: {
  historyItems: FailureAnalysisHistoryItemView[];
  historyLoading: boolean;
  historyError: string;
  historyLimitPerCase: number;
  canInherit: boolean;
  selectedCaseCount: number;
  onInherit: (item: FailureAnalysisHistoryItemView) => void;
  onBrowse: () => void;
  onPreview: (claim: FailureAnalysisClaimView, trigger: HTMLButtonElement) => void;
}) {
  return (
    <section className="failure-analysis-history-panel">
      <header>
        <span>
          <History size={18} />
          <strong>历史分析结论</strong>
        </span>
        <span className="failure-analysis-history-header-actions">
          <small>
            {selectedCaseCount > 1
              ? `按用例展示最近 ${historyLimitPerCase} 条`
              : `最近 ${historyLimitPerCase} 条`}
          </small>
          {canInherit ? (
            <Button onClick={onBrowse} size="compact" type="button" variant="secondary">
              <ClipboardPaste size={13} /> 从已分析用例继承
            </Button>
          ) : null}
        </span>
      </header>
      {historyLoading ? (
        <div className="failure-analysis-history-state" role="status">
          <LoaderCircle className="spin" size={16} /> 正在读取历史结论…
        </div>
      ) : historyError ? (
        <div className="failure-analysis-history-state error" role="alert">
          {historyError}
        </div>
      ) : historyItems.length === 0 ? (
        <div className="failure-analysis-history-state">该用例暂无已完成的历史分析结论。</div>
      ) : (
        <div className="failure-analysis-history-cards">
          {historyItems.map((item) => (
            <article key={item.claim.id}>
              <div className="failure-analysis-history-heading">
                <span className="analysis-status completed">
                  {categoryLabel(item.claim.category) ?? "已完成"}
                </span>
                <strong>{item.claim.caseName}</strong>
                <small>
                  #{item.batchSequenceNumber} {item.batchName} ·{" "}
                  {formatPlatformDateTime(item.claim.completedAt ?? item.claim.updatedAt)}
                </small>
              </div>
              <dl>
                <div>
                  <dt>分析责任人</dt>
                  <dd>
                    {item.claim.claimantDisplayName}（{item.claim.claimantUsername}）
                  </dd>
                </div>
                {item.claim.issueDescription ? (
                  <div>
                    <dt>问题说明</dt>
                    <dd>{item.claim.issueDescription}</dd>
                  </div>
                ) : null}
                {item.claim.ticketReference ? (
                  <div>
                    <dt>问题单</dt>
                    <dd>{item.claim.ticketReference}</dd>
                  </div>
                ) : null}
                {item.claim.caseFixEvidence ? (
                  <div>
                    <dt>用例修改证明</dt>
                    <dd>{item.claim.caseFixEvidence}</dd>
                  </div>
                ) : null}
                {item.claim.remark ? (
                  <div>
                    <dt>备注</dt>
                    <dd>{item.claim.remark}</dd>
                  </div>
                ) : null}
              </dl>
              <div className="failure-analysis-history-actions">
                {item.claim.rerunProofUrl ? (
                  <a href={item.claim.rerunProofUrl} rel="noreferrer" target="_blank">
                    <ExternalLink size={13} /> 重跑通过日志
                  </a>
                ) : null}
                {item.claim.screenshot ? (
                  <Button
                    onClick={(event) => onPreview(item.claim, event.currentTarget)}
                    size="compact"
                    type="button"
                    variant="secondary"
                  >
                    <Maximize2 size={13} /> 查看证明截图
                  </Button>
                ) : null}
                {canInherit ? (
                  <Button
                    onClick={() => onInherit(item)}
                    size="compact"
                    type="button"
                    variant="secondary"
                  >
                    {item.claim.category === "code_issue_filed"
                      ? "继承此代码问题结论"
                      : "继承此结论"}
                  </Button>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function uniqueScreenshotClaims(
  claims: readonly FailureAnalysisClaimView[],
): FailureAnalysisClaimView[] {
  const screenshotDigests = new Set<string>();
  return claims.filter((claim) => {
    const digest = claim.screenshot?.sha256;
    if (!digest || screenshotDigests.has(digest)) return false;
    screenshotDigests.add(digest);
    return true;
  });
}

function pastedImage(items: readonly DataTransferItem[]): File | undefined {
  return (
    items
      .find(
        (item) =>
          item.kind === "file" &&
          (item.type === "image/png" || item.type === "image/jpeg" || item.type === "image/webp"),
      )
      ?.getAsFile() ?? undefined
  );
}

function isTextPasteTarget(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement) {
    return ["email", "password", "search", "tel", "text", "url"].includes(target.type);
  }
  return target instanceof HTMLElement && target.isContentEditable;
}

function failureAnalysisEvidenceUrl(claim: FailureAnalysisClaimView, projectId: string): string {
  return `/api/v1/failure-analysis/claims/${encodeURIComponent(claim.id)}/evidence?projectId=${encodeURIComponent(projectId)}`;
}

function formatFileSize(sizeBytes: number): string {
  if (sizeBytes < 1_024) return `${sizeBytes} B`;
  return `${(sizeBytes / 1_024).toFixed(1)} KiB`;
}

function categoryLabel(category: FailureAnalysisCategory | undefined): string | undefined {
  return CATEGORY_OPTIONS.find((option) => option.value === category)?.label;
}

function statusLabel(status: FailureAnalysisClaimView["status"]): string {
  return { claimed: "已认领", analyzing: "分析中", completed: "已完成" }[status];
}

function readRememberedFailureAnalysisPreferences() {
  try {
    return readFailureAnalysisPreferences(window.localStorage);
  } catch {
    return undefined;
  }
}

function persistFailureAnalysisPreferences(
  preferences: Parameters<typeof writeFailureAnalysisPreferences>[1],
): void {
  try {
    writeFailureAnalysisPreferences(window.localStorage, preferences);
  } catch {
    // 浏览器禁用存储时继续使用当前会话内的筛选状态。
  }
}
