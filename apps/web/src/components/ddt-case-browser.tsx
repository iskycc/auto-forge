"use client";
import { Splitter } from "antd";
import { EmptyState } from "@/components/ui/empty-state";

import { LoadingStateMessage } from "@/components/ui/loading-state-message";

import { Badge } from "@/components/ui/badge";
import { Notice } from "@/components/ui/notice";

import { Tabs } from "./ui/tabs";
import { useContentTransition } from "./ui/tab-content";
import { Disclosure } from "@/components/ui/disclosure";

import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import {
  ddtJourneySteps,
  ddtStepNames,
  updateDdtCaseField,
  type DdtCase,
  type DdtCaseData,
  type DdtCaseSummary,
  type DdtCellValue,
} from "@autoforge/domain";
import { ddtCaseDataSchema } from "@autoforge/contracts";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Eye,
  FileSpreadsheet,
  History,
  PanelLeftClose,
  PanelLeftOpen,
  PencilLine,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { Button, Input, Select, Textarea } from "@/components/ui";
import { useToast } from "@/components/ui-feedback";
import { useConcurrentModificationFeedback } from "@/components/concurrent-modification-feedback";
import { formatPlatformDateTime } from "@/lib/platform-date-time";
import { OpenRunDialogButton } from "./global-run-dialog";
import { useDdtBrowserLayout } from "./use-ddt-browser-layout";

export type DdtHistoryItem = {
  id: string;
  changeType: string;
  sourceName: string;
  changes: Array<{ field: string }>;
  createdAt: string;
};
export type DdtEditorStatus = "idle" | "editing" | "saving";

