"use client";

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
  ChevronLeft,
  ChevronRight,
  Copy,
  FileSpreadsheet,
  History,
  PanelLeftClose,
  PanelLeftOpen,
  PencilLine,
} from "lucide-react";
import { useRef, useState, type CSSProperties, type ReactNode } from "react";

import { Button, Input, Select, Textarea } from "@/components/ui";
import { useToast } from "@/components/ui-feedback";
import { useConcurrentModificationFeedback } from "@/components/concurrent-modification-feedback";
import { formatPlatformDateTime } from "@/lib/platform-date-time";

export type DdtHistoryItem = {
  id: string;
  changeType: string;
  sourceName: string;
  changes: Array<{ field: string }>;
  createdAt: string;
};
export type DdtEditorStatus = "idle" | "editing" | "saving";

const DEFAULT_LIST_WIDTH = 280;
const MINIMUM_LIST_WIDTH = 200;
const MAXIMUM_LIST_WIDTH = 440;

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
  onSelect(caseId: string): void;
  onSelectAll(checked: boolean): void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [listWidth, setListWidth] = useState(DEFAULT_LIST_WIDTH);
  const dragStart = useRef<{ x: number; width: number } | null>(null);
  const changeWidth = (width: number) =>
    setListWidth(Math.max(MINIMUM_LIST_WIDTH, Math.min(MAXIMUM_LIST_WIDTH, width)));
  return (
    <div
      className={`ddt-case-browser${collapsed ? " is-collapsed" : ""}`}
      style={{ "--ddt-case-list-width": `${listWidth}px` } as CSSProperties}
    >
      <section className="ddt-case-navigation" aria-label="DDT 用例导航">
        <header>
          {!collapsed ? (
            <div>
              <strong>用例库</strong>
              <small>
                {cases.length} 条已加载{selected.size ? ` · 已选 ${selected.size} 条` : ""}
              </small>
            </div>
          ) : null}
          <Button
            type="button"
            className="icon-button"
            aria-label={collapsed ? "展开 CaseID 列表" : "收起 CaseID 列表"}
            title={collapsed ? "展开 CaseID 列表" : "收起 CaseID 列表"}
            onClick={() => setCollapsed(!collapsed)}
          >
            {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
          </Button>
        </header>
        <div className="ddt-case-navigation-content" hidden={collapsed}>
          <fieldset className="ddt-case-filters" disabled={savingCase}>
            {filters}
          </fieldset>
          <label className="ddt-loaded-selection">
            <Input
              type="checkbox"
              aria-label="选择已加载的全部 DDT 用例"
              disabled={savingCase}
              checked={cases.length > 0 && cases.every((item) => selected.has(item.caseId))}
              onChange={(event) => onSelectAll(event.target.checked)}
            />
            选择已加载用例
          </label>
          <div
            className="ddt-case-list"
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
                className={`ddt-case-list-row${activeCaseId === item.caseId ? " active" : ""}`}
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
                  className="ddt-case-list-item"
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
              </div>
            ))}
            {refreshing && !cases.length ? (
              <div className="ddt-navigation-empty" role="status">
                正在加载用例…
              </div>
            ) : !cases.length ? (
              <div className="ddt-navigation-empty">
                没有符合条件的用例，试试调整筛选条件或导入表格。
              </div>
            ) : null}
            {hasMore ? (
              <Button
                type="button"
                className="text-button ddt-load-more"
                disabled={loadingMore}
                onClick={onLoadMore}
              >
                {loadingMore ? "正在加载…" : "加载更多"}
              </Button>
            ) : null}
          </div>
          <small className="ddt-navigation-hint">↑ / ↓ 或 J / K 切换用例</small>
        </div>
      </section>
      {!collapsed ? (
        <div
          className="ddt-case-resizer"
          role="separator"
          aria-label="调整 CaseID 列表宽度"
          aria-orientation="vertical"
          aria-valuemin={MINIMUM_LIST_WIDTH}
          aria-valuemax={MAXIMUM_LIST_WIDTH}
          aria-valuenow={listWidth}
          tabIndex={0}
          onDoubleClick={() => setListWidth(DEFAULT_LIST_WIDTH)}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
            event.preventDefault();
            changeWidth(
              event.key === "Home"
                ? DEFAULT_LIST_WIDTH
                : listWidth + (event.key === "ArrowLeft" ? -20 : 20),
            );
          }}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            dragStart.current = {
              x: event.clientX,
              width: event.currentTarget.previousElementSibling!.getBoundingClientRect().width,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (dragStart.current)
              changeWidth(dragStart.current.width + event.clientX - dragStart.current.x);
          }}
          onPointerUp={(event) => {
            dragStart.current = null;
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onLostPointerCapture={() => {
            dragStart.current = null;
          }}
        />
      ) : null}
      <section className="ddt-case-detail-panel" aria-label="DDT 用例详情">
        {selected.size ? (
          <div className="ddt-bulk-workspace">
            <header>
              <FileSpreadsheet size={24} />
              <div>
                <h2>已选择 {selected.size} 条用例</h2>
                <p>在左侧继续选择，在这里统一管理所选用例。</p>
              </div>
            </header>
            {selectionActions}
          </div>
        ) : (
          children
        )}
      </section>
    </div>
  );
}

