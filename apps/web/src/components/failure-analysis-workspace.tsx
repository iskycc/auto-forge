"use client";
import { LinkButton } from "@/components/ui/link-button";

import { Notice } from "@/components/ui/notice";

import { Dialog } from "@/components/ui/dialog";
import { Tabs } from "./ui/tabs";
import { TabContent } from "./ui/tab-content";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";

import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import {
  failureAnalysisRerunProofLookupResultSchema,
  type ClaimFailureAnalysisResult,
  type FailureAnalysisCandidate,
  type FailureAnalysisCandidatePage,
  type FailureAnalysisClaimReleaseView,
  type FailureAnalysisClaimView,
  type FailureAnalysisCompletionOrder,
  type FailureAnalysisHistoryItemView,
  type FailureAnalysisInheritanceScope,
  type FailureAnalysisRecentSuccess,
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

import { FailureAnalysisAssignmentDialog } from "@/components/failure-analysis-assignment-dialog";
import { AttemptLogViewer } from "@/components/attempt-log-viewer";
import { AttemptLogComparison } from "@/components/attempt-log-comparison";
import {
  FailureAnalysisExecutionHistory,
  type AnalysisLogComparison,
} from "@/components/failure-analysis-execution-history";
import {
  FailureAnalysisRemark,
  type AnalysisImagePreview,
} from "@/components/failure-analysis-remark";
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
import { ExpandableText } from "./expandable-text";
import { DialogDiscardPrompt } from "./dialog-discard-prompt";
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
  canAssign,
  currentUserId,
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
  canAssign: boolean;
  currentUserId: string;
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
  const [assignmentOpen, setAssignmentOpen] = useState(false);
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
  const workspaceBlocked = modalOpen || assignmentOpen;

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
    setClaims((current) =>
      current.map((claim) => {
        const updated = updates.get(claim.id);
        if (!updated) return claim;
        return claim.recentSuccessfulExecution
          ? { ...updated, recentSuccessfulExecution: claim.recentSuccessfulExecution }
          : updated;
      }),
    );
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
      <Card
        as="section"
        aria-hidden={workspaceBlocked ? true : undefined}
        className={cn(
          "content-card failure-analysis-shell",
          uiPatterns["content-card"],
          failureAnalysisWorkspaceStyles["failure-analysis-shell"],
        )}
        inert={workspaceBlocked ? true : undefined}
      >
        <Tabs
          className="failure-analysis-tabs mb-4"
          label="用例分析步骤"
          value={view}
          items={[
            { key: "claim", label: "认领失败用例" },
            {
              key: "workbench",
              label: (
                <>
                  我的分析 <span>{myClaimCount}</span>
                </>
              ),
            },
          ]}
          onChange={changeView}
        />

        <TabContent activeKey={view}>
          {error ? (
            <Notice tone="error" className={cn("form-error", uiPatterns["form-error"])}>
              {error}
            </Notice>
          ) : null}

          {view === "claim" ? (
            <div
              className={cn(
                "failure-analysis-claim-view",
                failureAnalysisWorkspaceStyles["failure-analysis-claim-view"],
              )}
              role="tabpanel"
            >
              <form
                className={cn(
                  "failure-analysis-filter",
                  failureAnalysisWorkspaceStyles["failure-analysis-filter"],
                )}
                onSubmit={submitSearch}
              >
                <label>
                  类路径、用例名称或失败堆栈
                  <span
                    className={cn(
                      "failure-analysis-search-control",
                      failureAnalysisWorkspaceStyles["failure-analysis-search-control"],
                    )}
                  >
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
                <div
                  className={cn(
                    "failure-analysis-empty",
                    failureAnalysisWorkspaceStyles["failure-analysis-empty"],
                  )}
                >
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
                  canManage={canManage || canAssign}
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
            <div
              className={cn(
                "failure-analysis-workbench",
                failureAnalysisWorkspaceStyles["failure-analysis-workbench"],
              )}
              role="tabpanel"
            >
              <div
                className={cn(
                  "failure-analysis-workbench-heading",
                  failureAnalysisWorkspaceStyles["failure-analysis-workbench-heading"],
                )}
              >
                <div>
                  <span className={cn("eyebrow", uiPatterns["eyebrow"])}>My analysis</span>
                  <h2>我的分析队列</h2>
                  <p>勾选多个用例可批量填写相同分析结论；所有状态与证明均由服务端持久化。</p>
                </div>
                <div
                  className={cn(
                    "failure-analysis-workbench-actions",
                    failureAnalysisWorkspaceStyles["failure-analysis-workbench-actions"],
                  )}
                >
                  <label
                    className={cn(
                      "failure-analysis-order-control",
                      failureAnalysisWorkspaceStyles["failure-analysis-order-control"],
                    )}
                  >
                    <span>排列方式</span>
                    <Select
                      aria-label="我的分析排序字段"
                      disabled={loadingClaims}
                      onChange={(event) =>
                        changeClaimSort(event.target.value as FailureAnalysisSort)
                      }
                      value={claimSort}
                    >
                      {CLAIM_SORT_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </Select>
                  </label>
                  <label
                    className={cn(
                      "failure-analysis-order-control",
                      failureAnalysisWorkspaceStyles["failure-analysis-order-control"],
                    )}
                  >
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
                  <label
                    className={cn(
                      "failure-analysis-completed-filter",
                      failureAnalysisWorkspaceStyles["failure-analysis-completed-filter"],
                    )}
                  >
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
              <form
                className={cn(
                  "failure-analysis-filter",
                  failureAnalysisWorkspaceStyles["failure-analysis-filter"],
                )}
                onSubmit={submitAnalysisSearch}
              >
                <label>
                  用例名称、类路径或失败堆栈
                  <span
                    className={cn(
                      "failure-analysis-search-control",
                      failureAnalysisWorkspaceStyles["failure-analysis-search-control"],
                    )}
                  >
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
                <div
                  className={cn(
                    "failure-analysis-empty",
                    failureAnalysisWorkspaceStyles["failure-analysis-empty"],
                  )}
                >
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
                  <label
                    className={cn(
                      "failure-analysis-select-all",
                      failureAnalysisWorkspaceStyles["failure-analysis-select-all"],
                    )}
                  >
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
                  <div
                    className={cn(
                      "failure-analysis-grouped-list",
                      failureAnalysisWorkspaceStyles["failure-analysis-grouped-list"],
                    )}
                  >
                    {claimGroups.map((group) =>
                      group.claims.length > 0 ? (
                        <section
                          className={cn(
                            "failure-analysis-claim-group",
                            failureAnalysisWorkspaceStyles["failure-analysis-claim-group"],
                          )}
                          key={group.key}
                        >
                          <h3>
                            {group.label} <span>本页 {group.claims.length}</span>
                          </h3>
                          <div
                            className={cn(
                              "failure-analysis-card-list",
                              failureAnalysisWorkspaceStyles["failure-analysis-card-list"],
                            )}
                          >
                            {group.claims.map((claim) => (
                              <article
                                className={cn(
                                  "failure-analysis-card",
                                  failureAnalysisWorkspaceStyles["failure-analysis-card"],
                                )}
                                key={claim.id}
                              >
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
                                <div
                                  className={cn(
                                    "failure-analysis-card-main",
                                    failureAnalysisWorkspaceStyles["failure-analysis-card-main"],
                                  )}
                                >
                                  <div
                                    className={cn(
                                      "failure-analysis-card-title",
                                      failureAnalysisWorkspaceStyles["failure-analysis-card-title"],
                                    )}
                                  >
                                    <h3>{claim.caseName}</h3>
                                    <RecentSuccessBadge
                                      execution={claim.recentSuccessfulExecution}
                                    />
                                    <span
                                      className={cn(
                                        failureAnalysisWorkspaceStyles["analysis-status"],
                                        `analysis-status ${claim.status}`,
                                      )}
                                    >
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
                                <div
                                  className={cn(
                                    "failure-analysis-card-actions",
                                    failureAnalysisWorkspaceStyles["failure-analysis-card-actions"],
                                  )}
                                >
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
                                      className={cn(
                                        "failure-analysis-release-trigger",
                                        failureAnalysisWorkspaceStyles[
                                          "failure-analysis-release-trigger"
                                        ],
                                      )}
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
        </TabContent>
      </Card>

      {assignmentOpen ? (
        <FailureAnalysisAssignmentDialog
          scope={{ projectId, projectVersionId, batchId: initialBatchId }}
          executionRunIds={[...selectedRunIds]}
          onClose={() => setAssignmentOpen(false)}
          onAssigned={(result) => {
            setAssignmentOpen(false);
            setSelectedRunIds(new Set());
            onClaimCountDelta(result.claimed.length);
            setMyClaimCount(
              (count) =>
                count + result.claimed.filter((claim) => claim.claimantId === currentUserId).length,
            );
            void loadCandidates(candidatePageCursor);
          }}
        />
      ) : null}
      {(canManage || canAssign) &&
      !workspaceBlocked &&
      view === "claim" &&
      selectedRunIds.size > 0 ? (
        <div
          className={cn(
            "failure-analysis-floating-action",
            failureAnalysisWorkspaceStyles["failure-analysis-floating-action"],
          )}
        >
          <span>已选择 {selectedRunIds.size} 个用例</span>
          {canAssign ? (
            <Button onClick={() => setAssignmentOpen(true)} type="button">
              分配给用户
            </Button>
          ) : null}
          {canManage ? (
            <Button
              disabled={submitting}
              onClick={() => void claimSelected()}
              type="button"
              variant="primary"
            >
              认领并进入分析
            </Button>
          ) : null}
        </div>
      ) : null}
      {canManage && !workspaceBlocked && view === "workbench" && selectedAnalysisIds.size > 0 ? (
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
    <Dialog
      open
      role="alertdialog"
      zIndex={1100}
      title={`取消认领 ${claim.caseName}`}
      onClose={onClose}
      className={cn(
        "runner-update-dialog failure-analysis-release-dialog",
        failureAnalysisWorkspaceStyles["runner-update-dialog"],
        failureAnalysisWorkspaceStyles["failure-analysis-release-dialog"],
      )}
      backdropClassName="runner-update-overlay failure-analysis-confirm-overlay"
    >
      <header>
        <span
          className={cn(
            "failure-analysis-release-icon",
            failureAnalysisWorkspaceStyles["failure-analysis-release-icon"],
          )}
          aria-hidden="true"
        >
          <UserMinus size={21} />
        </span>
        <div>
          <strong>确认取消认领？</strong>
          <p>“{claim.caseName}”将重新回到待认领列表，其他分析人员可以立即认领该用例。</p>
        </div>
      </header>
      <label
        className={cn(
          "failure-analysis-field",
          failureAnalysisWorkspaceStyles["failure-analysis-field"],
        )}
      >
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
      <p
        className={cn(
          "failure-analysis-release-note",
          failureAnalysisWorkspaceStyles["failure-analysis-release-note"],
        )}
      >
        取消原因会永久记录；当前未提交的分析内容不会带给下一位认领人。
      </p>
      {error ? (
        <Notice tone="error" className={cn("form-error", uiPatterns["form-error"])}>
          {error}
        </Notice>
      ) : null}
      <div className={"dialog-actions"}>
        <Button disabled={submitting} onClick={onClose} type="button" variant="secondary">
          返回
        </Button>
        <Button
          className={cn(
            "failure-analysis-confirm-action",
            failureAnalysisWorkspaceStyles["failure-analysis-confirm-action"],
          )}
          disabled={!normalizedReason || submitting}
          onClick={() => void releaseClaim()}
          type="button"
          variant="danger"
        >
          {submitting ? (
            <LoaderCircle className={cn("spin", uiPatterns["spin"])} size={16} />
          ) : (
            <UserMinus aria-hidden="true" size={16} />
          )}
          确认取消认领
        </Button>
      </div>
    </Dialog>
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
    <div
      className={cn(
        "failure-analysis-table-wrap",
        failureAnalysisWorkspaceStyles["failure-analysis-table-wrap"],
      )}
    >
      <Table
        className={cn(
          "failure-analysis-table",
          failureAnalysisWorkspaceStyles["failure-analysis-table"],
        )}
      >
        <colgroup>
          <col
            className={cn(
              "failure-analysis-select-column",
              failureAnalysisWorkspaceStyles["failure-analysis-select-column"],
            )}
          />
          <col
            className={cn(
              "failure-analysis-name-column",
              failureAnalysisWorkspaceStyles["failure-analysis-name-column"],
            )}
          />
          <col
            className={cn(
              "failure-analysis-path-column",
              failureAnalysisWorkspaceStyles["failure-analysis-path-column"],
            )}
          />
          <col
            className={cn(
              "failure-analysis-stack-column",
              failureAnalysisWorkspaceStyles["failure-analysis-stack-column"],
            )}
          />
          <col
            className={cn(
              "failure-analysis-status-column",
              failureAnalysisWorkspaceStyles["failure-analysis-status-column"],
            )}
          />
        </colgroup>
        <TableHeader>
          <TableRow>
            <TableHead>
              <Input
                aria-label="选择本页全部未认领用例"
                checked={allAvailableSelected}
                disabled={!canManage || candidates.every((candidate) => Boolean(candidate.claim))}
                onChange={(event) => onSelectAll(event.target.checked)}
                type="checkbox"
              />
            </TableHead>
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
          </TableRow>
        </TableHeader>
        <TableBody>
          {candidates.map((candidate) => (
            <TableRow key={candidate.executionRunId}>
              <TableCell>
                <Input
                  aria-label={`认领 ${candidate.caseName}`}
                  checked={selectedRunIds.has(candidate.executionRunId)}
                  disabled={!canManage || Boolean(candidate.claim)}
                  onChange={(event) => onToggle(candidate.executionRunId, event.target.checked)}
                  type="checkbox"
                />
              </TableCell>
              <TableCell>
                <strong
                  className={cn(
                    "failure-analysis-case-name",
                    failureAnalysisWorkspaceStyles["failure-analysis-case-name"],
                  )}
                  title={candidate.caseName}
                >
                  {candidate.caseName}
                </strong>
                <div
                  className={cn(
                    "failure-analysis-case-meta",
                    failureAnalysisWorkspaceStyles["failure-analysis-case-meta"],
                  )}
                >
                  <small>第 {candidate.attemptNumber} 次尝试</small>
                  <RecentSuccessBadge compact execution={candidate.recentSuccessfulExecution} />
                </div>
              </TableCell>
              <TableCell>
                <code
                  className={cn(
                    "failure-analysis-class-path",
                    failureAnalysisWorkspaceStyles["failure-analysis-class-path"],
                  )}
                  title={candidate.className}
                >
                  {candidate.className}
                </code>
              </TableCell>
              <TableCell>
                <span
                  className={cn(
                    "failure-analysis-stack",
                    failureAnalysisWorkspaceStyles["failure-analysis-stack"],
                  )}
                  title={candidate.failureSummary}
                >
                  {candidate.failureSummary}
                </span>
              </TableCell>
              <TableCell>
                {candidate.claim ? (
                  <span
                    className={cn(
                      failureAnalysisWorkspaceStyles["analysis-status"],
                      `analysis-status ${candidate.claim.status}`,
                    )}
                  >
                    {statusLabel(candidate.claim.status)}
                    <small>{candidate.claim.claimantDisplayName}</small>
                  </span>
                ) : (
                  <span
                    className={cn(
                      "analysis-status available",
                      failureAnalysisWorkspaceStyles["analysis-status"],
                    )}
                  >
                    待认领
                  </span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function RecentSuccessBadge({
  compact = false,
  execution,
}: {
  compact?: boolean;
  execution: FailureAnalysisRecentSuccess | undefined;
}) {
  if (!execution) return null;
  return (
    <span
      aria-label="同一任务近 5 批次执行有成功"
      className={cn(
        "failure-analysis-recent-success",
        failureAnalysisWorkspaceStyles["failure-analysis-recent-success"],
      )}
      title={`同一任务最近 5 个更早批次中，批次 #${execution.batchSequenceNumber} 执行成功`}
    >
      <History aria-hidden="true" size={13} /> {compact ? "近 5 批成功" : "近 5 批次有成功"}
    </span>
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
    <div
      className={cn(
        "failure-analysis-pagination",
        failureAnalysisWorkspaceStyles["failure-analysis-pagination"],
      )}
    >
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
    <div
      className={cn(
        "failure-analysis-floating-action",
        failureAnalysisWorkspaceStyles["failure-analysis-floating-action"],
      )}
    >
      <span>已选择 {count} 个用例</span>
      <Button disabled={loading} onClick={onClick} type="button" variant="primary">
        {loading ? (
          <LoaderCircle className={cn("spin", uiPatterns["spin"])} size={16} />
        ) : (
          <ClipboardCheck size={16} />
        )}
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
    <TableHead>
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
          <ArrowUpDown
            className={cn(
              "failure-analysis-sort-idle",
              failureAnalysisWorkspaceStyles["failure-analysis-sort-idle"],
            )}
            size={13}
          />
        )}
      </Button>
    </TableHead>
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
  const [remarkImages, setRemarkImages] = useState<File[]>([]);
  const [uploadedClaims, setUploadedClaims] = useState(claims);
  const [logClaim, setLogClaim] = useState<FailureAnalysisClaimView>();
  const [logComparison, setLogComparison] = useState<AnalysisLogComparison>();
  const closeLogComparison = useCallback(() => setLogComparison(undefined), []);
  const [previewImage, setPreviewImage] = useState<AnalysisImagePreview>();
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
  const [inheritanceCandidate, setInheritanceCandidate] = useState<
    FailureAnalysisHistoryItemView & { inheritanceScope: FailureAnalysisInheritanceScope }
  >();
  const [copying, setCopying] = useState(false);
  const publicLogUrls = useRef(new Map<string, string>());
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
  const historyBatchId = claims[0]!.batchId;
  const [inheritedConclusion, setInheritedConclusion] = useState<{
    id: string;
    scope: FailureAnalysisInheritanceScope;
  }>();
  const dialogRef = useRef<HTMLElement>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const nestedDialogOpen = Boolean(
    logClaim ||
    logComparison ||
    previewImage ||
    showCaseConfirmation ||
    showConclusionPicker ||
    inheritanceCandidate,
  );
  const hasUnsavedChanges =
    !readOnly &&
    (category !== initial?.category ||
      issueDescription !== (initial?.issueDescription ?? "") ||
      caseFixEvidence !== (initial?.caseFixEvidence ?? "") ||
      ticketReference !== (initial?.ticketReference ?? "") ||
      remark !== (initial?.remark ?? "") ||
      remarkImages.length > 0 ||
      Boolean(inheritedConclusion));
  function requestClose() {
    if (submitting || uploading || nestedDialogOpen) return;
    if (hasUnsavedChanges) setConfirmDiscard(true);
    else onClose();
  }

  const currentAnalysisIds = useMemo(() => new Set(claims.map((claim) => claim.id)), [claims]);
  const historyLimitPerCase = claims.length > 20 ? 1 : claims.length > 5 ? 2 : 5;
  const closeScreenshotPreview = useCallback(() => {
    setPreviewImage(undefined);
    window.requestAnimationFrame(() => imagePreviewTriggerRef.current?.focus());
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const parameters = new URLSearchParams({
      projectId,
      batchId: historyBatchId,
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
        if (controller.signal.aborted) return;
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
  }, [caseDefinitionIds, currentAnalysisIds, historyBatchId, historyLimitPerCase, projectId]);

  function openScreenshotPreview(
    claim: FailureAnalysisClaimView,
    trigger: HTMLButtonElement,
  ): void {
    if (!claim.screenshot) return;
    openImagePreview(
      {
        ...claim.screenshot,
        src: failureAnalysisEvidenceUrl(claim, projectId),
        alt: `重跑通过截图大图：${claim.screenshot.fileName}`,
      },
      trigger,
    );
  }

  function openImagePreview(image: AnalysisImagePreview, trigger: HTMLButtonElement): void {
    imagePreviewTriggerRef.current = trigger;
    setImageZoomPercent(100);
    setPreviewImage(image);
  }

  async function publicLogUrl(claim: FailureAnalysisClaimView): Promise<string> {
    const cached = publicLogUrls.current.get(claim.attemptId);
    if (cached) return cached;
    const response = await fetch(
      `/api/v1/run-attempts/${encodeURIComponent(claim.attemptId)}/log-share`,
      { method: "POST", signal: AbortSignal.timeout(15_000) },
    );
    if (!response.ok) throw new Error((await readApiErrorMessage(response, "创建公开日志失败。"))!);
    const { shareUrl } = (await response.json()) as { shareUrl: string };
    const url = new URL(shareUrl, window.location.origin).href;
    publicLogUrls.current.set(claim.attemptId, url);
    return url;
  }

  async function openPublicLog(claim: FailureAnalysisClaimView): Promise<void> {
    const openedWindow = window.open("", "_blank");
    setError("");
    try {
      const shareUrl = await publicLogUrl(claim);
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
      logComparison ||
      previewImage ||
      showCaseConfirmation ||
      showConclusionPicker ||
      inheritanceCandidate
    ) {
      return;
    }
    const handlePaste = (event: globalThis.ClipboardEvent): void => {
      if (
        !event.clipboardData ||
        event.defaultPrevented ||
        (event.target instanceof Element && event.target.closest("[data-analysis-remark]"))
      )
        return;
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
    logComparison,
    previewImage,
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
      const input = JSON.stringify({
        projectId,
        analysisIds: claims.map((claim) => claim.id),
        category,
        issueDescription,
        caseFixEvidence,
        ticketReference,
        remark,
        caseIssueConfirmed,
        ...(inheritedConclusion
          ? {
              inheritedFromAnalysisId: inheritedConclusion.id,
              inheritanceScope: inheritedConclusion.scope,
            }
          : {}),
      });
      const form = new FormData();
      form.set("input", input);
      for (const file of remarkImages) form.append("remarkImages", file);
      const response = await fetch("/api/v1/failure-analysis/claims/complete", {
        method: "POST",
        ...(remarkImages.length > 0
          ? { body: form }
          : { headers: { "content-type": "application/json" }, body: input }),
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
    if (
      !inheritanceCandidate ||
      readOnly ||
      (inheritanceCandidate.inheritanceScope === "same_case" &&
        (!initial || inheritanceCandidate.claim.caseDefinitionId !== initial.caseDefinitionId))
    )
      return;
    setInheritedConclusion({
      id: inheritanceCandidate.claim.id,
      scope: inheritanceCandidate.inheritanceScope,
    });
    setCategory(inheritanceCandidate.claim.category);
    setRerunProofLookup(undefined);
    setIssueDescription(inheritanceCandidate.claim.issueDescription ?? "");
    setCaseFixEvidence(inheritanceCandidate.claim.caseFixEvidence ?? "");
    setTicketReference(inheritanceCandidate.claim.ticketReference ?? "");
    setRemark(inheritanceCandidate.claim.remark ?? "");
    setInheritanceCandidate(undefined);
    setError("");
    toast.success(
      claims.length > 1
        ? `已将历史结论填入所选的 ${claims.length} 个用例，提交分析后保存。`
        : "已填入历史分析结论，提交分析后保存。",
    );
  }

  async function copyCaseInformation(): Promise<void> {
    if (copying) return;
    setCopying(true);
    setError("");
    try {
      const casesWithLogs = [];
      // Share creation writes audit metadata. Keep batch copies sequential and reuse signed links.
      for (const claim of claims) {
        casesWithLogs.push({ ...claim, logUrl: await publicLogUrl(claim) });
      }
      await copyRichTextToClipboard(
        formatFailureAnalysisClipboard(casesWithLogs, {
          ...(category ? { category } : {}),
          ...(issueDescription ? { issueDescription } : {}),
          ...(caseFixEvidence ? { caseFixEvidence } : {}),
          ...(ticketReference ? { ticketReference } : {}),
          ...(remark ? { remark } : {}),
        }),
      );
      toast.success(`已复制 ${claims.length} 个用例的信息、日志链接和当前分析结论。`);
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : "复制用例信息失败。");
    } finally {
      setCopying(false);
    }
  }

  return (
    <>
      <Dialog
        open
        title={
          claims.length > 1 ? `批量分析 ${claims.length} 个用例` : `分析 ${claims[0]?.caseName}`
        }
        onClose={requestClose}
        className={cn(
          "runner-update-dialog failure-analysis-dialog failure-analysis-completion-dialog",
          failureAnalysisWorkspaceStyles["runner-update-dialog"],
          failureAnalysisWorkspaceStyles["failure-analysis-dialog"],
          failureAnalysisWorkspaceStyles["failure-analysis-completion-dialog"],
        )}
        backdropClassName="runner-update-overlay failure-analysis-overlay"
        panelRef={dialogRef}
        inactive={Boolean(nestedDialogOpen)}
        panelProps={{ tabIndex: -1, "data-read-only": readOnly ? "true" : undefined }}
      >
        <header
          className={cn(
            "runner-update-titlebar",
            failureAnalysisWorkspaceStyles["runner-update-titlebar"],
          )}
        >
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
          <div
            className={cn(
              "failure-analysis-titlebar-actions",
              failureAnalysisWorkspaceStyles["failure-analysis-titlebar-actions"],
            )}
          >
            <Button
              disabled={copying}
              onClick={() => void copyCaseInformation()}
              size="compact"
              type="button"
              variant="secondary"
            >
              {copying ? (
                <LoaderCircle className={cn("spin", uiPatterns["spin"])} size={14} />
              ) : (
                <Copy size={14} />
              )}
              复制用例信息
            </Button>
            <Button
              disabled={submitting || uploading}
              aria-label="关闭分析弹窗"
              onClick={requestClose}
              type="button"
            >
              <X size={16} />
            </Button>
          </div>
        </header>
        <div
          className={cn(
            "runner-update-body failure-analysis-dialog-body",
            failureAnalysisWorkspaceStyles["runner-update-body"],
            failureAnalysisWorkspaceStyles["failure-analysis-dialog-body"],
          )}
        >
          {confirmDiscard ? (
            <DialogDiscardPrompt
              onContinue={() => setConfirmDiscard(false)}
              onDiscard={() => {
                if (!submitting && !uploading) onClose();
              }}
            />
          ) : null}
          <section
            className={cn(
              "failure-analysis-case-summary",
              failureAnalysisWorkspaceStyles["failure-analysis-case-summary"],
            )}
          >
            {claims.length > 1 ? <h3>{claims.length} 个最终失败用例</h3> : null}
            <div
              className={cn(
                "failure-analysis-case-list",
                failureAnalysisWorkspaceStyles["failure-analysis-case-list"],
              )}
            >
              {claims.map((claim) => (
                <article key={claim.id}>
                  <div>
                    <ExpandableText text={claim.caseName} label="用例名称" />
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

          <FailureAnalysisExecutionHistory
            claims={claims}
            projectId={projectId}
            onCompare={setLogComparison}
          />

          <AnalysisHistoryPanel
            historyError={historyError}
            historyItems={historyItems}
            historyLoading={historyLoading}
            historyLimitPerCase={historyLimitPerCase}
            canInheritSameCase={!readOnly && claims.length === 1}
            canBrowseTaskConclusions={!readOnly}
            onBrowse={() => setShowConclusionPicker(true)}
            onInherit={(item) =>
              setInheritanceCandidate({ ...item, inheritanceScope: "same_case" })
            }
            onPreview={(claim, trigger) => openScreenshotPreview(claim, trigger)}
            selectedCaseCount={claims.length}
          />

          <fieldset
            className={cn(
              "failure-analysis-category-options",
              failureAnalysisWorkspaceStyles["failure-analysis-category-options"],
            )}
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
                  {!readOnly ? (
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
                  ) : null}
                  <span>
                    <strong>{option.label}</strong>
                    <small>{option.description}</small>
                  </span>
                </label>
              ),
            )}
          </fieldset>

          {category === "rerun_passed" ? (
            <section
              className={cn(
                "failure-analysis-proof-panel",
                failureAnalysisWorkspaceStyles["failure-analysis-proof-panel"],
              )}
            >
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
                <div
                  className={cn(
                    "failure-analysis-proof-lookup",
                    failureAnalysisWorkspaceStyles["failure-analysis-proof-lookup"],
                  )}
                >
                  <Button
                    disabled={lookingUpRerunProofs || uploading}
                    onClick={() => void lookupRerunProofs()}
                    type="button"
                    variant="secondary"
                  >
                    {lookingUpRerunProofs ? (
                      <LoaderCircle className={cn("spin", uiPatterns["spin"])} size={15} />
                    ) : (
                      <SearchCheck size={15} />
                    )}
                    {lookingUpRerunProofs ? "正在查找…" : "查找重跑通过记录"}
                  </Button>
                  {!rerunProofLookup ? (
                    <small>尚未查找，提交分析暂不可用。</small>
                  ) : (
                    <div
                      className={cn(
                        "failure-analysis-proof-lookup-result",
                        failureAnalysisWorkspaceStyles["failure-analysis-proof-lookup-result"],
                      )}
                      role="status"
                    >
                      {foundRerunProofs.map((item) => {
                        const claim = claims.find((candidate) => candidate.id === item.analysisId);
                        return (
                          <a href={item.url} key={item.analysisId} rel="noreferrer" target="_blank">
                            <CheckCircle2 size={14} />
                            {claim?.caseName ?? item.analysisId} · 查看重跑通过日志
                          </a>
                        );
                      })}
                      {missingRerunProofs.length > 0 ? (
                        <span
                          className={cn(
                            "failure-analysis-proof-missing",
                            failureAnalysisWorkspaceStyles["failure-analysis-proof-missing"],
                          )}
                        >
                          <AlertTriangle size={15} />
                          {missingRerunProofs.length} 个用例未找到成功重跑记录，必须提交截图。
                        </span>
                      ) : (
                        <span
                          className={cn(
                            "failure-analysis-proof-found",
                            failureAnalysisWorkspaceStyles["failure-analysis-proof-found"],
                          )}
                        >
                          <CheckCircle2 size={15} /> 全部用例均已找到重跑通过日志。
                        </span>
                      )}
                    </div>
                  )}
                </div>
              ) : null}
              {uploadedClaims.some((claim) => claim.screenshot) ? (
                <>
                  <div
                    className={cn(
                      "failure-analysis-uploaded-proof",
                      failureAnalysisWorkspaceStyles["failure-analysis-uploaded-proof"],
                    )}
                  >
                    <CheckCircle2 size={17} />
                    <span>
                      通过截图已上传到平台对象存储
                      {claims.length > 1 ? "，并关联到全部选中用例" : ""}。
                    </span>
                  </div>
                  <div
                    className={cn(
                      "failure-analysis-proof-gallery",
                      failureAnalysisWorkspaceStyles["failure-analysis-proof-gallery"],
                    )}
                    aria-label="重跑通过截图"
                  >
                    {screenshotClaims.map((claim) => (
                      <Button
                        aria-label={`放大查看截图 ${claim.screenshot!.fileName}`}
                        className={cn(
                          "failure-analysis-proof-thumbnail",
                          failureAnalysisWorkspaceStyles["failure-analysis-proof-thumbnail"],
                        )}
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
                  className={cn(
                    "failure-analysis-paste-zone",
                    failureAnalysisWorkspaceStyles["failure-analysis-paste-zone"],
                  )}
                  role="group"
                  tabIndex={0}
                >
                  <ClipboardPaste size={24} />
                  <strong>
                    {uploading ? "正在保存粘贴的截图…" : "直接按 Ctrl + V 粘贴执行通过截图"}
                  </strong>
                  <span>无需点击选择文件；弹窗内任意位置均可粘贴，最大 10 MB</span>
                  <span
                    className={cn(
                      "failure-analysis-paste-shortcut",
                      failureAnalysisWorkspaceStyles["failure-analysis-paste-shortcut"],
                    )}
                    aria-hidden="true"
                  >
                    <kbd>Ctrl</kbd>
                    <b>+</b>
                    <kbd>V</kbd>
                    <small>macOS 使用 ⌘ + V</small>
                  </span>
                </div>
              ) : null}
              {readOnly && initial?.rerunProofUrl ? (
                <LinkButton
                  className={"ui-button ui-button-secondary"}
                  href={initial.rerunProofUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  <ExternalLink size={14} /> 查看重跑通过永久日志
                </LinkButton>
              ) : null}
            </section>
          ) : null}

          {category === "case_fixed" || category === "code_issue_filed" ? (
            <label
              className={cn(
                "failure-analysis-field",
                failureAnalysisWorkspaceStyles["failure-analysis-field"],
              )}
            >
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
            <label
              className={cn(
                "failure-analysis-field",
                failureAnalysisWorkspaceStyles["failure-analysis-field"],
              )}
            >
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
            <label
              className={cn(
                "failure-analysis-field",
                failureAnalysisWorkspaceStyles["failure-analysis-field"],
              )}
            >
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
            <FailureAnalysisRemark
              value={remark}
              onChange={setRemark}
              readOnly={readOnly}
              disabled={submitting}
              claims={uploadedClaims}
              projectId={projectId}
              onFilesChange={setRemarkImages}
              onPreview={openImagePreview}
              onError={setError}
            />
          ) : null}

          {error ? (
            <Notice tone="error" className={cn("form-error", uiPatterns["form-error"])}>
              {error}
            </Notice>
          ) : null}
        </div>
        <div className={"dialog-actions"}>
          <Button
            disabled={submitting || uploading}
            onClick={requestClose}
            type="button"
            variant="secondary"
          >
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
                <LoaderCircle className={cn("spin", uiPatterns["spin"])} size={16} />
              ) : (
                <CheckCircle2 size={16} />
              )}
              提交分析
            </Button>
          ) : null}
        </div>
      </Dialog>
      {logClaim ? (
        <AttemptLogViewer
          attemptId={logClaim.attemptId}
          attemptStatus="failed"
          canCreateRuns={false}
          canReadLogs
          onClose={() => setLogClaim(undefined)}
        />
      ) : null}
      {logComparison ? (
        <AttemptLogComparison comparison={logComparison} onClose={closeLogComparison} />
      ) : null}
      {previewImage ? (
        <Dialog
          open
          title={`图片预览 ${previewImage.fileName}`}
          onClose={closeScreenshotPreview}
          initialFocusRef={imageCloseButtonRef}
          className={cn(
            "failure-analysis-image-dialog",
            failureAnalysisWorkspaceStyles["failure-analysis-image-dialog"],
          )}
          backdropClassName="failure-analysis-image-overlay"
        >
          <header>
            <span>
              <strong>{previewImage.fileName}</strong>
              <small>{formatFileSize(previewImage.sizeBytes)}</small>
            </span>
            <div
              className={cn(
                "failure-analysis-image-controls",
                failureAnalysisWorkspaceStyles["failure-analysis-image-controls"],
              )}
              aria-label="图片缩放控制"
            >
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
          <div
            className={cn(
              "failure-analysis-image-viewport",
              failureAnalysisWorkspaceStyles["failure-analysis-image-viewport"],
            )}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- authenticated evidence must load directly with the browser session */}
            <img
              alt={previewImage.alt}
              src={previewImage.src}
              style={{ width: `${imageZoomPercent}%` }}
            />
          </div>
        </Dialog>
      ) : null}
      {showCaseConfirmation ? (
        <Dialog
          open
          role="alertdialog"
          zIndex={1100}
          title={"确认用例问题"}
          onClose={() => setShowCaseConfirmation(false)}
          className={cn(
            "runner-update-dialog failure-analysis-confirm-dialog",
            failureAnalysisWorkspaceStyles["runner-update-dialog"],
            failureAnalysisWorkspaceStyles["failure-analysis-confirm-dialog"],
          )}
          backdropClassName="runner-update-overlay failure-analysis-confirm-overlay"
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
          <div className={"dialog-actions"}>
            <Button
              onClick={() => setShowCaseConfirmation(false)}
              type="button"
              variant="secondary"
            >
              返回检查
            </Button>
            <Button
              className={cn(
                "failure-analysis-confirm-action",
                failureAnalysisWorkspaceStyles["failure-analysis-confirm-action"],
              )}
              disabled={submitting}
              onClick={() => void complete(true)}
              type="button"
              variant="danger"
            >
              我已核实，确认提交
            </Button>
          </div>
        </Dialog>
      ) : null}
      {showConclusionPicker && !readOnly ? (
        <FailureAnalysisConclusionPicker
          batchId={historyBatchId}
          caseDefinitionId={claims[0]!.caseDefinitionId}
          excludedAnalysisIds={currentAnalysisIds}
          onClose={() => setShowConclusionPicker(false)}
          onSelect={(item) => {
            setShowConclusionPicker(false);
            setInheritanceCandidate({ ...item, inheritanceScope: "task_recent_batches" });
          }}
          projectId={projectId}
        />
      ) : null}
      {inheritanceCandidate ? (
        <Dialog
          open
          role="alertdialog"
          zIndex={1100}
          title={
            inheritanceCandidate.claim.category === "code_issue_filed"
              ? "确认继承未闭环代码问题"
              : "确认继承分析结论"
          }
          onClose={() => setInheritanceCandidate(undefined)}
          className={cn(
            "runner-update-dialog failure-analysis-confirm-dialog",
            failureAnalysisWorkspaceStyles["runner-update-dialog"],
            failureAnalysisWorkspaceStyles["failure-analysis-confirm-dialog"],
          )}
          backdropClassName="runner-update-overlay failure-analysis-confirm-overlay"
        >
          <header>
            <AlertTriangle size={24} />
            <div>
              <strong>
                {inheritanceCandidate.claim.category === "code_issue_filed"
                  ? "确认问题单尚未闭环"
                  : "确认沿用该分析结论"}
              </strong>
              <p>
                来源：批次 #{inheritanceCandidate.batchSequenceNumber} ·{" "}
                {inheritanceCandidate.claim.caseName}
                {inheritanceCandidate.inheritanceScope === "task_recent_batches"
                  ? "（本任务近 5 次批跑）"
                  : "（当前用例历史）"}
              </p>
              {claims.length > 1 ? (
                <p>
                  该结论将填入所选的全部 {claims.length}{" "}
                  个用例，请确认这些用例失败根因一致；点击“提交分析”后保存。
                </p>
              ) : null}
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
          <div className={"dialog-actions"}>
            <Button
              onClick={() => setInheritanceCandidate(undefined)}
              type="button"
              variant="secondary"
            >
              返回重新分析
            </Button>
            <Button
              className={cn(
                "failure-analysis-confirm-action",
                failureAnalysisWorkspaceStyles["failure-analysis-confirm-action"],
              )}
              onClick={inheritConclusion}
              type="button"
              variant="danger"
            >
              {inheritanceCandidate.claim.category === "code_issue_filed"
                ? "问题仍存在，继承结论"
                : "确认继承结论"}
            </Button>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}

function AnalysisHistoryPanel({
  historyItems,
  historyLoading,
  historyError,
  historyLimitPerCase,
  canInheritSameCase,
  canBrowseTaskConclusions,
  selectedCaseCount,
  onInherit,
  onBrowse,
  onPreview,
}: {
  historyItems: FailureAnalysisHistoryItemView[];
  historyLoading: boolean;
  historyError: string;
  historyLimitPerCase: number;
  canInheritSameCase: boolean;
  canBrowseTaskConclusions: boolean;
  selectedCaseCount: number;
  onInherit: (item: FailureAnalysisHistoryItemView) => void;
  onBrowse: () => void;
  onPreview: (claim: FailureAnalysisClaimView, trigger: HTMLButtonElement) => void;
}) {
  return (
    <section
      className={cn(
        "failure-analysis-history-panel",
        failureAnalysisWorkspaceStyles["failure-analysis-history-panel"],
      )}
    >
      <header>
        <span>
          <History size={18} />
          <strong>历史分析结论</strong>
        </span>
        <span
          className={cn(
            "failure-analysis-history-header-actions",
            failureAnalysisWorkspaceStyles["failure-analysis-history-header-actions"],
          )}
        >
          <small>
            {selectedCaseCount > 1
              ? `同一任务 · 按用例展示最近 ${historyLimitPerCase} 条`
              : `同一任务 · 当前用例最近 ${historyLimitPerCase} 条`}
          </small>
          {canBrowseTaskConclusions ? (
            <Button onClick={onBrowse} size="compact" type="button" variant="secondary">
              <ClipboardPaste size={13} /> 从本任务近 5 次批跑继承
            </Button>
          ) : null}
        </span>
      </header>
      {historyLoading ? (
        <div
          className={cn(
            "failure-analysis-history-state",
            failureAnalysisWorkspaceStyles["failure-analysis-history-state"],
          )}
          role="status"
        >
          <LoaderCircle className={cn("spin", uiPatterns["spin"])} size={16} /> 正在读取历史结论…
        </div>
      ) : historyError ? (
        <div
          className={cn(
            "failure-analysis-history-state error",
            failureAnalysisWorkspaceStyles["failure-analysis-history-state"],
            uiPatterns["error"],
          )}
          role="alert"
        >
          {historyError}
        </div>
      ) : historyItems.length === 0 ? (
        <div
          className={cn(
            "failure-analysis-history-state",
            failureAnalysisWorkspaceStyles["failure-analysis-history-state"],
          )}
        >
          同一任务下，该用例暂无已完成的历史分析结论。
        </div>
      ) : (
        <div
          className={cn(
            "failure-analysis-history-cards",
            failureAnalysisWorkspaceStyles["failure-analysis-history-cards"],
          )}
        >
          {historyItems.map((item) => (
            <article key={item.claim.id}>
              <div
                className={cn(
                  "failure-analysis-history-heading",
                  failureAnalysisWorkspaceStyles["failure-analysis-history-heading"],
                )}
              >
                <span
                  className={cn(
                    "analysis-status completed",
                    failureAnalysisWorkspaceStyles["analysis-status"],
                  )}
                >
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
              <div
                className={cn(
                  "failure-analysis-history-actions",
                  failureAnalysisWorkspaceStyles["failure-analysis-history-actions"],
                )}
              >
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
                {canInheritSameCase ? (
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

const failureAnalysisWorkspaceStyles = {
  "analysis-status":
    "inline-flex max-w-full [flex:0_0_auto] flex-wrap items-center gap-[5px] py-[3px] px-[7px] rounded-full bg-muted text-muted-foreground text-xs font-semibold [&.available]:bg-info/10 [&.available]:text-info [&.claimed]:bg-warning/10 [&.claimed]:text-warning [&.analyzing]:bg-info/10 [&.analyzing]:text-info [&.completed]:bg-success/10 [&.completed]:text-success [&_small]:overflow-hidden [&_small]:max-w-full [&_small]:text-inherit! [&_small]:text-ellipsis [&_small]:whitespace-nowrap",
  "failure-analysis-card":
    "grid grid-cols-[24px_minmax(220px,_1fr)_minmax(170px,_0.32fr)_auto] items-center gap-2.5 py-[9px] px-[11px] border border-solid border-border rounded-lg bg-card shadow-xs [&_h3]:m-0 [&_h3]:text-sm [&_p]:m-0 [&_p]:[display:-webkit-box] [&_p]:mt-[3px] [&_p]:overflow-hidden [&_p]:text-muted-foreground [&_p]:leading-[1.35] [&_p]:[overflow-wrap:anywhere] [&_p]:[-webkit-box-orient:vertical] [&_p]:[-webkit-line-clamp:1] [&_dl]:m-0 [&_dl]:grid [&_dl]:grid-cols-[1fr] [&_dl]:gap-[3px] [&_dl]:leading-[1.3] [&_code]:block [&_code]:mt-0.5 [&_code]:overflow-hidden [&_code]:[overflow-wrap:anywhere] [&_code]:text-info [&_code]:font-mono [&_code]:text-xs [&_code]:text-ellipsis [&_code]:whitespace-nowrap [&_dl_>_div]:grid [&_dl_>_div]:gap-px [&_dt]:text-muted-foreground [&_dt]:text-xs [&_dd]:m-0 [&_dd]:text-sm [&_dd]:leading-4 [&_dd]:font-semibold max-[1181px]:grid-cols-[24px_minmax(200px,_1fr)_minmax(155px,_0.32fr)_auto]",
  "failure-analysis-card-actions": "grid min-w-[104px] gap-1",
  "failure-analysis-card-list": "grid gap-1.5",
  "failure-analysis-card-main": "min-w-0",
  "failure-analysis-card-title":
    "flex min-w-0 items-center gap-[7px] [&_h3]:[flex:1_1_auto] [&_h3]:min-w-0 [&_h3]:overflow-hidden [&_h3]:text-ellipsis [&_h3]:whitespace-nowrap",
  "failure-analysis-case-list":
    "[&_article]:flex [&_article]:items-center [&_article]:justify-between [&_article]:gap-[9px] [&_article]:py-[7px] [&_article]:px-[9px] [&_article]:border [&_article]:border-solid [&_article]:border-border [&_article]:rounded-lg [&_article]:bg-card [&_article_>_span]:flex [&_article_>_span]:items-center [&_article_>_span]:[flex:0_0_auto] [&_article_>_span]:gap-[7px] [&_strong]:[overflow-wrap:anywhere] grid min-w-0 grid-cols-[minmax(0,_1fr)] max-h-[236px] gap-1 overflow-y-auto [&_article_>_div]:grid [&_article_>_div]:min-w-0 [&_article_>_div]:gap-px [&_code]:overflow-hidden [&_code]:text-ellipsis [&_code]:whitespace-nowrap [&_code]:text-info [&_code]:text-xs [&_small]:overflow-hidden [&_small]:text-ellipsis [&_small]:whitespace-nowrap [&_small]:text-muted-foreground [&_.expandable-text]:font-semibold",
  "failure-analysis-case-meta": "flex min-w-0 items-center gap-1.5 mt-0.5",
  "failure-analysis-case-name": "block! overflow-hidden text-ellipsis whitespace-nowrap",
  "failure-analysis-case-summary":
    "grid gap-2 p-2.5 border border-solid border-border rounded-lg bg-card min-w-0 grid-cols-[minmax(0,_1fr)] [border-color:color-mix(in_srgb,_var(--info)_20%,_var(--border))] [&_h3]:[overflow-wrap:anywhere] [&_.failure-analysis-case-list_article]:p-2",
  "failure-analysis-category-options":
    'grid grid-cols-3 gap-2.5 p-0 border-0 [&_legend]:col-span-full [&_legend]:mb-px [&_legend]:text-foreground [&_legend]:text-sm [&_legend]:font-semibold [&_>_label]:flex [&_>_label]:items-start [&_>_label]:gap-[11px] [&_>_label]:min-h-22 [&_>_label]:p-[13px] [&_>_label]:border [&_>_label]:border-solid [&_>_label]:border-border [&_>_label]:rounded-lg [&_>_label]:bg-muted [&_>_label]:cursor-pointer [&[data-read-only="true"]]:grid-cols-[minmax(0,_1fr)] [&[data-read-only="true"]_>_label]:min-h-auto [&[data-read-only="true"]_>_label]:cursor-default [&_>_label.is-selected]:border-muted [&_>_label.is-selected]:bg-info/10 [&_>_label.is-selected]:shadow-lg [&_label_>_span]:grid [&_label_>_span]:gap-1 [&_small]:text-muted-foreground [&_small]:leading-[1.45]',
  "failure-analysis-claim-group":
    "grid gap-[7px] [&_>_h3]:flex [&_>_h3]:items-center [&_>_h3]:gap-[7px] [&_>_h3]:m-0 [&_>_h3]:text-muted-foreground [&_>_h3]:text-sm [&_>_h3_>_span]:rounded-full [&_>_h3_>_span]:py-0.5 [&_>_h3_>_span]:px-[7px] [&_>_h3_>_span]:bg-muted [&_>_h3_>_span]:text-muted-foreground [&_>_h3_>_span]:text-xs [&_>_h3_>_span]:font-semibold",
  "failure-analysis-claim-view": "grid gap-3 min-w-0",
  "failure-analysis-class-path": "block! overflow-hidden text-ellipsis whitespace-nowrap",
  "failure-analysis-completed-filter":
    "inline-flex min-h-8 items-center gap-[7px] py-0 px-2 text-muted-foreground text-xs font-semibold whitespace-nowrap",
  "failure-analysis-completion-dialog":
    'w-[min(980px,_calc(100vw_-_56px))] min-w-0 grid-cols-[minmax(0,_1fr)] [grid-template-rows:auto_minmax(0,_1fr)_auto] max-h-[calc(100vh_-_48px)] [&_.runner-update-body]:min-w-0 [&_.runner-update-body]:min-h-0 [&_.runner-update-body]:grid-cols-[minmax(0,_1fr)] [&_.runner-update-body]:overflow-y-auto [&_.runner-update-titlebar_>_span]:min-w-0 [&_.runner-update-titlebar_strong]:[flex:0_0_auto] [&_.runner-update-titlebar_small]:min-w-0 [&_.runner-update-titlebar_small]:overflow-hidden [&_.runner-update-titlebar_small]:text-ellipsis [&_.runner-update-titlebar_small]:whitespace-nowrap [&_.dialog-actions]:flex [&_.dialog-actions]:justify-end [&_.dialog-actions]:gap-2 [&_.dialog-actions]:border-t [&_.dialog-actions]:border-solid [&_.dialog-actions]:border-border [&_.dialog-actions]:py-3 [&_.dialog-actions]:px-4.5 [&_.dialog-actions]:[background:color-mix(in_srgb,_var(--card)_96%,_transparent)] [&_.dialog-actions]:shadow-lg [&[data-read-only="true"]_.ui-input:disabled]:border-border [&[data-read-only="true"]_.ui-input:disabled]:bg-muted [&[data-read-only="true"]_.ui-input:disabled]:text-foreground [&[data-read-only="true"]_.ui-input:disabled]:opacity-100 [&[data-read-only="true"]_.ui-input:disabled]:[-webkit-text-fill-color:var(--foreground)] [&[data-read-only="true"]_.ui-textarea:disabled]:border-border [&[data-read-only="true"]_.ui-textarea:disabled]:bg-muted [&[data-read-only="true"]_.ui-textarea:disabled]:text-foreground [&[data-read-only="true"]_.ui-textarea:disabled]:opacity-100 [&[data-read-only="true"]_.ui-textarea:disabled]:[-webkit-text-fill-color:var(--foreground)]',
  "failure-analysis-confirm-action":
    "[&.ui-button-danger]:border-transparent [&.ui-button-danger]:bg-destructive [&.ui-button-danger]:text-primary-foreground [&.ui-button-danger]:shadow-xs",
  "failure-analysis-confirm-dialog":
    "[&_header]:flex [&_header]:items-start [&_header]:min-w-0 [&_header]:min-h-0 [&_header]:overflow-y-auto [&_header]:[overscroll-behavior:contain] [&_header]:gap-3 [&_header]:text-warning w-[min(560px,_calc(100vw_-_48px))] min-w-0 [grid-template-rows:minmax(0,_1fr)_auto] p-5.5 [&_header_>_svg]:[box-sizing:content-box] [&_header_>_svg]:[flex:0_0_auto] [&_header_>_svg]:rounded-full [&_header_>_svg]:p-[9px] [&_header_>_svg]:bg-warning/10 [&_header_>_div]:grid [&_header_>_div]:min-w-0 [&_header_>_div]:gap-[7px] [&_header_strong]:text-foreground [&_header_strong]:text-lg [&_header_p]:m-0 [&_header_p]:[overflow-wrap:anywhere] [&_header_p]:text-muted-foreground [&_header_p]:leading-[1.6] [&_.dialog-actions]:flex [&_.dialog-actions]:justify-end [&_.dialog-actions]:gap-2 [&_.dialog-actions]:mt-4",
  "failure-analysis-confirm-overlay": "z-[240]",
  "failure-analysis-dialog": "w-[min(620px,_92vw)]",
  "failure-analysis-dialog-body":
    "min-w-0 grid-cols-[minmax(0,1fr)] [&_h3]:m-0 [&_h3]:mt-1 [&_h3]:text-lg [&_p]:m-0 [&_p]:mt-1.5 [&_p]:text-muted-foreground [&_p]:leading-[1.55]",
  "failure-analysis-empty":
    "grid min-h-[190px] place-items-center [align-content:center] gap-[9px] p-7 border border-dashed border-border rounded-lg bg-muted text-muted-foreground text-center [&_strong]:text-foreground",
  "failure-analysis-field":
    "grid gap-[7px] text-muted-foreground text-sm font-semibold [&_>_span_strong]:text-destructive [&_>_span_small]:text-muted-foreground [&_>_span_small]:font-medium",
  "failure-analysis-filter":
    "flex items-end gap-3 [&_>_label]:grid [&_>_label]:w-[min(680px,_100%)] [&_>_label]:gap-[7px] [&_>_label]:text-muted-foreground [&_>_label]:text-xs [&_>_label]:font-semibold max-[1025px]:[&_>_label]:w-full",
  "failure-analysis-floating-action":
    "fixed z-40 right-8 bottom-7 flex items-center gap-3 [padding:10px_10px_10px_16px] border border-solid border-border rounded-full bg-card shadow-xs [&_>_span]:text-muted-foreground [&_>_span]:text-sm [&_>_span]:font-semibold max-[1025px]:right-5 max-[1025px]:bottom-5",
  "failure-analysis-grouped-list": "grid gap-3",
  "failure-analysis-history-actions":
    "flex items-center flex-wrap justify-end gap-2 [&_>_a]:inline-flex [&_>_a]:items-center [&_>_a]:gap-1 [&_>_a]:text-xs [&_>_a]:font-semibold",
  "failure-analysis-history-cards":
    "grid max-h-[290px] gap-[5px] overflow-y-auto [overscroll-behavior:contain] [&_>_article]:grid [&_>_article]:gap-1.5 [&_>_article]:border [&_>_article]:border-solid [&_>_article]:border-border [&_>_article]:rounded-lg [&_>_article]:py-2 [&_>_article]:px-[9px] [&_>_article]:bg-card [&_dl]:grid [&_dl]:grid-cols-2 [&_dl]:gap-[4px_12px] [&_dl]:m-0 [&_dl_>_div]:min-w-0 [&_dt]:text-muted-foreground [&_dt]:text-xs [&_dd]:[display:-webkit-box] [&_dd]:[margin:2px_0_0] [&_dd]:overflow-hidden [&_dd]:text-muted-foreground [&_dd]:leading-[1.45] [&_dd]:[overflow-wrap:anywhere] [&_dd]:[-webkit-box-orient:vertical] [&_dd]:[-webkit-line-clamp:2]",
  "failure-analysis-history-header-actions":
    "flex [flex:0_0_auto] items-center gap-[7px] flex-wrap justify-end",
  "failure-analysis-history-heading":
    "flex items-center min-w-0 gap-2 [&_>_strong]:min-w-0 [&_>_strong]:overflow-hidden [&_>_strong]:text-ellipsis [&_>_strong]:whitespace-nowrap [&_>_small]:ml-auto [&_>_small]:text-muted-foreground [&_>_small]:whitespace-nowrap",
  "failure-analysis-history-panel":
    "grid gap-2 border border-solid border-border rounded-lg py-2 px-3 [background:color-mix(in_srgb,_color-mix(in_srgb,_var(--info)_10%,_transparent)_34%,_var(--card))] [&_>_header]:flex [&_>_header]:items-center [&_>_header]:justify-between [&_>_header]:gap-3 [&_>_header_>_span]:flex [&_>_header_>_span]:items-center [&_>_header_>_span]:gap-[7px] [&_>_header_small]:text-muted-foreground [&_.failure-analysis-history-state]:m-0 [&_.failure-analysis-history-state]:py-1 [&_.failure-analysis-history-state]:min-h-0 [&_.failure-analysis-history-state:not(.error)]:justify-start [&_.failure-analysis-history-state:not(.error)]:border-0 [&_.failure-analysis-history-state:not(.error)]:bg-transparent",
  "failure-analysis-history-state":
    "flex min-h-13.5 items-center justify-center gap-[7px] border border-dashed border-border rounded-lg text-muted-foreground text-sm [&.error]:[border-color:color-mix(in_srgb,_var(--destructive)_28%,_var(--border))] [&.error]:text-destructive",
  "failure-analysis-image-controls":
    "flex [flex:0_0_auto] items-center gap-1.5 [&_output]:min-w-13.5 [&_output]:text-muted-foreground [&_output]:text-xs [&_output]:font-semibold [&_output]:text-center",
  "failure-analysis-image-dialog":
    "grid w-[min(1440px,_calc(100vw_-_48px))] h-[min(900px,_calc(100vh_-_48px))] [grid-template-rows:auto_minmax(0,_1fr)] overflow-hidden border border-solid border-transparent rounded-xl bg-card shadow-lg [&_>_header]:flex [&_>_header]:items-center [&_>_header]:justify-between [&_>_header]:gap-4 [&_>_header]:border-b [&_>_header]:border-solid [&_>_header]:border-border [&_>_header]:[padding:11px_13px_11px_17px] [&_>_header_>_span]:grid [&_>_header_>_span]:min-w-0 [&_>_header_>_span]:gap-0.5 [&_>_header_strong]:overflow-hidden [&_>_header_strong]:text-ellipsis [&_>_header_strong]:whitespace-nowrap [&_>_header_small]:text-muted-foreground",

  "failure-analysis-image-viewport":
    "overflow-auto p-4.5 bg-card text-center [&_>_img]:block [&_>_img]:h-auto [&_>_img]:max-w-none [&_>_img]:my-0 [&_>_img]:mx-auto [&_>_img]:rounded-lg [&_>_img]:bg-card [&_>_img]:shadow-xs",
  "failure-analysis-name-column": "w-[24%] max-[1025px]:w-[26%]",
  "failure-analysis-order-control":
    "grid min-w-[138px] gap-[3px] text-muted-foreground text-xs font-semibold [&_.ui-select-trigger]:min-h-8 [&_.ui-select-trigger]:py-0 [&_.ui-select-trigger]:px-[9px]",
  "failure-analysis-pagination":
    "flex items-center justify-between gap-3 [&_>_span]:text-muted-foreground [&_>_span]:text-xs",
  "failure-analysis-paste-shortcut":
    "inline-flex! items-center! gap-[5px]! mt-[3px] [&_kbd]:min-w-[31px] [&_kbd]:border [&_kbd]:border-solid [&_kbd]:border-border [&_kbd]:[border-bottom-width:2px] [&_kbd]:rounded-md [&_kbd]:py-1 [&_kbd]:px-[7px] [&_kbd]:bg-card [&_kbd]:text-foreground [&_kbd]:font-mono [&_kbd]:text-xs [&_kbd]:font-semibold [&_kbd]:shadow-xs [&_b]:text-muted-foreground [&_b]:text-xs [&_small]:ml-[5px] [&_small]:text-muted-foreground",
  "failure-analysis-paste-zone":
    'grid! min-h-[146px] place-items-center [align-content:center]! gap-[7px]! border border-dashed border-border rounded-lg bg-card text-muted-foreground text-center [&_>_svg]:text-info [&[aria-busy="true"]]:opacity-72 [&:focus-visible]:[outline:3px_solid_var(--ring)] [&:focus-visible]:[outline-offset:2px]',
  "failure-analysis-path-column": "w-[24%] max-[1025px]:w-[23%]",
  "failure-analysis-proof-found": "bg-success/10 text-success",
  "failure-analysis-proof-gallery":
    "grid! grid-cols-[repeat(auto-fit,_minmax(210px,_1fr))] gap-2.5!",
  "failure-analysis-proof-lookup":
    "grid! grid-cols-[max-content_minmax(0,_1fr)] items-center! gap-2!",
  "failure-analysis-proof-lookup-result":
    "flex min-w-0 items-center gap-[7px] flex-wrap [&_a]:inline-flex [&_a]:items-center [&_a]:gap-[5px] [&_a]:rounded-lg [&_a]:py-1.5 [&_a]:px-2 [&_a]:text-xs [&_a]:font-semibold [&_a]:bg-success/10 [&_a]:text-success [&_>_span]:inline-flex [&_>_span]:items-center [&_>_span]:gap-[5px] [&_>_span]:rounded-lg [&_>_span]:py-1.5 [&_>_span]:px-2 [&_>_span]:text-xs [&_>_span]:font-semibold",
  "failure-analysis-proof-missing": "bg-warning/10 text-warning",
  "failure-analysis-proof-panel":
    "[&_>_div]:flex [&_>_div]:items-start [&_>_div]:gap-[9px] grid gap-2 p-2.5 border border-solid border-border rounded-lg bg-muted [&_>_div_>_span]:grid [&_>_div_>_span]:gap-[3px] [&_small]:text-muted-foreground [&_small]:leading-[1.45]",
  "failure-analysis-proof-thumbnail":
    "relative grid min-w-0 grid-cols-[104px_minmax(0,_1fr)_auto] items-center gap-2.5 overflow-hidden border border-solid border-border rounded-lg p-2 bg-card text-muted-foreground cursor-zoom-in text-left transition-colors duration-150 motion-reduce:transition-none [&:hover]:[border-color:color-mix(in_srgb,_var(--info)_42%,_var(--border))] [&:hover]:shadow-xs [&:focus-visible]:[outline:3px_solid_var(--ring)] [&:focus-visible]:[outline-offset:2px] [&_>_img]:w-[104px] [&_>_img]:h-17 [&_>_img]:rounded-xl [&_>_img]:bg-muted [&_>_img]:[object-fit:contain] [&_>_span]:grid [&_>_span]:min-w-0 [&_>_span]:gap-[3px] [&_strong]:overflow-hidden [&_strong]:text-ellipsis [&_strong]:whitespace-nowrap [&_strong]:text-foreground [&_small]:overflow-hidden [&_small]:text-ellipsis [&_small]:whitespace-nowrap [&_small]:text-muted-foreground",
  "failure-analysis-recent-success":
    "inline-flex min-h-6 [flex:0_0_auto] items-center gap-1 border border-solid border-border rounded-full py-0.5 px-[7px] bg-card text-success text-xs font-semibold whitespace-nowrap",
  "failure-analysis-release-dialog":
    "grid w-[min(540px,_calc(100vw_-_48px))] gap-4 p-5.5 [&_>_header]:flex [&_>_header]:items-start [&_>_header]:gap-3 [&_>_header_>_div]:grid [&_>_header_>_div]:min-w-0 [&_>_header_>_div]:gap-1.5 [&_>_header_strong]:text-foreground [&_>_header_strong]:text-lg [&_>_header_p]:m-0 [&_>_header_p]:text-muted-foreground [&_>_header_p]:leading-[1.55] [&_.failure-analysis-field_>_small]:justify-self-end [&_.failure-analysis-field_>_small]:text-muted-foreground [&_.failure-analysis-field_>_small]:font-medium [&_.dialog-actions]:flex [&_.dialog-actions]:justify-end [&_.dialog-actions]:gap-2",
  "failure-analysis-release-icon":
    "inline-flex [flex:0_0_auto] rounded-full p-[9px] bg-destructive/10 text-destructive",
  "failure-analysis-release-note":
    "m-0 text-muted-foreground leading-[1.55] border-l-3 border-solid border-border py-[7px] px-2.5 rounded-none bg-warning/10 text-xs",
  "failure-analysis-release-trigger":
    "text-destructive [&:hover:not(:disabled)]:bg-destructive/10 [&:hover:not(:disabled)]:text-destructive",
  "failure-analysis-search-control":
    "relative block [&_>_svg]:absolute [&_>_svg]:z-1 [&_>_svg]:top-1/2 [&_>_svg]:left-3 [&_>_svg]:text-muted-foreground [&_>_svg]:[transform:translateY(-50%)] [&_.ui-input]:pl-9!",
  "failure-analysis-select-all":
    "flex w-full items-center gap-2 border border-solid border-border rounded-lg py-[7px] px-2.5 bg-muted text-muted-foreground text-sm font-semibold [&_>_span]:flex [&_>_span]:min-w-0 [&_>_span]:flex-1 [&_>_span]:items-center [&_>_span]:justify-between [&_>_span]:gap-3 [&_small]:text-muted-foreground [&_small]:text-xs [&_small]:font-medium",
  "failure-analysis-select-column": "w-11.5",
  "failure-analysis-shell": "grid gap-3 min-w-0 [padding:clamp(15px,_1.6vw,_22px)] overflow-hidden",
  "failure-analysis-sort-idle": "text-muted-foreground opacity-62",
  "failure-analysis-stack":
    "[display:-webkit-box] overflow-hidden text-muted-foreground leading-[1.35] [overflow-wrap:anywhere] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]",
  "failure-analysis-stack-column": "w-[30%] max-[1025px]:w-[29%]",
  "failure-analysis-status-column": "w-[120px] max-[1025px]:w-[112px]",
  "failure-analysis-table":
    "w-full [table-layout:fixed] [border-collapse:collapse] text-sm [&_th]:min-w-0 [&_th]:py-[7px] [&_th]:px-[9px] [&_th]:border-b [&_th]:border-solid [&_th]:border-border [&_th]:[vertical-align:top] [&_th]:text-left [&_th]:bg-muted [&_th]:text-muted-foreground [&_th]:text-xs [&_td]:min-w-0 [&_td]:py-[7px] [&_td]:px-[9px] [&_td]:border-b [&_td]:border-solid [&_td]:border-border [&_td]:[vertical-align:top] [&_td]:text-left [&_th_>_button]:inline-flex [&_th_>_button]:min-h-8 [&_th_>_button]:items-center [&_th_>_button]:gap-[5px] [&_th_>_button]:p-0 [&_th_>_button]:border-0 [&_th_>_button]:bg-transparent [&_th_>_button]:text-inherit [&_th_>_button]:[font:inherit] [&_th_>_button]:font-semibold [&_th_>_button]:cursor-pointer [&_th_>_button.is-active]:text-info [&_tbody_tr]:transition-colors [&_tbody_tr]:duration-150 [&_tbody_tr]:motion-reduce:transition-none [&_tbody_tr:hover]:[background:color-mix(in_srgb,_color-mix(in_srgb,_var(--info)_10%,_transparent)_38%,_transparent)] [&_tr:last-child_td]:border-b-0 [&_td_strong]:block [&_td_strong]:min-w-0 [&_td_small]:block [&_td_small]:min-w-0 [&_td_small]:mt-0.5 [&_td_small]:text-muted-foreground [&_td_small]:text-xs [&_td_code]:block [&_td_code]:min-w-0 [&_td_code]:[overflow-wrap:anywhere] [&_td_code]:text-info [&_td_code]:font-mono [&_td_code]:leading-[1.45] [&_td_.failure-analysis-case-meta_small]:inline [&_td_.failure-analysis-case-meta_small]:[flex:0_0_auto] [&_td_.failure-analysis-case-meta_small]:mt-0 [&_td_.failure-analysis-case-meta_small]:whitespace-nowrap [&_.failure-analysis-recent-success]:min-h-5 [&_.failure-analysis-recent-success]:min-w-0 [&_.failure-analysis-recent-success]:overflow-hidden [&_.failure-analysis-recent-success]:py-px [&_.failure-analysis-recent-success]:px-[5px] [&_.failure-analysis-recent-success]:text-ellipsis",
  "failure-analysis-table-wrap":
    "w-full min-w-0 overflow-hidden border border-solid border-border rounded-lg",
  "failure-analysis-tabs":
    "flex w-fit gap-1 p-1 border border-solid border-border rounded-lg bg-muted [&_.ui-button]:min-h-9 [&_.ui-button]:border-0 [&_.ui-button]:bg-transparent [&_.ui-button]:shadow-none [&_.ui-button]:text-muted-foreground [&_.ui-button.is-active]:bg-card [&_.ui-button.is-active]:shadow-xs [&_.ui-button.is-active]:text-foreground [&_.ui-button_span]:min-w-5.5 [&_.ui-button_span]:py-0.5 [&_.ui-button_span]:px-[7px] [&_.ui-button_span]:rounded-full [&_.ui-button_span]:bg-info/10 [&_.ui-button_span]:text-info [&_.ui-button_span]:text-xs",
  "failure-analysis-titlebar-actions": "flex [flex:0_0_auto] items-center gap-[7px]",
  "failure-analysis-uploaded-proof":
    "flex items-start gap-[9px] p-2.5 rounded-lg bg-success/10 text-success [&_a]:ml-auto [&_a]:text-inherit [&_a]:font-semibold",
  "failure-analysis-workbench": "grid gap-3 min-w-0",
  "failure-analysis-workbench-actions":
    "flex [flex:0_0_auto] items-end gap-[7px] flex-wrap justify-end max-[1025px]:w-full max-[1025px]:flex-wrap max-[1025px]:justify-start",
  "failure-analysis-workbench-heading":
    "flex items-start justify-between gap-3 [&_h2]:m-0 [&_h2]:mt-0.5 [&_h2]:text-lg [&_p]:m-0 [&_p]:mt-[3px] [&_p]:text-muted-foreground [&_p]:leading-[1.5] max-[1025px]:items-stretch max-[1025px]:flex-col",
  "runner-update-body": "grid gap-4 p-4.5 overflow-y-auto",
  "runner-update-dialog":
    "grid w-[min(640px,_92vw)] max-h-[86vh] [grid-template-rows:auto_minmax(0,_1fr)] overflow-hidden border border-solid border-border rounded-xl bg-card shadow-lg",

  "runner-update-titlebar":
    "flex items-center justify-between gap-3 py-3.5 px-4.5 border-b border-solid border-border [&_>_span]:flex [&_>_span]:items-center [&_>_span]:gap-2.5 [&_small]:text-muted-foreground",
} as const;