export function DdtCaseBrowser({
  cases,
  activeCaseId,
  selected,
  filters,
  selectionActions,
  children,
  hasMore,
  loadingMore,
  refreshing,
  savingCase,
  onLoadMore,
  onOpen,
  onPreview,
  onSelect,
  onSelectAll,
}: {
  cases: DdtCaseSummary[];
  activeCaseId: string;
  selected: Set<string>;
  filters: ReactNode;
  selectionActions: ReactNode;
  children: ReactNode;
  hasMore: boolean;
  loadingMore: boolean;
  refreshing: boolean;
  savingCase: boolean;
  onLoadMore(): void;
  onOpen(caseId: string): void;
  onPreview(caseId: string): void;
  onSelect(caseId: string): void;
  onSelectAll(checked: boolean): void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const {
    browserRef,
    listWidth,
    minimumListWidth,
    maximumListWidth,
    style,
    resizeList,
    resetListWidth,
  } = useDdtBrowserLayout();
  useEffect(() => {
    const separator = browserRef.current?.querySelector('[role="separator"]');
    separator?.setAttribute("aria-label", "调整 CaseID 列表宽度");
    separator?.setAttribute("tabindex", "0");
  }, [browserRef, collapsed]);
  return (
    <div
      className={cn(
        ddtCaseBrowserStyles["ddt-case-browser"],
        `ddt-case-browser${collapsed ? " is-collapsed" : ""}`,
      )}
      ref={browserRef}
      style={style}
      onKeyDownCapture={(event) => {
        if (
          !(event.target instanceof HTMLElement) ||
          event.target.getAttribute("role") !== "separator"
        )
          return;
        if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Home") resetListWidth();
        else resizeList(listWidth + (event.key === "ArrowLeft" ? -20 : 20));
      }}
    >
      <Splitter
        classNames={{ dragger: { default: "ddt-case-resizer" } }}
        className="h-full min-h-0"
        onResize={(sizes) => {
          if (!collapsed && sizes[0] !== undefined) resizeList(sizes[0]);
        }}
        onDraggerDoubleClick={resetListWidth}
      >
        <Splitter.Panel
          size={collapsed ? 52 : listWidth}
          min={collapsed ? 52 : minimumListWidth}
          max={collapsed ? 52 : maximumListWidth}
          resizable={!collapsed}
          className="min-h-0 [&>.ddt-case-navigation]:h-full"
        >
          <section
            className={cn("ddt-case-navigation", ddtCaseBrowserStyles["ddt-case-navigation"])}
            aria-label="DDT 用例导航"
          >
            <header>
              {!collapsed ? (
                <div>
                  <strong>用例库</strong>
                  <small title="↑ / ↓ 或 J / K 切换用例">{cases.length} 条已加载</small>
                </div>
              ) : null}
              <Button
                type="button"
                className={cn("icon-button", uiPatterns["icon-button"])}
                aria-label={collapsed ? "展开 CaseID 列表" : "收起 CaseID 列表"}
                title={collapsed ? "展开 CaseID 列表" : "收起 CaseID 列表"}
                onClick={() => setCollapsed(!collapsed)}
              >
                {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
              </Button>
            </header>
            <div
              className={cn(
                "ddt-case-navigation-content",
                ddtCaseBrowserStyles["ddt-case-navigation-content"],
              )}
              hidden={collapsed}
            >
              <fieldset
                className={cn("ddt-case-filters", ddtCaseBrowserStyles["ddt-case-filters"])}
                disabled={savingCase}
              >
                {filters}
              </fieldset>
              <label
                className={cn("ddt-loaded-selection", ddtCaseBrowserStyles["ddt-loaded-selection"])}
              >
                <Input
                  type="checkbox"
                  aria-label="选择已加载的全部 DDT 用例"
                  disabled={savingCase}
                  checked={cases.length > 0 && cases.every((item) => selected.has(item.caseId))}
                  onChange={(event) => onSelectAll(event.target.checked)}
                />
                {selected.size ? `已选 ${selected.size} 条` : "选择已加载用例"}
              </label>
              <div
                className={cn("ddt-case-list", ddtCaseBrowserStyles["ddt-case-list"])}
                aria-busy={refreshing}
                onKeyDown={(event) => {
                  if (!(event.target instanceof HTMLButtonElement) || !event.target.dataset.caseId)
                    return;
                  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
                  const direction = ["ArrowDown", "j"].includes(event.key)
                    ? 1
                    : ["ArrowUp", "k"].includes(event.key)
                      ? -1
                      : 0;
                  if (!direction) return;
                  const focusedCaseId = event.target.dataset.caseId;
                  const index = cases.findIndex((item) => item.caseId === focusedCaseId);
                  const next = cases[index + direction];
                  if (!next) return;
                  event.preventDefault();
                  onOpen(next.caseId);
                  const buttons =
                    event.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-case-id]");
                  buttons[index + direction]?.focus();
                }}
              >
                {cases.map((item) => (
                  <div
                    key={item.id}
                    className={cn(
                      ddtCaseBrowserStyles["ddt-case-list-row"],
                      `ddt-case-list-row${activeCaseId === item.caseId ? " active" : ""}`,
                    )}
                  >
                    <Input
                      type="checkbox"
                      aria-label={`选择 ${item.caseId}`}
                      disabled={savingCase}
                      checked={selected.has(item.caseId)}
                      onChange={() => onSelect(item.caseId)}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      className={cn(
                        "ddt-case-list-item",
                        ddtCaseBrowserStyles["ddt-case-list-item"],
                      )}
                      aria-label={item.caseId}
                      aria-current={activeCaseId === item.caseId ? "true" : undefined}
                      data-case-id={item.caseId}
                      disabled={savingCase}
                      onClick={() => onOpen(item.caseId)}
                    >
                      <FileSpreadsheet size={17} />
                      <span>
                        <strong title={item.caseId}>{item.caseId}</strong>
                        <small>
                          <span>{item.srNum}</span>
                          {item.kind === "journey" ? <em>用户旅程</em> : null}
                        </small>
                      </span>
                      <ChevronRight size={14} />
                    </Button>
                    <Button
                      type="button"
                      className={cn("ddt-case-preview", ddtCaseBrowserStyles["ddt-case-preview"])}
                      variant="ghost"
                      size="compact"
                      aria-label={`快速预览 ${item.caseId}`}
                      title="查看执行记录、分析结论与测试类详情"
                      disabled={savingCase}
                      onClick={() => onPreview(item.caseId)}
                    >
                      <Eye size={15} aria-hidden="true" />
                    </Button>
                  </div>
                ))}
                {refreshing && !cases.length ? (
                  <LoadingStateMessage
                    className={cn(
                      "ddt-navigation-empty",
                      ddtCaseBrowserStyles["ddt-navigation-empty"],
                    )}
                    role="status"
                  >
                    正在加载用例…
                  </LoadingStateMessage>
                ) : !cases.length ? (
                  <EmptyState
                    className={cn(
                      "ddt-navigation-empty",
                      ddtCaseBrowserStyles["ddt-navigation-empty"],
                    )}
                  >
                    没有符合条件的用例，试试调整筛选条件或导入表格。
                  </EmptyState>
                ) : null}
                {hasMore ? (
                  <Button
                    type="button"
                    className={cn("ddt-load-more", ddtCaseBrowserStyles["ddt-load-more"])}
                    loading={loadingMore}
                    disabled={loadingMore || savingCase}
                    variant="secondary"
                    size="compact"
                    onClick={onLoadMore}
                  >
                    <ChevronDown size={14} aria-hidden="true" />
                    {loadingMore ? "正在加载…" : "加载更多"}
                  </Button>
                ) : null}
              </div>
            </div>
          </section>
        </Splitter.Panel>
        <Splitter.Panel min={320} className="min-h-0 [&>.ddt-case-detail-panel]:h-full">
          <section
            className={cn("ddt-case-detail-panel", ddtCaseBrowserStyles["ddt-case-detail-panel"])}
            aria-label="DDT 用例详情"
          >
            {selected.size ? (
              <div className={cn("ddt-bulk-workspace", ddtCaseBrowserStyles["ddt-bulk-workspace"])}>
                <header>
                  <FileSpreadsheet size={24} />
                  <div>
                    <h2>已选择 {selected.size} 条用例</h2>
                    <p>在左侧继续选择，在这里统一管理所选用例。</p>
                    {selected.size > cases.filter((item) => selected.has(item.caseId)).length ? (
                      <p>包含当前列表尚未显示的用例，加入任务时会包含全部已选用例。</p>
                    ) : null}
                  </div>
                </header>
                {selectionActions}
              </div>
            ) : (
              children
            )}
          </section>
        </Splitter.Panel>
      </Splitter>
    </div>
  );
}

export function DdtCaseDetail({
  item,
  history,
  canManage,
  canRun,
  onPreview,
  onSave,
  onRestore,
  onStatusChange,
  onPrevious,
  onNext,
}: {
  item: DdtCase;
  history: DdtHistoryItem[];
  canManage: boolean;
  canRun: boolean;
  onPreview(): void;
  onSave(data: DdtCaseData): Promise<void>;
  onRestore(historyId: string): Promise<void>;
  onStatusChange(status: DdtEditorStatus): void;
  onPrevious: (() => void) | undefined;
  onNext: (() => void) | undefined;
}) {
  const toast = useToast();
  const showConcurrentModification = useConcurrentModificationFeedback();
  const [activeStep, setActiveStep] = useState("");
  const [editor, setEditor] = useState<{
    field?: string | undefined;
    text: string;
    valueType: string;
  }>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const steps = ddtJourneySteps(item.data);
  const stepNames = ddtStepNames(item.data);
  const resolvedStep = steps && steps[activeStep] ? activeStep : (stepNames[0] ?? "");
  const fields = Object.entries(steps?.[resolvedStep] ?? item.data);
  const fieldsRef = useContentTransition(resolvedStep);
  const finishEditing = () => {
    setEditor(undefined);
    onStatusChange("idle");
    setError("");
  };
  const beginEditing = (field?: string, value?: unknown) => {
    setError("");
    setEditor({
      field,
      text: field ? String(value ?? "") : JSON.stringify(item.data, null, 2),
      valueType: value === null ? "null" : typeof value,
    });
    onStatusChange("editing");
  };
  const apply = async (mutation: () => Promise<void>) => {
    setSaving(true);
    setError("");
    onStatusChange("saving");
    try {
      await mutation();
      finishEditing();
    } catch (error) {
      onStatusChange(editor ? "editing" : "idle");
      if (!(await showConcurrentModification(error)))
        setError(error instanceof Error ? error.message : "保存用例失败，请重试。");
    } finally {
      setSaving(false);
    }
  };
  const save = () =>
    apply(async () => {
      if (!editor) return;
      const next = editor.field
        ? updateDdtCaseField(
            item.data,
            editor.field,
            parseFieldValue(editor.text, editor.valueType),
            resolvedStep || undefined,
          )
        : ddtCaseDataSchema.parse(JSON.parse(editor.text));
      await onSave(next);
    });
  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success("已复制字段内容。");
    } catch {
      toast.error("复制失败，请选中文字手动复制。");
    }
  };
  return (
    <>
      <header className={cn("ddt-detail-toolbar", ddtCaseBrowserStyles["ddt-detail-toolbar"])}>
        <span>
          用例详情 <ChevronRight size={14} /> <strong title={item.caseId}>{item.caseId}</strong>
        </span>
        <div>
          <Button
            type="button"
            className={cn("icon-button", uiPatterns["icon-button"])}
            aria-label="上一条用例"
            title="上一条用例"
            disabled={!onPrevious || saving}
            onClick={onPrevious}
          >
            <ChevronLeft size={17} />
          </Button>
          <Button
            type="button"
            className={cn("icon-button", uiPatterns["icon-button"])}
            aria-label="下一条用例"
            title="下一条用例"
            disabled={!onNext || saving}
            onClick={onNext}
          >
            <ChevronRight size={17} />
          </Button>
          {canManage ? (
            <Button
              type="button"
              className={cn(
                "button button-secondary",
                uiPatterns["button"],
                uiPatterns["button-secondary"],
              )}
              disabled={Boolean(editor) || saving}
              onClick={() => beginEditing()}
            >
              <PencilLine size={15} /> 编辑动态字段
            </Button>
          ) : null}
        </div>
      </header>
      <div className={cn("ddt-case-detail-scroll", ddtCaseBrowserStyles["ddt-case-detail-scroll"])}>
        <div className={cn("ddt-detail-title", ddtCaseBrowserStyles["ddt-detail-title"])}>
          <FileSpreadsheet size={26} />
          <div>
            <h2>{item.caseId}</h2>
            <p>来自 {item.sourceName || "人工维护"}</p>
          </div>
          <Badge className={cn(ddtCaseBrowserStyles["ddt-kind"], `ddt-kind ${item.kind}`)}>
            {item.kind === "journey" ? "用户旅程" : "普通用例"}
          </Badge>
        </div>
        <dl className={cn("ddt-detail-summary", ddtCaseBrowserStyles["ddt-detail-summary"])}>
          <div>
            <dt>所属 srNum</dt>
            <dd>{item.srNum}</dd>
          </div>
          <div>
            <dt>{steps ? "旅程结构" : "字段数量"}</dt>
            <dd>
              {steps ? `${stepNames.length} 步 · ` : ""}
              {fields.length} 个字段
            </dd>
          </div>
          <div>
            <dt>修订版本</dt>
            <dd>{item.revision}</dd>
          </div>
          <div>
            <dt>最后更新</dt>
            <dd>
              <time dateTime={item.updatedAt} title={item.updatedAt}>
                {formatPlatformDateTime(item.updatedAt)}
              </time>
            </dd>
          </div>
        </dl>
        <section
          className={cn(
            "ddt-execution-class-summary",
            ddtCaseBrowserStyles["ddt-execution-class-summary"],
          )}
          aria-label="DDT 执行类"
        >
          <div className="grid min-w-0 flex-1 basis-48 gap-0.5 [overflow-wrap:anywhere]">
            <span className="text-xs text-muted-foreground">执行类 · 继承自 SR {item.srNum}</span>
            <strong>{item.executionClass?.displayName ?? "尚未设置执行类"}</strong>
            <small>
              {item.executionClass?.className ??
                "请在“SR 测试类关联”页面配置当前 SR 的测试类；本 SR 下所有用例自动继承。"}
            </small>
          </div>
          <div
            className={cn(
              "ddt-execution-class-actions",
              ddtCaseBrowserStyles["ddt-execution-class-actions"],
            )}
          >
            <Button
              type="button"
              variant="secondary"
              disabled={Boolean(editor) || saving}
              onClick={onPreview}
            >
              <Eye size={15} /> 查看执行详情
            </Button>
            {canRun && item.executionClass?.enabled && !item.executionClass.archived ? (
              <OpenRunDialogButton
                ddtCase={item}
                disabled={Boolean(editor) || saving}
                className={cn(
                  "button button-primary compact-button",
                  uiPatterns["button"],
                  uiPatterns["button-primary"],
                  uiPatterns["compact-button"],
                )}
              >
                立即执行
              </OpenRunDialogButton>
            ) : null}
          </div>
        </section>
        {steps ? (
          <div className={cn("ddt-journey-switcher", ddtCaseBrowserStyles["ddt-journey-switcher"])}>
            <strong>用户旅程步骤</strong>
            <Tabs
              label="用户旅程步骤"
              value={resolvedStep}
              items={stepNames.map((step) => ({
                key: step,
                label: step,
                disabled: Boolean(editor) || saving,
              }))}
              onChange={setActiveStep}
            />
          </div>
        ) : null}
        <header className={cn("ddt-fields-heading", ddtCaseBrowserStyles["ddt-fields-heading"])}>
          <div>
            <h3>{steps ? `${resolvedStep} 字段内容` : "字段内容"}</h3>
            <p>
              {steps
                ? "切换 Step 查看字段；修改 CaseID 或 srNum 会同步所有步骤。"
                : canManage
                  ? "逐项查看用例数据，字段支持独立编辑和复制。"
                  : "逐项查看用例数据，支持复制字段内容。"}
            </p>
          </div>
          <small>{canManage ? "可编辑" : "只读查看"}</small>
        </header>
        {editor && !editor.field ? (
          <label className={cn("ddt-json-editor", ddtCaseBrowserStyles["ddt-json-editor"])}>
            <span>用例数据 JSON</span>
            <Textarea
              value={editor.text}
              disabled={saving}
              onChange={(event) => setEditor({ ...editor, text: event.target.value })}
              spellCheck={false}
            />
          </label>
        ) : (
          <div
            ref={fieldsRef}
            className={cn("ddt-field-cards", ddtCaseBrowserStyles["ddt-field-cards"])}
          >
            {fields.map(([field, value]) => (
              <article
                className={cn("ddt-field-card", ddtCaseBrowserStyles["ddt-field-card"])}
                key={field}
              >
                <header>
                  <strong>{field}</strong>
                  <div>
                    <Button
                      type="button"
                      className={cn("icon-button", uiPatterns["icon-button"], "size-8")}
                      aria-label={`复制字段 ${field}`}
                      onClick={() =>
                        void copy(
                          typeof value === "object" && value !== null
                            ? JSON.stringify(value, null, 2)
                            : String(value ?? ""),
                        )
                      }
                    >
                      <Copy size={14} />
                    </Button>
                    {canManage ? (
                      <Button
                        type="button"
                        className={cn("icon-button", uiPatterns["icon-button"], "size-8")}
                        aria-label={`编辑字段 ${field}`}
                        disabled={Boolean(editor) || saving}
                        onClick={() => beginEditing(field, value)}
                      >
                        <PencilLine size={14} />
                      </Button>
                    ) : null}
                  </div>
                </header>
                {editor?.field === field ? (
                  <div className={cn("ddt-field-editor", ddtCaseBrowserStyles["ddt-field-editor"])}>
                    <label>
                      <span>字段类型</span>
                      <Select
                        value={editor.valueType}
                        disabled={saving || field === "CaseID" || field === "srNum"}
                        onChange={(event) =>
                          setEditor({ ...editor, valueType: event.target.value })
                        }
                      >
                        <option value="string">文本</option>
                        <option value="number">数字</option>
                        <option value="boolean">布尔值</option>
                        <option value="null">空值</option>
                      </Select>
                    </label>
                    <label>
                      <span>{field} 的值</span>
                      <Textarea
                        autoFocus
                        value={editor.text}
                        disabled={saving || editor.valueType === "null"}
                        onChange={(event) => setEditor({ ...editor, text: event.target.value })}
                      />
                    </label>
                  </div>
                ) : (
                  <pre>
                    {typeof value === "object" && value !== null
                      ? JSON.stringify(value, null, 2)
                      : value === null
                        ? "空值"
                        : String(value)}
                  </pre>
                )}
              </article>
            ))}
          </div>
        )}
        {error ? (
          <Notice
            tone="error"
            className={cn("inline-notice error", uiPatterns["inline-notice"], uiPatterns["error"])}
            role="alert"
          >
            {error}
          </Notice>
        ) : null}
        {editor ? (
          <footer className={cn("ddt-detail-save", ddtCaseBrowserStyles["ddt-detail-save"])}>
            <span>请先保存或取消编辑后切换旅程步骤。</span>
            <Button
              type="button"
              className={cn(
                "button button-secondary",
                uiPatterns["button"],
                uiPatterns["button-secondary"],
              )}
              disabled={saving}
              onClick={finishEditing}
            >
              取消
            </Button>
            <Button
              type="button"
              className={cn(
                "button button-primary",
                uiPatterns["button"],
                uiPatterns["button-primary"],
              )}
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? "正在保存…" : "保存修改"}
            </Button>
          </footer>
        ) : null}
        <Disclosure
          header={
            <>
              <History size={16} /> 修改历史 <small>{history.length} 条已加载</small>
            </>
          }
          className={cn("ddt-history", ddtCaseBrowserStyles["ddt-history"])}
          defaultOpen
        >
          {history.length ? (
            history.map((entry) => (
              <article key={entry.id}>
                <div>
                  <strong>{historyLabel(entry.changeType)}</strong>
                  <span>{entry.sourceName}</span>
                  <small>
                    {formatPlatformDateTime(entry.createdAt)} · {entry.changes.length} 个字段
                  </small>
                </div>
                {canManage ? (
                  <Button
                    type="button"
                    className={cn("text-button", uiPatterns["text-button"])}
                    disabled={Boolean(editor) || saving}
                    onClick={() => void apply(() => onRestore(entry.id))}
                  >
                    恢复此版本
                  </Button>
                ) : null}
              </article>
            ))
          ) : (
            <EmptyState>暂无修改历史</EmptyState>
          )}
        </Disclosure>
      </div>
    </>
  );
}