export function DdtCaseDetail({
  item,
  history,
  canManage,
  onSave,
  onRestore,
  onStatusChange,
  onPrevious,
  onNext,
}: {
  item: DdtCase;
  history: DdtHistoryItem[];
  canManage: boolean;
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
      <header className="ddt-detail-toolbar">
        <span>
          用例详情 <ChevronRight size={14} /> <strong title={item.caseId}>{item.caseId}</strong>
        </span>
        <div>
          <Button
            type="button"
            className="icon-button"
            aria-label="上一条用例"
            title="上一条用例"
            disabled={!onPrevious || saving}
            onClick={onPrevious}
          >
            <ChevronLeft size={17} />
          </Button>
          <Button
            type="button"
            className="icon-button"
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
              className="button button-secondary"
              disabled={Boolean(editor) || saving}
              onClick={() => beginEditing()}
            >
              <PencilLine size={15} /> 编辑动态字段
            </Button>
          ) : null}
        </div>
      </header>
      <div className="ddt-case-detail-scroll">
        <div className="ddt-detail-title">
          <FileSpreadsheet size={26} />
          <div>
            <h2>{item.caseId}</h2>
            <p>来自 {item.sourceName || "人工维护"}</p>
          </div>
          <span className={`ddt-kind ${item.kind}`}>
            {item.kind === "journey" ? "用户旅程" : "普通用例"}
          </span>
        </div>
        <dl className="ddt-detail-summary">
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
        <section className="ddt-execution-class-summary" aria-label="DDT 执行类">
          <span>执行类 · 继承自 SR {item.srNum}</span>
          <strong>{item.executionClass?.displayName ?? "尚未设置执行类"}</strong>
          <small>
            {item.executionClass?.className ??
              "请在“SR 测试类关联”页面配置当前 SR 的测试类；本 SR 下所有用例自动继承。"}
          </small>
        </section>
        {steps ? (
          <div className="ddt-journey-switcher">
            <strong>用户旅程步骤</strong>
            <div role="tablist" aria-label="用户旅程步骤">
              {stepNames.map((step) => (
                <Button
                  key={step}
                  type="button"
                  role="tab"
                  aria-selected={step === resolvedStep}
                  disabled={Boolean(editor) || saving}
                  onClick={() => setActiveStep(step)}
                >
                  {step}
                </Button>
              ))}
            </div>
          </div>
        ) : null}
        <header className="ddt-fields-heading">
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
          <label className="ddt-json-editor">
            <span>用例数据 JSON</span>
            <Textarea
              value={editor.text}
              disabled={saving}
              onChange={(event) => setEditor({ ...editor, text: event.target.value })}
              spellCheck={false}
            />
          </label>
        ) : (
          <div className="ddt-field-cards">
            {fields.map(([field, value]) => (
              <article className="ddt-field-card" key={field}>
                <header>
                  <strong>{field}</strong>
                  <div>
                    <Button
                      type="button"
                      className="icon-button"
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
                        className="icon-button"
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
                  <div className="ddt-field-editor">
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
          <div className="inline-notice error" role="alert">
            {error}
          </div>
        ) : null}
        {editor ? (
          <footer className="ddt-detail-save">
            <span>请先保存或取消编辑后切换旅程步骤。</span>
            <Button
              type="button"
              className="button button-secondary"
              disabled={saving}
              onClick={finishEditing}
            >
              取消
            </Button>
            <Button
              type="button"
              className="button button-primary"
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? "正在保存…" : "保存修改"}
            </Button>
          </footer>
        ) : null}
        <details className="ddt-history" open>
          <summary>
            <History size={16} /> 修改历史 <small>{history.length} 条已加载</small>
          </summary>
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
                    className="text-button"
                    disabled={Boolean(editor) || saving}
                    onClick={() => void apply(() => onRestore(entry.id))}
                  >
                    恢复此版本
                  </Button>
                ) : null}
              </article>
            ))
          ) : (
            <p>暂无修改历史</p>
          )}
        </details>
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
