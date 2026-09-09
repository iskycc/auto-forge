"use client";

import {
  browserCacheEpoch,
  readBrowserSnapshot,
  writeBrowserSnapshot,
  clearBrowserSnapshots,
} from "@/lib/browser-read-cache";
import type { DdtScope as Scope, DdtCaseSummary as CaseSummary, DdtCase } from "@autoforge/domain";
import {
  DdtCaseBrowser,
  DdtCaseDetail,
  type DdtEditorStatus,
  type DdtHistoryItem,
} from "@/components/ddt-case-browser";
import { formatPlatformDateTime } from "@/lib/platform-date-time";
import { DdtCaseInspector } from "./ddt-case-inspector";

import {
  ArchiveRestore,
  AlertTriangle,
  BarChart3,
  Boxes,
  CheckCircle2,
  Code2,
  Download,
  FileSpreadsheet,
  Filter,
  Layers3,
  LoaderCircle,
  ListPlus,
  PencilLine,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { DragEvent as ReactDragEvent, ReactNode } from "react";

import { Button, Input, OperationProgress, Select, Textarea } from "@/components/ui";
import { LoadingState } from "@/components/loading-state";
import { uploadWithProgress } from "@/lib/upload-with-progress";
import { useConfirm, useToast } from "@/components/ui-feedback";
import { useConcurrentModificationFeedback } from "@/components/concurrent-modification-feedback";
import { readApiError } from "@/lib/client-api";

type HistoryItem = DdtHistoryItem;
type Dashboard = {
  caseCount: number;
  groupCount: number;
  sourceCount: number;
  journeyCount: number;
  importedToday: number;
  updatedToday: number;
  groups: Array<{ srNum: string; count: number }>;
  timeline: Array<{ date: string; count: number }>;
};
type ImportFile = {
  id: string;
  fileName: string;
  archiveEntryName?: string;
  status: string;
  rowCount: number;
  insertedCount: number;
  updatedCount: number;
  unchangedCount: number;
  errorSummary?: string;
};
type ColumnConflict = {
  archiveEntryName?: string;
  sheetName: string;
  normalizedName: string;
  columns: Array<{
    columnIndex: number;
    originalName: string;
    currentName: string;
    suggestedName: string;
    nonEmptyCount: number;
    sampleValues: Array<{ rowNumber: number; value: string }>;
  }>;
};
type ColumnResolution = {
  uploadIndex: number;
  archiveEntryName?: string;
  sheetName: string;
  columnIndex: number;
  resolvedName: string;
  deleteColumn?: boolean;
};
type ImportUpload = {
  id: string;
  fileName: string;
  columnConflicts?: ColumnConflict[];
};
type LocatedColumnConflict = ColumnConflict & {
  uploadIndex: number;
  uploadName: string;
};
type ImportJob = Scope & {
  id: string;
  status: string;
  progressPercent: number;
  totalFiles: number;
  validFiles: number;
  totalRows: number;
  insertedCount: number;
  updatedCount: number;
  unchangedCount: number;
  skippedCount: number;
  failedFiles: number;
  errorSummary?: string;
  uploads: ImportUpload[];
  files: ImportFile[];
  createdAt: string;
};
type TemplateRule = {
  field: string;
  required: boolean;
  type: "string" | "number" | "boolean" | "date";
};
type Template = Scope & {
  id: string;
  srNum: string;
  name: string;
  description: string;
  rules: TemplateRule[];
  revision: number;
};
type DeletedCase = {
  id: string;
  caseId: string;
  srNum: string;
  sourceName: string;
  deletedAt: string;
};
type WorkspaceTab = "overview" | "cases" | "imports" | "templates" | "recycle";

const DDT_IMPORT_FILE_ACCEPT = ".xlsx,.xls,.xlsb,.csv,.ods,.zip";
const DDT_IMPORT_FILE_EXTENSIONS = new Set(["xlsx", "xls", "xlsb", "csv", "ods", "zip"]);

const discardDdtEdits = {
  title: "放弃未保存的修改",
  description: "当前用例仍有未保存的编辑，切换后这些修改将被丢弃。",
  confirmLabel: "放弃修改",
  cancelLabel: "继续编辑",
  tone: "warning",
} as const;

const emptyDashboard: Dashboard = {
  caseCount: 0,
  groupCount: 0,
  sourceCount: 0,
  journeyCount: 0,
  importedToday: 0,
  updatedToday: 0,
  groups: [],
  timeline: [],
};

export function DdtManagementWorkspace({
  scope,
  canManage,
  canManageSuites,
  canRun,
  suites,
}: {
  scope: Scope;
  canManage: boolean;
  canManageSuites: boolean;
  canRun: boolean;
  suites: Array<{ id: string; name: string }>;
}) {
  const confirmAction = useConfirm();
  const showConcurrentModification = useConcurrentModificationFeedback();
  const toast = useToast();
  const router = useRouter();
  const searchParameters = useSearchParams();
  const initialView = searchParameters.get("ddtView");
  const [tab, setTab] = useState<WorkspaceTab>(initialView === "cases" ? "cases" : "overview");
  const [dashboard, setDashboard] = useState(emptyDashboard);
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [imports, setImports] = useState<ImportJob[]>([]);
  const [deletedCases, setDeletedCases] = useState<DeletedCase[]>([]);
  const query = searchParameters.get("ddtQuery") ?? "";
  const srNum = searchParameters.get("ddtGroup") ?? "";
  const advancedField = searchParameters.get("ddtField") ?? "";
  const advancedOperator = searchParameters.get("ddtOperator") ?? "contains";
  const advancedValue = searchParameters.get("ddtValue") ?? "";
  const updateFilterUrl = (key: string, value: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set("tab", "ddt");
    url.searchParams.set("ddtView", "cases");
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
    window.history.pushState(null, "", url);
  };
  const setQuery = (value: string) => updateFilterUrl("ddtQuery", value);
  const setSrNum = (value: string) => updateFilterUrl("ddtGroup", value);
  const setAdvancedField = (value: string) => updateFilterUrl("ddtField", value);
  const setAdvancedOperator = (value: string) => updateFilterUrl("ddtOperator", value);
  const setAdvancedValue = (value: string) => updateFilterUrl("ddtValue", value);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [executionPreviewCaseId, setExecutionPreviewCaseId] = useState<string>();
  const [detail, setDetail] = useState<DdtCase>();
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [activeCaseId, setActiveCaseId] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [editorEpoch, setEditorEpoch] = useState(0);
  const editorStatus = useRef<DdtEditorStatus>("idle");
  const [savingCase, setSavingCase] = useState(false);
  const detailRequest = useRef<AbortController | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  const [busy, setBusy] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [showTemplate, setShowTemplate] = useState(false);
  const [showBulk, setShowBulk] = useState(false);
  const [showAddToSuite, setShowAddToSuite] = useState(false);
  const [deleteProgress, setDeleteProgress] = useState<{
    completed: number;
    total: number;
    label: string;
  }>();
  const hasLoaded = useRef(false);
  const loadGeneration = useRef(0);
  const appliedFilters = useRef<{ key: string; url: string } | null>(null);
  const filterKey = JSON.stringify([query, srNum, advancedField, advancedOperator, advancedValue]);

  const { projectId, projectVersionId, testStageId } = scope;
  const endpoint = useCallback(
    (path: string, extra?: URLSearchParams) => {
      const parameters = new URLSearchParams({ projectId, projectVersionId, testStageId });
      extra?.forEach((value, key) => parameters.append(key, value));
      return `/api/v1/ddt/${path}?${parameters.toString()}`;
    },
    [projectId, projectVersionId, testStageId],
  );

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    if (hasLoaded.current) setRefreshing(true);
    else setBusy(true);
    setError("");
    // A cold statistical projection must not delay the bounded case list.
    void requestJson<Dashboard>(endpoint("dashboard"))
      .then((next) => {
        if (generation === loadGeneration.current) setDashboard(next);
      })
      .catch((error: unknown) => {
        if (generation === loadGeneration.current) setError(messageOf(error));
      });
    try {
      const caseParameters = new URLSearchParams({ limit: "60" });
      if (query.trim()) caseParameters.set("query", query.trim());
      if (srNum) caseParameters.set("srNum", srNum);
      if (advancedField.trim()) {
        caseParameters.set(
          "filters",
          JSON.stringify([
            {
              field: advancedField.trim(),
              operator: advancedOperator,
              ...(advancedOperator === "exists" ? {} : { value: advancedValue }),
            },
          ]),
        );
      }
      const [casePage, templatePage, importPage, recyclePage] = await Promise.all([
        requestJson<{ items: CaseSummary[]; nextCursor?: string }>(
          endpoint("cases", caseParameters),
        ),
        requestJson<{ items: Template[] }>(endpoint("templates")),
        requestJson<{ items: ImportJob[] }>(endpoint("imports")),
        requestJson<{ items: DeletedCase[] }>(endpoint("recycle")),
      ]);
      if (generation !== loadGeneration.current) return;
      setCases(casePage.items);
      setNextCursor(casePage.nextCursor);
      setTemplates(templatePage.items);
      setImports(importPage.items);
      setDeletedCases(recyclePage.items);
    } catch (loadError) {
      if (generation === loadGeneration.current) setError(messageOf(loadError));
    } finally {
      if (generation === loadGeneration.current) {
        hasLoaded.current = true;
        setBusy(false);
        setRefreshing(false);
      }
    }
  }, [
    advancedField,
    advancedOperator,
    advancedValue,
    endpoint,
    query,
    srNum,
    setRefreshing,
    setBusy,
    setError,
    setDashboard,
    setCases,
    setNextCursor,
    setTemplates,
    setImports,
    setDeletedCases,
  ]);

  useEffect(() => {
    let cancelled = false;
    const applyFilter = async () => {
      // Returning to a recently requested filter must restart its cancelled read.
      if (appliedFilters.current?.key === filterKey && editorStatus.current !== "idle") return;
      // Back/forward can change the URL without passing through the filter controls.
      if (editorStatus.current !== "idle") {
        const discard = editorStatus.current !== "saving" && (await confirmAction(discardDdtEdits));
        if (cancelled) return;
        if (!discard) {
          if (appliedFilters.current)
            window.history.replaceState(null, "", appliedFilters.current.url);
          return;
        }
        editorStatus.current = "idle";
        setEditorEpoch((epoch) => epoch + 1);
      }
      appliedFilters.current = {
        key: filterKey,
        url: window.location.pathname + window.location.search,
      };
      setSelected(new Set());
      detailRequest.current?.abort();
      setDetail(undefined);
      setDetailLoading(false);
      setActiveCaseId("");
      setExecutionPreviewCaseId(undefined);
      await load();
    };
    const timer = window.setTimeout(() => void applyFilter(), 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      loadGeneration.current += 1;
    };
  }, [confirmAction, filterKey, load]);

  useEffect(() => {
    if (!imports.some((job) => ["queued", "running", "cancel_requested"].includes(job.status)))
      return;
    const timer = window.setInterval(() => {
      clearBrowserSnapshots();
      void load();
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [imports, load]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void requestJson<Dashboard>(endpoint("dashboard"), {
        cache: "reload",
        signal: controller.signal,
      })
        .then((next) => {
          if (!controller.signal.aborted) setDashboard(next);
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) setError(messageOf(error));
        });
    }, 60_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [endpoint]);

  const openCase = useCallback(
    async (caseId: string) => {
      detailRequest.current?.abort();
      const controller = new AbortController();
      detailRequest.current = controller;
      setActiveCaseId(caseId);
      setDetail(undefined);
      setHistory([]);
      setDetailError("");
      setDetailLoading(true);
      try {
        const [item, historyPage] = await Promise.all([
          requestJson<DdtCase>(endpoint(`cases/${encodeURIComponent(caseId)}`), {
            signal: controller.signal,
          }),
          requestJson<{ items: HistoryItem[] }>(
            endpoint(`cases/${encodeURIComponent(caseId)}/history`),
            { signal: controller.signal },
          ),
        ]);
        if (controller.signal.aborted) return;
        setDetail(item);
        setHistory(historyPage.items);
      } catch (openError) {
        if (!controller.signal.aborted) setDetailError(messageOf(openError));
      } finally {
        if (!controller.signal.aborted) setDetailLoading(false);
      }
    },
    [endpoint, setActiveCaseId, setDetail, setHistory, setDetailError, setDetailLoading],
  );

  useEffect(() => () => detailRequest.current?.abort(), [endpoint]);

  useEffect(() => {
    if (tab !== "cases" || busy || refreshing || activeCaseId || !cases[0]) return;
    const timer = window.setTimeout(() => void openCase(cases[0]!.caseId), 0);
    return () => window.clearTimeout(timer);
  }, [tab, busy, refreshing, activeCaseId, cases, openCase]);

  const leaveEditor = async (): Promise<boolean> => {
    if (editorStatus.current === "saving") return false;
    if (editorStatus.current === "editing") {
      if (!(await confirmAction(discardDdtEdits))) return false;
      editorStatus.current = "idle";
      setEditorEpoch((epoch) => epoch + 1);
    }
    return true;
  };
  const navigateCase = async (caseId: string) => {
    if (!(await leaveEditor())) return;
    setExecutionPreviewCaseId(undefined);
    setSelected(new Set());
    await openCase(caseId);
  };
  const previewCase = async (caseId: string) => {
    if (!(await leaveEditor())) return;
    detailRequest.current?.abort();
    setSelected(new Set());
    setActiveCaseId(caseId);
    setExecutionPreviewCaseId(caseId);
  };
  const changeFilter = async (change: () => void) => {
    if (!(await leaveEditor())) return;
    setExecutionPreviewCaseId(undefined);
    detailRequest.current?.abort();
    setDetail(undefined);
    setActiveCaseId("");
    setDetailError("");
    setCases([]);
    setNextCursor(undefined);
    setSelected(new Set());
    change();
  };
  const savedCase = async (next: DdtCase) => {
    toast.success(`已保存 ${next.caseId}`);
    setActiveCaseId(next.caseId);
    setDetail(next);
    await load();
    try {
      const historyPage = await requestJson<{ items: HistoryItem[] }>(
        endpoint(`cases/${encodeURIComponent(next.caseId)}/history`),
      );
      setHistory(historyPage.items);
    } catch (historyError) {
      setHistory([]);
      toast.error(`用例已保存，但修改历史刷新失败：${messageOf(historyError)}`);
    }
  };

  const loadMore = async () => {
    if (!nextCursor || loadingMoreRef.current) return;
    const generation = loadGeneration.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const parameters = new URLSearchParams({ limit: "60", cursor: nextCursor });
    if (query.trim()) parameters.set("query", query.trim());
    if (srNum) parameters.set("srNum", srNum);
    if (advancedField.trim()) {
      parameters.set(
        "filters",
        JSON.stringify([
          {
            field: advancedField.trim(),
            operator: advancedOperator,
            ...(advancedOperator === "exists" ? {} : { value: advancedValue }),
          },
        ]),
      );
    }
    try {
      const page = await requestJson<{ items: CaseSummary[]; nextCursor?: string }>(
        endpoint("cases", parameters),
      );
      if (generation !== loadGeneration.current) return;
      setCases((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (loadError) {
      if (generation === loadGeneration.current) setError(messageOf(loadError));
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  };

  const deleteSelected = async () => {
    const caseIds = [...selected];
    if (
      !(await confirmAction({
        title: "删除 DDT 用例",
        description: `将 ${caseIds.length} 条 DDT 用例移入回收站，之后仍可恢复。`,
        confirmLabel: "移入回收站",
        tone: "danger",
      }))
    )
      return;
    setError("");
    setDeleteProgress({ completed: 0, total: caseIds.length, label: "正在移入回收站" });
    try {
      await requestJson(endpoint("cases/bulk-delete"), {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ caseIds }),
      });
      setDeleteProgress({
        completed: caseIds.length,
        total: caseIds.length,
        label: "删除完成，正在刷新用例列表",
      });
      toast.success(`已将 ${caseIds.length} 条用例移入回收站。`);
      setSelected(new Set());
      if (caseIds.includes(activeCaseId)) {
        detailRequest.current?.abort();
        setActiveCaseId("");
        setDetail(undefined);
      }
      await load();
    } catch (deleteError) {
      setError(messageOf(deleteError));
    } finally {
      setDeleteProgress(undefined);
    }
  };

  const exportSelection = async () => {
    try {
      const response = await fetch(endpoint("export"), {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify(selected.size ? { caseIds: [...selected] } : srNum ? { srNum } : {}),
      });
      if (!response.ok) throw await responseError(response);
      downloadBlob(await response.blob(), "DDT-cases.xlsx");
    } catch (downloadError) {
      setError(messageOf(downloadError));
    }
  };

  const activeCaseIndex = cases.findIndex((item) => item.caseId === activeCaseId);
  const previousCase = cases[activeCaseIndex - 1];
  const nextCase = activeCaseIndex >= 0 ? cases[activeCaseIndex + 1] : undefined;
  const maximumTimeline = Math.max(...dashboard.timeline.map((point) => point.count), 1);

  return (
    <section className="ddt-workspace" aria-label="DDT 管理工作台">
      <div className="ddt-workspace-bar">
        <div>
          <strong>DDT 工作台</strong>
          <span>CaseID 在当前项目版本与测试阶段内唯一</span>
        </div>
        <Button
          className="button button-secondary"
          type="button"
          disabled={savingCase}
          onClick={async () => {
            if (await leaveEditor()) router.push("/cases/ddt-associations");
          }}
        >
          <Code2 size={15} /> SR 测试类关联
        </Button>
        <Button
          className="button button-secondary"
          type="button"
          onClick={async () => {
            if (!(await leaveEditor())) return;
            clearBrowserSnapshots();
            await load();
            if (activeCaseId) await openCase(activeCaseId);
          }}
          disabled={busy || refreshing || savingCase}
        >
          <RefreshCw size={15} className={busy || refreshing ? "spin" : ""} /> 刷新
        </Button>
        {canManage ? (
          <Button
            className="button button-primary"
            type="button"
            onClick={async () => {
              if (await leaveEditor()) setShowImport(true);
            }}
          >
            <Upload size={16} /> 导入表格
          </Button>
        ) : null}
      </div>

      <div className="ddt-subtabs" role="tablist" aria-label="DDT 功能">
        {(
          [
            ["overview", BarChart3, "概览"],
            ["cases", FileSpreadsheet, "用例"],
            ["imports", Layers3, "导入任务"],
            ["templates", Boxes, "字段模板"],
            ["recycle", ArchiveRestore, "回收站"],
          ] as const
        ).map(([value, Icon, label]) => (
          <Button
            key={value}
            className={tab === value ? "active" : ""}
            type="button"
            role="tab"
            aria-selected={tab === value}
            disabled={savingCase}
            onClick={async () => {
              if (await leaveEditor()) setTab(value);
            }}
          >
            <Icon size={16} /> {label}
            {value === "recycle" && deletedCases.length ? (
              <small>{deletedCases.length}</small>
            ) : null}
          </Button>
        ))}
      </div>

      {error ? (
        <div className="inline-notice error" role="alert">
          {error}
          <Button type="button" aria-label="关闭错误" onClick={() => setError("")}>
            <X size={14} />
          </Button>
        </div>
      ) : null}
      {deleteProgress ? (
        <OperationProgress
          detail={`已处理 ${deleteProgress.completed} / ${deleteProgress.total} 条用例`}
          indeterminate={deleteProgress.completed === 0}
          label={deleteProgress.label}
          value={
            deleteProgress.total > 0 ? (deleteProgress.completed / deleteProgress.total) * 100 : 0
          }
        />
      ) : null}

      {busy && cases.length === 0 ? <WorkspaceLoading /> : null}

      {!busy && tab === "overview" ? (
        <div className="ddt-overview">
          <div className="ddt-metrics">
            <Metric
              label="用例总数"
              value={dashboard.caseCount}
              hint={`其中 ${dashboard.journeyCount} 条用户旅程`}
            />
            <Metric label="业务分组" value={dashboard.groupCount} hint="按 srNum 汇总" />
            <Metric
              label="导入来源"
              value={dashboard.sourceCount}
              hint={`今日新增 ${dashboard.importedToday}`}
            />
            <Metric label="今日更新" value={dashboard.updatedToday} hint="含导入覆盖与人工编辑" />
          </div>
          <div className="ddt-chart-grid">
            <article className="card ddt-chart-card">
              <header>
                <div>
                  <strong>近 7 日新增</strong>
                  <span>按用例创建日期</span>
                </div>
              </header>
              <div className="ddt-bars" aria-label="近 7 日新增用例柱形图">
                {dashboard.timeline.length ? (
                  dashboard.timeline.map((point) => (
                    <div key={point.date}>
                      <span
                        style={{ height: `${Math.max((point.count / maximumTimeline) * 100, 7)}%` }}
                        title={`${point.date}: ${point.count}`}
                      />
                      <small>{point.date.slice(5)}</small>
                    </div>
                  ))
                ) : (
                  <p className="ddt-chart-empty">还没有导入数据</p>
                )}
              </div>
            </article>
            <article className="card ddt-chart-card">
              <header>
                <div>
                  <strong>主要业务分组</strong>
                  <span>按 srNum 用例量排序</span>
                </div>
              </header>
              <div className="ddt-group-ranking">
                {dashboard.groups.length ? (
                  dashboard.groups.map((group, index) => (
                    <Button
                      key={group.srNum}
                      type="button"
                      onClick={() => {
                        void changeFilter(() => {
                          setSrNum(group.srNum);
                          setTab("cases");
                        });
                      }}
                    >
                      <span>{index + 1}</span>
                      <strong>{group.srNum}</strong>
                      <i
                        style={{
                          width: `${Math.max((group.count / (dashboard.groups[0]?.count ?? 1)) * 100, 8)}%`,
                        }}
                      />
                      <small>{group.count}</small>
                    </Button>
                  ))
                ) : (
                  <p className="ddt-chart-empty">导入后将在这里展示业务分组</p>
                )}
              </div>
            </article>
          </div>
        </div>
      ) : null}

      {!busy && tab === "cases" ? (
        <DdtCaseBrowser
          cases={cases}
          activeCaseId={activeCaseId}
          selected={selected}
          hasMore={Boolean(nextCursor)}
          loadingMore={loadingMore}
          refreshing={refreshing}
          savingCase={savingCase}
          onLoadMore={() => void loadMore()}
          onOpen={(caseId) => void navigateCase(caseId)}
          onPreview={(caseId) => void previewCase(caseId)}
          onSelect={async (caseId) => {
            if (await leaveEditor()) setSelected((current) => toggleSet(current, caseId));
          }}
          onSelectAll={async (checked) => {
            if (await leaveEditor())
              setSelected(checked ? new Set(cases.map((item) => item.caseId)) : new Set());
          }}
          filters={
            <>
              <label className="search-field">
                <Search size={16} />
                <Input
                  value={query}
                  onChange={(event) => {
                    const value = event.target.value;
                    void changeFilter(() => setQuery(value));
                  }}
                  placeholder="按 CaseID 前缀搜索"
                  aria-label="搜索 DDT 用例"
                />
              </label>
              <label>
                <span>业务分组</span>
                <Select
                  value={srNum}
                  aria-label="DDT 业务分组"
                  onChange={(event) => {
                    const value = event.target.value;
                    void changeFilter(() => setSrNum(value));
                  }}
                >
                  <option value="">全部 srNum</option>
                  {dashboard.groups.map((group) => (
                    <option key={group.srNum}>{group.srNum}</option>
                  ))}
                </Select>
              </label>
              <details className="ddt-advanced-filters">
                <summary>
                  <Filter size={14} /> 高级筛选
                </summary>
                <div className="ddt-advanced-filter-fields">
                  <label>
                    <span>动态字段</span>
                    <Input
                      value={advancedField}
                      onChange={(event) => {
                        const value = event.target.value;
                        void changeFilter(() => setAdvancedField(value));
                      }}
                      placeholder="例如 owner"
                      aria-label="DDT 动态字段"
                    />
                  </label>
                  <label>
                    <span>匹配方式</span>
                    <Select
                      value={advancedOperator}
                      onChange={(event) => {
                        const value = event.target.value;
                        void changeFilter(() => setAdvancedOperator(value));
                      }}
                      aria-label="动态字段匹配方式"
                    >
                      <option value="contains">包含</option>
                      <option value="eq">等于</option>
                      <option value="prefix">前缀</option>
                      <option value="ne">不等于</option>
                      <option value="exists">存在</option>
                      <option value="gt">大于</option>
                      <option value="gte">大于等于</option>
                      <option value="lt">小于</option>
                      <option value="lte">小于等于</option>
                    </Select>
                  </label>
                  {advancedOperator !== "exists" ? (
                    <label>
                      <span>字段值</span>
                      <Input
                        value={advancedValue}
                        onChange={(event) => {
                          const value = event.target.value;
                          void changeFilter(() => setAdvancedValue(value));
                        }}
                        aria-label="动态字段值"
                      />
                    </label>
                  ) : null}
                </div>
              </details>
              <Button className="text-button" type="button" onClick={() => void exportSelection()}>
                <Download size={15} /> 导出当前范围
              </Button>
            </>
          }
          selectionActions={
            <div className="ddt-selection-bar">
              <Button
                className="button button-secondary"
                type="button"
                onClick={() => void exportSelection()}
              >
                <Download size={15} /> 导出 {selected.size} 条
              </Button>
              {canManage ? (
                <>
                  <Button
                    className="button button-secondary"
                    type="button"
                    onClick={() => setShowBulk(true)}
                  >
                    <PencilLine size={15} /> 批量修改
                  </Button>
                  <Button
                    className="button button-danger"
                    type="button"
                    disabled={Boolean(deleteProgress)}
                    onClick={() => void deleteSelected()}
                  >
                    {deleteProgress ? (
                      <LoaderCircle className="spin" size={15} />
                    ) : (
                      <Trash2 size={15} />
                    )}{" "}
                    移入回收站
                  </Button>
                </>
              ) : null}
              {canManageSuites ? (
                <Button
                  className="button button-secondary"
                  type="button"
                  onClick={() => setShowAddToSuite(true)}
                >
                  <ListPlus size={15} /> 加入用例任务
                </Button>
              ) : null}
              <Button type="button" className="text-button" onClick={() => setSelected(new Set())}>
                清空选择
              </Button>
            </div>
          }
        >
          {executionPreviewCaseId ? (
            <DdtCaseInspector
              key={executionPreviewCaseId}
              scope={scope}
              caseId={executionPreviewCaseId}
              onClose={() => void navigateCase(executionPreviewCaseId)}
            />
          ) : detailLoading ? (
            <LoadingState label="正在读取用例" description="正在加载所选用例的字段与修改历史。" />
          ) : detailError ? (
            <div className="ddt-detail-error">
              <div className="inline-notice error" role="alert">
                {detailError}
              </div>
              <Button
                type="button"
                className="button button-secondary"
                onClick={() => void openCase(activeCaseId)}
              >
                重试读取用例
              </Button>
            </div>
          ) : detail ? (
            <DdtCaseDetail
              key={`${detail.id}:${editorEpoch}`}
              item={detail}
              history={history}
              canManage={canManage}
              canRun={canRun}
              onPreview={() => void previewCase(detail.caseId)}
              onStatusChange={(status) => {
                editorStatus.current = status;
                setSavingCase(status === "saving");
              }}
              onPrevious={previousCase ? () => void navigateCase(previousCase.caseId) : undefined}
              onNext={nextCase ? () => void navigateCase(nextCase.caseId) : undefined}
              onSave={async (data) => {
                const next = await requestJson<DdtCase>(
                  endpoint(`cases/${encodeURIComponent(detail.caseId)}`),
                  {
                    method: "PATCH",
                    headers: jsonHeaders,
                    body: JSON.stringify({ expectedRevision: detail.revision, data }),
                  },
                );
                await savedCase(next);
              }}
              onRestore={async (historyId) => {
                const next = await requestJson<DdtCase>(
                  endpoint(
                    `cases/${encodeURIComponent(detail.caseId)}/history/${historyId}/restore`,
                  ),
                  {
                    method: "POST",
                    headers: jsonHeaders,
                    body: JSON.stringify({ snapshot: "after" }),
                  },
                );
                await savedCase(next);
              }}
            />
          ) : (
            <Empty
              title="选择用例查看详情"
              description="从左侧选择 CaseID，在这里查看字段、旅程步骤和修改历史。"
            />
          )}
        </DdtCaseBrowser>
      ) : null}

      {!busy && tab === "imports" ? (
        <ImportJobs
          jobs={imports}
          canManage={canManage}
          onOpen={() => setShowImport(true)}
          onCancel={async (id) => {
            await requestJson(endpoint(`imports/${id}/cancel`), { method: "POST" });
            await load();
          }}
          onExportCaseIds={async (id) => {
            const result = await requestJson<{
              items: Array<{ caseId: string; outcome: string }>;
            }>(endpoint(`imports/${id}/case-ids`));
            downloadBlob(
              new Blob(
                [
                  "CaseID,结果\n",
                  ...result.items.map(
                    (item) => `${csvCell(item.caseId)},${csvCell(item.outcome)}\n`,
                  ),
                ],
                { type: "text/csv;charset=utf-8" },
              ),
              `DDT-import-${id}-CaseIDs.csv`,
            );
          }}
        />
      ) : null}
      {!busy && tab === "templates" ? (
        <Templates
          templates={templates}
          canManage={canManage}
          onCreate={() => setShowTemplate(true)}
          onDelete={async (item) => {
            if (
              !(await confirmAction({
                title: "删除 DDT 模板",
                description: `确认删除模板“${item.name}”？已有用例数据不会被删除。`,
                confirmLabel: "确认删除",
                tone: "danger",
              }))
            )
              return;
            try {
              await requestJson(
                endpoint(
                  `templates/${item.id}`,
                  new URLSearchParams({ revision: String(item.revision) }),
                ),
                { method: "DELETE" },
              );
              await load();
            } catch (deleteError) {
              if (await showConcurrentModification(deleteError)) return;
              setError(messageOf(deleteError));
            }
          }}
        />
      ) : null}
      {!busy && tab === "recycle" ? (
        <Recycle
          items={deletedCases}
          canManage={canManage}
          onRestore={async (id) => {
            await requestJson(endpoint(`recycle/${id}/restore`), { method: "POST" });
            await load();
          }}
          onPurge={async (id) => {
            if (
              !(await confirmAction({
                title: "永久删除 DDT 用例",
                description: "永久删除后无法恢复，请确认不再需要这条用例。",
                confirmLabel: "永久删除",
                tone: "danger",
              }))
            )
              return;
            await requestJson(endpoint(`recycle/${id}`), { method: "DELETE" });
            await load();
          }}
        />
      ) : null}

      {showImport ? (
        <ImportDialog
          endpoint={endpoint}
          onClose={() => setShowImport(false)}
          onComplete={async () => {
            setShowImport(false);
            setTab("imports");
            await load();
          }}
        />
      ) : null}
      {showTemplate ? (
        <TemplateDialog
          endpoint={endpoint}
          onClose={() => setShowTemplate(false)}
          onComplete={async () => {
            setShowTemplate(false);
            setTab("templates");
            await load();
          }}
        />
      ) : null}
      {showBulk ? (
        <BulkDialog
          count={selected.size}
          endpoint={endpoint}
          caseIds={[...selected]}
          onClose={() => setShowBulk(false)}
          onComplete={async () => {
            await load();
            if (activeCaseId) await openCase(activeCaseId);
            setShowBulk(false);
            setSelected(new Set());
            router.refresh();
          }}
        />
      ) : null}
      {showAddToSuite ? (
        <AddDdtToSuiteDialog
          caseIds={[...selected]}
          scope={scope}
          suites={suites}
          initialSuiteId={searchParameters.get("targetSuiteId") ?? undefined}
          onClose={() => setShowAddToSuite(false)}
          onComplete={async (suiteName) => {
            toast.success(`已将 ${selected.size} 条 DDT 用例加入任务“${suiteName}”。`);
            setShowAddToSuite(false);
            setSelected(new Set());
          }}
        />
      ) : null}
    </section>
  );
}

function Metric({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <article className="card ddt-metric">
      <span>{label}</span>
      <strong>{value.toLocaleString("zh-CN")}</strong>
      <small>{hint}</small>
    </article>
  );
}

function WorkspaceLoading() {
  return (
    <LoadingState
      label="正在加载 DDT 工作台"
      description="正在读取当前项目版本与测试阶段的数据。"
    />
  );
}

function Empty({ title, description }: { title: string; description: string }) {
  return (
    <div className="empty-state ddt-empty">
      <FileSpreadsheet size={28} />
      <strong>{title}</strong>
      <p>{description}</p>
    </div>
  );
}

function ImportJobs({
  jobs,
  canManage,
  onOpen,
  onCancel,
  onExportCaseIds,
}: {
  jobs: ImportJob[];
  canManage: boolean;
  onOpen(): void;
  onCancel(id: string): Promise<void>;
  onExportCaseIds(id: string): Promise<void>;
}) {
  return (
    <div className="ddt-section">
      <header>
        <div>
          <strong>导入任务</strong>
          <span>预检、冲突策略和逐文件结果都可追溯</span>
        </div>
        {canManage ? (
          <Button className="button button-primary" type="button" onClick={onOpen}>
            <Plus size={15} /> 新建导入
          </Button>
        ) : null}
      </header>
      {jobs.length ? (
        <div className="ddt-job-list">
          {jobs.map((job) => (
            <article className="card ddt-job" key={job.id}>
              <div className="ddt-job-main">
                <span className={`ddt-status ${job.status}`}>{statusLabel(job.status)}</span>
                <strong>
                  {job.totalFiles} 个表格 · {job.totalRows} 行
                </strong>
                <small>{formatDate(job.createdAt)}</small>
              </div>
              <div className="ddt-job-progress">
                <div>
                  <i style={{ width: `${job.progressPercent}%` }} />
                </div>
                <span>{job.progressPercent}%</span>
              </div>
              <div className="ddt-job-results">
                <span>
                  新增 <strong>{job.insertedCount}</strong>
                </span>
                <span>
                  更新 <strong>{job.updatedCount}</strong>
                </span>
                <span>
                  未变 <strong>{job.unchangedCount}</strong>
                </span>
                <span>
                  跳过 <strong>{job.skippedCount}</strong>
                </span>
                <span>
                  失败文件 <strong>{job.failedFiles}</strong>
                </span>
              </div>
              {job.errorSummary ? (
                <div className="inline-notice error" role="alert">
                  {job.errorSummary}
                </div>
              ) : null}
              {canManage && ["previewed", "queued", "running"].includes(job.status) ? (
                <Button
                  className="text-button danger"
                  type="button"
                  onClick={() => void onCancel(job.id)}
                >
                  取消
                </Button>
              ) : null}
              {["succeeded", "partially_succeeded"].includes(job.status) ? (
                <Button
                  className="text-button"
                  type="button"
                  onClick={() => void onExportCaseIds(job.id)}
                >
                  <Download size={14} /> 导出本任务 CaseID
                </Button>
              ) : null}
              <details>
                <summary>逐文件结果</summary>
                {job.files.map((file) => (
                  <div className="ddt-file-row" key={file.id}>
                    <strong>{file.archiveEntryName ?? file.fileName}</strong>
                    <span>{file.rowCount} 行</span>
                    <span>{statusLabel(file.status)}</span>
                    {file.errorSummary ? <small>{file.errorSummary}</small> : null}
                  </div>
                ))}
              </details>
            </article>
          ))}
        </div>
      ) : (
        <Empty
          title="还没有导入任务"
          description="支持 XLSX、XLS、XLSB、CSV、ODS 和 ZIP 批量导入。"
        />
      )}
    </div>
  );
}

function Templates({
  templates,
  canManage,
  onCreate,
  onDelete,
}: {
  templates: Template[];
  canManage: boolean;
  onCreate(): void;
  onDelete(item: Template): Promise<void>;
}) {
  return (
    <div className="ddt-section">
      <header>
        <div>
          <strong>字段模板</strong>
          <span>按 srNum 校验必填字段、数据类型和默认值</span>
        </div>
        {canManage ? (
          <Button className="button button-primary" type="button" onClick={onCreate}>
            <Plus size={15} /> 新建模板
          </Button>
        ) : null}
      </header>
      {templates.length ? (
        <div className="ddt-template-grid">
          {templates.map((item) => (
            <article className="card ddt-template" key={item.id}>
              <div>
                <span className="ddt-group-tag">{item.srNum}</span>
                <strong>{item.name}</strong>
                <p>{item.description || "未填写说明"}</p>
              </div>
              <div className="ddt-rule-chips">
                {item.rules.map((rule) => (
                  <span key={rule.field}>
                    {rule.field}
                    <small>
                      {rule.type}
                      {rule.required ? " · 必填" : ""}
                    </small>
                  </span>
                ))}
              </div>
              {canManage ? (
                <Button
                  className="icon-button danger"
                  type="button"
                  aria-label={`删除模板 ${item.name}`}
                  onClick={() => void onDelete(item)}
                >
                  <Trash2 size={16} />
                </Button>
              ) : null}
            </article>
          ))}
        </div>
      ) : (
        <Empty
          title="还没有字段模板"
          description="模板是可选的；创建后会在预检与编辑时统一校验。"
        />
      )}
    </div>
  );
}

function Recycle({
  items,
  canManage,
  onRestore,
  onPurge,
}: {
  items: DeletedCase[];
  canManage: boolean;
  onRestore(id: string): Promise<void>;
  onPurge(id: string): Promise<void>;
}) {
  return (
    <div className="ddt-section">
      <header>
        <div>
          <strong>回收站</strong>
          <span>删除先进入回收站，永久清除需再次确认</span>
        </div>
      </header>
      {items.length ? (
        <div className="ddt-table-shell">
          <table className="data-table ddt-table">
            <thead>
              <tr>
                <th>CaseID</th>
                <th>srNum</th>
                <th>来源</th>
                <th>删除时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <strong>{item.caseId}</strong>
                  </td>
                  <td>{item.srNum}</td>
                  <td>{item.sourceName}</td>
                  <td>{formatDate(item.deletedAt)}</td>
                  <td>
                    {canManage ? (
                      <div className="table-actions">
                        <Button
                          className="text-button"
                          type="button"
                          onClick={() => void onRestore(item.id)}
                        >
                          <RotateCcw size={14} /> 恢复
                        </Button>
                        <Button
                          className="text-button danger"
                          type="button"
                          onClick={() => void onPurge(item.id)}
                        >
                          <Trash2 size={14} /> 永久删除
                        </Button>
                      </div>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title="回收站为空" description="被删除的 DDT 用例会保留在这里，直到永久清除。" />
      )}
    </div>
  );
}

function ImportDialog({
  endpoint,
  onClose,
  onComplete,
}: {
  endpoint(path: string, extra?: URLSearchParams): string;
  onClose(): void;
  onComplete(): Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const [files, setFiles] = useState<File[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [job, setJob] = useState<ImportJob>();
  const [strategy, setStrategy] = useState("overwrite");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showColumnConflicts, setShowColumnConflicts] = useState(false);
  const [columnConflictError, setColumnConflictError] = useState("");
  const [columnResolutions, setColumnResolutions] = useState<ColumnResolution[]>([]);
  const [uploadProgress, setUploadProgress] = useState<{
    label: string;
    detail: string;
    percent: number;
    indeterminate?: boolean;
  }>();
  const selectFiles = (selectedFiles: File[]) => {
    if (!selectedFiles.length) return;
    const unsupportedFiles = selectedFiles.filter((file) => !isSupportedDdtImportFile(file));
    if (unsupportedFiles.length) {
      setError(
        `不支持以下文件：${unsupportedFiles.map((file) => file.name).join("、")}。请上传 XLSX、XLS、XLSB、CSV、ODS 或 ZIP 文件。`,
      );
      return;
    }
    setFiles(selectedFiles);
    setJob(undefined);
    setShowColumnConflicts(false);
    setColumnResolutions([]);
    setError("");
  };
  const handleDragEnter = (event: ReactDragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (busy) return;
    dragDepthRef.current += 1;
    setDragActive(true);
  };
  const handleDragOver = (event: ReactDragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!busy) event.dataTransfer.dropEffect = "copy";
  };
  const handleDragLeave = (event: ReactDragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  };
  const handleDrop = (event: ReactDragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = 0;
    setDragActive(false);
    if (busy) return;
    const droppedFiles = [...event.dataTransfer.files];
    if (!droppedFiles.length) {
      setError("没有检测到可上传文件，请直接拖入文件，不要拖入文件夹。");
      return;
    }
    selectFiles(droppedFiles);
  };
  const acceptPreview = (
    nextJob: ImportJob,
    previousResolutions: readonly ColumnResolution[] = [],
  ) => {
    const conflicts = importColumnConflicts(nextJob);
    setJob(nextJob);
    if (conflicts.length) {
      setColumnResolutions(defaultColumnResolutions(conflicts, previousResolutions));
      setColumnConflictError("");
      setShowColumnConflicts(true);
    } else {
      setShowColumnConflicts(false);
    }
  };
  const preview = async () => {
    setBusy(true);
    setError("");
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    const detail = `${files.length} 个文件 · ${formatBytes(totalBytes)}`;
    setUploadProgress({ label: "正在上传用例文件", detail, percent: 0 });
    try {
      const body = new FormData();
      files.forEach((file) => body.append("files", file));
      const response = await uploadWithProgress({
        url: endpoint("imports/preview"),
        body,
        onProgress: ({ percent }) =>
          setUploadProgress({ label: "正在上传用例文件", detail, percent }),
        onUploadComplete: () =>
          setUploadProgress({
            label: "上传完成，正在解析并预检",
            detail,
            percent: 100,
          }),
      });
      if (!response.ok) throw await responseError(response);
      acceptPreview((await response.json()) as ImportJob);
      setUploadProgress(undefined);
    } catch (previewError) {
      setError(messageOf(previewError));
      setUploadProgress(undefined);
    } finally {
      setBusy(false);
    }
  };
  const resolveColumns = async () => {
    if (!job) return;
    const validationError = validateColumnResolutions(
      columnResolutions,
      importColumnConflicts(job),
    );
    if (validationError) {
      setColumnConflictError(validationError);
      return;
    }
    const normalizedResolutions = columnResolutions.map((resolution) => ({
      ...resolution,
      resolvedName: resolution.resolvedName.trim(),
    }));
    setBusy(true);
    setColumnConflictError("");
    setUploadProgress({
      label: "正在应用并重新预检",
      detail: "使用服务器已保存的原始文件，无需重新上传",
      percent: 0,
      indeterminate: true,
    });
    try {
      const nextJob = await requestJson<ImportJob>(endpoint(`imports/${job.id}/resolve-columns`), {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ columnResolutions: normalizedResolutions }),
      });
      acceptPreview(nextJob, normalizedResolutions);
    } catch (resolutionError) {
      setColumnConflictError(messageOf(resolutionError));
    } finally {
      setUploadProgress(undefined);
      setBusy(false);
    }
  };
  const confirm = async () => {
    if (!job) return;
    setBusy(true);
    setError("");
    try {
      await requestJson(endpoint(`imports/${job.id}/confirm`), {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ conflictStrategy: strategy }),
      });
      await onComplete();
    } catch (confirmError) {
      setError(messageOf(confirmError));
      setBusy(false);
    }
  };
  const unresolvedColumnConflicts = job ? importColumnConflicts(job) : [];
  return (
    <>
      <Dialog
        title="导入 DDT 用例"
        subtitle="先预检，再选择冲突策略启动后台导入"
        onClose={onClose}
        inactive={showColumnConflicts}
        closeDisabled={busy}
      >
        <div className="ddt-import-dialog">
          {error ? <div className="inline-notice error">{error}</div> : null}
          {!job ? (
            <>
              <Button
                className={`ddt-dropzone${dragActive ? " drag-active" : ""}`}
                type="button"
                aria-busy={busy}
                aria-describedby="ddt-import-file-help"
                disabled={busy}
                onDragEnter={handleDragEnter}
                onDragLeave={handleDragLeave}
                onDragOver={handleDragOver}
                onDrop={handleDrop}
                onClick={() => inputRef.current?.click()}
              >
                <Upload size={28} />
                <strong>{dragActive ? "松开即可添加文件" : "选择或拖入表格、ZIP 压缩包"}</strong>
                <span id="ddt-import-file-help">
                  支持 XLSX、XLS、XLSB、CSV、ODS；ZIP 可包含根目录或一层子目录
                </span>
              </Button>
              <Input
                ref={inputRef}
                hidden
                multiple
                type="file"
                disabled={busy}
                accept={DDT_IMPORT_FILE_ACCEPT}
                onChange={(event) => {
                  selectFiles([...(event.target.files ?? [])]);
                  event.target.value = "";
                }}
              />
              {files.length ? (
                <div className="ddt-picked-files">
                  {files.map((file) => (
                    <span key={`${file.name}-${file.size}`}>
                      <FileSpreadsheet size={14} /> {file.name}
                      <small>{formatBytes(file.size)}</small>
                    </span>
                  ))}
                </div>
              ) : null}
              {uploadProgress ? (
                <OperationProgress
                  detail={uploadProgress.detail}
                  {...(uploadProgress.indeterminate ? { indeterminate: true } : {})}
                  label={uploadProgress.label}
                  value={uploadProgress.percent}
                />
              ) : null}
              <footer>
                <Button
                  className="button button-secondary"
                  type="button"
                  onClick={onClose}
                  disabled={busy}
                >
                  取消
                </Button>
                <Button
                  className="button button-primary"
                  type="button"
                  disabled={!files.length || busy}
                  onClick={() => void preview()}
                >
                  {busy ? <LoaderCircle className="spin" size={15} /> : null}开始预检
                </Button>
              </footer>
            </>
          ) : (
            <>
              <div className="ddt-preview-summary">
                <span>
                  <small>有效表格</small>
                  <strong>
                    {job.validFiles} / {job.totalFiles}
                  </strong>
                </span>
                <span>
                  <small>数据行</small>
                  <strong>{job.totalRows}</strong>
                </span>
                <span>
                  <small>预计新增</small>
                  <strong>{job.files.reduce((sum, file) => sum + file.insertedCount, 0)}</strong>
                </span>
                <span>
                  <small>预计更新</small>
                  <strong>{job.files.reduce((sum, file) => sum + file.updatedCount, 0)}</strong>
                </span>
              </div>
              <div className="ddt-preview-files">
                {job.files.map((file) => (
                  <div key={file.id}>
                    <strong>{file.archiveEntryName ?? file.fileName}</strong>
                    <span>{file.rowCount} 行</span>
                    {file.errorSummary ? <small>{file.errorSummary}</small> : <i>可导入</i>}
                  </div>
                ))}
              </div>
              {unresolvedColumnConflicts.length ? (
                <div className="ddt-column-conflict-notice" role="alert">
                  <AlertTriangle size={18} aria-hidden="true" />
                  <span>
                    <strong>发现重复列名</strong>
                    <small>
                      请先处理上方文件中的重复列名，再确认导入。暂不处理会保留当前选择。
                    </small>
                  </span>
                  <Button
                    className="button button-secondary"
                    type="button"
                    disabled={busy}
                    onClick={() => setShowColumnConflicts(true)}
                  >
                    处理重复列名
                  </Button>
                </div>
              ) : null}
              <fieldset
                className="ddt-strategy"
                disabled={busy || unresolvedColumnConflicts.length > 0}
              >
                <legend>CaseID 冲突时</legend>
                {(
                  [
                    ["overwrite", "覆盖并保留历史"],
                    ["skip", "跳过已有用例"],
                    ["error", "遇到冲突终止"],
                  ] as const
                ).map(([value, label]) => (
                  <label key={value}>
                    <Input
                      type="radio"
                      name="strategy"
                      value={value}
                      checked={strategy === value}
                      onChange={() => setStrategy(value)}
                    />
                    <span>
                      <strong>{label}</strong>
                    </span>
                  </label>
                ))}
              </fieldset>
              <footer>
                <Button
                  className="button button-secondary"
                  type="button"
                  disabled={busy}
                  onClick={() => setJob(undefined)}
                >
                  重新选择
                </Button>
                <Button
                  className="button button-primary"
                  type="button"
                  disabled={!job.validFiles || busy || unresolvedColumnConflicts.length > 0}
                  onClick={() => void confirm()}
                >
                  {busy ? <LoaderCircle className="spin" size={15} /> : null}确认并后台导入
                </Button>
              </footer>
            </>
          )}
        </div>
      </Dialog>
      {showColumnConflicts && job ? (
        <ColumnConflictDialog
          conflicts={unresolvedColumnConflicts}
          resolutions={columnResolutions}
          busy={busy}
          error={columnConflictError}
          {...(uploadProgress ? { uploadProgress } : {})}
          onChange={(resolutions) => {
            setColumnConflictError("");
            setColumnResolutions(resolutions);
          }}
          onClose={() => setShowColumnConflicts(false)}
          onConfirm={() => void resolveColumns()}
        />
      ) : null}
    </>
  );
}

