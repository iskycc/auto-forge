"use client";

import { Alert, Dropdown, Empty, Table, Tag, Tooltip, type TableColumnsType } from "antd";
import {
  ArrowDown,
  ChevronLeft,
  ChevronRight,
  MoreHorizontal,
  RefreshCw,
  Save,
  Search,
  UserPlus,
} from "lucide-react";
import { useEffect, useState, type KeyboardEvent, type Key } from "react";
import type {
  FailureAnalysisSheetRow,
  FailureAnalysisSheetPage,
  FailureAnalysisSort,
} from "@autoforge/contracts";
import {
  analysisCategoryLabels,
  analysisSheetColumns,
  type AnalysisSheetField,
} from "@/lib/failure-analysis-fill";
import { cn } from "@/lib/utils";
import { Button, Input, Select, Textarea } from "./ui";
import { Tabs } from "./ui/tabs";
import { Dialog } from "./ui/dialog";
import { useFailureAnalysisSheet } from "./use-failure-analysis-sheet";
import { AttemptLogViewer } from "./attempt-log-viewer";
import { AnalysisSheetProofDialog } from "./analysis-sheet-proof-dialog";
import { SheetButton } from "./ui/sheet-button";

type SheetCell = { row: number; field: AnalysisSheetField };
type FillRange = SheetCell & { target: number };

