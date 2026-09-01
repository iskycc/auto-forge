"use client";

import type {
  ClaimFailureAnalysisResult,
  FailureAnalysisCandidate,
  FailureAnalysisCandidatePage,
  FailureAnalysisSort,
} from "@autoforge/contracts";
import type { FailureAnalysisCategory, FailureAnalysisClaim } from "@autoforge/domain";
import {
  AlertTriangle,
  ArrowDownAZ,
  ArrowUpAZ,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  ExternalLink,
  FileCheck2,
  ImagePlus,
  LoaderCircle,
  Search,
  SquareActivity,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
} from "react";

import { AttemptLogViewer } from "@/components/attempt-log-viewer";
import { Button, Input, Textarea } from "@/components/ui";
import { readApiErrorMessage } from "@/lib/client-api";
import { formatPlatformDateTime } from "@/lib/platform-date-time";

type WorkspaceView = "claim" | "workbench";

const CATEGORY_OPTIONS: Array<{
  value: FailureAnalysisCategory;
  label: string;
  description: string;
}> = [
  {
    value: "rerun_passed",
    label: "重跑通过",
    description: "优先自动使用从公开日志页重跑成功的永久日志链接，否则必须上传通过截图。",
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
  initialBatchId,
  initialView,
}: {
  canManage: boolean;
  projectId: string;
  projectVersionId: string;
  initialCandidatePage: FailureAnalysisCandidatePage | null | undefined;
  initialClaimPage: { items: FailureAnalysisClaim[]; nextCursor?: string } | undefined;
  initialBatchId: string;
  initialView: WorkspaceView;
}) {
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
  const [claims, setClaims] = useState<FailureAnalysisClaim[]>(initialClaimPage?.items ?? []);
  const [claimsCursor, setClaimsCursor] = useState<string | undefined>(
    initialClaimPage?.nextCursor,
  );
  const [claimsPageCursor, setClaimsPageCursor] = useState<string>();
  const [claimsCursorHistory, setClaimsCursorHistory] = useState<Array<string | undefined>>([]);
  const [selectedRunIds, setSelectedRunIds] = useState<Set<string>>(() => new Set());
  const [selectedAnalysisIds, setSelectedAnalysisIds] = useState<Set<string>>(() => new Set());
  const [dialogClaims, setDialogClaims] = useState<FailureAnalysisClaim[]>();
  const [sort, setSort] = useState<FailureAnalysisSort>("class_path");
  const [direction, setDirection] = useState<"asc" | "desc">("asc");
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [loadingClaims, setLoadingClaims] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const candidateRequestSequence = useRef(0);
  const claimsRequestSequence = useRef(0);
  const skipInitialCandidateLoad = useRef(
    initialView === "claim" && initialCandidatePage !== undefined,
  );
  const skipInitialClaimsLoad = useRef(
    initialView === "workbench" && initialClaimPage !== undefined,
  );

  const updateLocation = useCallback(
    (nextView: WorkspaceView) => {
      window.history.replaceState(
        null,
        "",
        `/case-analysis/${encodeURIComponent(initialBatchId)}?view=${nextView}`,
      );
    },
    [initialBatchId],
  );

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
          limit: "50",
        });
        if (cursor) parameters.set("cursor", cursor);
        const response = await fetch(`/api/v1/failure-analysis/claims?${parameters}`, {
          cache: "no-store",
          ...(signal ? { signal } : {}),
        });
        if (!response.ok)
          throw new Error((await readApiErrorMessage(response, "读取已认领用例失败。"))!);
        const page = (await response.json()) as {
          items: FailureAnalysisClaim[];
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
    [initialBatchId, projectId, projectVersionId],
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

  function changeView(nextView: WorkspaceView): void {
    setView(nextView);
    setNotice("");
    updateLocation(nextView);
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
    setNotice("");
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
      setNotice(
        result.conflicts.length > 0
          ? `已认领 ${result.claimed.length} 个用例，另有 ${result.conflicts.length} 个已被其他用户认领。`
          : `已认领 ${result.claimed.length} 个用例，可以开始分析。`,
      );
      setSelectedRunIds(new Set());
      setView("workbench");
      updateLocation("workbench");
      setClaimsCursorHistory([]);
      setClaimsPageCursor(undefined);
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

  function applyCompletedClaims(updatedClaims: FailureAnalysisClaim[]): void {
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
    setNotice(`已完成 ${updatedClaims.length} 个用例的分析并永久保存。`);
  }

  return (
    <>
      <section className="content-card failure-analysis-shell">
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
            我的分析 <span>{claims.length}</span>
          </Button>
        </div>

        {error ? <p className="form-error">{error}</p> : null}
        {notice ? <p className="form-success">{notice}</p> : null}

        {view === "claim" ? (
          <div className="failure-analysis-claim-view" role="tabpanel">
            <form className="failure-analysis-filter" onSubmit={submitSearch}>
              <label>
                类路径、用例名称或失败堆栈
                <span className="failure-analysis-search-control">
                  <Search aria-hidden="true" size={15} />
                  <Input
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
              <div className="failure-analysis-empty">
                <LoaderCircle className="spin" size={22} /> 正在读取最终失败用例…
              </div>
            ) : candidates.length === 0 ? (
              <div className="failure-analysis-empty">
                <CheckCircle2 size={24} />
                <strong>当前任务没有可认领的最终失败用例</strong>
                <span>只统计任务最后一轮仍然失败的用例。</span>
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
              <Button onClick={() => changeView("claim")} type="button" variant="secondary">
                返回继续认领
              </Button>
            </div>
            {loadingClaims ? (
              <div className="failure-analysis-empty">
                <LoaderCircle className="spin" size={22} /> 正在读取分析队列…
              </div>
            ) : claims.length === 0 ? (
              <div className="failure-analysis-empty">
                <ClipboardCheck size={25} />
                <strong>当前任务还没有你认领的用例</strong>
                <Button onClick={() => changeView("claim")} type="button" variant="primary">
                  去认领失败用例
                </Button>
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
                  选择本页全部未完成分析
                </label>
                <div className="failure-analysis-card-list">
                  {claims.map((claim) => (
                    <article className="failure-analysis-card" key={claim.id}>
                      <Input
                        aria-label={`选择分析 ${claim.caseName}`}
                        checked={selectedAnalysisIds.has(claim.id)}
                        disabled={!canManage || claim.status === "completed"}
                        onChange={(event) =>
                          toggleSelection(setSelectedAnalysisIds, claim.id, event.target.checked)
                        }
                        type="checkbox"
                      />
                      <div className="failure-analysis-card-main">
                        <span className={`analysis-status ${claim.status}`}>
                          {statusLabel(claim.status)}
                        </span>
                        <h3>{claim.caseName}</h3>
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
                      <Button
                        disabled={!canManage}
                        onClick={() => setDialogClaims([claim])}
                        type="button"
                        variant={claim.status === "completed" ? "secondary" : "primary"}
                      >
                        {claim.status === "completed" ? "查看分析详情" : "开始分析"}
                      </Button>
                    </article>
                  ))}
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

      {canManage && view === "claim" && selectedRunIds.size > 0 ? (
        <FloatingAction
          count={selectedRunIds.size}
          label="认领并进入分析"
          loading={submitting}
          onClick={() => void claimSelected()}
        />
      ) : null}
      {canManage && view === "workbench" && selectedAnalysisIds.size > 0 ? (
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
    </>
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
                <strong>{candidate.caseName}</strong>
                <small>最终失败 · 第 {candidate.attemptNumber} 轮</small>
              </td>
              <td>
                <code>{candidate.className}</code>
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
        {active && direction === "desc" ? <ArrowDownAZ size={14} /> : <ArrowUpAZ size={14} />}
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
  claims: FailureAnalysisClaim[];
  projectId: string;
  readOnly: boolean;
  onClose: () => void;
  onCompleted: (claims: FailureAnalysisClaim[]) => void;
}) {
  const initial = claims.length === 1 ? claims[0] : undefined;
  const [category, setCategory] = useState<FailureAnalysisCategory | undefined>(initial?.category);
  const [issueDescription, setIssueDescription] = useState(initial?.issueDescription ?? "");
  const [caseFixEvidence, setCaseFixEvidence] = useState(initial?.caseFixEvidence ?? "");
  const [ticketReference, setTicketReference] = useState(initial?.ticketReference ?? "");
  const [remark, setRemark] = useState(initial?.remark ?? "");
  const [uploadedClaims, setUploadedClaims] = useState(claims);
  const [logClaim, setLogClaim] = useState<FailureAnalysisClaim>();
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [showCaseConfirmation, setShowCaseConfirmation] = useState(false);
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function openPublicLog(claim: FailureAnalysisClaim): Promise<void> {
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

  async function uploadScreenshot(file: File): Promise<void> {
    if (uploading || readOnly) return;
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
      const payload = (await response.json()) as { items: FailureAnalysisClaim[] };
      setUploadedClaims(payload.items);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "上传重跑证明失败。");
    } finally {
      setUploading(false);
    }
  }

  function pasteScreenshot(event: ClipboardEvent<HTMLDivElement>): void {
    const image = [...event.clipboardData.items]
      .find((item) => item.kind === "file" && item.type.startsWith("image/"))
      ?.getAsFile();
    if (!image) {
      setError("剪贴板中没有 PNG、JPEG 或 WebP 图片。");
      return;
    }
    event.preventDefault();
    void uploadScreenshot(image);
  }

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
      const payload = (await response.json()) as { items: FailureAnalysisClaim[] };
      onCompleted(payload.items);
    } catch (completeError) {
      setError(completeError instanceof Error ? completeError.message : "提交用例分析失败。");
      setShowCaseConfirmation(false);
    } finally {
      setSubmitting(false);
    }
  }

  function requestCompletion(): void {
    setError("");
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

  return (
    <>
      <div
        className="runner-update-overlay failure-analysis-overlay"
        role="presentation"
        onMouseDown={onClose}
      >
        <section
          aria-label={
            claims.length > 1 ? `批量分析 ${claims.length} 个用例` : `分析 ${claims[0]?.caseName}`
          }
          aria-modal="true"
          className="runner-update-dialog failure-analysis-dialog failure-analysis-completion-dialog"
          onMouseDown={(event) => event.stopPropagation()}
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
            <Button aria-label="关闭分析弹窗" onClick={onClose} type="button">
              <X size={16} />
            </Button>
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
                        第 {claim.attemptNumber} 轮 · {claim.failureSummary}
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

            <fieldset className="failure-analysis-category-options" disabled={readOnly}>
              <legend className="sr-only">失败类别</legend>
              {CATEGORY_OPTIONS.map((option) => (
                <label
                  className={category === option.value ? "is-selected" : ""}
                  key={option.value}
                >
                  <Input
                    checked={category === option.value}
                    name="failure-category"
                    onChange={() => setCategory(option.value)}
                    type="radio"
                    value={option.value}
                  />
                  <span>
                    <strong>{option.label}</strong>
                    <small>{option.description}</small>
                  </span>
                </label>
              ))}
            </fieldset>

            {category === "rerun_passed" ? (
              <section className="failure-analysis-proof-panel">
                <div>
                  <FileCheck2 size={18} />
                  <span>
                    <strong>重跑通过证明</strong>
                    <small>
                      提交时会自动查找这些用例从公开日志页发起的成功重跑，并生成永久公开日志链接。
                    </small>
                  </span>
                </div>
                {uploadedClaims.some((claim) => claim.screenshot) ? (
                  <div className="failure-analysis-uploaded-proof">
                    <CheckCircle2 size={17} />
                    <span>
                      通过截图已上传到平台对象存储
                      {claims.length > 1 ? "，并关联到全部选中用例" : ""}。
                    </span>
                    {uploadedClaims[0]?.screenshot ? (
                      <a
                        href={`/api/v1/failure-analysis/claims/${encodeURIComponent(uploadedClaims[0].id)}/evidence?projectId=${encodeURIComponent(projectId)}`}
                        rel="noreferrer"
                        target="_blank"
                      >
                        查看截图
                      </a>
                    ) : null}
                  </div>
                ) : null}
                {!readOnly ? (
                  <div
                    className="failure-analysis-paste-zone"
                    onClick={() => fileInputRef.current?.click()}
                    onPaste={pasteScreenshot}
                    role="button"
                    tabIndex={0}
                  >
                    <ImagePlus size={24} />
                    <strong>
                      {uploading ? "正在上传截图…" : "点击此处后直接粘贴执行通过截图"}
                    </strong>
                    <span>也可以点击选择 PNG、JPEG 或 WebP，最大 10 MB</span>
                    <Input
                      ref={fileInputRef}
                      accept="image/png,image/jpeg,image/webp"
                      className="sr-only"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void uploadScreenshot(file);
                        event.target.value = "";
                      }}
                      type="file"
                    />
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
                  disabled={!category || submitting || uploading}
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
      {showCaseConfirmation ? (
        <div
          className="runner-update-overlay failure-analysis-confirm-overlay"
          role="presentation"
          onMouseDown={() => setShowCaseConfirmation(false)}
        >
          <section
            aria-label="确认用例问题"
            aria-modal="true"
            className="runner-update-dialog failure-analysis-confirm-dialog"
            onMouseDown={(event) => event.stopPropagation()}
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
    </>
  );
}

function categoryLabel(category: FailureAnalysisCategory | undefined): string | undefined {
  return CATEGORY_OPTIONS.find((option) => option.value === category)?.label;
}

function statusLabel(status: FailureAnalysisClaim["status"]): string {
  return { claimed: "已认领", analyzing: "分析中", completed: "已完成" }[status];
}
