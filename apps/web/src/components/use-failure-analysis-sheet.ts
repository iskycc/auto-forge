"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  failureAnalysisSheetPageSchema,
  type ClaimFailureAnalysisResult,
  type FailureAnalysisClaimView,
  type FailureAnalysisSheetQuery,
  type FailureAnalysisSheetRow,
  type FailureAnalysisSheetPage,
} from "@autoforge/contracts";
import {
  analysisSheetDraft,
  type AnalysisSheetDraft,
  type AnalysisSheetField,
  fillAnalysisColumn,
} from "@/lib/failure-analysis-fill";
import { readApiErrorMessage, throwApiErrorResponse, ApiClientError } from "@/lib/client-api";
import { useConfirm, usePrompt, useToast } from "./ui-feedback";
import { useUnsavedForm } from "./use-unsaved-form";
import { analysisSheetQuery, analysisSheetFilterUrl } from "@/lib/failure-analysis-sheet-query";

export function useFailureAnalysisSheet({
  endpoint,
  currentUserId,
  canManage,
  onCompleted,
  onClaimed,
  initialPage,
}: {
  endpoint: string;
  currentUserId: string | null;
  canManage: boolean;
  onCompleted?: ((count: number) => void) | undefined;
  onClaimed?: ((count: number) => void) | undefined;
  initialPage?: FailureAnalysisSheetPage | undefined;
}) {
  const parameters = useSearchParams();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const toast = useToast();
  const unsaved = useUnsavedForm();
  const markSaved = unsaved.markSaved;
  const [query, setQuery] = useState<FailureAnalysisSheetQuery>(() =>
    analysisSheetQuery(parameters, currentUserId),
  );
  const [rows, setRows] = useState<FailureAnalysisSheetRow[]>(initialPage?.items ?? []);
  const [nextCursor, setNextCursor] = useState<string | undefined>(initialPage?.nextCursor);
  const [cursorHistory, setCursorHistory] = useState<(string | undefined)[]>([]);
  const [drafts, setDrafts] = useState<Readonly<Record<string, AnalysisSheetDraft>>>(() =>
    Object.fromEntries(
      (initialPage?.items ?? []).map((row) => [row.executionRunId, analysisSheetDraft(row)]),
    ),
  );
  const [dirtyIds, setDirtyIds] = useState<Set<string>>(() => new Set());
  const [fillUndo, setFillUndo] = useState<{
    drafts: Readonly<Record<string, AnalysisSheetDraft>>;
    dirtyIds: ReadonlySet<string>;
  }>();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(!initialPage);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number }>();
  const loadingController = useRef<AbortController | null>(null);
  const mutationRunning = useRef(false);
  const skipInitialLoad = useRef(Boolean(initialPage));
  const editable = new Set(
    rows
      .filter(
        (row) =>
          canManage &&
          row.analysis?.claimantId === currentUserId &&
          row.analysis.status !== "completed",
      )
      .map((row) => row.executionRunId),
  );

  const load = useCallback(
    async (input: FailureAnalysisSheetQuery) => {
      loadingController.current?.abort();
      const controller = new AbortController();
      loadingController.current = controller;
      setLoading(true);
      setError("");
      try {
        const search = new URLSearchParams({
          view: input.view,
          sort: input.sort,
          direction: input.direction,
          limit: String(input.limit),
        });
        if (input.query) search.set("query", input.query);
        if (input.cursor) search.set("cursor", input.cursor);
        const response = await fetch(`${endpoint}?${search}`, {
          cache: "no-store",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
        });
        if (!response.ok)
          throw new Error((await readApiErrorMessage(response, "读取分析表格失败。"))!);
        const page = failureAnalysisSheetPageSchema.parse(await response.json());
        if (controller.signal.aborted) return;
        setRows(page.items);
        setNextCursor(page.nextCursor);
        setDrafts(
          Object.fromEntries(
            page.items.map((row) => [row.executionRunId, analysisSheetDraft(row)]),
          ),
        );
        setDirtyIds(new Set());
        setFillUndo(undefined);
        setErrors({});
        setSelectedIds([]);
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "读取分析表格失败。");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [endpoint],
  );

  useEffect(() => {
    if (skipInitialLoad.current) {
      skipInitialLoad.current = false;
      return;
    }
    const timer = window.setTimeout(() => void load(query), 0);
    return () => {
      window.clearTimeout(timer);
      loadingController.current?.abort();
    };
  }, [load, query]);

  useEffect(() => {
    const pathname = window.location.pathname;
    const batchId = new URL(window.location.href).searchParams.get("BatchId");
    let disposed = false,
      asking = false;
    const pop = async () => {
      const url = new URL(window.location.href);
      if (asking || url.pathname !== pathname || url.searchParams.get("BatchId") !== batchId)
        return;
      const next = analysisSheetQuery(url.searchParams, currentUserId);
      if (
        next.view === query.view &&
        next.query === query.query &&
        next.sort === query.sort &&
        next.direction === query.direction
      )
        return;
      asking = true;
      const accepted =
        !busy &&
        (!dirtyIds.size ||
          (await confirm({
            title: "放弃未提交的分析草稿？",
            description: "返回其他筛选范围将丢弃当前未提交的修改。",
            confirmLabel: "放弃草稿并返回",
            tone: "danger",
          })));
      asking = false;
      if (disposed) return;
      if (!accepted) {
        window.history.replaceState(null, "", analysisSheetFilterUrl(window.location.href, query));
        return;
      }
      markSaved();
      setCursorHistory([]);
      setQuery(next);
    };
    const navigate = () => void pop();
    window.addEventListener("popstate", navigate);
    return () => {
      disposed = true;
      window.removeEventListener("popstate", navigate);
    };
  }, [query, currentUserId, busy, dirtyIds, confirm, markSaved]);

  async function discardAllowed() {
    return (
      !dirtyIds.size ||
      (await confirm({
        title: "放弃未提交的分析草稿？",
        description: `当前有 ${dirtyIds.size} 行草稿尚未提交，继续将丢弃这些修改。`,
        confirmLabel: "放弃草稿并继续",
        tone: "danger",
      }))
    );
  }
  async function changeQuery(patch: Partial<FailureAnalysisSheetQuery>) {
    if (busy || !(await discardAllowed())) return;
    unsaved.markSaved();
    const updated = { ...query, ...patch, cursor: undefined };
    setCursorHistory([]);
    setQuery(updated);
    window.history.pushState(null, "", analysisSheetFilterUrl(window.location.href, updated));
  }
  async function refresh() {
    if (busy || !(await discardAllowed())) return;
    unsaved.markSaved();
    await load(query);
  }
  async function movePage(forward: boolean) {
    if (busy || !(await discardAllowed())) return;
    unsaved.markSaved();
    const cursor = forward ? nextCursor : cursorHistory.at(-1);
    setCursorHistory((history) => (forward ? [...history, query.cursor] : history.slice(0, -1)));
    setQuery({ ...query, cursor });
  }
  function edit(id: string, field: AnalysisSheetField, value: string) {
    if (!editable.has(id) || busy || loading) return;
    setFillUndo(undefined);
    setDrafts((current) => ({ ...current, [id]: { ...current[id]!, [field]: value } }));
    setDirtyIds((current) => new Set(current).add(id));
    unsaved.markDirty();
    setErrors((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  }
  function fill(sourceIndex: number, targetIndex: number, field: AnalysisSheetField) {
    if (busy || loading) return;
    const result = fillAnalysisColumn({
      rowIds: rows.map((row) => row.executionRunId),
      drafts,
      sourceIndex,
      targetIndex,
      field,
      editable,
    });
    if (!result.updatedIds.length) return;
    setFillUndo({ drafts, dirtyIds });
    setDrafts(result.drafts);
    setDirtyIds((current) => new Set([...current, ...result.updatedIds]));
    unsaved.markDirty();
    toast.info(
      `已向下填充 ${result.updatedIds.length} 行草稿${result.skippedCount ? `，跳过 ${result.skippedCount} 行只读记录` : ""}；提交后才会保存。`,
    );
  }
  function undoFill() {
    if (!fillUndo || busy) return;
    setDrafts(fillUndo.drafts);
    setDirtyIds(new Set(fillUndo.dirtyIds));
    setFillUndo(undefined);
    if (fillUndo.dirtyIds.size) unsaved.markDirty();
    else unsaved.markSaved();
  }
  function updateClaim(claim: FailureAnalysisClaimView) {
    setRows((current) =>
      current.map((row) =>
        row.executionRunId === claim.executionRunId ? { ...row, analysis: claim, claim } : row,
      ),
    );
  }
  async function post(action: string, body: unknown) {
    const response = await fetch(`${endpoint}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) await throwApiErrorResponse(response, "分析操作失败。");
    return response;
  }
  async function claimSelected() {
    if (mutationRunning.current || !canManage) return;
    const executionRunIds = rows
      .filter((row) => selectedIds.includes(row.executionRunId) && !row.analysis)
      .map((row) => row.executionRunId);
    if (!executionRunIds.length) return;
    mutationRunning.current = true;
    setBusy(true);
    setError("");
    try {
      const result = (await (
        await post("claim", { executionRunIds })
      ).json()) as ClaimFailureAnalysisResult;
      for (const claim of result.claimed) updateClaim(claim);
      onClaimed?.(result.claimed.length);
      setSelectedIds([]);
      toast[result.conflicts.length ? "warning" : "success"](
        `已认领 ${result.claimed.length} 个用例${result.conflicts.length ? `，${result.conflicts.length} 个已由其他人认领，请刷新查看` : "，可直接填写分析"}。`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "认领失败。");
    } finally {
      mutationRunning.current = false;
      setBusy(false);
    }
  }
  async function save() {
    if (mutationRunning.current || !canManage || !dirtyIds.size) return;
    const pending = rows.filter(
      (row) => dirtyIds.has(row.executionRunId) && editable.has(row.executionRunId),
    );
    if (pending.some((row) => !drafts[row.executionRunId]?.category)) {
      setError("请为每行草稿选择分析类别。");
      return;
    }
    const includesCaseFix = pending.some(
      (row) => drafts[row.executionRunId]?.category === "case_fixed",
    );
    mutationRunning.current = true;
    setBusy(true);
    if (
      !(await confirm({
        title: "提交分析结论",
        description: `将提交 ${pending.length} 行分析结论。${includesCaseFix ? "其中包含“用例问题已修改”，请确认问题确实由用例引起，并已提供修改证明。" : "已完成的结论将保持只读，重跑通过仍须逐例具备证明。"}`,
        confirmLabel: includesCaseFix ? "确认用例问题并提交" : "确认提交",
      }))
    ) {
      mutationRunning.current = false;
      setBusy(false);
      return;
    }
    mutationRunning.current = true;
    setBusy(true);
    setError("");
    const remaining = new Set(dirtyIds);
    const failures: Record<string, string> = {};
    let completed = 0;
    setProgress({ done: 0, total: pending.length });
    setFillUndo(undefined);
    try {
      // One bounded write at a time keeps Lite transactions short and leaves execution work responsive.
      for (const row of pending) {
        try {
          const response = await post("complete", {
            ...drafts[row.executionRunId],
            analysisIds: [row.analysis!.id],
            caseIssueConfirmed: includesCaseFix,
            expectedUpdatedAt: row.analysis!.updatedAt,
          });
          const result = (await response.json()) as { items: FailureAnalysisClaimView[] };
          for (const claim of result.items) updateClaim(claim);
          remaining.delete(row.executionRunId);
          completed++;
        } catch (cause) {
          failures[row.executionRunId] =
            cause instanceof Error ? cause.message : "提交失败，请重试。";
          if (cause instanceof ApiClientError && [401, 403, 404].includes(cause.status)) break;
        }
        setProgress((current) => (current ? { ...current, done: current.done + 1 } : current));
      }
      setDirtyIds(remaining);
      setErrors(failures);
      if (!remaining.size) unsaved.markSaved();
      onCompleted?.(completed);
      toast[Object.keys(failures).length ? "warning" : "success"](
        `已提交 ${completed} 行${Object.keys(failures).length ? `，${Object.keys(failures).length} 行未提交，草稿已保留，请查看行内原因` : "分析结论"}。`,
      );
    } finally {
      mutationRunning.current = false;
      setBusy(false);
      setProgress(undefined);
    }
  }
  async function release(row: FailureAnalysisSheetRow) {
    if (mutationRunning.current || !row.analysis || !editable.has(row.executionRunId)) return;
    const reason = await prompt({
      title: "取消认领",
      description: "记录取消原因后，该用例可重新认领；本行未提交草稿会清除。",
      inputLabel: "取消原因",
      multiline: true,
      required: true,
      confirmLabel: "确认取消认领",
      tone: "danger",
    });
    if (!reason?.trim()) return;
    mutationRunning.current = true;
    setBusy(true);
    setError("");
    try {
      await post("release", { analysisId: row.analysis.id, reason });
      onClaimed?.(-1);
      const remaining = new Set(dirtyIds);
      remaining.delete(row.executionRunId);
      setDirtyIds(remaining);
      if (!remaining.size) unsaved.markSaved();
      setRows((current) =>
        current.map((item) =>
          item.executionRunId === row.executionRunId
            ? { ...item, analysis: undefined, claim: undefined }
            : item,
        ),
      );
      setDrafts((current) => ({
        ...current,
        [row.executionRunId]: analysisSheetDraft({ ...row, analysis: undefined }),
      }));
      toast.success("已取消认领。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "取消认领失败。");
    } finally {
      mutationRunning.current = false;
      setBusy(false);
    }
  }

  return {
    rows,
    query,
    drafts,
    dirtyIds,
    selectedIds,
    setSelectedIds,
    errors,
    error,
    loading,
    busy,
    progress,
    editable,
    nextCursor,
    pageNumber: cursorHistory.length + 1,
    edit,
    fill,
    refresh,
    changeQuery,
    movePage,
    claimSelected,
    save,
    release,
    updateClaim,
    dirty: unsaved.dirty,
    undoFill,
    canUndoFill: Boolean(fillUndo),
  };
}