function parseFieldValue(text: string, type: string): DdtCellValue {
  if (type === "null") return null;
  if (type === "number") {
    const value = Number(text);
    if (!text.trim() || !Number.isFinite(value)) throw new Error("请输入有效的数字。");
    return value;
  }
  if (type === "boolean") {
    if (!["true", "false"].includes(text.trim())) throw new Error("布尔值只能是 true 或 false。");
    return text.trim() === "true";
  }
  return text;
}

function historyLabel(value: string): string {
  return (
    (
      {
        edit: "人工编辑",
        bulk_edit: "批量修改",
        import_overwrite: "导入覆盖",
        restore: "版本恢复",
      } as Record<string, string>
    )[value] ?? value
  );
}

const ddtCaseBrowserStyles = {
  "ddt-bulk-workspace":
    "[&_p]:text-muted-foreground [&_p]:text-xs [&_p]:[margin:4px_0_0] [&_p]:[overflow-wrap:anywhere] [&_>_header]:flex [&_>_header]:items-center [&_>_header]:gap-3 [&_h2]:m-0 [&_h2]:text-lg [&_h2]:[overflow-wrap:anywhere] overflow-auto p-5 [&_.ddt-selection-bar]:flex-wrap [&_.ddt-selection-bar]:mt-5 [&_.ddt-selection-bar]:p-4",
  "ddt-case-browser":
    "[--ddt-case-list-width:clamp(240px,_26%,_440px)] [--ddt-case-list-collapsed-width:52px] [--ddt-case-resizer-width:10px] [--ddt-case-browser-height:320px] [--ddt-case-filter-max-height:none] block h-[var(--ddt-case-browser-height)] min-w-0 overflow-hidden border border-solid border-border rounded-xl bg-card shadow-xs ",
  "ddt-case-detail-panel": "flex min-w-0 min-h-0 flex-col",
  "ddt-case-detail-scroll":
    "min-h-0 flex-1 overflow-auto p-3 [container-type:inline-size] [&_.ddt-execution-class-summary]:grid-cols-[minmax(0,_1fr)] [&_.ddt-execution-class-summary]:gap-[4px_8px] [&_.ddt-execution-class-summary]:mb-3 [&_.ddt-execution-class-summary]:py-2 [&_.ddt-execution-class-summary]:px-3 [&_.ddt-execution-class-summary_>_small]:col-span-full [&_.ddt-history]:block",
  "ddt-case-filters":
    "m-0 border-0 grid grid-cols-2 [flex:0_0_auto] gap-2 overflow-visible py-2 px-3 [&_>_label]:col-span-full [&_>_label_>_span:not(.ui-select):not(.ui-field-feedback)]:hidden [&_label]:grid [&_label]:min-w-0 [&_label]:gap-1 [&_.ui-input]:w-full [&_.ui-input]:min-w-0 [&_.ui-select]:w-full [&_.ui-select]:min-w-0 [&_.search-field]:flex [&_.search-field]:items-center [&_.search-field]:gap-1 [&_.search-field_>_svg]:[flex:0_0_auto] [&_label_>_span]:text-muted-foreground [&_label_>_span]:text-xs",
  "ddt-case-list": "min-h-0 flex-1 overflow-auto p-1",
  "ddt-case-list-item":
    "[&.ui-button]:shadow-none [&_>_span]:grid [&_>_span]:min-w-0 [&_>_span]:gap-0.5 [&_>_span]:flex-1 flex min-w-0 flex-1 items-center gap-2 border-0 py-1 px-1 bg-transparent text-foreground text-left [&_>_svg]:[flex:0_0_auto] [&_>_svg]:text-muted-foreground [&_strong]:overflow-hidden [&_strong]:text-ellipsis [&_strong]:whitespace-nowrap [&_small_>_span]:overflow-hidden [&_small_>_span]:text-ellipsis [&_small_>_span]:whitespace-nowrap [&_small]:flex [&_small]:min-w-0 [&_small]:items-center [&_small]:gap-2 [&_em]:[flex:0_0_auto] [&_em]:text-info [&_em]:[font-style:normal]",
  "ddt-case-list-row":
    "flex min-w-0 items-center gap-1 border border-solid border-transparent rounded-lg pl-2 [&.active]:border-primary/30 [&.active]:bg-accent [&.active_.ddt-case-list-item]:text-primary-text [&:hover]:bg-muted/60",
  "ddt-case-navigation":
    "flex min-w-0 min-h-0 flex-col bg-card [&_>_header]:flex [&_>_header]:min-h-[calc(20px_*_2)] [&_>_header]:[flex:0_0_auto] [&_>_header]:items-center [&_>_header]:justify-between [&_>_header]:gap-2 [&_>_header]:border-b [&_>_header]:border-solid [&_>_header]:border-border [&_>_header]:py-1 [&_>_header]:px-3 [&_>_header_>_div]:flex [&_>_header_>_div]:items-baseline [&_>_header_>_div]:min-w-0 [&_>_header_>_div]:gap-2 [&_small]:text-muted-foreground [&_small]:text-xs",
  "ddt-case-navigation-content": "flex min-w-0 min-h-0 flex-col flex-1 [&[hidden]]:hidden",
  "ddt-case-preview":
    "[flex:0_0_auto] [&.ant-btn]:size-8 [&.ant-btn]:p-0 mr-1 text-muted-foreground",
  "ddt-case-resizer":
    "relative z-10 cursor-col-resize select-none touch-none border-x border-border bg-muted/30 after:absolute after:inset-y-[calc(50%_-_16px)] after:left-1/2 after:w-0.5 after:-translate-x-1/2 after:rounded-full after:bg-border hover:bg-accent hover:after:bg-primary focus-visible:bg-accent focus-visible:outline-none focus-visible:after:bg-primary",
  "ddt-detail-save":
    "sticky bottom-0 flex flex-wrap items-center justify-end gap-2 mt-3 border border-solid border-border rounded-lg p-3 bg-card shadow-xs [&_>_span]:flex-1 [&_>_span]:text-xs [&_>_span]:text-muted-foreground",
  "ddt-detail-summary":
    "[&_dt]:text-muted-foreground [&_dt]:text-xs grid grid-cols-4 gap-2 my-3 mx-0 [border-block:1px_solid_var(--border)] py-2 my-2 [&_dd]:[margin:4px_0_0] [&_dd]:font-semibold [&_dd]:[overflow-wrap:anywhere] [&_>_div]:min-w-0 [&_>_div]:[overflow-wrap:anywhere]",
  "ddt-detail-title":
    "[&_p]:text-muted-foreground [&_p]:text-xs [&_p]:[margin:4px_0_0] [&_p]:[overflow-wrap:anywhere] flex items-center gap-3 flex-wrap [&_>_div]:min-w-0 [&_>_div]:flex-1 [&_>_svg]:[flex:0_0_auto] [&_>_svg]:text-info [&_h2]:m-0 [&_h2]:text-lg [&_h2]:[overflow-wrap:anywhere]",
  "ddt-detail-toolbar":
    "flex min-h-[calc(20px_*_2)] [flex:0_0_auto] items-center justify-between gap-2 border-b border-solid border-border py-2 px-3 flex-wrap [&_>_span]:flex [&_>_span]:min-w-0 [&_>_span]:items-center [&_>_span]:gap-1 [&_>_span]:flex-1 [&_>_span]:flex-wrap [&_>_div]:flex [&_>_div]:min-w-0 [&_>_div]:items-center [&_>_div]:gap-1 [&_>_span_>_strong]:min-w-0 [&_>_span_>_strong]:[overflow-wrap:anywhere] [&_>_span_>_strong]:whitespace-normal [&_>_span_>_svg]:[flex:0_0_auto]",
  "ddt-execution-class-actions": "flex shrink-0 flex-wrap items-center gap-2",
  "ddt-execution-class-summary":
    "flex min-w-0 flex-wrap items-center gap-3 mb-2 border border-solid border-border rounded-lg p-2.5 bg-muted/40 [&_small]:text-muted-foreground [&_small]:text-xs [&_strong]:[overflow-wrap:anywhere]",
  "ddt-field-card":
    "min-w-0 overflow-hidden border border-solid border-border rounded-lg bg-card [&_>_header]:flex [&_>_header]:min-h-8 [&_>_header]:items-center [&_>_header]:justify-between [&_>_header]:gap-1 [&_>_header]:border-b [&_>_header]:border-solid [&_>_header]:border-border [&_>_header]:py-0 [&_>_header]:px-2 [&_>_header]:bg-muted/50 [&_>_header_>_strong]:min-w-0 [&_>_header_>_strong]:text-xs [&_>_header_>_strong]:[overflow-wrap:anywhere] [&_>_header_>_div]:flex [&_>_header_>_div]:[flex:0_0_auto] [&_pre]:max-h-[calc(20px_*_12)] [&_pre]:m-0 [&_pre]:overflow-auto [&_pre]:p-2 [&_pre]:font-mono [&_pre]:whitespace-pre-wrap [&_pre]:[overflow-wrap:anywhere]",
  "ddt-field-cards": "grid grid-cols-1 @[300px]:grid-cols-2 @[500px]:grid-cols-3 items-start gap-2",
  "ddt-field-editor":
    "[&_label]:grid [&_label]:min-w-0 [&_label]:gap-1 [&_textarea]:w-full [&_textarea]:min-w-0 [&_.ui-select]:w-full [&_.ui-select]:min-w-0 grid gap-2 p-3",
  "ddt-fields-heading":
    "[&_p]:text-muted-foreground [&_p]:text-xs [&_p]:[margin:4px_0_0] [&_p]:[overflow-wrap:anywhere] [&_small]:text-muted-foreground [&_small]:text-xs flex items-center gap-3 mb-2 [&_>_div]:min-w-0 [&_>_div]:flex-1 [&_h3]:m-0 [&_h3]:text-sm [&_>_small]:[flex:0_0_auto]",
  "ddt-history":
    "[&_.ui-disclosure-label]:flex [&_.ui-disclosure-label]:items-center [&_.ui-disclosure-label]:gap-2 [&_.ui-disclosure-label]:py-2 [&_.ui-disclosure-label]:cursor-pointer [&_.ui-disclosure-label]:font-semibold [&_article_>_div]:min-w-0 [&_article_>_div]:[overflow-wrap:anywhere] [&_article_>_div]:grid [&_article_>_div]:gap-0.5 [&_article_>_div]:mr-auto [&_article_>_button]:[flex:0_0_auto] grid gap-2 mt-5 [&_h3]:flex [&_h3]:items-center [&_h3]:gap-[7px] [&_h3]:m-0 [&_article]:flex [&_article]:items-center [&_article]:gap-3 [&_article]:border-t [&_article]:border-solid [&_article]:border-border [&_article]:py-2.5 [&_article]:px-0 [&_span]:text-muted-foreground [&_small]:text-muted-foreground",
  "ddt-journey-switcher":
    'grid gap-2 my-4 [&_>_div]:flex [&_>_div]:gap-2 [&_>_div]:overflow-auto [&_>_div]:pb-1 [&_button]:border [&_button]:border-solid [&_button]:border-border [&_button]:rounded-lg [&_button]:py-2 [&_button]:px-3 [&_button]:bg-muted [&_button[aria-selected="true"]]:border-ring [&_button[aria-selected="true"]]:bg-info/10 [&_button[aria-selected="true"]]:text-info',
  "ddt-json-editor":
    "grid gap-[7px] [&_textarea]:min-h-[430px] [&_textarea]:font-mono [&_textarea]:leading-[1.55] [&_small]:text-muted-foreground",
  "ddt-kind":
    "inline-flex w-fit rounded-full py-1 px-2 bg-muted text-muted-foreground text-xs [font-style:normal] whitespace-nowrap [&.journey]:bg-info/10 [&.journey]:text-info",
  "ddt-load-more":
    "[&.ant-btn]:flex [&.ant-btn]:w-[calc(100%_-_8px)] [&.ant-btn]:mx-1 [&.ant-btn]:my-2 [&.ant-btn]:rounded-lg",
  "ddt-loaded-selection":
    "flex [flex:0_0_auto] items-center gap-2 [border-block:1px_solid_var(--border)] py-1.5 px-3 text-xs text-muted-foreground",
  "ddt-navigation-empty": "p-3",
} as const;
