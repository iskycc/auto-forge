"use client";

import { formatPlatformDateTime } from "@/lib/platform-date-time";

import {
  ArchiveRestore,
  BarChart3,
  Boxes,
  ChevronRight,
  Code2,
  Download,
  FileSpreadsheet,
  Filter,
  History,
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
import type { DragEvent as ReactDragEvent, ReactNode } from "react";

import { Button, Input, OperationProgress, Select, Textarea } from "@/components/ui";
import { LoadingState } from "@/components/loading-state";
import { uploadWithProgress } from "@/lib/upload-with-progress";
import { useConfirm, useToast } from "@/components/ui-feedback";

type Scope = { projectId: string; projectVersionId: string; testStageId: string };
type ExecutionClass = {
  caseDefinitionId: string;
  className: string;
  displayName: string;
  sourceId: string;
  currentVersion: number;
  enabled: boolean;
  archived: boolean;
};
type CaseSummary = Scope & {
  id: string;
  caseId: string;
  srNum: string;
  kind: "standard" | "journey";
  sourceName: string;
  revision: number;
  updatedAt: string;
  executionClass?: ExecutionClass;
};
type DdtCase = CaseSummary & { data: Record<string, unknown>; createdAt: string };
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
type HistoryItem = {
  id: string;
  changeType: string;
  sourceName: string;
  changes: Array<{ field: string }>;
  createdAt: string;
};
type WorkspaceTab = "overview" | "cases" | "imports" | "templates" | "recycle";

const DDT_IMPORT_FILE_ACCEPT = ".xlsx,.xls,.xlsb,.csv,.ods,.zip";
const DDT_IMPORT_FILE_EXTENSIONS = new Set(["xlsx", "xls", "xlsb", "csv", "ods", "zip"]);

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
  suites,
}: {
  scope: Scope;
  canManage: boolean;
  canManageSuites: boolean;
  suites: Array<{ id: string; name: string }>;
}) {
  const confirmAction = useConfirm();
  const toast = useToast();
  const [tab, setTab] = useState<WorkspaceTab>("overview");
  const [dashboard, setDashboard] = useState(emptyDashboard);
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [imports, setImports] = useState<ImportJob[]>([]);
  const [deletedCases, setDeletedCases] = useState<DeletedCase[]>([]);
  const [query, setQuery] = useState("");
  const [srNum, setSrNum] = useState("");
  const [advancedField, setAdvancedField] = useState("");
  const [advancedOperator, setAdvancedOperator] = useState("contains");
  const [advancedValue, setAdvancedValue] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<DdtCase>();
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [busy, setBusy] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [showTemplate, setShowTemplate] = useState(false);
  const [showBulk, setShowBulk] = useState(false);
  const [showExecutionClass, setShowExecutionClass] = useState(false);
  const [showAddToSuite, setShowAddToSuite] = useState(false);
  const [deleteProgress, setDeleteProgress] = useState<{
    completed: number;
    total: number;
    label: string;
  }>();
  const hasLoaded = useRef(false);

  const endpoint = useCallback(
    (path: string, extra?: URLSearchParams) => {
      const parameters = new URLSearchParams(scope);
      extra?.forEach((value, key) => parameters.append(key, value));
      return `/api/v1/ddt/${path}?${parameters.toString()}`;
    },
    [scope],
  );

  const load = useCallback(async () => {
    if (hasLoaded.current) setRefreshing(true);
    else setBusy(true);
    setError("");
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
      const [nextDashboard, casePage, templatePage, importPage, recyclePage] = await Promise.all([
        requestJson<Dashboard>(endpoint("dashboard")),
        requestJson<{ items: CaseSummary[]; nextCursor?: string }>(
          endpoint("cases", caseParameters),
        ),
        requestJson<{ items: Template[] }>(endpoint("templates")),
        requestJson<{ items: ImportJob[] }>(endpoint("imports")),
        requestJson<{ items: DeletedCase[] }>(endpoint("recycle")),
      ]);
      setDashboard(nextDashboard);
      setCases(casePage.items);
      setNextCursor(casePage.nextCursor);
      setTemplates(templatePage.items);
      setImports(importPage.items);
      setDeletedCases(recyclePage.items);
      setSelected(new Set());
    } catch (loadError) {
      setError(messageOf(loadError));
    } finally {
      hasLoaded.current = true;
      setBusy(false);
      setRefreshing(false);
    }
  }, [advancedField, advancedOperator, advancedValue, endpoint, query, srNum]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    if (!imports.some((job) => ["queued", "running", "cancel_requested"].includes(job.status)))
      return;
    const timer = window.setInterval(() => void load(), 2_000);
    return () => window.clearInterval(timer);
  }, [imports, load]);

  const openCase = async (caseId: string) => {
    setError("");
    try {
      const [item, historyPage] = await Promise.all([
        requestJson<DdtCase>(endpoint(`cases/${encodeURIComponent(caseId)}`)),
        requestJson<{ items: HistoryItem[] }>(
          endpoint(`cases/${encodeURIComponent(caseId)}/history`),
        ),
      ]);
      setDetail(item);
      setHistory(historyPage.items);
    } catch (openError) {
      setError(messageOf(openError));
    }
  };

  const loadMore = async () => {
    if (!nextCursor) return;
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
      setCases((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (loadError) {
      setError(messageOf(loadError));
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
          onClick={() => void load()}
          disabled={busy || refreshing}
        >
          <RefreshCw size={15} className={busy || refreshing ? "spin" : ""} /> 刷新
        </Button>
        {canManage ? (
          <Button
            className="button button-primary"
            type="button"
            onClick={() => setShowImport(true)}
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
            onClick={() => setTab(value)}
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
                        setSrNum(group.srNum);
                        setTab("cases");
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
        <div className="ddt-case-panel">
          <div className="ddt-filterbar">
            <label className="search-field">
              <Search size={16} />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="按 CaseID 前缀搜索"
                aria-label="搜索 DDT 用例"
              />
            </label>
            <label>
              <span>业务分组</span>
              <Select value={srNum} onChange={(event) => setSrNum(event.target.value)}>
                <option value="">全部 srNum</option>
                {dashboard.groups.map((group) => (
                  <option key={group.srNum}>{group.srNum}</option>
                ))}
              </Select>
            </label>
            <label>
              <span>动态字段</span>
              <Input
                value={advancedField}
                onChange={(event) => setAdvancedField(event.target.value)}
                placeholder="例如 owner"
                aria-label="DDT 动态字段"
              />
            </label>
            <label>
              <span>匹配方式</span>
              <Select
                value={advancedOperator}
                onChange={(event) => setAdvancedOperator(event.target.value)}
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
                  onChange={(event) => setAdvancedValue(event.target.value)}
                  aria-label="动态字段值"
                />
              </label>
            ) : null}
            <span className="ddt-filter-count">
              <Filter size={14} /> 当前 {cases.length} 条
            </span>
            <Button
              className="button button-secondary"
              type="button"
              onClick={() => void exportSelection()}
            >
              <Download size={15} /> {selected.size ? `导出 ${selected.size} 条` : "导出当前范围"}
            </Button>
          </div>
          {selected.size ? (
            <div className="ddt-selection-bar">
              <strong>已选择 {selected.size} 条</strong>
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
                    className="button button-secondary"
                    type="button"
                    onClick={() => setShowExecutionClass(true)}
                  >
                    <Code2 size={15} /> 设置执行类
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
                  disabled={suites.length === 0}
                  onClick={() => setShowAddToSuite(true)}
                >
                  <ListPlus size={15} /> 加入用例任务
                </Button>
              ) : null}
              <Button type="button" className="text-button" onClick={() => setSelected(new Set())}>
                清空选择
              </Button>
            </div>
          ) : null}
          <div className="ddt-table-shell">
            <table className="data-table ddt-table">
              <thead>
                <tr>
                  <th className="selection-column">
                    <Input
                      type="checkbox"
                      aria-label="选择当前页全部 DDT 用例"
                      checked={cases.length > 0 && cases.every((item) => selected.has(item.caseId))}
                      onChange={(event) =>
                        setSelected(
                          event.target.checked
                            ? new Set(cases.map((item) => item.caseId))
                            : new Set(),
                        )
                      }
                    />
                  </th>
                  <th>CaseID</th>
                  <th>srNum</th>
                  <th>结构</th>
                  <th>执行类</th>
                  <th>来源</th>
                  <th>更新时间</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {cases.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <Input
                        type="checkbox"
                        aria-label={`选择 ${item.caseId}`}
                        checked={selected.has(item.caseId)}
                        onChange={() => setSelected(toggleSet(selected, item.caseId))}
                      />
                    </td>
                    <td>
                      <Button
                        className="ddt-case-link"
                        type="button"
                        onClick={() => void openCase(item.caseId)}
                      >
                        {item.caseId}
                      </Button>
                    </td>
                    <td>
                      <span className="ddt-group-tag">{item.srNum}</span>
                    </td>
                    <td>
                      <span className={`ddt-kind ${item.kind}`}>
                        {item.kind === "journey" ? "用户旅程" : "普通用例"}
                      </span>
                    </td>
                    <td className="ddt-execution-class-cell">
                      {item.executionClass ? (
                        <span title={item.executionClass.className}>
                          <strong>{item.executionClass.displayName}</strong>
                          <small>{item.executionClass.className}</small>
                        </span>
                      ) : (
                        <span className="ddt-unmapped-class">未设置</span>
                      )}
                    </td>
                    <td title={item.sourceName}>{item.sourceName || "人工维护"}</td>
                    <td>{formatDate(item.updatedAt)}</td>
                    <td>
                      <Button
                        className="icon-button"
                        type="button"
                        aria-label={`查看 ${item.caseId}`}
                        onClick={() => void openCase(item.caseId)}
                      >
                        <ChevronRight size={17} />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!cases.length ? (
              <Empty
                title="没有符合条件的 DDT 用例"
                description="调整筛选条件，或导入 data / step 表格。"
              />
            ) : null}
          </div>
          {nextCursor ? (
            <Button
              className="button button-secondary ddt-load-more"
              type="button"
              onClick={() => void loadMore()}
            >
              加载更多
            </Button>
          ) : null}
        </div>
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
            await requestJson(
              endpoint(
                `templates/${item.id}`,
                new URLSearchParams({ revision: String(item.revision) }),
              ),
              { method: "DELETE" },
            );
            await load();
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

      {detail ? (
        <CaseDrawer
          item={detail}
          history={history}
          canManage={canManage}
          onClose={() => setDetail(undefined)}
          onSaved={async (next) => {
            toast.success(`已保存 ${next.caseId}`);
            await load();
            await openCase(next.caseId);
          }}
          endpoint={endpoint}
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
            setShowBulk(false);
            setSelected(new Set());
          }}
        />
      ) : null}
      {showExecutionClass ? (
        <ExecutionClassDialog
          count={selected.size}
          caseIds={[...selected]}
          endpoint={endpoint}
          onClose={() => setShowExecutionClass(false)}
          onComplete={async (executionClass) => {
            toast.success(
              `已将 ${selected.size} 条 DDT 用例的执行类设置为 ${executionClass.className}。`,
            );
            setShowExecutionClass(false);
            setSelected(new Set());
            await load();
          }}
        />
      ) : null}
      {showAddToSuite ? (
        <AddDdtToSuiteDialog
          caseIds={[...selected]}
          scope={scope}
          suites={suites}
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
                  失败文件 <strong>{job.failedFiles}</strong>
                </span>
              </div>
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

function CaseDrawer({
  item,
  history,
  canManage,
  onClose,
  onSaved,
  endpoint,
}: {
  item: DdtCase;
  history: HistoryItem[];
  canManage: boolean;
  onClose(): void;
  onSaved(item: DdtCase): Promise<void>;
  endpoint(path: string, extra?: URLSearchParams): string;
}) {
  const [editing, setEditing] = useState(false);
  const [json, setJson] = useState(() => JSON.stringify(item.data, null, 2));
  const [error, setError] = useState("");
  const fields = Object.entries(item.data);
  const save = async () => {
    try {
      const data = JSON.parse(json) as Record<string, unknown>;
      const next = await requestJson<DdtCase>(
        endpoint(`cases/${encodeURIComponent(item.caseId)}`),
        {
          method: "PATCH",
          headers: jsonHeaders,
          body: JSON.stringify({ expectedRevision: item.revision, data }),
        },
      );
      setEditing(false);
      await onSaved(next);
    } catch (saveError) {
      setError(messageOf(saveError));
    }
  };
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        className="ddt-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ddt-case-title"
      >
        <header>
          <div>
            <span className="eyebrow">{item.kind === "journey" ? "用户旅程" : "普通用例"}</span>
            <h2 id="ddt-case-title">{item.caseId}</h2>
            <p>
              {item.srNum} · 修订 {item.revision}
            </p>
          </div>
          <Button className="icon-button" type="button" aria-label="关闭用例详情" onClick={onClose}>
            <X size={18} />
          </Button>
        </header>
        {error ? <div className="inline-notice error">{error}</div> : null}
        <div className="ddt-drawer-body">
          <section className="ddt-execution-class-summary" aria-label="DDT 执行类">
            <span>执行类型</span>
            <strong>DDT · classDataFile = {item.caseId}</strong>
            <small>
              {item.executionClass
                ? `${item.executionClass.displayName} · ${item.executionClass.className}`
                : "尚未设置普通用例执行类，加入任务后将无法通过执行预检。"}
            </small>
          </section>
          {editing ? (
            <label className="ddt-json-editor">
              <span>用例数据 JSON</span>
              <Textarea
                value={json}
                onChange={(event) => setJson(event.target.value)}
                spellCheck={false}
              />
              <small>
                CaseID 与 srNum 为身份字段；用户旅程的 step1…stepN 位于“用户旅程”对象中。
              </small>
            </label>
          ) : (
            <div className="ddt-field-list">
              {fields.map(([field, value]) => (
                <div key={field}>
                  <span>{field}</span>
                  {typeof value === "object" && value !== null ? (
                    <pre>{JSON.stringify(value, null, 2)}</pre>
                  ) : (
                    <strong>{String(value ?? "—")}</strong>
                  )}
                </div>
              ))}
            </div>
          )}
          <section className="ddt-history">
            <h3>
              <History size={16} /> 修改历史
            </h3>
            {history.length ? (
              history.map((entry) => (
                <article key={entry.id}>
                  <div>
                    <strong>{changeLabel(entry.changeType)}</strong>
                    <span>{entry.sourceName}</span>
                    <small>
                      {formatDate(entry.createdAt)} · {entry.changes.length} 个字段
                    </small>
                  </div>
                  {canManage ? (
                    <Button
                      className="text-button"
                      type="button"
                      onClick={async () => {
                        const next = await requestJson<DdtCase>(
                          endpoint(
                            `cases/${encodeURIComponent(item.caseId)}/history/${entry.id}/restore`,
                          ),
                          {
                            method: "POST",
                            headers: jsonHeaders,
                            body: JSON.stringify({ snapshot: "after" }),
                          },
                        );
                        await onSaved(next);
                      }}
                    >
                      恢复此版本
                    </Button>
                  ) : null}
                </article>
              ))
            ) : (
              <p>暂无修改历史</p>
            )}
          </section>
        </div>
        {canManage ? (
          <footer>
            {editing ? (
              <>
                <Button
                  className="button button-secondary"
                  type="button"
                  onClick={() => setEditing(false)}
                >
                  取消
                </Button>
                <Button className="button button-primary" type="button" onClick={() => void save()}>
                  保存修改
                </Button>
              </>
            ) : (
              <Button
                className="button button-primary"
                type="button"
                onClick={() => setEditing(true)}
              >
                <PencilLine size={15} /> 编辑动态字段
              </Button>
            )}
          </footer>
        ) : null}
      </aside>
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
  const [uploadProgress, setUploadProgress] = useState<{
    label: string;
    detail: string;
    percent: number;
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
      setJob((await response.json()) as ImportJob);
      setUploadProgress(undefined);
    } catch (previewError) {
      setError(messageOf(previewError));
      setUploadProgress(undefined);
    } finally {
      setBusy(false);
    }
  };
  const confirm = async () => {
    if (!job) return;
    setBusy(true);
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
  return (
    <Dialog title="导入 DDT 用例" subtitle="先预检，再选择冲突策略启动后台导入" onClose={onClose}>
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
                label={uploadProgress.label}
                value={uploadProgress.percent}
              />
            ) : null}
            <footer>
              <Button className="button button-secondary" type="button" onClick={onClose}>
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
            <fieldset className="ddt-strategy">
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
                onClick={() => setJob(undefined)}
              >
                重新选择
              </Button>
              <Button
                className="button button-primary"
                type="button"
                disabled={!job.validFiles || busy}
                onClick={() => void confirm()}
              >
                {busy ? <LoaderCircle className="spin" size={15} /> : null}确认并后台导入
              </Button>
            </footer>
          </>
        )}
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