export function FailureAnalysisSheet({
  endpoint,
  currentUserId,
  canManage,
  onCompleted,
  onClaimed,
  initialPage,
  onDirtyChange,
  stickyHeaderOffset = 0,
}: {
  endpoint: string;
  currentUserId: string | null;
  canManage: boolean;
  onCompleted?: (count: number) => void;
  onClaimed?: (count: number) => void;
  initialPage?: FailureAnalysisSheetPage | undefined;
  onDirtyChange?: (dirty: boolean) => void;
  stickyHeaderOffset?: number;
}) {
  const sheet = useFailureAnalysisSheet({
    endpoint,
    currentUserId,
    canManage,
    onCompleted,
    onClaimed,
    initialPage,
  });
  const [queryInput, setQueryInput] = useState(sheet.query.query ?? "");
  const [active, setActive] = useState<SheetCell>();
  const [fill, setFill] = useState<FillRange>();
  const [detail, setDetail] = useState<FailureAnalysisSheetRow>();
  const [log, setLog] = useState<FailureAnalysisSheetRow>();
  const [proofId, setProofId] = useState<string>();
  const proof = sheet.rows.find((row) => row.analysis?.id === proofId);
  const detailDraft = detail ? sheet.drafts[detail.executionRunId] : undefined;
  useEffect(() => {
    onDirtyChange?.(sheet.dirty);
  }, [onDirtyChange, sheet.dirty]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setActive(undefined);
      setFill(undefined);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [sheet.query]);
  useEffect(() => {
    const cancel = () => setFill(undefined);
    window.addEventListener("dragend", cancel);
    return () => window.removeEventListener("dragend", cancel);
  }, []);
  function fillToPageEnd() {
    if (!active) return;
    const end = sheet.rows.length - 1;
    if (end > active.row) sheet.fill(active.row, end, active.field);
  }
  function handleFillKey(event: KeyboardEvent<HTMLButtonElement>, cell: SheetCell) {
    if (event.key === "Escape") {
      setFill(undefined);
      event.preventDefault();
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setFill({ ...cell, target: Math.min(sheet.rows.length - 1, (fill?.target ?? cell.row) + 1) });
    }
    if (event.key === "ArrowUp" && fill) {
      event.preventDefault();
      setFill({ ...fill, target: Math.max(cell.row, fill.target - 1) });
    }
    if (event.key === "Enter" && fill) {
      event.preventDefault();
      sheet.fill(fill.row, fill.target, fill.field);
      setFill(undefined);
    }
  }
  function cell(
    row: FailureAnalysisSheetRow,
    index: number,
    field: AnalysisSheetField,
    label: string,
  ) {
    const editable = sheet.editable.has(row.executionRunId) && !sheet.busy && !sheet.loading;
    const current = sheet.drafts[row.executionRunId];
    const value = current?.[field] ?? "";
    const selected = active?.row === index && active.field === field && editable;
    const filling = fill?.field === field && index > fill.row && index <= fill.target;
    return (
      <div
        data-sheet-cell={`${index}:${field}`}
        className={cn(
          "relative flex h-12 min-w-0 items-center rounded-sm border border-transparent px-1",
          selected && "border-primary bg-primary/5",
          filling && "border-primary bg-primary/10",
          !editable && "text-muted-foreground",
        )}
        onDragOver={(event) => {
          if (fill?.field === field && index >= fill.row) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            setFill({ ...fill, target: index });
          }
        }}
        onDrop={(event) => {
          if (fill?.field === field) {
            event.preventDefault();
            sheet.fill(fill.row, index, field);
            setFill(undefined);
          }
        }}
      >
        {selected ? (
          field === "category" ? (
            <Select
              aria-label={`${label}：${row.caseName}`}
              value={value}
              onChange={(event) => sheet.edit(row.executionRunId, field, event.target.value)}
            >
              <option value="">选择类别</option>
              {Object.entries(analysisCategoryLabels).map(([key, text]) => (
                <option key={key} value={key}>
                  {text}
                </option>
              ))}
            </Select>
          ) : (
            <Textarea
              aria-label={`${label}：${row.caseName}`}
              className="!min-h-8 !h-9 resize-none text-sm"
              rows={1}
              maxLength={field === "ticketReference" ? 1000 : 4000}
              value={value}
              onChange={(event) => sheet.edit(row.executionRunId, field, event.target.value)}
            />
          )
        ) : (
          <SheetButton
            type="button"
            className="flex h-full w-full min-w-0 items-center border-0 bg-transparent p-1 text-left text-sm text-inherit outline-offset-2"
            aria-label={`${editable ? "编辑" : "查看"}${label}：${row.caseName}`}
            onClick={() => (editable ? setActive({ row: index, field }) : setDetail(row))}
          >
            <span className="line-clamp-2 break-all">
              {field === "category" && value
                ? analysisCategoryLabels[value as keyof typeof analysisCategoryLabels]
                : value || (editable ? "点击填写" : "—")}
            </span>
          </SheetButton>
        )}
        {selected ? (
          <SheetButton
            type="button"
            draggable
            aria-label={`向下填充${label}`}
            title="向下拖拽复制此列；键盘方向键选择范围，Enter 填充，Esc 取消"
            className="relative ml-1 h-8 w-8 shrink-0 cursor-crosshair self-end rounded-sm border-0 bg-transparent p-0 focus-visible:outline-2 focus-visible:outline-primary"
            disabled={sheet.busy}
            onDragStart={(event) => {
              event.dataTransfer.setData("text/plain", "autoforge-analysis-fill");
              event.dataTransfer.effectAllowed = "copy";
              setFill({ row: index, field, target: index });
            }}
            onKeyDown={(event) => handleFillKey(event, { row: index, field })}
          >
            <span
              aria-hidden
              className="absolute bottom-0 right-0 h-3 w-3 border border-solid border-card bg-primary"
            />
          </SheetButton>
        ) : null}
      </div>
    );
  }
  const columns: TableColumnsType<FailureAnalysisSheetRow> = [
    {
      title: "用例 / 类路径",
      key: "case",
      width: 220,
      fixed: "left",
      render: (_, row) => (
        <div className="grid min-w-0 gap-1">
          <SheetButton
            type="button"
            className="min-h-8 w-full truncate border-0 bg-transparent p-0 text-left font-semibold text-foreground [&>span]:truncate"
            style={{ whiteSpace: "nowrap" }}
            title={row.caseName}
            onClick={() => setDetail(row)}
          >
            {row.caseName}
          </SheetButton>
          <span className="truncate text-xs text-muted-foreground" title={row.className}>
            {row.className}
          </span>
        </div>
      ),
    },
    {
      title: "状态",
      key: "status",
      width: 96,
      render: (_, row) => (
        <Tag
          className="m-0"
          color={
            row.analysis?.status === "completed"
              ? "success"
              : row.analysis
                ? "processing"
                : "default"
          }
        >
          {row.analysis?.status === "completed" ? "已完成" : row.analysis ? "已认领" : "待认领"}
        </Tag>
      ),
    },
    {
      title: "认领人",
      key: "owner",
      width: 96,
      ellipsis: true,
      render: (_, row) => row.analysis?.claimantDisplayName ?? "—",
    },
    ...analysisSheetColumns.map((column) => ({
      title: column.label,
      key: column.field,
      width: column.width,
      render: (_: unknown, row: FailureAnalysisSheetRow, index: number) =>
        cell(row, index, column.field, column.label),
    })),
    {
      title: "操作",
      key: "actions",
      width: 112,
      fixed: "right",
      render: (_, row) => (
        <div className="flex items-center gap-1">
          <Button type="button" variant="secondary" className="px-2" onClick={() => setLog(row)}>
            日志
          </Button>
          <Dropdown
            menu={{
              items: [
                { key: "details", label: "查看完整内容" },
                ...(row.analysis ? [{ key: "proof", label: "查看 / 补充证明" }] : []),
                ...(sheet.editable.has(row.executionRunId)
                  ? [{ key: "release", label: "取消认领", danger: true }]
                  : []),
              ],
              onClick: ({ key }) => {
                if (key === "proof") setProofId(row.analysis?.id);
                else if (key === "release") void sheet.release(row);
                else setDetail(row);
              },
            }}
            trigger={["click"]}
          >
            <Button
              type="button"
              variant="ghost"
              className="px-1"
              aria-label={`更多操作：${row.caseName}`}
              disabled={sheet.busy}
            >
              <MoreHorizontal size={16} />
            </Button>
          </Dropdown>
        </div>
      ),
    },
  ];
  const scrollWidth = columns.reduce(
    (width, column) => width + (typeof column.width === "number" ? column.width : 0),
    canManage ? 44 : 0,
  );
  return (
    <section
      aria-label="分析表格"
      className="grid min-w-0 gap-4 rounded-xl border border-solid border-border bg-card p-4 shadow-xs"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="m-0 text-base font-semibold">分析工作表</h2>
          <p className="mb-0 mt-1 text-xs text-muted-foreground">
            {canManage
              ? "先认领，再点击单元格填写；拖拽右下角填充柄向下复制同列内容。"
              : "只读浏览分析结论、失败摘要及证明材料。"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Tag className="m-0">本页 {sheet.rows.length} 条</Tag>
          {sheet.dirtyIds.size ? (
            <Tag color="warning" className="m-0">
              {sheet.dirtyIds.size} 行草稿
            </Tag>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            onClick={() => void sheet.refresh()}
            disabled={sheet.busy || sheet.loading}
          >
            <RefreshCw size={14} />
            刷新
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-y border-solid border-border py-3">
        <Tabs
          label="分析表格范围"
          value={sheet.query.view}
          items={[
            { key: "all", label: "全部用例" },
            { key: "mine", label: "我的认领", disabled: !currentUserId },
          ]}
          onChange={(view) => void sheet.changeQuery({ view })}
        />
        <form
          className="flex min-w-0 flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void sheet.changeQuery({ query: queryInput.trim() });
          }}
        >
          <div className="w-36">
            <Select
              aria-label="分析表格排序"
              value={sheet.query.sort}
              disabled={sheet.busy || sheet.loading}
              onChange={(event) =>
                void sheet.changeQuery({ sort: event.target.value as FailureAnalysisSort })
              }
            >
              <option value="class_path">按类路径</option>
              <option value="case_name">按用例名称</option>
              <option value="failure_summary">按失败摘要</option>
              <option value="claim_status">按认领状态</option>
            </Select>
          </div>
          <Button
            type="button"
            variant="secondary"
            disabled={sheet.busy || sheet.loading}
            onClick={() =>
              void sheet.changeQuery({
                direction: sheet.query.direction === "asc" ? "desc" : "asc",
              })
            }
          >
            {sheet.query.direction === "asc" ? "升序" : "降序"}
          </Button>
          <div className="w-64 max-w-full">
            <Input
              aria-label="搜索分析表格"
              maxLength={240}
              placeholder="用例、类路径或失败摘要"
              value={queryInput}
              onChange={(event) => setQueryInput(event.target.value)}
            />
          </div>
          <Button type="submit" variant="secondary" disabled={sheet.busy || sheet.loading}>
            <Search size={14} />
            搜索
          </Button>
        </form>
      </div>
      {sheet.error ? <Alert showIcon type="error" title={sheet.error} /> : null}
      {canManage ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={
                sheet.busy ||
                sheet.loading ||
                !sheet.rows.some(
                  (row) => sheet.selectedIds.includes(row.executionRunId) && !row.analysis,
                )
              }
              onClick={() => void sheet.claimSelected()}
            >
              <UserPlus size={15} />
              认领所选
            </Button>
            <Tooltip title="将当前单元格复制到本页下方本人的未完成记录，其他记录自动跳过">
              <Button
                type="button"
                variant="secondary"
                disabled={
                  !active ||
                  sheet.busy ||
                  !sheet.editable.has(sheet.rows[active.row]?.executionRunId ?? "") ||
                  active.row >= sheet.rows.length - 1
                }
                onClick={fillToPageEnd}
              >
                <ArrowDown size={15} />
                填充至本页末行
              </Button>
            </Tooltip>
            <Button
              type="button"
              variant="secondary"
              disabled={sheet.busy || !sheet.canUndoFill}
              onClick={sheet.undoFill}
            >
              撤销填充
            </Button>
            <span className="text-xs text-muted-foreground">填充只改草稿，证明材料逐例校验</span>
          </div>
          <Button
            type="button"
            variant="primary"
            aria-label="提交草稿"
            aria-busy={sheet.busy}
            disabled={sheet.busy || !sheet.dirtyIds.size}
            loading={sheet.busy}
            onClick={() => void sheet.save()}
          >
            <Save size={15} />
            {sheet.progress ? `提交中 ${sheet.progress.done}/${sheet.progress.total}` : "提交草稿"}
          </Button>
        </div>
      ) : null}
      <div className="min-w-0 overflow-clip rounded-lg border border-solid border-border">
        <Table<FailureAnalysisSheetRow>
          aria-label="用例分析工作表"
          rowKey="executionRunId"
          columns={columns}
          dataSource={sheet.rows}
          pagination={false}
          size="small"
          bordered
          tableLayout="fixed"
          scroll={{ x: scrollWidth }}
          sticky={{ offsetHeader: stickyHeaderOffset, offsetScroll: 0 }}
          loading={sheet.loading}
          rowClassName={(row) =>
            cn(
              "h-[68px]",
              sheet.dirtyIds.has(row.executionRunId) && "bg-warning/5",
              sheet.errors[row.executionRunId] && "bg-destructive/5",
            )
          }
          expandable={{
            expandedRowKeys: Object.keys(sheet.errors),
            expandedRowRender: (row) => (
              <Alert type="error" showIcon title={sheet.errors[row.executionRunId]} />
            ),
            showExpandColumn: false,
          }}
          {...(canManage
            ? {
                rowSelection: {
                  selectedRowKeys: sheet.selectedIds,
                  columnWidth: 44,
                  fixed: true as const,
                  onChange: (keys: Key[]) => sheet.setSelectedIds(keys.map(String)),
                  getCheckboxProps: (row: FailureAnalysisSheetRow) => ({
                    disabled:
                      sheet.busy ||
                      (Boolean(row.analysis) && !sheet.editable.has(row.executionRunId)),
                    "aria-label": `选择用例：${row.caseName}`,
                  }),
                },
              }
            : {})}
          locale={{
            emptyText: (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前范围没有用例" />
            ),
          }}
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>
          每页最多 50 条 · 第 {sheet.pageNumber} 页
          {fill
            ? ` · 待填充 ${Math.max(0, fill.target - fill.row)} 行，释放鼠标或按 Enter 确认`
            : ""}
        </span>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="secondary"
            disabled={sheet.busy || sheet.loading || sheet.pageNumber === 1}
            onClick={() => void sheet.movePage(false)}
          >
            <ChevronLeft size={14} />
            上一页
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={sheet.busy || sheet.loading || !sheet.nextCursor}
            onClick={() => void sheet.movePage(true)}
          >
            下一页
            <ChevronRight size={14} />
          </Button>
        </div>
      </div>
      {detail ? (
        <Dialog
          open
          title="用例分析完整内容"
          onClose={() => setDetail(undefined)}
          className="w-[min(880px,calc(100vw-48px))]"
        >
          <div className="grid max-h-[85vh] min-w-0 gap-4 overflow-auto p-6">
            <div className="flex items-center justify-between gap-3">
              <h2 className="m-0 text-lg font-semibold">用例分析完整内容</h2>
              <Button type="button" variant="secondary" onClick={() => setDetail(undefined)}>
                关闭
              </Button>
            </div>
            <strong className="break-all">{detail.caseName}</strong>
            {sheet.dirtyIds.has(detail.executionRunId) ? (
              <Tag color="warning" className="m-0 w-fit">
                当前未提交草稿
              </Tag>
            ) : null}
            <code className="break-all text-sm">{detail.className}</code>
            <div>
              <h3 className="text-sm font-semibold">失败摘要</h3>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 text-xs">
                {detail.failureSummary}
              </pre>
            </div>
            {analysisSheetColumns.map((column) => (
              <div key={column.field}>
                <h3 className="mb-1 text-sm font-semibold">{column.label}</h3>
                <p className="m-0 whitespace-pre-wrap break-all text-sm">
                  {column.field === "category"
                    ? detailDraft?.category
                      ? analysisCategoryLabels[detailDraft.category]
                      : "—"
                    : detailDraft?.[column.field] || "—"}
                </p>
              </div>
            ))}
          </div>
        </Dialog>
      ) : null}
      {log ? (
        <AttemptLogViewer
          attemptId={log.attemptId}
          attemptStatus="failed"
          canReadLogs
          canRetryRuns={false}
          onClose={() => setLog(undefined)}
          logEndpoint={`${endpoint}/logs?${new URLSearchParams({ executionRunId: log.executionRunId })}`}
        />
      ) : null}
      {proof?.analysis ? (
        <AnalysisSheetProofDialog
          claim={proof.analysis}
          endpoint={endpoint}
          editable={sheet.editable.has(proof.executionRunId)}
          onUpdated={sheet.updateClaim}
          onClose={() => setProofId(undefined)}
        />
      ) : null}
    </section>
  );
}
