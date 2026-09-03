"use client";

import type {
  DeleteStorageRuntimeAssetResult,
  StorageInventoryCategory,
  StorageInventoryItem,
  StorageInventoryPage,
  StorageInventorySummary,
} from "@autoforge/contracts";
import { Database, HardDrive, LoaderCircle, RefreshCw, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";

import { Button, Input, Select } from "@/components/ui";
import { useConfirm, useToast } from "@/components/ui-feedback";
import { LoadingState } from "@/components/loading-state";
import { StorageInventoryTree } from "@/components/storage-inventory-tree";
import { buildStorageInventoryTree } from "@/components/storage-inventory-tree-model";
import { readApiErrorMessage } from "@/lib/client-api";

const INVENTORY_READ_BATCH_SIZE = 500;
const INVENTORY_RENDER_COMMIT_SIZE = 2_000;

const CATEGORY_LABELS: Record<StorageInventoryCategory, string> = {
  database: "平台数据库",
  "execution-log": "用例日志库",
  jdk: "JDK 包",
  dependency: "依赖包",
  "case-source": "用例来源",
  "ddt-import": "DDT 导入",
  artifact: "执行产物",
  "analytics-export": "分析导出",
  configuration: "平台配置",
  temporary: "临时文件",
  other: "其他文件",
};

export function StorageInventory({
  initialCategory,
  initialQuery,
  timeZone,
  canManage,
}: {
  initialCategory?: StorageInventoryCategory;
  initialQuery: string;
  timeZone: string;
  canManage: boolean;
}) {
  const router = useRouter();
  const confirmAction = useConfirm();
  const toast = useToast();
  const [items, setItems] = useState<StorageInventoryItem[]>([]);
  const [summary, setSummary] = useState<StorageInventorySummary>();
  const [draftCategory, setDraftCategory] = useState(initialCategory ?? "");
  const [draftQuery, setDraftQuery] = useState(initialQuery);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshSequence, setRefreshSequence] = useState(0);
  const [deletingRuntimeAssetId, setDeletingRuntimeAssetId] = useState<string>();
  const handledRefreshSequence = useRef(0);

  useEffect(() => {
    const abort = new AbortController();
    const refreshSummary = refreshSequence > handledRefreshSequence.current;
    void loadCompleteInventory({
      signal: abort.signal,
      initialCategory,
      initialQuery,
      refreshSummary,
      onBatch(batch, nextSummary) {
        if (abort.signal.aborted) return;
        setItems((current) => [...current, ...batch]);
        setSummary(nextSummary);
      },
    })
      .then(() => {
        if (!abort.signal.aborted && refreshSummary) {
          handledRefreshSequence.current = refreshSequence;
        }
      })
      .catch((cause: unknown) => {
        if (abort.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : "存储清单读取失败。");
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [initialCategory, initialQuery, refreshSequence]);

  const maximumCategoryBytes = useMemo(
    () => Math.max(1, ...(summary?.categories.map((item) => item.allocatedBytes) ?? [])),
    [summary],
  );
  const tree = useMemo(
    () =>
      summary
        ? buildStorageInventoryTree(items, {
            dataDirectory: summary.dataDirectory,
            objectStoreRoot: summary.objectStoreRoot,
          })
        : [],
    [items, summary],
  );

  function applyFilters(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setLoading(true);
    setError("");
    const parameters = new URLSearchParams({ section: "storage" });
    const query = draftQuery.trim();
    if (draftCategory) parameters.set("category", draftCategory);
    if (query) parameters.set("query", query);
    router.replace(`/settings/platform?${parameters}`);
  }

  function refreshInventory(): void {
    setItems([]);
    setSummary(undefined);
    setLoading(true);
    setError("");
    setRefreshSequence((value) => value + 1);
  }

  async function deleteRuntimeAsset(item: StorageInventoryItem): Promise<void> {
    if (!item.runtimeAssetId || (item.category !== "jdk" && item.category !== "dependency")) {
      return;
    }
    const categoryLabel = CATEGORY_LABELS[item.category];
    const accepted = await confirmAction({
      title: `删除${categoryLabel}`,
      description:
        item.location === "external-reference"
          ? `确定删除“${item.name}”的外部资源登记吗？删除后无法恢复；若资源仍被项目或运行中的任务使用，平台会拒绝本次操作。`
          : `确定永久删除“${item.name}”吗？文件及资源记录删除后无法恢复；若资源仍被项目或运行中的任务使用，平台会拒绝本次操作。`,
      confirmLabel: "确认永久删除",
      cancelLabel: "取消",
      tone: "danger",
    });
    if (!accepted) return;

    setDeletingRuntimeAssetId(item.runtimeAssetId);
    setError("");
    toast.dismissAll();
    try {
      const response = await fetch("/api/v1/settings/storage", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runtimeAssetId: item.runtimeAssetId }),
      });
      const errorMessage = await readApiErrorMessage(response, `删除${categoryLabel}失败。`);
      if (errorMessage) throw new Error(errorMessage);
      const result = (await response.json()) as DeleteStorageRuntimeAssetResult;
      toast.success(
        result.sourceType === "upload"
          ? `${categoryLabel}已永久删除，释放 ${formatBytes(result.deletedBytes)}。`
          : `${categoryLabel}的外部资源登记已删除。`,
      );
      refreshInventory();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : `删除${categoryLabel}失败。`;
      setError(message);
      toast.error(message);
    } finally {
      setDeletingRuntimeAssetId(undefined);
    }
  }

  return (
    <div className="settings-stack storage-inventory" aria-busy={loading}>
      <section className="content-card settings-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Storage Overview</p>
            <h2>空间概览</h2>
            <p>统计数据目录、受管对象空间和外部运行时资源引用，不包含程序镜像与操作系统文件。</p>
          </div>
          <HardDrive size={22} aria-hidden="true" />
        </div>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        {summary ? (
          <>
            <div className="storage-summary-grid">
              <StorageMetric label="平台实际占用" value={formatBytes(summary.allocatedBytes)} />
              <StorageMetric label="内容逻辑大小" value={formatBytes(summary.logicalBytes)} />
              <StorageMetric
                label="文件与引用"
                value={`${summary.fileCount.toLocaleString()} 项`}
              />
              <StorageMetric
                label="外部引用"
                value={`${summary.externalReferenceCount.toLocaleString()} 项 · ${formatBytes(summary.externalReferenceBytes)}`}
              />
            </div>
            <div className="storage-roots">
              <span>
                <HardDrive size={15} /> 数据目录 <code>{summary.dataDirectory}</code>
              </span>
              <span>
                <Database size={15} /> 对象空间 <code>{summary.objectStoreRoot}</code>
              </span>
              <small>
                统计生成于 {formatDate(summary.generatedAt, timeZone)}；MinIO 占用为对象内容大小，
                不包含存储集群副本或纠删码开销。
              </small>
            </div>
            <div className="storage-category-grid" aria-label="文件分类占用">
              {summary.categories.map((item) => (
                <div className="storage-category-card" key={item.category}>
                  <span>
                    {CATEGORY_LABELS[item.category]} · {item.fileCount.toLocaleString()} 项
                  </span>
                  <strong>{formatBytes(item.allocatedBytes)}</strong>
                  <div className="storage-category-track" aria-hidden="true">
                    <i
                      style={{
                        width: `${Math.max(2, (item.allocatedBytes / maximumCategoryBytes) * 100)}%`,
                      }}
                    />
                  </div>
                  {item.logicalBytes !== item.allocatedBytes ? (
                    <small>逻辑大小 {formatBytes(item.logicalBytes)}</small>
                  ) : null}
                </div>
              ))}
            </div>
          </>
        ) : loading ? (
          <LoadingState
            label="正在扫描平台存储"
            description="正在统计数据库、JDK、依赖包、日志与对象存储空间。"
          />
        ) : null}
      </section>

      <section className="content-card settings-section">
        <div className="section-heading storage-list-heading">
          <div>
            <p className="eyebrow">File Inventory</p>
            <h2>文件目录</h2>
            <p>
              按存储位置和逻辑路径逐级展示；文件显示创建与修改时间，SQLite
              伴随文件合并后可展开查看。
            </p>
          </div>
          <Button disabled={loading} onClick={refreshInventory} type="button" variant="secondary">
            <RefreshCw size={15} /> 重新扫描
          </Button>
        </div>
        <form className="storage-inventory-filters" onSubmit={applyFilters}>
          <label>
            <span>文件类型</span>
            <Select
              aria-label="按文件类型筛选"
              onChange={(event) => setDraftCategory(event.target.value)}
              value={draftCategory}
            >
              <option value="">全部类型</option>
              {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </label>
          <label className="storage-query-field">
            <span>名称或路径</span>
            <Input
              aria-label="搜索文件名称或路径"
              maxLength={240}
              onChange={(event) => setDraftQuery(event.target.value)}
              placeholder="例如 autoforge.sqlite、runtime-assets、项目 ID"
              value={draftQuery}
            />
          </label>
          <Button type="submit" variant="secondary">
            <Search size={15} /> 应用筛选
          </Button>
        </form>
        {loading && summary ? (
          <div className="storage-tree-loading" role="status">
            <LoaderCircle aria-hidden="true" className="spin" size={15} />
            正在继续扫描目录，已载入 {items.length.toLocaleString()} 个文件与引用…
          </div>
        ) : null}
        {tree.length > 0 ? (
          <StorageInventoryTree
            forceOpen={
              !loading && Boolean(initialQuery) && items.length <= INVENTORY_READ_BATCH_SIZE
            }
            roots={tree}
            timeZone={timeZone}
            deletion={{
              canManage,
              deletingRuntimeAssetId,
              onDelete: (item) => void deleteRuntimeAsset(item),
            }}
          />
        ) : summary && !loading ? (
          <div className="inline-empty">当前筛选条件下没有文件或资源引用。</div>
        ) : null}
      </section>
    </div>
  );
}

function StorageMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_024 ** 2) return `${(value / 1_024).toFixed(1)} KiB`;
  if (value < 1_024 ** 3) return `${(value / 1_024 ** 2).toFixed(1)} MiB`;
  if (value < 1_024 ** 4) return `${(value / 1_024 ** 3).toFixed(2)} GiB`;
  return `${(value / 1_024 ** 4).toFixed(2)} TiB`;
}