function ExecutionClassDialog({
  count,
  caseIds,
  endpoint,
  onClose,
  onComplete,
}: {
  count: number;
  caseIds: string[];
  endpoint(path: string, extra?: URLSearchParams): string;
  onClose(): void;
  onComplete(executionClass: ExecutionClass): Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<ExecutionClass[]>([]);
  const [selectedClassName, setSelectedClassName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const search = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const result = await requestJson<{ items: ExecutionClass[] }>(
        endpoint("execution-classes", new URLSearchParams({ query, limit: "50" })),
      );
      setItems(result.items);
    } catch (searchError) {
      setError(messageOf(searchError));
    } finally {
      setBusy(false);
    }
  }, [endpoint, query]);

  useEffect(() => {
    const timer = window.setTimeout(() => void search(), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  const save = async () => {
    const executionClass = items.find((item) => item.className === selectedClassName);
    if (!executionClass) return;
    setBusy(true);
    setError("");
    try {
      await requestJson(endpoint("cases/execution-class"), {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ caseIds, className: executionClass.className }),
      });
      await onComplete(executionClass);
    } catch (saveError) {
      setError(messageOf(saveError));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={`设置 ${count} 条 DDT 用例的执行类`}
      subtitle="选择当前项目版本与测试阶段中的普通 TestNG 用例类"
      onClose={onClose}
    >
      <div className="ddt-execution-class-dialog">
        {error ? <div className="inline-notice error">{error}</div> : null}
        <label className="search-field">
          <Search size={16} />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索类名或人类友好名称"
            aria-label="搜索 DDT 执行类"
          />
        </label>
        <div className="ddt-execution-class-options" role="radiogroup" aria-label="执行类">
          {items.map((item) => (
            <label key={item.caseDefinitionId}>
              <Input
                type="radio"
                name="ddt-execution-class"
                value={item.className}
                checked={selectedClassName === item.className}
                onChange={() => setSelectedClassName(item.className)}
              />
              <span>
                <strong>{item.displayName}</strong>
                <small>{item.className}</small>
              </span>
            </label>
          ))}
          {!busy && items.length === 0 ? <p>当前范围没有可选的普通用例类。</p> : null}
          {busy ? (
            <p>
              <LoaderCircle className="spin" size={16} /> 正在读取执行类…
            </p>
          ) : null}
        </div>
        <footer>
          <Button className="button button-secondary" type="button" onClick={onClose}>
            取消
          </Button>
          <Button
            className="button button-primary"
            type="button"
            disabled={!selectedClassName || busy}
            onClick={() => void save()}
          >
            保存执行类
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
  onClose,
  onComplete,
}: {
  caseIds: string[];
  scope: Scope;
  suites: Array<{ id: string; name: string }>;
  onClose(): void;
  onComplete(suiteName: string): Promise<void>;
}) {
  const [suiteId, setSuiteId] = useState(suites[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    const suite = suites.find((item) => item.id === suiteId);
    if (!suite) return;
    setBusy(true);
    setError("");
    try {
      await requestJson(`/api/v1/case-suites/${encodeURIComponent(suiteId)}/ddt-cases`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ testStageId: scope.testStageId, caseIds }),
      });
      await onComplete(suite.name);
    } catch (saveError) {
      setError(messageOf(saveError));
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={`将 ${caseIds.length} 条 DDT 用例加入任务`}
      subtitle="任务会按 srNum 展示 DDT 目录，并在执行时固化每条用例的数据快照"
      onClose={onClose}
    >
      <div className="form-grid ddt-add-suite-dialog">
        {error ? <div className="inline-notice error full-span">{error}</div> : null}
        <label className="full-span">
          <span>目标用例任务</span>
          <Select value={suiteId} onChange={(event) => setSuiteId(event.target.value)}>
            {suites.map((suite) => (
              <option key={suite.id} value={suite.id}>
                {suite.name}
              </option>
            ))}
          </Select>
        </label>
        <footer className="full-span">
          <Button className="button button-secondary" type="button" onClick={onClose}>
            取消
          </Button>
          <Button
            className="button button-primary"
            type="button"
            disabled={!suiteId || busy}
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
}: {
  title: string;
  subtitle: string;
  onClose(): void;
  children: ReactNode;
}) {
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="modal-card ddt-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ddt-dialog-title"
      >
        <header>
          <div>
            <h2 id="ddt-dialog-title">{title}</h2>
            <p>{subtitle}</p>
          </div>
          <Button className="icon-button" type="button" aria-label="关闭弹窗" onClick={onClose}>
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
  const response = await fetch(url, init);
  if (!response.ok) throw await responseError(response);
  if (response.status === 204) return undefined as Result;
  return response.json() as Promise<Result>;
}

async function responseError(response: Response): Promise<Error> {
  const payload = (await response.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  return new Error(payload?.error?.message ?? `请求失败（${response.status}）`);
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
function changeLabel(value: string): string {
  return (
    (
      {
        edit: "人工编辑",
        bulk_edit: "批量修改",
        import_overwrite: "导入覆盖",
        restore: "历史恢复",
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
