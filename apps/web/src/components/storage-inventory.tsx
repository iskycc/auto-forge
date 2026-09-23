"use client";
import { Notice } from "@/components/ui/notice";

import { Disclosure } from "@/components/ui/disclosure";

import { Card } from "@/components/ui/card";

import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import { storageInventoryPageSchema } from "@autoforge/contracts";
import {
  browserCacheEpoch,
  clearBrowserSnapshots,
  readBrowserSnapshot,
  writeBrowserSnapshot,
} from "@/lib/browser-read-cache";

import type {
  DeleteStorageRuntimeAssetResult,
  DeleteStorageRuntimeAssetsResult,
  StorageInventoryCategory,
  StorageInventoryItem,
  StorageInventoryPage,
  StorageInventorySummary,
} from "@autoforge/contracts";
import { Database, HardDrive, LoaderCircle, RefreshCw, Search, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { Button, Input, Select } from "@/components/ui";
import { useConfirm, useToast } from "@/components/ui-feedback";
import { LoadingState } from "@/components/loading-state";
import { removeRuntimeAssetsFromInventory } from "@/components/storage-inventory-deletion";
import { StorageInventoryTree } from "@/components/storage-inventory-tree";
import { buildStorageInventoryTree } from "@/components/storage-inventory-tree-model";
import { ApiClientError, readApiError, readApiErrorMessage } from "@/lib/client-api";

const INVENTORY_READ_BATCH_SIZE = 500;
const RUNTIME_ASSET_DELETE_BATCH_SIZE = 100;
const MAX_SNAPSHOT_RESTARTS = 2;

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
  const [snapshotState, setSnapshotState] =
    useState<StorageInventoryPage["snapshotState"]>("pending");
  const [refreshSequence, setRefreshSequence] = useState(0);
  const [selectedRuntimeAssetIds, setSelectedRuntimeAssetIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [pendingRuntimeAssetIds, setPendingRuntimeAssetIds] = useState<Set<string>>(
    () => new Set(),
  );
  const handledRefreshSequence = useRef(0);
  const removedRuntimeAssets = useRef(new Set<string>());
  const inventoryAbort = useRef<AbortController | undefined>(undefined);
  const deletionScrollPosition = useRef<number | undefined>(undefined);

  useLayoutEffect(() => {
    const scrollTop = deletionScrollPosition.current;
    if (scrollTop === undefined) return;
    deletionScrollPosition.current = undefined;
    window.scrollTo({ top: scrollTop, behavior: "auto" });
  }, [items]);

  useEffect(() => {
    const abort = new AbortController();
    inventoryAbort.current = abort;
    const refreshSummary = refreshSequence > handledRefreshSequence.current;
    void loadCompleteInventory({
      signal: abort.signal,
      initialCategory,
      initialQuery,
      refreshSummary,
      onState: setSnapshotState,
      onBatch(batch, nextSummary) {
        if (abort.signal.aborted) return;
        const visible = removeRuntimeAssetsFromInventory(
          batch,
          nextSummary,
          removedRuntimeAssets.current,
        );
        setItems(visible.items);
        setSummary(visible.summary);
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
  const selectableRuntimeAssets = useMemo(() => {
    const uniqueAssets = new Map<string, StorageInventoryItem>();
    if (!canManage) return [];
    for (const item of items) {
      if (
        item.runtimeAssetId &&
        (item.category === "jdk" || item.category === "dependency") &&
        !uniqueAssets.has(item.runtimeAssetId)
      ) {
        uniqueAssets.set(item.runtimeAssetId, item);
      }
    }
    return [...uniqueAssets.values()];
  }, [canManage, items]);
  const allRuntimeAssetsSelected =
    selectableRuntimeAssets.length > 0 &&
    selectableRuntimeAssets.every((item) => selectedRuntimeAssetIds.has(item.runtimeAssetId!));

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
    setSelectedRuntimeAssetIds(new Set());
    clearBrowserSnapshots();
    setLoading(true);
    setError("");
    setRefreshSequence((value) => value + 1);
  }

  async function deleteRuntimeAsset(item: StorageInventoryItem): Promise<void> {
    if (!item.runtimeAssetId || (item.category !== "jdk" && item.category !== "dependency")) {
      return;
    }
    const categoryLabel = CATEGORY_LABELS[item.category];
    deletionScrollPosition.current = window.scrollY;
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
    if (!accepted) {
      deletionScrollPosition.current = undefined;
      return;
    }

    setPendingRuntimeAssetIds(new Set([item.runtimeAssetId]));
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
      applyDeletedRuntimeAssets(new Set([result.runtimeAssetId]));
    } catch (cause) {
      deletionScrollPosition.current = undefined;
      const message = cause instanceof Error ? cause.message : `删除${categoryLabel}失败。`;
      setError(message);
      toast.error(message);
    } finally {
      setPendingRuntimeAssetIds(new Set());
    }
  }

  async function deleteSelectedRuntimeAssets(): Promise<void> {
    const runtimeAssetIds = [...selectedRuntimeAssetIds];
    if (runtimeAssetIds.length === 0) return;
    deletionScrollPosition.current = window.scrollY;
    const accepted = await confirmAction({
      title: "批量删除存储资源",
      description: `确定永久删除已选择的 ${runtimeAssetIds.length} 项 JDK 包或依赖包吗？平台会逐项校验引用关系；无法删除的资源会保留并显示原因。该操作无法恢复。`,
      confirmLabel: `永久删除 ${runtimeAssetIds.length} 项`,
      cancelLabel: "取消",
      tone: "danger",
    });
    if (!accepted) {
      deletionScrollPosition.current = undefined;
      return;
    }

    setPendingRuntimeAssetIds(new Set(runtimeAssetIds));
    setError("");
    toast.dismissAll();
    const deleted: DeleteStorageRuntimeAssetResult[] = [];
    const failures: DeleteStorageRuntimeAssetsResult["failures"] = [];
    try {
      for (
        let offset = 0;
        offset < runtimeAssetIds.length;
        offset += RUNTIME_ASSET_DELETE_BATCH_SIZE
      ) {
        const currentBatch = runtimeAssetIds.slice(
          offset,
          offset + RUNTIME_ASSET_DELETE_BATCH_SIZE,
        );
        const response = await fetch("/api/v1/settings/storage", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ runtimeAssetIds: currentBatch }),
        });
        const errorMessage = await readApiErrorMessage(response, "批量删除存储资源失败。");
        if (errorMessage) throw new Error(errorMessage);
        const result = (await response.json()) as DeleteStorageRuntimeAssetsResult;
        deleted.push(...result.deleted);
        failures.push(...result.failures);
      }
      const deletedIds = new Set(deleted.map((item) => item.runtimeAssetId));
      applyDeletedRuntimeAssets(deletedIds);
      if (deletedIds.size === 0) deletionScrollPosition.current = undefined;

      if (failures.length > 0) {
        const firstFailure = failures[0];
        const message = `已删除 ${deleted.length} 项，${failures.length} 项未删除${firstFailure ? `：${firstFailure.message}` : "。"}`;
        setError(message);
        toast.warning(message, { durationMs: 7_000 });
      } else {
        const deletedBytes = deleted.reduce((total, item) => total + item.deletedBytes, 0);
        toast.success(
          deletedBytes > 0
            ? `已永久删除 ${deleted.length} 项，释放 ${formatBytes(deletedBytes)}。`
            : `已删除 ${deleted.length} 项外部资源登记。`,
        );
      }
    } catch (cause) {
      applyDeletedRuntimeAssets(new Set(deleted.map((item) => item.runtimeAssetId)));
      if (deleted.length === 0) deletionScrollPosition.current = undefined;
      const reason = cause instanceof Error ? cause.message : "批量删除存储资源失败。";
      const message =
        deleted.length > 0 ? `已删除 ${deleted.length} 项，后续请求中断：${reason}` : reason;
      setError(message);
      toast.error(message);
    } finally {
      setPendingRuntimeAssetIds(new Set());
    }
  }

  function applyDeletedRuntimeAssets(runtimeAssetIds: ReadonlySet<string>): void {
    clearBrowserSnapshots();
    inventoryAbort.current?.abort();
    if (runtimeAssetIds.size === 0 || !summary) return;
    for (const id of runtimeAssetIds) removedRuntimeAssets.current.add(id);
    // Removing an expanded file can shorten the document before the browser restores focus,
    // which previously made the whole settings page jump to the top. Keep the viewport and let
    // keyed tree branches retain their own expanded state while applying the local patch.
    deletionScrollPosition.current ??= window.scrollY;
    const patched = removeRuntimeAssetsFromInventory(items, summary, runtimeAssetIds);
    setItems(patched.items);
    setSummary(patched.summary);
    setSelectedRuntimeAssetIds((current) => {
      const next = new Set(current);
      for (const runtimeAssetId of runtimeAssetIds) next.delete(runtimeAssetId);
      return next;
    });
  }

  function updateRuntimeAssetSelection(runtimeAssetId: string, selected: boolean): void {
    setSelectedRuntimeAssetIds((current) => {
      const next = new Set(current);
      if (selected) next.add(runtimeAssetId);
      else next.delete(runtimeAssetId);
      return next;
    });
  }

  function toggleAllRuntimeAssets(selected: boolean): void {
    setSelectedRuntimeAssetIds(
      selected ? new Set(selectableRuntimeAssets.map((item) => item.runtimeAssetId!)) : new Set(),
    );
  }

  return (
    <div
      className={cn(
        "settings-stack storage-inventory",
        uiPatterns["settings-stack"],
        storageInventoryStyles["storage-inventory"],
      )}
      aria-busy={loading}
    >
      <Card
        as="section"
        className={cn(
          "content-card settings-section",
          uiPatterns["content-card"],
          uiPatterns["settings-section"],
        )}
      >
        <div className={cn("section-heading", uiPatterns["section-heading"])}>
          <div>
            <p className={cn("eyebrow", uiPatterns["eyebrow"])}>Storage Overview</p>
            <h2>空间概览</h2>
            <p>统计数据目录、受管对象空间和外部运行时资源引用，不包含程序镜像与操作系统文件。</p>
          </div>
          <HardDrive size={22} aria-hidden="true" />
        </div>
        {error ? (
          <Notice tone="error" className={cn("form-error", uiPatterns["form-error"])} role="alert">
            {error}
          </Notice>
        ) : null}
        <p role="status">
          {snapshotState === "pending"
            ? "后台正在扫描存储清单，扫描结果会自动显示。"
            : snapshotState === "stale"
              ? "后台扫描中，当前显示上次完成的清单。"
              : snapshotState === "failed"
                ? "后台扫描失败，保留上次清单，请重新扫描。"
                : ""}
        </p>
        {summary ? (
          <>
            <div
              className={cn("storage-summary-grid", storageInventoryStyles["storage-summary-grid"])}
            >
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
            <Disclosure
              header={<>存储路径与统计口径 · {formatDate(summary.generatedAt, timeZone)}</>}
              className={cn(
                "management-disclosure",
                storageInventoryStyles["management-disclosure"],
              )}
            >
              <div className={cn("storage-roots", storageInventoryStyles["storage-roots"])}>
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
            </Disclosure>
            <div
              className={cn(
                "storage-category-grid",
                storageInventoryStyles["storage-category-grid"],
              )}
              aria-label="文件分类占用"
            >
              {summary.categories.map((item) => (
                <div
                  className={cn(
                    "storage-category-card",
                    storageInventoryStyles["storage-category-card"],
                  )}
                  key={item.category}
                >
                  <span>
                    {CATEGORY_LABELS[item.category]} · {item.fileCount.toLocaleString()} 项
                  </span>
                  <strong>{formatBytes(item.allocatedBytes)}</strong>
                  <div
                    className={cn(
                      "storage-category-track",
                      storageInventoryStyles["storage-category-track"],
                    )}
                    aria-hidden="true"
                  >
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
      </Card>

      <Card
        as="section"
        className={cn(
          "content-card settings-section",
          uiPatterns["content-card"],
          uiPatterns["settings-section"],
        )}
      >
        <div
          className={cn(
            "section-heading storage-list-heading",
            uiPatterns["section-heading"],
            storageInventoryStyles["storage-list-heading"],
          )}
        >
          <div>
            <p className={cn("eyebrow", uiPatterns["eyebrow"])}>File Inventory</p>
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
        <form
          className={cn(
            "storage-inventory-filters",
            storageInventoryStyles["storage-inventory-filters"],
          )}
          onSubmit={applyFilters}
        >
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
          <label className={"storage-query-field"}>
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
        {selectableRuntimeAssets.length > 0 ? (
          <div
            className={cn(
              "storage-bulk-selection",
              storageInventoryStyles["storage-bulk-selection"],
            )}
          >
            <label>
              <Input
                aria-label="选择当前结果中的全部可删除资源"
                checked={allRuntimeAssetsSelected}
                disabled={loading || pendingRuntimeAssetIds.size > 0}
                onChange={(event) => toggleAllRuntimeAssets(event.currentTarget.checked)}
                type="checkbox"
              />
              <span>选择当前结果中的全部可删除资源</span>
            </label>
            <span>
              当前有 {selectableRuntimeAssets.length.toLocaleString()} 项 JDK 包或依赖包可管理
            </span>
          </div>
        ) : null}
        {loading && summary ? (
          <div
            className={cn("storage-tree-loading", storageInventoryStyles["storage-tree-loading"])}
            role="status"
          >
            <LoaderCircle aria-hidden="true" className={cn("spin", uiPatterns["spin"])} size={15} />
            正在载入目录，已载入 {items.length.toLocaleString()} 个文件与引用…
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
              disabled: loading || pendingRuntimeAssetIds.size > 0,
              pendingRuntimeAssetIds,
              selectedRuntimeAssetIds,
              onDelete: (item) => void deleteRuntimeAsset(item),
              onSelectionChange: updateRuntimeAssetSelection,
            }}
          />
        ) : summary && !loading ? (
          <div className={cn("inline-empty", uiPatterns["inline-empty"])}>
            当前筛选条件下没有文件或资源引用。
          </div>
        ) : null}
      </Card>
      {selectedRuntimeAssetIds.size > 0 ? (
        <div
          aria-label="批量删除存储资源"
          className={cn(
            "storage-deletion-floating-action",
            storageInventoryStyles["storage-deletion-floating-action"],
          )}
          role="region"
        >
          <span>
            已选择 <strong>{selectedRuntimeAssetIds.size.toLocaleString()}</strong> 项
          </span>
          <Button
            aria-label="清空已选择资源"
            disabled={pendingRuntimeAssetIds.size > 0}
            onClick={() => setSelectedRuntimeAssetIds(new Set())}
            size="compact"
            type="button"
            variant="ghost"
          >
            <X aria-hidden="true" size={15} /> 清空
          </Button>
          <Button
            disabled={loading || pendingRuntimeAssetIds.size > 0}
            onClick={() => void deleteSelectedRuntimeAssets()}
            size="compact"
            type="button"
            variant="danger"
          >
            {pendingRuntimeAssetIds.size > 0 ? (
              <LoaderCircle
                aria-hidden="true"
                className={cn("spin", uiPatterns["spin"])}
                size={15}
              />
            ) : (
              <Trash2 aria-hidden="true" size={15} />
            )}
            {pendingRuntimeAssetIds.size > 0 ? "正在删除…" : "批量删除"}
          </Button>
        </div>
      ) : null}
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
  onState,
}: {
  signal: AbortSignal;
  initialCategory: StorageInventoryCategory | undefined;
  initialQuery: string;
  refreshSummary: boolean;
  onBatch: (items: StorageInventoryItem[], summary: StorageInventorySummary) => void;
  onState: (state: StorageInventoryPage["snapshotState"]) => void;
}): Promise<void> {
  const scopeKey = `storage-inventory:v1:${initialCategory ?? ""}:${initialQuery}`;
  const epoch = browserCacheEpoch();
  const cached = readBrowserSnapshot(scopeKey) as
    | { items: StorageInventoryItem[]; summary: StorageInventorySummary; generation?: string }
    | undefined;
  if (cached) onBatch(cached.items, cached.summary);
  let displayedGeneration = cached?.generation;
  let firstRequest = true;
  let nodeId: string | undefined;
  let snapshotRestarts = 0;
  for (;;) {
    signal.throwIfAborted();
    const parameters = new URLSearchParams({ limit: String(INVENTORY_READ_BATCH_SIZE) });
    if (nodeId) parameters.set("nodeId", nodeId);
    if (initialCategory) parameters.set("category", initialCategory);
    if (initialQuery) parameters.set("query", initialQuery);
    if (firstRequest && refreshSummary) parameters.set("refresh", "1");
    try {
      const first = await fetchInventory(parameters, signal);
      firstRequest = false;
      nodeId = first.nodeId;
      if (nodeId) parameters.set("nodeId", nodeId);
      onState(first.snapshotState);
      if (first.snapshotState === "failed")
        throw new Error("后台扫描失败，请重新扫描；已加载的清单仍可查看。");
      if (first.generation && first.generation !== displayedGeneration) {
        const items = [...first.items];
        onBatch([...items], first.summary);
        let cursor = first.nextCursor;
        const visited = new Set<string>();
        while (cursor) {
          if (visited.has(cursor)) throw new Error("存储清单返回重复游标，已停止读取。");
          visited.add(cursor);
          parameters.delete("refresh");
          parameters.set("cursor", cursor);
          const key = `${scopeKey}:${cursor}`;
          const cachedPage = readBrowserSnapshot(key);
          const page = cachedPage
            ? storageInventoryPageSchema.parse(cachedPage)
            : await fetchInventory(parameters, signal);
          if (page.generation !== first.generation || page.nodeId !== first.nodeId)
            throw new Error("存储清单分页信息不一致，请刷新清单后重试。");
          writeBrowserSnapshot(key, page, epoch);
          items.push(...page.items);
          cursor = page.nextCursor;
        }
        signal.throwIfAborted();
        onBatch(items, first.summary);
        writeBrowserSnapshot(
          scopeKey,
          { items, summary: first.summary, generation: first.generation },
          epoch,
        );
        displayedGeneration = first.generation;
      }
      if (first.snapshotState !== "pending" && first.snapshotState !== "stale") return;
    } catch (cause) {
      signal.throwIfAborted();
      if (
        !(cause instanceof ApiClientError) ||
        cause.code !== "STORAGE_INVENTORY_SNAPSHOT_EXPIRED" ||
        snapshotRestarts >= MAX_SNAPSHOT_RESTARTS
      )
        throw cause;
      // Restart from the owner's first page, never combine different snapshots
      // and never trigger another filesystem scan just to recover a stale cursor.
      snapshotRestarts += 1;
      displayedGeneration = undefined;
      firstRequest = false;
      onState("stale");
    }
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        window.clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = window.setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, 1_000);
      signal.addEventListener("abort", abort, { once: true });
    });
  }
}

async function fetchInventory(
  parameters: URLSearchParams,
  signal: AbortSignal,
): Promise<StorageInventoryPage> {
  const response = await fetch(`/api/v1/settings/storage?${parameters}`, {
    cache: "no-store",
    signal,
  });
  const error = await readApiError(response, "存储清单读取失败。");
  if (error) throw error;
  return storageInventoryPageSchema.parse(await response.json());
}

const storageInventoryStyles = {
  "management-disclosure":
    "min-w-0 p-3 border border-solid border-border rounded-lg [&_.ui-disclosure-label]:cursor-pointer [&_.ui-disclosure-label]:font-semibold [&[data-open=true]_.ui-disclosure-label]:mb-3",
  "storage-bulk-selection":
    "flex min-h-9.5 items-center justify-between gap-3 [margin:calc(8px_*_-1)_0_12px] border border-solid border-border rounded-lg py-[7px] px-[11px] [background:color-mix(in_srgb,_color-mix(in_srgb,_var(--info)_10%,_transparent)_50%,_var(--card))] [&_label]:inline-flex [&_label]:items-center [&_label]:gap-2 [&_label]:text-foreground [&_label]:text-sm [&_label]:font-semibold [&_label]:cursor-pointer [&_>_span]:text-muted-foreground [&_>_span]:text-xs",
  "storage-category-card":
    "[&_span]:text-muted-foreground [&_span]:text-xs grid min-w-0 gap-1.5 p-3 border border-solid border-border rounded-lg [&_strong]:text-sm",
  "storage-category-grid": "grid grid-cols-3 gap-2 mt-4 max-[1181px]:grid-cols-2",
  "storage-category-track":
    "h-[5px] overflow-hidden rounded-full bg-muted [&_i]:block [&_i]:h-full [&_i]:rounded-xl [&_i]:bg-primary",
  "storage-deletion-floating-action":
    "fixed z-40 right-8 bottom-7 flex items-center gap-2 border border-solid border-border rounded-full [padding:9px_10px_9px_16px] [background:color-mix(in_srgb,_var(--card)_94%,_transparent)] shadow-xs [&_>_span]:text-muted-foreground [&_>_span]:text-sm [&_>_span]:font-semibold [&_>_span]:whitespace-nowrap [&_>_span_strong]:text-destructive [&_>_span_strong]:tabular-nums max-[1181px]:right-5 max-[1181px]:bottom-5",
  "storage-inventory":
    'gap-4 [&_[role="status"]:empty]:hidden [&_.settings-section_>_.section-heading_p]:hidden [&_.settings-section_>_p:empty]:hidden [&_.storage-category-grid]:gap-2 [&_.storage-category-grid]:mt-3 [&_.storage-category-card]:py-2 [&_.storage-category-card]:px-3',
  "storage-inventory-filters":
    "grid grid-cols-[minmax(170px,_0.35fr)_minmax(280px,_1fr)_auto] items-end gap-3 my-4 mx-0 [&_label]:grid [&_label]:min-w-0 [&_label]:gap-1.5 [&_label]:text-muted-foreground [&_label]:text-xs max-[1181px]:grid-cols-[minmax(160px,_0.45fr)_minmax(220px,_1fr)_auto]",
  "storage-list-heading": "items-start",
  "storage-roots":
    "[&_small]:text-muted-foreground [&_small]:text-xs grid gap-2 mt-4 py-3 px-3.5 border border-solid border-border rounded-lg bg-info/10 [&_>_span]:grid [&_>_span]:grid-cols-[auto_auto_minmax(0,_1fr)] [&_>_span]:items-center [&_>_span]:gap-[7px] [&_>_span]:text-muted-foreground [&_>_span]:text-xs [&_code]:[overflow-wrap:anywhere] [&_code]:text-foreground",
  "storage-summary-grid":
    "grid grid-cols-4 gap-2 mt-4 [&_>_div]:grid [&_>_div]:min-w-0 [&_>_div]:gap-1.5 [&_>_div]:p-3.5 [&_>_div]:border [&_>_div]:border-solid [&_>_div]:border-border [&_>_div]:rounded-lg [&_>_div]:bg-muted [&_span]:text-muted-foreground [&_span]:text-xs [&_strong]:overflow-hidden [&_strong]:text-lg [&_strong]:text-ellipsis [&_strong]:whitespace-nowrap max-[1181px]:grid-cols-2",
  "storage-tree-loading":
    "flex items-center gap-[7px] min-h-8.5 [margin:calc(8px_*_-1)_0_12px] rounded-lg py-0 px-2.5 bg-info/10 text-info text-xs",
} as const;