function ColumnConflictDialog({
  conflicts,
  resolutions,
  busy,
  error,
  uploadProgress,
  onChange,
  onClose,
  onConfirm,
}: {
  conflicts: LocatedColumnConflict[];
  resolutions: ColumnResolution[];
  busy: boolean;
  error: string;
  uploadProgress?: {
    label: string;
    detail: string;
    percent: number;
    indeterminate?: boolean;
  };
  onChange(resolutions: ColumnResolution[]): void;
  onClose(): void;
  onConfirm(): void;
}) {
  const validationError = validateColumnResolutions(resolutions, conflicts);
  const conflictColumnCount = conflicts.reduce(
    (total, conflict) => total + conflict.columns.length,
    0,
  );
  const currentConflictColumnKeys = new Set(
    conflicts.flatMap((conflict) =>
      conflict.columns.map((column) =>
        columnResolutionKey(columnResolutionIdentity(conflict, column.columnIndex)),
      ),
    ),
  );
  const deletedColumnCount = resolutions.filter(
    (resolution) =>
      resolution.deleteColumn && currentConflictColumnKeys.has(columnResolutionKey(resolution)),
  ).length;
  const affectedFileCount = new Set(
    conflicts.map((conflict) =>
      [conflict.uploadIndex, conflict.archiveEntryName ?? conflict.uploadName].join("\u0000"),
    ),
  ).size;
  const firstColumn = conflicts[0]?.columns[0];
  const firstColumnKey = firstColumn
    ? columnResolutionKey({
        uploadIndex: conflicts[0]!.uploadIndex,
        ...(conflicts[0]!.archiveEntryName
          ? { archiveEntryName: conflicts[0]!.archiveEntryName }
          : {}),
        sheetName: conflicts[0]!.sheetName,
        columnIndex: firstColumn.columnIndex,
      })
    : "";
  return (
    <Dialog
      title="解决重复列名"
      subtitle="对照两列内容后选择改名保留或删除，平台会使用已保存的原文件重新预检"
      onClose={onClose}
      closeDisabled={busy}
      backdropClassName="ddt-column-conflict-backdrop"
    >
      <div className="ddt-column-conflict-dialog">
        <div className="ddt-column-conflict-guidance">
          <AlertTriangle size={18} />
          <p>
            <strong>
              {affectedFileCount} 个文件 · {conflicts.length} 组冲突 · {conflictColumnCount}{" "}
              个重复列
            </strong>
          </p>
          <Button
            className="button button-secondary"
            disabled={busy}
            size="compact"
            type="button"
            onClick={() => onChange(applySuggestedColumnNames(resolutions, conflicts))}
          >
            全部按建议改名
          </Button>
        </div>
        <div className="ddt-column-conflict-list">
          {conflicts.map((conflict, conflictIndex) => {
            const location = conflict.archiveEntryName
              ? `${conflict.uploadName} / ${conflict.archiveEntryName}`
              : conflict.uploadName;
            const retainedColumnCount = countRetainedConflictColumns(resolutions, conflict);
            return (
              <section
                key={`${conflict.uploadIndex}-${location}-${conflict.sheetName}-${conflict.normalizedName}`}
              >
                <header>
                  <div className="ddt-column-conflict-location">
                    <span>
                      <FileSpreadsheet size={16} />
                      <strong title={location}>{location}</strong>
                    </span>
                    <small>
                      {conflict.sheetName} Sheet · “{conflict.columns[0]?.currentName}”重复
                    </small>
                  </div>
                  <div className="ddt-column-conflict-group-actions">
                    <small>
                      第 {conflictIndex + 1} / {conflicts.length} 组
                    </small>
                    <Button
                      className="button button-secondary"
                      disabled={busy}
                      size="compact"
                      type="button"
                      onClick={() => onChange(applySuggestedColumnNames(resolutions, [conflict]))}
                    >
                      本组全部改名保留
                    </Button>
                  </div>
                </header>
                <div>
                  {conflict.columns.map((column) => {
                    const identity = {
                      uploadIndex: conflict.uploadIndex,
                      ...(conflict.archiveEntryName
                        ? { archiveEntryName: conflict.archiveEntryName }
                        : {}),
                      sheetName: conflict.sheetName,
                      columnIndex: column.columnIndex,
                    };
                    const key = columnResolutionKey(identity);
                    const resolution = resolutions.find(
                      (candidate) => columnResolutionKey(candidate) === key,
                    );
                    const resolvedName = resolution?.resolvedName ?? column.suggestedName;
                    const deleteColumn = resolution?.deleteColumn === true;
                    return (
                      <article
                        className={`ddt-column-choice${deleteColumn ? " is-deleted" : ""}`}
                        key={key}
                      >
                        <div className="ddt-column-choice-heading">
                          <span>
                            <small>第 {column.columnIndex + 1} 列</small>
                            <strong title={column.originalName}>{column.originalName}</strong>
                          </span>
                          <label className="ddt-column-delete-option">
                            <Input
                              type="checkbox"
                              disabled={busy}
                              checked={deleteColumn}
                              aria-label={`${location} ${conflict.sheetName} Sheet 删除第 ${column.columnIndex + 1} 列 ${column.originalName}`}
                              onChange={(event) =>
                                onChange(
                                  replaceColumnResolution(resolutions, {
                                    ...identity,
                                    resolvedName,
                                    deleteColumn: event.target.checked,
                                  }),
                                )
                              }
                            />
                            <Trash2 size={14} aria-hidden="true" />
                            删除此列
                          </label>
                        </div>
                        <div className="ddt-column-samples">
                          <header>
                            <span>内容预览</span>
                            <small>{column.nonEmptyCount} 个非空单元格</small>
                          </header>
                          {column.sampleValues.length ? (
                            <ul>
                              {column.sampleValues.map((sample) => (
                                <li key={`${sample.rowNumber}-${sample.value}`}>
                                  <small>行 {sample.rowNumber}</small>
                                  <span title={sample.value}>{sample.value}</span>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p>该列没有非空内容</p>
                          )}
                        </div>
                        <Button
                          className="ddt-column-keep-only button button-secondary"
                          disabled={busy || (!deleteColumn && retainedColumnCount === 1)}
                          size="compact"
                          type="button"
                          onClick={() =>
                            onChange(
                              keepOnlyConflictColumn(resolutions, conflict, column.columnIndex),
                            )
                          }
                        >
                          仅保留此列
                        </Button>
                        <label className="ddt-column-name-field">
                          <span>{deleteColumn ? "该列将在导入时忽略" : "保留后的列名"}</span>
                          <Input
                            autoFocus={key === firstColumnKey}
                            disabled={busy || deleteColumn}
                            maxLength={256}
                            value={resolvedName}
                            aria-label={`${location} ${conflict.sheetName} Sheet 第 ${column.columnIndex + 1} 列的新列名`}
                            onChange={(event) =>
                              onChange(
                                replaceColumnResolution(resolutions, {
                                  ...identity,
                                  resolvedName: event.target.value,
                                  ...(deleteColumn ? { deleteColumn: true } : {}),
                                }),
                              )
                            }
                          />
                        </label>
                      </article>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
        {uploadProgress ? (
          <OperationProgress
            detail={uploadProgress.detail}
            {...(uploadProgress.indeterminate ? { indeterminate: true } : {})}
            label={uploadProgress.label}
            value={uploadProgress.percent}
          />
        ) : null}
        <div className="ddt-column-resolution-feedback">
          {error || validationError ? (
            <div className="inline-notice error" role="alert">
              {error || validationError}
            </div>
          ) : (
            <div className="ddt-column-resolution-summary" aria-live="polite">
              <CheckCircle2 aria-hidden="true" size={16} />
              <span>
                待应用的列名方案
                <small>
                  保留 {conflictColumnCount - deletedColumnCount} 列 · 删除 {deletedColumnCount} 列
                </small>
              </span>
            </div>
          )}
          <p className="ddt-column-resolution-help">
            对照上方内容，改名可保留全部数据，也可仅保留指定列。应用后会重新预检，此时还不会导入用例。
          </p>
        </div>
        <footer>
          <Button
            className="button button-secondary"
            type="button"
            disabled={busy}
            onClick={onClose}
          >
            暂不处理
          </Button>
          <Button
            className="button button-primary"
            type="button"
            disabled={busy || conflicts.length === 0 || Boolean(validationError)}
            onClick={onConfirm}
          >
            {busy ? <LoaderCircle className="spin" size={15} /> : null}
            应用并重新预检
          </Button>
        </footer>
      </div>
    </Dialog>
  );
}

function TemplateDialog({
  endpoint,
  onClose,
  onComplete,
}: {
  endpoint(path: string): string;
  onClose(): void;
  onComplete(): Promise<void>;
}) {
  const [srNum, setSrNum] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [rules, setRules] = useState<TemplateRule[]>([
    { field: "", required: false, type: "string" },
  ]);
  const [error, setError] = useState("");
  const save = async () => {
    try {
      await requestJson(endpoint("templates"), {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          srNum,
          name,
          description,
          rules: rules.filter((rule) => rule.field.trim()),
        }),
      });
      await onComplete();
    } catch (saveError) {
      setError(messageOf(saveError));
    }
  };
  return (
    <Dialog title="新建字段模板" subtitle="模板仅作用于当前项目版本和测试阶段" onClose={onClose}>
      <div className="form-grid ddt-template-form">
        {error ? <div className="inline-notice error full-span">{error}</div> : null}
        <label>
          <span>srNum</span>
          <Input
            value={srNum}
            onChange={(event) => setSrNum(event.target.value)}
            placeholder="例如：ORDER"
          />
        </label>
        <label>
          <span>模板名称</span>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="订单用例字段"
          />
        </label>
        <label className="full-span">
          <span>说明</span>
          <Textarea value={description} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <div className="full-span ddt-rule-builder">
          <div>
            <strong>字段规则</strong>
            <Button
              className="text-button"
              type="button"
              onClick={() => setRules([...rules, { field: "", required: false, type: "string" }])}
            >
              <Plus size={14} /> 添加字段
            </Button>
          </div>
          {rules.map((rule, index) => (
            <div key={index}>
              <Input
                aria-label={`字段 ${index + 1} 名称`}
                value={rule.field}
                onChange={(event) =>
                  setRules(replaceAt(rules, index, { ...rule, field: event.target.value }))
                }
                placeholder="字段名"
              />
              <Select
                aria-label={`字段 ${index + 1} 类型`}
                value={rule.type}
                onChange={(event) =>
                  setRules(
                    replaceAt(rules, index, {
                      ...rule,
                      type: event.target.value as TemplateRule["type"],
                    }),
                  )
                }
              >
                <option value="string">文本</option>
                <option value="number">数字</option>
                <option value="boolean">布尔</option>
                <option value="date">日期</option>
              </Select>
              <label>
                <Input
                  type="checkbox"
                  checked={rule.required}
                  onChange={(event) =>
                    setRules(replaceAt(rules, index, { ...rule, required: event.target.checked }))
                  }
                />{" "}
                必填
              </label>
              <Button
                className="icon-button danger"
                type="button"
                aria-label={`删除字段 ${index + 1}`}
                onClick={() => setRules(rules.filter((_, itemIndex) => itemIndex !== index))}
              >
                <Trash2 size={15} />
              </Button>
            </div>
          ))}
        </div>
        <footer className="full-span">
          <Button className="button button-secondary" type="button" onClick={onClose}>
            取消
          </Button>
          <Button
            className="button button-primary"
            type="button"
            disabled={!srNum.trim() || !name.trim()}
            onClick={() => void save()}
          >
            创建模板
          </Button>
        </footer>
      </div>
    </Dialog>
  );
}

function BulkDialog({
  count,
  caseIds,
  endpoint,
  onClose,
  onComplete,
}: {
  count: number;
  caseIds: string[];
  endpoint(path: string): string;
  onClose(): void;
  onComplete(): Promise<void>;
}) {
  const [field, setField] = useState("");
  const [value, setValue] = useState("");
  const [stepName, setStepName] = useState("");
  const [error, setError] = useState("");
  const save = async () => {
    try {
      await requestJson(endpoint("cases/bulk-update"), {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ caseIds, field, value, ...(stepName ? { stepName } : {}) }),
      });
      await onComplete();
    } catch (saveError) {
      setError(messageOf(saveError));
    }
  };
  return (
    <Dialog
      title={`批量修改 ${count} 条用例`}
      subtitle="普通用例直接修改字段；用户旅程可指定 step1…stepN"
      onClose={onClose}
    >
      <div className="form-grid ddt-bulk-form">
        {error ? <div className="inline-notice error full-span">{error}</div> : null}
        <label>
          <span>字段名</span>
          <Input
            value={field}
            onChange={(event) => setField(event.target.value)}
            placeholder="例如：priority"
          />
        </label>
        <label>
          <span>新值</span>
          <Input value={value} onChange={(event) => setValue(event.target.value)} />
        </label>
        <label className="full-span">
          <span>用户旅程 Step（可选）</span>
          <Input
            value={stepName}
            onChange={(event) => setStepName(event.target.value)}
            placeholder="step1"
          />
        </label>
        <footer className="full-span">
          <Button className="button button-secondary" type="button" onClick={onClose}>
            取消
          </Button>
          <Button
            className="button button-primary"
            disabled={!field.trim()}
            type="button"
            onClick={() => void save()}
          >
            应用修改
          </Button>
        </footer>
      </div>
    </Dialog>
  );
}

function AddDdtToSuiteDialog({
  caseIds,
  scope,
  suites,
  initialSuiteId,
  onClose,
  onComplete,
}: {
  caseIds: string[];
  scope: Scope;
  initialSuiteId?: string | undefined;
  suites: Array<{ id: string; name: string }>;
  onClose(): void;
  onComplete(suiteName: string): Promise<void>;
}) {
  const [suiteId, setSuiteId] = useState(
    suites.some((suite) => suite.id === initialSuiteId)
      ? initialSuiteId!
      : (suites[0]?.id ?? "new"),
  );
  const [newSuiteName, setNewSuiteName] = useState("");
  const [createdSuite, setCreatedSuite] = useState<{ id: string; name: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    let suite = suiteId === "new" ? createdSuite : suites.find((item) => item.id === suiteId);
    setBusy(true);
    setError("");
    try {
      if (!suite && suiteId === "new") {
        suite = await requestJson<{ id: string; name: string }>("/api/v1/case-suites", {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({
            name: newSuiteName.trim(),
            projectId: scope.projectId,
            projectVersionId: scope.projectVersionId,
          }),
        });
        // Keep the created task on a membership failure so retrying cannot create duplicates.
        setCreatedSuite(suite);
      }
      if (!suite) return;
      await requestJson(`/api/v1/case-suites/${encodeURIComponent(suite.id)}/ddt-cases`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ testStageId: scope.testStageId, caseIds }),
      });
      await onComplete(suite.name);
    } catch (saveError) {
      setError(messageOf(saveError));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={`将 ${caseIds.length} 条 DDT 用例加入任务`}
      subtitle="可加入已有任务与普通用例混合执行，也可新建仅含 DDT 的任务。执行前所有 DDT 用例必须完成 SR 测试类关联，并在任务设置中启用 Adapter。"
      onClose={onClose}
      closeDisabled={busy}
    >
      <div className="form-grid ddt-add-suite-dialog">
        {error ? <div className="inline-notice error full-span">{error}</div> : null}
        <label className="full-span">
          <span>目标用例任务</span>
          <Select
            value={suiteId}
            disabled={busy || Boolean(createdSuite)}
            onChange={(event) => setSuiteId(event.target.value)}
          >
            {suites.map((suite) => (
              <option key={suite.id} value={suite.id}>
                {suite.name}
              </option>
            ))}
            <option value="new">新建用例任务</option>
          </Select>
        </label>
        {suiteId === "new" ? (
          <label className="full-span">
            <span>新任务名称</span>
            <Input
              value={createdSuite?.name ?? newSuiteName}
              maxLength={120}
              disabled={busy || Boolean(createdSuite)}
              onChange={(event) => setNewSuiteName(event.target.value)}
              placeholder="例如：DDT 回归测试"
            />
          </label>
        ) : null}
        {createdSuite ? (
          <p className="muted full-span">
            任务“{createdSuite.name}”已创建，重新点击加入任务可重试添加所选用例。
          </p>
        ) : null}
        <footer className="full-span">
          <Button
            className="button button-secondary"
            type="button"
            disabled={busy}
            onClick={onClose}
          >
            取消
          </Button>
          <Button
            className="button button-primary"
            type="button"
            disabled={
              busy || (suiteId === "new" ? !newSuiteName.trim() && !createdSuite : !suiteId)
            }
            onClick={() => void save()}
          >
            {busy ? <LoaderCircle className="spin" size={15} /> : <ListPlus size={15} />}
            加入任务
          </Button>
        </footer>
      </div>
    </Dialog>
  );
}

function Dialog({
  title,
  subtitle,
  onClose,
  children,
  inactive = false,
  closeDisabled = false,
  backdropClassName,
}: {
  title: string;
  subtitle: string;
  onClose(): void;
  children: ReactNode;
  inactive?: boolean;
  closeDisabled?: boolean;
  backdropClassName?: string;
}) {
  const titleId = useId();
  return (
    <div
      className={`modal-backdrop${backdropClassName ? ` ${backdropClassName}` : ""}`}
      role="presentation"
      onMouseDown={(event) => {
        if (!inactive && !closeDisabled && event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="modal-card ddt-dialog"
        role="dialog"
        aria-modal={!inactive}
        aria-hidden={inactive || undefined}
        inert={inactive}
        aria-labelledby={titleId}
      >
        <header>
          <div>
            <h2 id={titleId}>{title}</h2>
            <p>{subtitle}</p>
          </div>
          <Button
            className="icon-button"
            type="button"
            aria-label="关闭弹窗"
            disabled={closeDisabled}
            onClick={onClose}
          >
            <X size={18} />
          </Button>
        </header>
        {children}
      </section>
    </div>
  );
}

const jsonHeaders = { "content-type": "application/json" };

async function requestJson<Result = unknown>(url: string, init?: RequestInit): Promise<Result> {
  const read = !init?.method || init.method === "GET";
  const cacheable = read && /\/ddt\/(?:dashboard|cases|groups|templates|recycle)\?/.test(url);
  if (cacheable && init?.cache !== "reload") {
    const cached = readBrowserSnapshot(url);
    if (cached !== undefined) return cached as Result;
  }
  if (!read) clearBrowserSnapshots();
  const epoch = browserCacheEpoch();
  const response = await fetch(url, init);
  if (!response.ok) throw await responseError(response);
  if (response.status === 204) return undefined as Result;
  const result = (await response.json()) as Result;
  if (cacheable) writeBrowserSnapshot(url, result, epoch);
  return result;
}

async function responseError(response: Response): Promise<Error> {
  return (
    (await readApiError(response, `请求失败（${response.status}）`)) ??
    new Error(`请求失败（${response.status}）`)
  );
}

function importColumnConflicts(job: ImportJob): LocatedColumnConflict[] {
  return job.uploads.flatMap((upload, uploadIndex) =>
    (upload.columnConflicts ?? []).map((conflict) => ({
      ...conflict,
      uploadIndex,
      uploadName: upload.fileName,
    })),
  );
}

function defaultColumnResolutions(
  conflicts: readonly LocatedColumnConflict[],
  previous: readonly ColumnResolution[] = [],
): ColumnResolution[] {
  const byColumn = new Map(
    previous.map((resolution) => [columnResolutionKey(resolution), resolution]),
  );
  for (const conflict of conflicts) {
    for (const column of conflict.columns) {
      const resolution: ColumnResolution = {
        uploadIndex: conflict.uploadIndex,
        ...(conflict.archiveEntryName ? { archiveEntryName: conflict.archiveEntryName } : {}),
        sheetName: conflict.sheetName,
        columnIndex: column.columnIndex,
        resolvedName: column.suggestedName,
      };
      const key = columnResolutionKey(resolution);
      if (!byColumn.has(key)) byColumn.set(key, resolution);
    }
  }
  return [...byColumn.values()].sort(
    (left, right) =>
      left.uploadIndex - right.uploadIndex ||
      (left.archiveEntryName ?? "").localeCompare(right.archiveEntryName ?? "") ||
      left.sheetName.localeCompare(right.sheetName) ||
      left.columnIndex - right.columnIndex,
  );
}

function applySuggestedColumnNames(
  resolutions: readonly ColumnResolution[],
  conflicts: readonly LocatedColumnConflict[],
): ColumnResolution[] {
  let next = [...resolutions];
  for (const conflict of conflicts) {
    for (const column of conflict.columns) {
      next = replaceColumnResolution(next, {
        ...columnResolutionIdentity(conflict, column.columnIndex),
        resolvedName: column.suggestedName,
      });
    }
  }
  return next;
}

function keepOnlyConflictColumn(
  resolutions: readonly ColumnResolution[],
  conflict: LocatedColumnConflict,
  retainedColumnIndex: number,
): ColumnResolution[] {
  const requiredName =
    conflict.normalizedName === "caseid"
      ? "CaseID"
      : conflict.normalizedName === "srnum"
        ? "srNum"
        : undefined;
  let next = [...resolutions];
  for (const column of conflict.columns) {
    const identity = columnResolutionIdentity(conflict, column.columnIndex);
    const existing = next.find(
      (resolution) => columnResolutionKey(resolution) === columnResolutionKey(identity),
    );
    const retained = column.columnIndex === retainedColumnIndex;
    next = replaceColumnResolution(next, {
      ...identity,
      resolvedName: retained
        ? (requiredName ?? existing?.resolvedName ?? column.currentName)
        : (existing?.resolvedName ?? column.suggestedName),
      ...(retained ? {} : { deleteColumn: true }),
    });
  }
  return next;
}

function countRetainedConflictColumns(
  resolutions: readonly ColumnResolution[],
  conflict: LocatedColumnConflict,
): number {
  return conflict.columns.filter((column) => {
    const key = columnResolutionKey(columnResolutionIdentity(conflict, column.columnIndex));
    return (
      resolutions.find((resolution) => columnResolutionKey(resolution) === key)?.deleteColumn !==
      true
    );
  }).length;
}

function columnResolutionIdentity(
  conflict: LocatedColumnConflict,
  columnIndex: number,
): Pick<ColumnResolution, "uploadIndex" | "archiveEntryName" | "sheetName" | "columnIndex"> {
  return {
    uploadIndex: conflict.uploadIndex,
    ...(conflict.archiveEntryName ? { archiveEntryName: conflict.archiveEntryName } : {}),
    sheetName: conflict.sheetName,
    columnIndex,
  };
}

function replaceColumnResolution(
  resolutions: readonly ColumnResolution[],
  replacement: ColumnResolution,
): ColumnResolution[] {
  const key = columnResolutionKey(replacement);
  const found = resolutions.some((resolution) => columnResolutionKey(resolution) === key);
  return found
    ? resolutions.map((resolution) =>
        columnResolutionKey(resolution) === key ? replacement : resolution,
      )
    : [...resolutions, replacement];
}

function validateColumnResolutions(
  resolutions: readonly ColumnResolution[],
  conflicts: readonly LocatedColumnConflict[],
): string | undefined {
  const namesBySheet = new Map<string, Set<string>>();
  for (const resolution of resolutions) {
    if (resolution.deleteColumn) continue;
    const resolvedName = resolution.resolvedName.trim();
    if (!resolvedName) {
      return `${resolution.sheetName} Sheet 第 ${resolution.columnIndex + 1} 列的新列名不能为空。`;
    }
    const sheetKey = [
      resolution.uploadIndex,
      resolution.archiveEntryName ?? "",
      resolution.sheetName,
    ].join("\u0000");
    const names = namesBySheet.get(sheetKey) ?? new Set<string>();
    const normalizedName = resolvedName.toLocaleLowerCase("en-US");
    if (names.has(normalizedName)) {
      return `${resolution.sheetName} Sheet 的新列名“${resolvedName}”仍然重复。`;
    }
    names.add(normalizedName);
    namesBySheet.set(sheetKey, names);
  }
  const resolutionsByColumn = new Map(
    resolutions.map((resolution) => [columnResolutionKey(resolution), resolution]),
  );
  for (const conflict of conflicts) {
    const conflictResolutions = conflict.columns.flatMap((column) => {
      const key = columnResolutionKey({
        uploadIndex: conflict.uploadIndex,
        ...(conflict.archiveEntryName ? { archiveEntryName: conflict.archiveEntryName } : {}),
        sheetName: conflict.sheetName,
        columnIndex: column.columnIndex,
      });
      const resolution = resolutionsByColumn.get(key);
      return resolution ? [resolution] : [];
    });
    const retainedResolutions = conflictResolutions.filter(
      (resolution) => !resolution.deleteColumn,
    );
    if (conflictResolutions.length && !retainedResolutions.length) {
      return `${conflict.sheetName} Sheet 的重复列“${conflict.columns[0]?.currentName ?? conflict.normalizedName}”至少需要保留一列。`;
    }
    const requiredName =
      conflict.normalizedName === "caseid"
        ? "CaseID"
        : conflict.normalizedName === "srnum"
          ? "srNum"
          : undefined;
    if (!requiredName) continue;
    const conflictResolvedNames = retainedResolutions.map((resolution) =>
      resolution.resolvedName.trim(),
    );
    if (conflictResolvedNames.length && !conflictResolvedNames.includes(requiredName)) {
      return `${conflict.sheetName} Sheet 必须保留一列名为 ${requiredName}。`;
    }
  }
  return undefined;
}

function columnResolutionKey(
  resolution: Pick<
    ColumnResolution,
    "uploadIndex" | "archiveEntryName" | "sheetName" | "columnIndex"
  >,
): string {
  return [
    resolution.uploadIndex,
    resolution.archiveEntryName ?? "",
    resolution.sheetName,
    resolution.columnIndex,
  ].join("\u0000");
}

function toggleSet(current: Set<string>, value: string): Set<string> {
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}
function replaceAt<T>(items: T[], index: number, value: T): T[] {
  return items.map((item, itemIndex) => (itemIndex === index ? value : item));
}
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请稍后重试。";
}
function formatDate(value: string): string {
  return formatPlatformDateTime(value, undefined, { dateStyle: "medium", timeStyle: "short" });
}
function formatBytes(value: number): string {
  return value >= 1_048_576
    ? `${(value / 1_048_576).toFixed(1)} MiB`
    : `${Math.ceil(value / 1_024)} KiB`;
}
function isSupportedDdtImportFile(file: File): boolean {
  const extension = file.name.split(".").pop()?.toLocaleLowerCase("en-US");
  return Boolean(extension && DDT_IMPORT_FILE_EXTENSIONS.has(extension));
}
function statusLabel(value: string): string {
  return (
    (
      {
        previewed: "等待确认",
        queued: "排队中",
        running: "导入中",
        cancel_requested: "取消中",
        succeeded: "已完成",
        partially_succeeded: "部分完成",
        failed: "失败",
        cancelled: "已取消",
        valid: "预检通过",
        excluded: "已排除",
        importing: "导入中",
      } as Record<string, string>
    )[value] ?? value
  );
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