function formatDate(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

async function loadCompleteInventory({
  signal,
  initialCategory,
  initialQuery,
  refreshSummary,
  onBatch,
}: {
  signal: AbortSignal;
  initialCategory: StorageInventoryCategory | undefined;
  initialQuery: string;
  refreshSummary: boolean;
  onBatch: (items: StorageInventoryItem[], summary: StorageInventorySummary) => void;
}): Promise<void> {
  let cursor: string | undefined;
  const visitedCursors = new Set<string>();
  let firstRequest = true;
  let bufferedItems: StorageInventoryItem[] = [];

  do {
    const parameters = new URLSearchParams({ limit: String(INVENTORY_READ_BATCH_SIZE) });
    if (cursor) parameters.set("cursor", cursor);
    if (initialCategory) parameters.set("category", initialCategory);
    if (initialQuery) parameters.set("query", initialQuery);
    if (firstRequest && refreshSummary) parameters.set("refresh", "1");

    const response = await fetch(`/api/v1/settings/storage?${parameters}`, {
      cache: "no-store",
      signal,
    });
    const body = (await response.json()) as StorageInventoryPage & {
      error?: { message?: string };
    };
    if (!response.ok) {
      throw new Error(body.error?.message ?? "存储清单读取失败。");
    }
    bufferedItems.push(...body.items);
    cursor = body.nextCursor;
    if (firstRequest || bufferedItems.length >= INVENTORY_RENDER_COMMIT_SIZE || !cursor) {
      onBatch(bufferedItems, body.summary);
      bufferedItems = [];
    }
    firstRequest = false;
    if (cursor) {
      if (visitedCursors.has(cursor)) {
        throw new Error("存储清单返回了重复游标，目录加载已停止。");
      }
      visitedCursors.add(cursor);
    }
  } while (cursor);
}
