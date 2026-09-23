"use client";
import { Notice } from "@/components/ui/notice";

import { EmptyState } from "@/components/ui/empty-state";

import { Tabs } from "./ui/tabs";
import { Disclosure } from "@/components/ui/disclosure";

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
import { ActionDialog } from "./action-dialog";
import { DdtCaseInspector } from "./ddt-case-inspector";
import { DdtCaseSelectionDialog } from "./ddt-case-selection-dialog";
import { DdtInheritanceDialog, type DdtInheritanceVersion } from "./ddt-inheritance-dialog";
import type { DdtExecutionStatistics } from "@autoforge/contracts";
import { DdtExecutionChart } from "./ddt-execution-chart";
import { DdtValueSearch } from "./ddt-value-search";
import { DdtApiReference, type DdtScopeLabels } from "./ddt-api-reference";

import {
  ArchiveRestore,
  AlertTriangle,
  BarChart3,
  Boxes,
  CheckCircle2,
  Code2,
  CopyPlus,
  Download,
  FileSpreadsheet,
  Filter,
  Globe2,
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
import { useCallback, useEffect, useRef, useState } from "react";
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
  execution?: DdtExecutionStatistics;
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
type WorkspaceTab = "overview" | "cases" | "imports" | "templates" | "recycle" | "api" | "search";

function workspaceTab(value: string | null): WorkspaceTab {
  return value === "cases" ||
    value === "imports" ||
    value === "templates" ||
    value === "recycle" ||
    value === "api" ||
    value === "search"
    ? value
    : "overview";
}

const DDT_IMPORT_FILE_ACCEPT = ".xlsx,.xls,.xlsb,.csv,.ods,.zip";
const DDT_IMPORT_FILE_EXTENSIONS = new Set(["xlsx", "xls", "xlsb", "csv", "ods", "zip"]);
const DDT_TERMINAL_IMPORT_STATES = new Set([
  "succeeded",
  "partially_succeeded",
  "failed",
  "cancelled",
]);

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
  scopeLabels,
  canManage,
  canManageSuites,
  canRun,
  suites,
  versions,
}: {
  scope: Scope;
  scopeLabels: DdtScopeLabels;
  canManage: boolean;
  canManageSuites: boolean;
  canRun: boolean;
  suites: Array<{ id: string; name: string }>;
  versions: DdtInheritanceVersion[];
}) {
  const confirmAction = useConfirm();
  const showConcurrentModification = useConcurrentModificationFeedback();
  const toast = useToast();
  const router = useRouter();
  const searchParameters = useSearchParams();
  const requestedTab = workspaceTab(searchParameters.get("ddtView"));
  const [tab, setActiveTab] = useState<WorkspaceTab>(requestedTab);
  const isApiTab = tab === "api";
  const isIndependentTab = isApiTab || tab === "search";
  const setTab = (value: WorkspaceTab) => {
    setActiveTab(value);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", "ddt");
    url.searchParams.set("ddtView", value);
    window.history.pushState(null, "", url.pathname + url.search);
  };
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
  const [showInheritance, setShowInheritance] = useState(false);
  const [showTemplate, setShowTemplate] = useState(false);
  const [showBulk, setShowBulk] = useState(false);
  const [showAddToSuite, setShowAddToSuite] = useState(false);
  const [showCaseSelection, setShowCaseSelection] = useState(false);
  const [deleteProgress, setDeleteProgress] = useState<{
    completed: number;
    total: number;
    label: string;
  }>();
  const hasLoaded = useRef(false);
  const loadGeneration = useRef(0);
  const observedImportStates = useRef(new Map<string, string>());
  const appliedFilters = useRef<{ key: string; url: string } | null>(null);
  const filterKey = JSON.stringify([query, srNum, advancedField, advancedOperator, advancedValue]);

  const { projectId, projectVersionId, testStageId } = scope;
  const endpoint = useCallback(
    (path: string, extra?: URLSearchParams) => {
      const parameters = new URLSearchParams({ projectId, projectVersionId, testStageId });
      if (path === "dashboard") parameters.set("statisticsVersion", "2");
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
      const [initialCasePage, templatePage, importPage, recyclePage] = await Promise.all([
        requestJson<{ items: CaseSummary[]; nextCursor?: string }>(
          endpoint("cases", caseParameters),
        ),
        requestJson<{ items: Template[] }>(endpoint("templates")),
        requestJson<{ items: ImportJob[] }>(endpoint("imports")),
        requestJson<{ items: DeletedCase[] }>(endpoint("recycle")),
      ]);
      if (generation !== loadGeneration.current) return;
      let casePage = initialCasePage;
      const importCompleted = importPage.items.some(
        (job) =>
          DDT_TERMINAL_IMPORT_STATES.has(job.status) &&
          observedImportStates.current.get(job.id) !== job.status,
      );
      if (importCompleted) {
        // Parallel reads can observe the case list before commit and the import
        // status after commit. Refresh once before publishing the terminal state,
        // otherwise polling stops with a stale (possibly empty) list in cache.
        clearBrowserSnapshots();
        casePage = await requestJson<{ items: CaseSummary[]; nextCursor?: string }>(
          endpoint("cases", caseParameters),
          { cache: "reload" },
        );
        if (generation !== loadGeneration.current) return;
      }
      observedImportStates.current = new Map(importPage.items.map((job) => [job.id, job.status]));
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
    if (isIndependentTab) return;
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
  }, [confirmAction, filterKey, isIndependentTab, load]);

  useEffect(() => {
    if (isIndependentTab) return;
    if (!imports.some((job) => ["queued", "running", "cancel_requested"].includes(job.status)))
      return;
    const timer = window.setInterval(() => {
      clearBrowserSnapshots();
      void load();
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [imports, isIndependentTab, load]);

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

  const leaveEditor = useCallback(async (): Promise<boolean> => {
    if (editorStatus.current === "saving") return false;
    if (editorStatus.current === "editing") {
      if (!(await confirmAction(discardDdtEdits))) return false;
      editorStatus.current = "idle";
      setEditorEpoch((epoch) => epoch + 1);
    }
    return true;
  }, [confirmAction, setEditorEpoch]);

  useEffect(() => {
    if (requestedTab === tab) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const discard = await leaveEditor();
      if (cancelled) return;
      if (discard) {
        setActiveTab(requestedTab);
      } else {
        const url = new URL(window.location.href);
        url.searchParams.set("ddtView", tab);
        window.history.replaceState(null, "", url.pathname + url.search);
      }
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [leaveEditor, requestedTab, tab]);
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

  return (
    <section
      className={cn("ddt-workspace", ddtManagementWorkspaceStyles["ddt-workspace"])}
      aria-label="DDT 管理工作台"
    >
      <div className={cn("ddt-workspace-bar", ddtManagementWorkspaceStyles["ddt-workspace-bar"])}>
        <div>
          <strong>DDT 工作台</strong>
          <span>CaseID 在当前项目版本与测试阶段内唯一</span>
        </div>
        {tab === "cases" ? (
          <Button
            type="button"
            disabled={busy || savingCase}
            onClick={() => setShowCaseSelection(true)}
          >
            <ListPlus size={16} /> 按清单选择
          </Button>
        ) : null}
        <Button
          className={cn(
            "button button-secondary",
            uiPatterns["button"],
            uiPatterns["button-secondary"],
          )}
          type="button"
          disabled={savingCase}
          onClick={async () => {
            if (await leaveEditor()) router.push("/cases/ddt-associations");
          }}
        >
          <Code2 size={15} /> SR 测试类关联
        </Button>
        {!isIndependentTab ? (
          <Button
            className={cn(
              "button button-secondary",
              uiPatterns["button"],
              uiPatterns["button-secondary"],
            )}
            type="button"
            onClick={async () => {
              if (!(await leaveEditor())) return;
              clearBrowserSnapshots();
              await load();
              if (activeCaseId) await openCase(activeCaseId);
            }}
            disabled={busy || refreshing || savingCase}
          >
            <RefreshCw
              size={15}
              className={busy || refreshing ? cn("spin", uiPatterns["spin"]) : ""}
            />{" "}
            刷新
          </Button>
        ) : null}
        {canManage ? (
          <Button
            type="button"
            disabled={savingCase}
            onClick={async () => {
              if (await leaveEditor()) setShowInheritance(true);
            }}
          >
            <CopyPlus size={16} /> 继承用例
          </Button>
        ) : null}
        {canManage ? (
          <Button
            className={cn(
              "button button-primary",
              uiPatterns["button"],
              uiPatterns["button-primary"],
            )}
            type="button"
            onClick={async () => {
              if (await leaveEditor()) setShowImport(true);
            }}
          >
            <Upload size={16} /> 导入表格
          </Button>
        ) : null}
      </div>

      <Tabs
        className="ddt-subtabs"
        label="DDT 功能"
        value={tab}
        items={(
          [
            ["overview", BarChart3, "概览"],
            ["cases", FileSpreadsheet, "用例"],
            ["search", Search, "高级检索"],
            ["imports", Layers3, "导入任务"],
            ["templates", Boxes, "字段模板"],
            ["recycle", ArchiveRestore, "回收站"],
            ["api", Globe2, "开放 API"],
          ] as const
        ).map(([value, Icon, label]) => ({
          key: value,
          disabled: savingCase,
          label: (
            <span className="inline-flex items-center gap-2">
              <Icon size={16} /> {label}
              {value === "recycle" && deletedCases.length ? (
                <small>{deletedCases.length}</small>
              ) : null}
            </span>
          ),
        }))}
        onChange={(value) => {
          void (async () => {
            if (await leaveEditor()) setTab(value);
          })();
        }}
      />

      {error ? (
        <Notice
          tone="info"
          className={cn("inline-notice error", uiPatterns["inline-notice"], uiPatterns["error"])}
          role="alert"
        >
          {error}
          <Button type="button" aria-label="关闭错误" onClick={() => setError("")}>
            <X size={14} />
          </Button>
        </Notice>
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

      {!isIndependentTab && busy && cases.length === 0 ? <WorkspaceLoading /> : null}

      {isApiTab ? <DdtApiReference scope={scope} labels={scopeLabels} /> : null}
      {tab === "search" ? (
        <DdtValueSearch key={JSON.stringify(scope)} scope={scope} labels={scopeLabels} />
      ) : null}

      {!busy && tab === "overview" ? (
        <div className={cn("ddt-overview", ddtManagementWorkspaceStyles["ddt-overview"])}>
          <div className={cn("ddt-metrics", ddtManagementWorkspaceStyles["ddt-metrics"])}>
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
          <div className={cn("ddt-chart-grid", ddtManagementWorkspaceStyles["ddt-chart-grid"])}>
            <DdtExecutionChart execution={dashboard.execution} />
            <Card
              as="article"
              className={cn(
                "card ddt-chart-card",
                uiPatterns["card"],
                ddtManagementWorkspaceStyles["ddt-chart-card"],
              )}
            >
              <header>
                <div>
                  <strong>主要业务分组</strong>
                  <span>按 srNum 用例量排序</span>
                </div>
              </header>
              <div
                className={cn(
                  "ddt-group-ranking",
                  ddtManagementWorkspaceStyles["ddt-group-ranking"],
                )}
              >
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
                  <p
                    className={cn(
                      "ddt-chart-empty",
                      ddtManagementWorkspaceStyles["ddt-chart-empty"],
                    )}
                  >
                    导入后将在这里展示业务分组
                  </p>
                )}
              </div>
            </Card>
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
              setSelected((current) => {
                const next = new Set(current);
                for (const item of cases) {
                  if (checked) next.add(item.caseId);
                  else next.delete(item.caseId);
                }
                return next;
              });
          }}
          filters={
            <>
              <label className={"search-field"}>
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
              <Disclosure
                showArrow={false}
                header={
                  <>
                    <Filter size={14} /> 高级筛选
                  </>
                }
                className={cn(
                  "ddt-advanced-filters",
                  ddtManagementWorkspaceStyles["ddt-advanced-filters"],
                )}
              >
                <div
                  className={cn(
                    "ddt-advanced-filter-fields",
                    ddtManagementWorkspaceStyles["ddt-advanced-filter-fields"],
                  )}
                >
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
              </Disclosure>
              <Button
                className={cn("text-button", uiPatterns["text-button"])}
                type="button"
                onClick={() => void exportSelection()}
              >
                <Download size={15} /> 导出当前范围
              </Button>
            </>
          }
          selectionActions={
            <div
              className={cn("ddt-selection-bar", ddtManagementWorkspaceStyles["ddt-selection-bar"])}
            >
              <Button
                className={cn(
                  "button button-secondary",
                  uiPatterns["button"],
                  uiPatterns["button-secondary"],
                )}
                type="button"
                onClick={() => void exportSelection()}
              >
                <Download size={15} /> 导出 {selected.size} 条
              </Button>
              {canManage ? (
                <>
                  <Button
                    className={cn(
                      "button button-secondary",
                      uiPatterns["button"],
                      uiPatterns["button-secondary"],
                    )}
                    type="button"
                    onClick={() => setShowBulk(true)}
                  >
                    <PencilLine size={15} /> 批量修改
                  </Button>
                  <Button
                    className={cn("button button-danger", uiPatterns["button"])}
                    type="button"
                    disabled={Boolean(deleteProgress)}
                    onClick={() => void deleteSelected()}
                  >
                    {deleteProgress ? (
                      <LoaderCircle className={cn("spin", uiPatterns["spin"])} size={15} />
                    ) : (
                      <Trash2 size={15} />
                    )}{" "}
                    移入回收站
                  </Button>
                </>
              ) : null}
              {canManageSuites ? (
                <Button
                  className={cn(
                    "button button-secondary",
                    uiPatterns["button"],
                    uiPatterns["button-secondary"],
                  )}
                  type="button"
                  onClick={() => setShowAddToSuite(true)}
                >
                  <ListPlus size={15} /> 加入用例任务
                </Button>
              ) : null}
              <Button
                type="button"
                className={cn("text-button", uiPatterns["text-button"])}
                onClick={() => setSelected(new Set())}
              >
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
            <div
              className={cn("ddt-detail-error", ddtManagementWorkspaceStyles["ddt-detail-error"])}
            >
              <Notice
                tone="info"
                className={cn(
                  "inline-notice error",
                  uiPatterns["inline-notice"],
                  uiPatterns["error"],
                )}
                role="alert"
              >
                {detailError}
              </Notice>
              <Button
                type="button"
                className={cn(
                  "button button-secondary",
                  uiPatterns["button"],
                  uiPatterns["button-secondary"],
                )}
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

      {showCaseSelection ? (
        <DdtCaseSelectionDialog
          key={`${scope.projectId}:${scope.projectVersionId}:${scope.testStageId}`}
          scope={scope}
          onClose={() => setShowCaseSelection(false)}
          onSelect={async (caseIds) => {
            if (!(await leaveEditor())) return false;
            setSelected((current) => new Set([...current, ...caseIds]));
            toast.success(`已勾选 ${caseIds.length} 条匹配的 DDT 用例，原有选择已保留。`);
            return true;
          }}
        />
      ) : null}
      {showInheritance ? (
        <DdtInheritanceDialog
          scope={scope}
          scopeLabels={scopeLabels}
          versions={versions}
          onClose={() => setShowInheritance(false)}
          onChanged={async () => {
            clearBrowserSnapshots();
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
    <Card
      as="article"
      className={cn(
        "card ddt-metric",
        uiPatterns["card"],
        ddtManagementWorkspaceStyles["ddt-metric"],
      )}
    >
      <span>{label}</span>
      <strong>{value.toLocaleString("zh-CN")}</strong>
      <small>{hint}</small>
    </Card>
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
    <EmptyState
      className={cn(
        "empty-state ddt-empty",
        uiPatterns["empty-state"],
        ddtManagementWorkspaceStyles["ddt-empty"],
      )}
    >
      <FileSpreadsheet size={28} />
      <strong>{title}</strong>
      <p>{description}</p>
    </EmptyState>
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
    <div className={cn("ddt-section", ddtManagementWorkspaceStyles["ddt-section"])}>
      <header>
        <div>
          <strong>导入任务</strong>
          <span>预检、冲突策略和逐文件结果都可追溯</span>
        </div>
        {canManage ? (
          <Button
            className={cn(
              "button button-primary",
              uiPatterns["button"],
              uiPatterns["button-primary"],
            )}
            type="button"
            onClick={onOpen}
          >
            <Plus size={15} /> 新建导入
          </Button>
        ) : null}
      </header>
      {jobs.length ? (
        <div className={cn("ddt-job-list", ddtManagementWorkspaceStyles["ddt-job-list"])}>
          {jobs.map((job) => (
            <Card
              as="article"
              className={cn(
                "card ddt-job",
                uiPatterns["card"],
                ddtManagementWorkspaceStyles["ddt-job"],
              )}
              key={job.id}
            >
              <div className={cn("ddt-job-main", ddtManagementWorkspaceStyles["ddt-job-main"])}>
                <span
                  className={cn(
                    ddtManagementWorkspaceStyles["ddt-status"],
                    `ddt-status ${job.status}`,
                  )}
                >
                  {statusLabel(job.status)}
                </span>
                <strong>
                  {job.totalFiles} 个表格 · {job.totalRows} 行
                </strong>
                <small>{formatDate(job.createdAt)}</small>
              </div>
              <div
                className={cn("ddt-job-progress", ddtManagementWorkspaceStyles["ddt-job-progress"])}
              >
                <div>
                  <i style={{ width: `${job.progressPercent}%` }} />
                </div>
                <span>{job.progressPercent}%</span>
              </div>
              <div
                className={cn("ddt-job-results", ddtManagementWorkspaceStyles["ddt-job-results"])}
              >
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
                <Notice
                  tone="info"
                  className={cn(
                    "inline-notice error",
                    uiPatterns["inline-notice"],
                    uiPatterns["error"],
                  )}
                  role="alert"
                >
                  {job.errorSummary}
                </Notice>
              ) : null}
              {canManage && ["previewed", "queued", "running"].includes(job.status) ? (
                <Button
                  className={cn("text-button danger", uiPatterns["text-button"])}
                  type="button"
                  onClick={() => void onCancel(job.id)}
                >
                  取消
                </Button>
              ) : null}
              {["succeeded", "partially_succeeded"].includes(job.status) ? (
                <Button
                  className={cn("text-button", uiPatterns["text-button"])}
                  type="button"
                  onClick={() => void onExportCaseIds(job.id)}
                >
                  <Download size={14} /> 导出本任务 CaseID
                </Button>
              ) : null}
              <Disclosure header={<>逐文件结果</>}>
                {job.files.map((file) => (
                  <div
                    className={cn("ddt-file-row", ddtManagementWorkspaceStyles["ddt-file-row"])}
                    key={file.id}
                  >
                    <strong>{file.archiveEntryName ?? file.fileName}</strong>
                    <span>{file.rowCount} 行</span>
                    <span>{statusLabel(file.status)}</span>
                    {file.errorSummary ? <small>{file.errorSummary}</small> : null}
                  </div>
                ))}
              </Disclosure>
            </Card>
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
    <div className={cn("ddt-section", ddtManagementWorkspaceStyles["ddt-section"])}>
      <header>
        <div>
          <strong>字段模板</strong>
          <span>按 srNum 校验必填字段、数据类型和默认值</span>
        </div>
        {canManage ? (
          <Button
            className={cn(
              "button button-primary",
              uiPatterns["button"],
              uiPatterns["button-primary"],
            )}
            type="button"
            onClick={onCreate}
          >
            <Plus size={15} /> 新建模板
          </Button>
        ) : null}
      </header>
      {templates.length ? (
        <div className={cn("ddt-template-grid", ddtManagementWorkspaceStyles["ddt-template-grid"])}>
          {templates.map((item) => (
            <Card
              as="article"
              className={cn(
                "card ddt-template",
                uiPatterns["card"],
                ddtManagementWorkspaceStyles["ddt-template"],
              )}
              key={item.id}
            >
              <div>
                <span
                  className={cn("ddt-group-tag", ddtManagementWorkspaceStyles["ddt-group-tag"])}
                >
                  {item.srNum}
                </span>
                <strong>{item.name}</strong>
                <p>{item.description || "未填写说明"}</p>
              </div>
              <div className={cn("ddt-rule-chips", ddtManagementWorkspaceStyles["ddt-rule-chips"])}>
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
                  className={cn("icon-button danger", uiPatterns["icon-button"])}
                  type="button"
                  aria-label={`删除模板 ${item.name}`}
                  onClick={() => void onDelete(item)}
                >
                  <Trash2 size={16} />
                </Button>
              ) : null}
            </Card>
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
    <div className={cn("ddt-section", ddtManagementWorkspaceStyles["ddt-section"])}>
      <header>
        <div>
          <strong>回收站</strong>
          <span>删除先进入回收站，永久清除需再次确认</span>
        </div>
      </header>
      {items.length ? (
        <div className={cn("ddt-table-shell", ddtManagementWorkspaceStyles["ddt-table-shell"])}>
          <Table
            className={cn(
              "data-table ddt-table",
              uiPatterns["data-table"],
              ddtManagementWorkspaceStyles["ddt-table"],
            )}
          >
            <TableHeader>
              <TableRow>
                <TableHead>CaseID</TableHead>
                <TableHead>srNum</TableHead>
                <TableHead>来源</TableHead>
                <TableHead>删除时间</TableHead>
                <TableHead>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    <strong>{item.caseId}</strong>
                  </TableCell>
                  <TableCell>{item.srNum}</TableCell>
                  <TableCell>{item.sourceName}</TableCell>
                  <TableCell>{formatDate(item.deletedAt)}</TableCell>
                  <TableCell>
                    {canManage ? (
                      <div
                        className={cn(
                          "table-actions",
                          ddtManagementWorkspaceStyles["table-actions"],
                        )}
                      >
                        <Button
                          className={cn("text-button", uiPatterns["text-button"])}
                          type="button"
                          onClick={() => void onRestore(item.id)}
                        >
                          <RotateCcw size={14} /> 恢复
                        </Button>
                        <Button
                          className={cn("text-button danger", uiPatterns["text-button"])}
                          type="button"
                          onClick={() => void onPurge(item.id)}
                        >
                          <Trash2 size={14} /> 永久删除
                        </Button>
                      </div>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
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
        <div className={cn("ddt-import-dialog", ddtManagementWorkspaceStyles["ddt-import-dialog"])}>
          {error ? (
            <Notice
              tone="info"
              className={cn(
                "inline-notice error",
                uiPatterns["inline-notice"],
                uiPatterns["error"],
              )}
            >
              {error}
            </Notice>
          ) : null}
          {!job ? (
            <>
              <Button
                className={cn(
                  ddtManagementWorkspaceStyles["ddt-dropzone"],
                  `ddt-dropzone${dragActive ? " drag-active" : ""}`,
                )}
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
                <div
                  className={cn(
                    "ddt-picked-files",
                    ddtManagementWorkspaceStyles["ddt-picked-files"],
                  )}
                >
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
                  className={cn(
                    "button button-secondary",
                    uiPatterns["button"],
                    uiPatterns["button-secondary"],
                  )}
                  type="button"
                  data-dialog-dismiss
                  onClick={onClose}
                  disabled={busy}
                >
                  取消
                </Button>
                <Button
                  className={cn(
                    "button button-primary",
                    uiPatterns["button"],
                    uiPatterns["button-primary"],
                  )}
                  type="button"
                  disabled={!files.length || busy}
                  onClick={() => void preview()}
                >
                  {busy ? (
                    <LoaderCircle className={cn("spin", uiPatterns["spin"])} size={15} />
                  ) : null}
                  开始预检
                </Button>
              </footer>
            </>
          ) : (
            <>
              <div
                className={cn(
                  "ddt-preview-summary",
                  ddtManagementWorkspaceStyles["ddt-preview-summary"],
                )}
              >
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
              <div
                className={cn(
                  "ddt-preview-files",
                  ddtManagementWorkspaceStyles["ddt-preview-files"],
                )}
              >
                {job.files.map((file) => (
                  <div key={file.id}>
                    <strong>{file.archiveEntryName ?? file.fileName}</strong>
                    <span>{file.rowCount} 行</span>
                    {file.errorSummary ? <small>{file.errorSummary}</small> : <i>可导入</i>}
                  </div>
                ))}
              </div>
              {unresolvedColumnConflicts.length ? (
                <div
                  className={cn(
                    "ddt-column-conflict-notice",
                    ddtManagementWorkspaceStyles["ddt-column-conflict-notice"],
                  )}
                  role="alert"
                >
                  <AlertTriangle size={18} aria-hidden="true" />
                  <span>
                    <strong>发现重复列名</strong>
                    <small>
                      请先处理上方文件中的重复列名，再确认导入。暂不处理会保留当前选择。
                    </small>
                  </span>
                  <Button
                    className={cn(
                      "button button-secondary",
                      uiPatterns["button"],
                      uiPatterns["button-secondary"],
                    )}
                    type="button"
                    disabled={busy}
                    onClick={() => setShowColumnConflicts(true)}
                  >
                    处理重复列名
                  </Button>
                </div>
              ) : null}
              <fieldset
                className={cn("ddt-strategy", ddtManagementWorkspaceStyles["ddt-strategy"])}
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
                  className={cn(
                    "button button-secondary",
                    uiPatterns["button"],
                    uiPatterns["button-secondary"],
                  )}
                  type="button"
                  disabled={busy}
                  onClick={() => setJob(undefined)}
                >
                  重新选择
                </Button>
                <Button
                  className={cn(
                    "button button-primary",
                    uiPatterns["button"],
                    uiPatterns["button-primary"],
                  )}
                  type="button"
                  disabled={!job.validFiles || busy || unresolvedColumnConflicts.length > 0}
                  onClick={() => void confirm()}
                >
                  {busy ? (
                    <LoaderCircle className={cn("spin", uiPatterns["spin"])} size={15} />
                  ) : null}
                  确认并后台导入
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
      // Closing this nested view retains its draft in ImportDialog.
      dirty={false}
      subtitle="对照两列内容后选择改名保留或删除，平台会使用已保存的原文件重新预检"
      onClose={onClose}
      closeDisabled={busy}
      backdropClassName={cn(
        "ddt-column-conflict-backdrop",
        ddtManagementWorkspaceStyles["ddt-column-conflict-backdrop"],
      )}
    >
      <div
        className={cn(
          "ddt-column-conflict-dialog",
          ddtManagementWorkspaceStyles["ddt-column-conflict-dialog"],
        )}
      >
        <div
          className={cn(
            "ddt-column-conflict-guidance",
            ddtManagementWorkspaceStyles["ddt-column-conflict-guidance"],
          )}
        >
          <AlertTriangle size={18} />
          <p>
            <strong>
              {affectedFileCount} 个文件 · {conflicts.length} 组冲突 · {conflictColumnCount}{" "}
              个重复列
            </strong>
          </p>
          <Button
            className={cn(
              "button button-secondary",
              uiPatterns["button"],
              uiPatterns["button-secondary"],
            )}
            disabled={busy}
            size="compact"
            type="button"
            onClick={() => onChange(applySuggestedColumnNames(resolutions, conflicts))}
          >
            全部按建议改名
          </Button>
        </div>
        <div
          className={cn(
            "ddt-column-conflict-list",
            ddtManagementWorkspaceStyles["ddt-column-conflict-list"],
          )}
        >
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
                  <div
                    className={cn(
                      "ddt-column-conflict-location",
                      ddtManagementWorkspaceStyles["ddt-column-conflict-location"],
                    )}
                  >
                    <span>
                      <FileSpreadsheet size={16} />
                      <strong title={location}>{location}</strong>
                    </span>
                    <small>
                      {conflict.sheetName} Sheet · “{conflict.columns[0]?.currentName}”重复
                    </small>
                  </div>
                  <div
                    className={cn(
                      "ddt-column-conflict-group-actions",
                      ddtManagementWorkspaceStyles["ddt-column-conflict-group-actions"],
                    )}
                  >
                    <small>
                      第 {conflictIndex + 1} / {conflicts.length} 组
                    </small>
                    <Button
                      className={cn(
                        "button button-secondary",
                        uiPatterns["button"],
                        uiPatterns["button-secondary"],
                      )}
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
                        className={cn(
                          ddtManagementWorkspaceStyles["ddt-column-choice"],
                          `ddt-column-choice${deleteColumn ? " is-deleted" : ""}`,
                        )}
                        key={key}
                      >
                        <div
                          className={cn(
                            "ddt-column-choice-heading",
                            ddtManagementWorkspaceStyles["ddt-column-choice-heading"],
                          )}
                        >
                          <span>
                            <small>第 {column.columnIndex + 1} 列</small>
                            <strong title={column.originalName}>{column.originalName}</strong>
                          </span>
                          <label
                            className={cn(
                              "ddt-column-delete-option",
                              ddtManagementWorkspaceStyles["ddt-column-delete-option"],
                            )}
                          >
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
                        <div
                          className={cn(
                            "ddt-column-samples",
                            ddtManagementWorkspaceStyles["ddt-column-samples"],
                          )}
                        >
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
                          className={cn(
                            "ddt-column-keep-only button button-secondary",
                            ddtManagementWorkspaceStyles["ddt-column-keep-only"],
                            uiPatterns["button"],
                            uiPatterns["button-secondary"],
                          )}
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
                        <label
                          className={cn(
                            "ddt-column-name-field",
                            ddtManagementWorkspaceStyles["ddt-column-name-field"],
                          )}
                        >
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
        <div
          className={cn(
            "ddt-column-resolution-feedback",
            ddtManagementWorkspaceStyles["ddt-column-resolution-feedback"],
          )}
        >
          {error || validationError ? (
            <Notice
              tone="info"
              className={cn(
                "inline-notice error",
                uiPatterns["inline-notice"],
                uiPatterns["error"],
              )}
              role="alert"
            >
              {error || validationError}
            </Notice>
          ) : (
            <div
              className={cn(
                "ddt-column-resolution-summary",
                ddtManagementWorkspaceStyles["ddt-column-resolution-summary"],
              )}
              aria-live="polite"
            >
              <CheckCircle2 aria-hidden="true" size={16} />
              <span>
                待应用的列名方案
                <small>
                  保留 {conflictColumnCount - deletedColumnCount} 列 · 删除 {deletedColumnCount} 列
                </small>
              </span>
            </div>
          )}
          <p
            className={cn(
              "ddt-column-resolution-help",
              ddtManagementWorkspaceStyles["ddt-column-resolution-help"],
            )}
          >
            对照上方内容，改名可保留全部数据，也可仅保留指定列。应用后会重新预检，此时还不会导入用例。
          </p>
        </div>
        <footer>
          <Button
            className={cn(
              "button button-secondary",
              uiPatterns["button"],
              uiPatterns["button-secondary"],
            )}
            type="button"
            disabled={busy}
            data-dialog-dismiss
            onClick={onClose}
          >
            暂不处理
          </Button>
          <Button
            className={cn(
              "button button-primary",
              uiPatterns["button"],
              uiPatterns["button-primary"],
            )}
            type="button"
            disabled={busy || conflicts.length === 0 || Boolean(validationError)}
            onClick={onConfirm}
          >
            {busy ? <LoaderCircle className={cn("spin", uiPatterns["spin"])} size={15} /> : null}
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
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (saving) return;
    setSaving(true);
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
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      title="新建字段模板"
      subtitle="模板仅作用于当前项目版本和测试阶段"
      onClose={onClose}
      dirty={Boolean(
        srNum ||
        name ||
        description ||
        rules.length !== 1 ||
        rules.some((rule) => rule.field || rule.required || rule.type !== "string"),
      )}
      closeDisabled={saving}
    >
      <div
        className={cn(
          "form-grid ddt-template-form",
          ddtManagementWorkspaceStyles["form-grid"],
          ddtManagementWorkspaceStyles["ddt-template-form"],
        )}
      >
        {error ? (
          <Notice
            tone="info"
            className={cn(
              "inline-notice error full-span",
              uiPatterns["inline-notice"],
              uiPatterns["error"],
              uiPatterns["full-span"],
            )}
          >
            {error}
          </Notice>
        ) : null}
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
        <label className={cn("full-span", uiPatterns["full-span"])}>
          <span>说明</span>
          <Textarea value={description} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <div
          className={cn(
            "full-span ddt-rule-builder",
            uiPatterns["full-span"],
            ddtManagementWorkspaceStyles["ddt-rule-builder"],
          )}
        >
          <div>
            <strong>字段规则</strong>
            <Button
              className={cn("text-button", uiPatterns["text-button"])}
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
                className={cn("icon-button danger", uiPatterns["icon-button"])}
                type="button"
                aria-label={`删除字段 ${index + 1}`}
                onClick={() => setRules(rules.filter((_, itemIndex) => itemIndex !== index))}
              >
                <Trash2 size={15} />
              </Button>
            </div>
          ))}
        </div>
        <footer className={cn("full-span", uiPatterns["full-span"])}>
          <Button
            className={cn(
              "button button-secondary",
              uiPatterns["button"],
              uiPatterns["button-secondary"],
            )}
            type="button"
            data-dialog-dismiss
            onClick={onClose}
          >
            取消
          </Button>
          <Button
            className={cn(
              "button button-primary",
              uiPatterns["button"],
              uiPatterns["button-primary"],
            )}
            type="button"
            disabled={saving || !srNum.trim() || !name.trim()}
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
      <div
        className={cn(
          "form-grid ddt-bulk-form",
          ddtManagementWorkspaceStyles["form-grid"],
          ddtManagementWorkspaceStyles["ddt-bulk-form"],
        )}
      >
        {error ? (
          <Notice
            tone="info"
            className={cn(
              "inline-notice error full-span",
              uiPatterns["inline-notice"],
              uiPatterns["error"],
              uiPatterns["full-span"],
            )}
          >
            {error}
          </Notice>
        ) : null}
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
        <label className={cn("full-span", uiPatterns["full-span"])}>
          <span>用户旅程 Step（可选）</span>
          <Input
            value={stepName}
            onChange={(event) => setStepName(event.target.value)}
            placeholder="step1"
          />
        </label>
        <footer className={cn("full-span", uiPatterns["full-span"])}>
          <Button
            className={cn(
              "button button-secondary",
              uiPatterns["button"],
              uiPatterns["button-secondary"],
            )}
            type="button"
            data-dialog-dismiss
            onClick={onClose}
          >
            取消
          </Button>
          <Button
            className={cn(
              "button button-primary",
              uiPatterns["button"],
              uiPatterns["button-primary"],
            )}
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
      <div
        className={cn(
          "form-grid ddt-add-suite-dialog",
          ddtManagementWorkspaceStyles["form-grid"],
          ddtManagementWorkspaceStyles["ddt-add-suite-dialog"],
        )}
      >
        {error ? (
          <Notice
            tone="info"
            className={cn(
              "inline-notice error full-span",
              uiPatterns["inline-notice"],
              uiPatterns["error"],
              uiPatterns["full-span"],
            )}
          >
            {error}
          </Notice>
        ) : null}
        <label className={cn("full-span", uiPatterns["full-span"])}>
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
          <label className={cn("full-span", uiPatterns["full-span"])}>
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
          <p className={cn("muted full-span", uiPatterns["muted"], uiPatterns["full-span"])}>
            任务“{createdSuite.name}”已创建，重新点击加入任务可重试添加所选用例。
          </p>
        ) : null}
        <footer className={cn("full-span", uiPatterns["full-span"])}>
          <Button
            className={cn(
              "button button-secondary",
              uiPatterns["button"],
              uiPatterns["button-secondary"],
            )}
            type="button"
            disabled={busy}
            data-dialog-dismiss
            onClick={onClose}
          >
            取消
          </Button>
          <Button
            className={cn(
              "button button-primary",
              uiPatterns["button"],
              uiPatterns["button-primary"],
            )}
            type="button"
            disabled={
              busy || (suiteId === "new" ? !newSuiteName.trim() && !createdSuite : !suiteId)
            }
            onClick={() => void save()}
          >
            {busy ? (
              <LoaderCircle className={cn("spin", uiPatterns["spin"])} size={15} />
            ) : (
              <ListPlus size={15} />
            )}
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
  dirty,
}: {
  title: string;
  subtitle: string;
  onClose(): void;
  children: ReactNode;
  inactive?: boolean;
  closeDisabled?: boolean;
  backdropClassName?: string;
  dirty?: boolean;
}) {
  return (
    <ActionDialog
      open
      title={title}
      description={subtitle}
      onClose={onClose}
      className={cn("ddt-dialog", ddtManagementWorkspaceStyles["ddt-dialog"])}
      closeLabel="关闭弹窗"
      protectUnsavedChanges
      {...(dirty === undefined ? {} : { dirty })}
      inactive={inactive}
      closeDisabled={closeDisabled}
      {...(backdropClassName ? { backdropClassName } : {})}
    >
      {children}
    </ActionDialog>
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

const ddtManagementWorkspaceStyles = {
  "ddt-add-suite-dialog":
    "p-5 [&_footer]:flex [&_footer]:justify-end [&_footer]:gap-2 [&_footer]:m-0",
  "ddt-advanced-filter-fields":
    "absolute z-10 top-full left-0 grid w-[calc(200%_+_8px)] max-h-[var(--ddt-case-filter-max-height)] overflow-y-auto gap-2 border border-solid border-border rounded-lg p-3 bg-card shadow-xs [&_.ui-select-list]:static [&_.ui-select-list]:mt-1",
  "ddt-advanced-filters":
    "[&_.ui-disclosure-label]:flex [&_.ui-disclosure-label]:items-center [&_.ui-disclosure-label]:gap-2 [&_.ui-disclosure-label]:py-2 [&_.ui-disclosure-label]:cursor-pointer [&[data-open=true]_.ui-disclosure-label]:text-info relative",
  "ddt-bulk-form":
    "p-5 [&_footer]:grid [&_footer]:grid-cols-[repeat(4,_1fr)] [&_footer]:gap-2 [&_>_label]:grid [&_>_label]:gap-[5px]",
  "ddt-chart-card":
    "[&_header]:flex [&_header]:items-center [&_header_>_div]:grid [&_header_>_div]:min-w-0 [&_header_>_div]:gap-[3px] [&_header_>_div]:mr-auto [&_header_span]:text-muted-foreground [&_header_span]:text-xs min-w-0 p-5",
  "ddt-chart-empty": "m-auto text-muted-foreground",
  "ddt-chart-grid":
    "grid grid-cols-[minmax(0,_1.1fr)_minmax(0,_0.9fr)] gap-4 max-[1181px]:grid-cols-[1fr]",
  "ddt-column-choice":
    "grid min-w-0 [align-content:start] gap-2.5 border border-solid border-border rounded-lg p-[11px] bg-card transition-colors duration-150 motion-reduce:transition-none [&.is-deleted]:[border-color:color-mix(in_srgb,_var(--destructive)_32%,_var(--border))] [&.is-deleted]:[background:color-mix(in_srgb,_color-mix(in_srgb,_var(--destructive)_10%,_transparent)_55%,_var(--card))] [&.is-deleted_.ddt-column-name-field_>_span]:text-destructive",
  "ddt-column-choice-heading":
    "flex min-w-0 items-center justify-between gap-2.5 [&_>_span]:grid [&_>_span]:min-w-0 [&_strong]:overflow-hidden [&_strong]:text-ellipsis [&_strong]:whitespace-nowrap [&_small]:text-muted-foreground",
  "ddt-column-conflict-backdrop":
    "[&_.ddt-dialog]:w-[min(960px,_calc(100dvw_-_40px))] [&_.ddt-dialog]:overflow-hidden",
  "ddt-column-conflict-dialog":
    "flex min-h-0 flex-1 flex-col gap-3.5 overflow-hidden p-5 [&_footer]:flex [&_footer]:shrink-0 [&_footer]:justify-end [&_footer]:gap-[9px]",
  "ddt-column-conflict-group-actions":
    "flex [flex:0_0_auto] items-center gap-[9px] [&_>_small]:text-muted-foreground [&_>_small]:whitespace-nowrap",
  "ddt-column-conflict-guidance":
    "flex items-start gap-2.5 rounded-lg py-[11px] px-3 bg-warning/10 text-warning [&_p]:grid [&_p]:min-w-0 [&_p]:flex-1 [&_p]:m-0 [&_p]:gap-0.5 [&_span]:text-muted-foreground [&_span]:text-xs",
  "ddt-column-conflict-list":
    "grid [grid-auto-rows:max-content] [align-content:start] min-h-0 [flex:1_1_auto] gap-2.5 overflow-auto [overscroll-behavior:contain] pr-[3px] [&_>_section]:overflow-hidden [&_>_section]:border [&_>_section]:border-solid [&_>_section]:border-border [&_>_section]:rounded-lg [&_>_section]:bg-card [&_>_section_>_header]:flex [&_>_section_>_header]:items-center [&_>_section_>_header]:justify-between [&_>_section_>_header]:gap-3 [&_>_section_>_header]:border-b [&_>_section_>_header]:border-solid [&_>_section_>_header]:border-border [&_>_section_>_header]:py-2.5 [&_>_section_>_header]:px-3 [&_>_section_>_header]:bg-muted [&_>_section_>_div]:grid [&_>_section_>_div]:grid-cols-2 [&_>_section_>_div]:gap-2 [&_>_section_>_div]:py-[11px] [&_>_section_>_div]:px-3",
  "ddt-column-conflict-location":
    "grid min-w-0 flex-1 gap-0.5 [&_>_span]:flex [&_>_span]:min-w-0 [&_>_span]:items-center [&_>_span]:gap-[7px] [&_strong]:overflow-hidden [&_strong]:text-ellipsis [&_strong]:whitespace-nowrap [&_>_small]:text-destructive",
  "ddt-column-conflict-notice":
    "flex items-center gap-2.5 mt-3 border border-solid border-border rounded-lg py-[11px] px-3 bg-warning/10 text-warning [&_>_span]:grid [&_>_span]:min-w-0 [&_>_span]:flex-1 [&_>_span]:gap-0.5 [&_small]:text-muted-foreground",
  "ddt-column-delete-option":
    'inline-flex [flex:0_0_auto] items-center gap-[5px] text-muted-foreground text-xs cursor-pointer [&:has(input:checked)]:text-destructive [&_.ui-input[type="checkbox"]]:w-4 [&_.ui-input[type="checkbox"]]:h-4 [&_.ui-input[type="checkbox"]]:[flex-basis:16px]',
  "ddt-column-keep-only": "w-fit justify-self-end",
  "ddt-column-name-field": "grid gap-[5px] [&_>_span]:text-muted-foreground [&_>_span]:text-xs",
  "ddt-column-resolution-feedback": "grid shrink-0 gap-2",
  "ddt-column-resolution-help": "m-0 text-muted-foreground text-xs",
  "ddt-column-resolution-summary":
    "flex items-center gap-2 border border-solid border-border rounded-lg py-2 px-2.5 bg-success/10 text-success [&_>_span]:flex [&_>_span]:min-w-0 [&_>_span]:flex-1 [&_>_span]:items-center [&_>_span]:justify-between [&_>_span]:gap-3 [&_>_span]:text-xs [&_>_span]:font-semibold [&_small]:text-muted-foreground [&_small]:font-medium",
  "ddt-column-samples":
    "[&_header_small]:text-muted-foreground overflow-hidden border border-solid border-border rounded-lg bg-muted [&_>_header]:flex [&_>_header]:items-center [&_>_header]:justify-between [&_>_header]:gap-2 [&_>_header]:border-b [&_>_header]:border-solid [&_>_header]:border-border [&_>_header]:py-[7px] [&_>_header]:px-[9px] [&_>_header]:text-xs [&_ul]:grid [&_ul]:max-h-[152px] [&_ul]:m-0 [&_ul]:py-1 [&_ul]:px-0 [&_ul]:overflow-auto [&_ul]:[list-style:none] [&_li]:grid [&_li]:grid-cols-[45px_minmax(0,_1fr)] [&_li]:items-center [&_li]:gap-[7px] [&_li]:py-[5px] [&_li]:px-[9px] [&_li_+_li]:border-t [&_li_+_li]:border-solid [&_li_+_li]:border-transparent [&_li_small]:text-muted-foreground [&_li_span]:overflow-hidden [&_li_span]:text-ellipsis [&_li_span]:whitespace-nowrap [&_>_p]:m-0 [&_>_p]:py-3.5 [&_>_p]:px-[9px] [&_>_p]:text-muted-foreground [&_>_p]:text-xs [&_>_p]:text-center",
  "ddt-detail-error": "overflow-auto p-5",
  "ddt-dialog":
    "[&_>_header]:flex [&_>_header]:items-center [&_>_header]:[flex:0_0_auto] [&_>_header]:justify-between [&_>_header]:gap-4.5 [&_>_header]:border-b [&_>_header]:border-solid [&_>_header]:border-border [&_>_header]:py-4.5 [&_>_header]:px-5 flex w-[min(760px,_calc(100dvw_-_40px))] max-h-[calc(100dvh_-_40px)] flex-col overflow-auto border border-solid border-border rounded-xl bg-card shadow-lg [&_>_header_h2]:m-0 [&_>_header_p]:m-0 [&_>_header_p]:mt-1 [&_>_header_p]:text-muted-foreground [&_>_.action-dialog-body]:p-0 [&_.draft-discard-prompt]:m-3",
  "ddt-dropzone":
    "grid w-full min-h-[170px] place-items-center [align-content:center] gap-[7px] border border-dashed border-border rounded-lg bg-info/10 text-info transition-colors duration-150 motion-reduce:transition-none [&:hover:not(:disabled)]:border-info [&:hover:not(:disabled)]:shadow-xs [&:focus-visible]:border-info [&:focus-visible]:shadow-xs [&.drag-active]:border-info [&.drag-active]:shadow-xs [&.drag-active]:[border-style:solid] [&.drag-active]:[background:color-mix(in_srgb,_color-mix(in_srgb,_var(--info)_10%,_transparent)_72%,_var(--card))] [&.drag-active]:[transform:translateY(-1px)] [&_span]:max-w-[520px] [&_span]:text-muted-foreground [&_span]:text-center",
  "ddt-empty":
    "grid min-h-[220px] place-items-center [align-content:center] gap-2 text-muted-foreground text-center [&_strong]:text-foreground [&_p]:m-0",
  "ddt-file-row":
    "grid grid-cols-[minmax(0,_1fr)_70px_80px] gap-2 pt-[9px] [&_small]:col-span-full [&_small]:text-destructive",
  "ddt-group-ranking":
    "grid gap-2 mt-[17px] [&_button]:grid [&_button]:grid-cols-[24px_minmax(90px,_0.7fr)_minmax(80px,_1fr)_32px] [&_button]:items-center [&_button]:gap-[9px] [&_button]:border-0 [&_button]:rounded-lg [&_button]:p-[7px] [&_button]:bg-transparent [&_button]:text-foreground [&_button]:text-left [&_button:hover]:bg-muted [&_button_>_span]:grid [&_button_>_span]:h-6 [&_button_>_span]:place-items-center [&_button_>_span]:rounded-md [&_button_>_span]:bg-info/10 [&_button_>_span]:text-info [&_button_>_span]:text-xs [&_i]:h-[7px] [&_i]:rounded-md [&_i]:bg-primary",
  "ddt-group-tag":
    "inline-flex w-fit rounded-full py-1 px-2 bg-muted text-muted-foreground text-xs [font-style:normal] whitespace-nowrap",
  "ddt-import-dialog": "p-5 [&_footer]:grid [&_footer]:grid-cols-[repeat(4,_1fr)] [&_footer]:gap-2",
  "ddt-job":
    "relative grid gap-[13px] p-[17px] [&_.ui-disclosure]:border-t [&_.ui-disclosure]:border-solid [&_.ui-disclosure]:border-border [&_.ui-disclosure]:pt-2.5 [&_.ui-disclosure-label]:text-muted-foreground [&_.ui-disclosure-label]:cursor-pointer",
  "ddt-job-list": "grid gap-3",
  "ddt-job-main":
    "grid grid-cols-[auto_1fr_auto] items-center gap-2.5 [&_small]:text-muted-foreground",
  "ddt-job-progress":
    "grid grid-cols-[1fr_42px] items-center gap-[9px] [&_>_div]:h-[7px] [&_>_div]:overflow-hidden [&_>_div]:rounded-md [&_>_div]:bg-muted [&_i]:block [&_i]:h-full [&_i]:rounded-xl [&_i]:bg-info",
  "ddt-job-results":
    "flex flex-wrap gap-2 [&_span]:rounded-md [&_span]:py-1.5 [&_span]:px-[9px] [&_span]:bg-muted [&_span]:text-muted-foreground [&_span]:text-xs",
  "ddt-metric":
    "grid gap-[5px] p-4.5 [&_.ui-card-content_>_span]:text-muted-foreground [&_small]:text-muted-foreground [&_strong]:text-3xl [&_strong]:tabular-nums [&_strong]:tracking-normal",
  "ddt-metrics": "grid grid-cols-4 gap-3 max-[1181px]:grid-cols-2",
  "ddt-overview": "grid min-w-0 gap-4",
  "ddt-picked-files":
    "grid gap-[7px] mt-3 [&_>_span]:flex [&_>_span]:items-center [&_>_span]:gap-2 [&_>_span]:rounded-lg [&_>_span]:py-[9px] [&_>_span]:px-[11px] [&_>_span]:bg-muted [&_small]:ml-auto [&_small]:text-muted-foreground",
  "ddt-preview-files":
    "grid gap-[7px] mt-3 max-h-[min(320px,_35dvh)] overflow-auto [overscroll-behavior:contain] [&_>_div]:flex [&_>_div]:items-center [&_>_div]:gap-2 [&_>_div]:rounded-lg [&_>_div]:py-[9px] [&_>_div]:px-[11px] [&_>_div]:bg-muted [&_>_div]:flex-wrap [&_span]:ml-auto [&_span]:text-muted-foreground [&_small]:[flex-basis:100%] [&_small]:text-destructive [&_>_div_>_strong]:min-w-0 [&_>_div_>_strong]:[flex:1_1_50%] [&_>_div_>_strong]:[overflow-wrap:anywhere] [&_i]:text-success [&_i]:text-xs",
  "ddt-preview-summary":
    "grid grid-cols-[repeat(4,_1fr)] gap-2 [&_span]:grid [&_span]:gap-[3px] [&_span]:rounded-lg [&_span]:p-[11px] [&_span]:bg-muted [&_small]:text-muted-foreground [&_strong]:text-lg",
  "ddt-rule-builder":
    "grid gap-2 [&_>_div]:grid [&_>_div]:grid-cols-[minmax(0,_1fr)_130px_80px_36px] [&_>_div]:items-center [&_>_div]:gap-2 [&_>_div:first-child]:flex [&_>_div:first-child]:justify-between [&_>_div_>_label]:flex [&_>_div_>_label]:items-center [&_>_div_>_label]:gap-[5px]",
  "ddt-rule-chips":
    "flex col-span-full flex-wrap gap-1.5 [&_>_span]:grid [&_>_span]:gap-px [&_>_span]:rounded-md [&_>_span]:py-1.5 [&_>_span]:px-[9px] [&_>_span]:bg-muted [&_small]:text-muted-foreground",
  "ddt-section":
    "[&_>_header]:flex [&_>_header]:items-center [&_>_header]:gap-3 [&_>_header_>_div]:grid [&_>_header_>_div]:min-w-0 [&_>_header_>_div]:gap-[3px] [&_>_header_>_div]:mr-auto [&_>_header_>_div_>_span]:text-muted-foreground [&_>_header_>_div_>_span]:text-xs grid min-w-0 gap-4",
  "ddt-selection-bar":
    "flex items-center gap-[9px] border border-solid border-border rounded-lg py-[9px] px-3 bg-info/10 [&_strong]:mr-auto [&_strong]:text-info",
  "ddt-status":
    "inline-flex w-fit rounded-full py-1 px-2 bg-muted text-muted-foreground text-xs [font-style:normal] whitespace-nowrap [&.running]:bg-info/10 [&.running]:text-info [&.queued]:bg-info/10 [&.queued]:text-info [&.succeeded]:bg-success/10 [&.succeeded]:text-success [&.failed]:bg-destructive/10 [&.failed]:text-destructive [&.previewed]:bg-warning/10 [&.previewed]:text-warning [&.partially\\_succeeded]:bg-warning/10 [&.partially\\_succeeded]:text-warning",
  "ddt-strategy":
    "flex gap-2 mt-[15px] border-0 p-0 [&_legend]:mb-[7px] [&_legend]:text-muted-foreground [&_legend]:text-xs [&_label]:flex [&_label]:flex-1 [&_label]:items-center [&_label]:gap-[7px] [&_label]:border [&_label]:border-solid [&_label]:border-border [&_label]:rounded-lg [&_label]:p-2.5",
  "ddt-subtabs":
    "flex items-center flex-wrap gap-[3px] border-b border-solid border-border pb-2 [&_button]:inline-flex [&_button]:items-center [&_button]:gap-[7px] [&_button]:border-0 [&_button]:rounded-lg [&_button]:py-[9px] [&_button]:px-3.5 [&_button]:bg-transparent [&_button]:text-muted-foreground [&_button]:font-semibold [&_button]:relative [&_button]:shadow-none [&_button.active]:bg-info/10 [&_button.active]:text-info [&_button.active]:shadow-none [&_small]:inline-grid [&_small]:min-w-4.5 [&_small]:h-4.5 [&_small]:place-items-center [&_small]:rounded-lg [&_small]:bg-destructive/10 [&_small]:text-destructive",
  "ddt-table":
    '[table-layout:fixed] [&_th:nth-child(1)]:w-11.5 [&_th:nth-child(2)]:w-[21%] [&_th:nth-child(3)]:w-[15%] [&_th:nth-child(4)]:w-[110px] [&_th:nth-child(5)]:w-[25%] [&_th:last-child]:w-12.5 [&_td]:overflow-hidden [&_td]:text-ellipsis [&_td]:whitespace-nowrap [&_input[type="checkbox"]]:w-4 [&_input[type="checkbox"]]:h-4',
  "ddt-table-shell":
    "min-w-0 overflow-hidden border border-solid border-border rounded-xl bg-card shadow-xs",
  "ddt-template":
    "relative grid gap-[13px] p-[17px] grid-cols-[minmax(0,_1fr)_auto] [&_.ui-card-content_>_div:first-child]:grid [&_.ui-card-content_>_div:first-child]:gap-[7px] [&_p]:m-0 [&_p]:text-muted-foreground",
  "ddt-template-form":
    "p-5 [&_footer]:grid [&_footer]:grid-cols-[repeat(4,_1fr)] [&_footer]:gap-2 [&_>_label]:grid [&_>_label]:gap-[5px]",
  "ddt-template-grid": "grid gap-3 grid-cols-2 max-[1181px]:grid-cols-[1fr]",
  "ddt-workspace":
    "grid min-w-0 gap-4 [&_.inline-notice]:justify-between [&_.inline-notice.success]:border-success/10 [&_.inline-notice.success]:bg-success/10 [&_.inline-notice.success]:text-success [&_.inline-notice.error]:border-destructive/10 [&_.inline-notice.error]:bg-destructive/10 [&_.inline-notice.error]:text-destructive [&_.inline-notice_button]:grid [&_.inline-notice_button]:border-0 [&_.inline-notice_button]:bg-transparent [&_.inline-notice_button]:text-current [&_.text-button]:inline-flex [&_.text-button]:min-h-8 [&_.text-button]:items-center [&_.text-button]:gap-[5px] [&_.text-button]:border-0 [&_.text-button]:p-[3px] [&_.text-button]:bg-transparent [&_.text-button]:text-info [&_.text-button]:font-semibold [&_.text-button.danger]:text-destructive [&_.icon-button.danger]:text-destructive [&_.button-danger]:border-destructive/10 [&_.button-danger]:bg-destructive/10 [&_.button-danger]:text-destructive [&:has(.ddt-case-browser)]:grid-cols-[minmax(0,_1fr)_auto] [&:has(.ddt-case-browser)]:gap-3 [&:has(.ddt-case-browser)_>_.ddt-workspace-bar]:[grid-column:2] [&:has(.ddt-case-browser)_>_.ddt-workspace-bar]:[grid-row:1] [&:has(.ddt-case-browser)_>_.ddt-workspace-bar_>_div:first-child]:hidden [&:has(.ddt-case-browser)_>_.ddt-subtabs]:[grid-column:1] [&:has(.ddt-case-browser)_>_.ddt-subtabs]:[grid-row:1] [&:has(.ddt-case-browser)_>_.ddt-subtabs]:border-0 [&:has(.ddt-case-browser)_>_.ddt-subtabs]:p-0 [&:has(.ddt-case-browser)_>_:not(.ddt-workspace-bar,_.ddt-subtabs)]:col-span-full max-[1601px]:[&:has(.ddt-case-browser)]:grid-cols-[minmax(0,_1fr)] max-[1601px]:[&:has(.ddt-case-browser)_>_.ddt-workspace-bar]:[grid-column:1] max-[1601px]:[&:has(.ddt-case-browser)_>_.ddt-workspace-bar]:justify-end max-[1601px]:[&:has(.ddt-case-browser)_>_.ddt-subtabs]:[grid-column:1] max-[1601px]:[&:has(.ddt-case-browser)_>_.ddt-subtabs]:[grid-row:2]",
  "ddt-workspace-bar":
    "flex items-center gap-2 justify-end [&_>_div:first-child]:grid [&_>_div:first-child]:min-w-0 [&_>_div:first-child]:gap-[3px] [&_>_div:first-child]:mr-auto [&_>_div:first-child_>_span]:text-muted-foreground [&_>_div:first-child_>_span]:text-xs [&_>_div:first-child_>_strong]:hidden",
  "form-grid":
    "grid grid-cols-[minmax(0,_0.7fr)_minmax(0,_1.3fr)] gap-3.5 [&_.field-stack]:mt-0 [&.ddt-template-form]:grid [&.ddt-template-form]:grid-cols-2 [&.ddt-template-form]:gap-[13px] [&.ddt-bulk-form]:grid [&.ddt-bulk-form]:grid-cols-2 [&.ddt-bulk-form]:gap-[13px]",
  "table-actions": "flex items-center gap-2",
} as const;
