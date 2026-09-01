"use client";

import type {
  StorageInventoryCategory,
  StorageInventoryItem,
  StorageInventoryPage,
} from "@autoforge/contracts";
import { ChevronLeft, ChevronRight, Database, HardDrive, RefreshCw, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";

import { Button, Input, Select } from "@/components/ui";

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
}: {
  initialCategory?: StorageInventoryCategory;
  initialQuery: string;
  timeZone: string;
}) {
  const router = useRouter();
  const [page, setPage] = useState<StorageInventoryPage>();
  const [cursor, setCursor] = useState<string>();
  const [cursorHistory, setCursorHistory] = useState<Array<string | undefined>>([]);
  const [draftCategory, setDraftCategory] = useState(initialCategory ?? "");
  const [draftQuery, setDraftQuery] = useState(initialQuery);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshSequence, setRefreshSequence] = useState(0);
  const handledRefreshSequence = useRef(0);

  useEffect(() => {
    const abort = new AbortController();
    const parameters = new URLSearchParams({ limit: "100" });
    if (cursor) parameters.set("cursor", cursor);
    if (initialCategory) parameters.set("category", initialCategory);
    if (initialQuery) parameters.set("query", initialQuery);
    const refreshSummary = refreshSequence > handledRefreshSequence.current;
    if (refreshSummary) parameters.set("refresh", "1");
    void fetch(`/api/v1/settings/storage?${parameters}`, {
      cache: "no-store",
      signal: abort.signal,
    })
      .then(async (response) => {
        const body = (await response.json()) as StorageInventoryPage & {
          error?: { message?: string };
        };
        if (!response.ok) throw new Error(body.error?.message ?? "存储清单读取失败。");
        setPage(body);
        if (refreshSummary) handledRefreshSequence.current = refreshSequence;
      })
      .catch((cause: unknown) => {
        if (abort.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : "存储清单读取失败。");
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [cursor, initialCategory, initialQuery, refreshSequence]);

  const maximumCategoryBytes = useMemo(
    () => Math.max(1, ...(page?.summary.categories.map((item) => item.allocatedBytes) ?? [])),
    [page],
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

  function nextPage(): void {
    if (!page?.nextCursor) return;
    setLoading(true);
    setError("");
    setCursorHistory((current) => [...current, cursor]);
    setCursor(page.nextCursor);
  }

  function previousPage(): void {
    const previous = cursorHistory.at(-1);
    setLoading(true);
    setError("");
    setCursorHistory((current) => current.slice(0, -1));
    setCursor(previous);
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
        {page ? (
          <>
            <div className="storage-summary-grid">
              <StorageMetric
                label="平台实际占用"
                value={formatBytes(page.summary.allocatedBytes)}
              />
              <StorageMetric label="内容逻辑大小" value={formatBytes(page.summary.logicalBytes)} />
              <StorageMetric
                label="文件与引用"
                value={`${page.summary.fileCount.toLocaleString()} 项`}
              />
              <StorageMetric
                label="外部引用"
                value={`${page.summary.externalReferenceCount.toLocaleString()} 项 · ${formatBytes(page.summary.externalReferenceBytes)}`}
              />
            </div>
            <div className="storage-roots">
              <span>
                <HardDrive size={15} /> 数据目录 <code>{page.summary.dataDirectory}</code>
              </span>
              <span>
                <Database size={15} /> 对象空间 <code>{page.summary.objectStoreRoot}</code>
              </span>
              <small>
                统计生成于 {formatDate(page.summary.generatedAt, timeZone)}；MinIO
                占用为对象内容大小， 不包含存储集群副本或纠删码开销。
              </small>
            </div>
            <div className="storage-category-grid" aria-label="文件分类占用">
              {page.summary.categories.map((item) => (
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
          <div className="inline-empty">正在扫描平台文件与对象空间…</div>
        ) : null}
      </section>

      <section className="content-card settings-section">
        <div className="section-heading storage-list-heading">
          <div>
            <p className="eyebrow">File Inventory</p>
            <h2>文件逻辑清单</h2>
            <p>每页最多显示 100 项；路径可完整复制，长内容仅在当前单元格内换行。</p>
          </div>
          <Button
            disabled={loading}
            onClick={() => {
              setLoading(true);
              setError("");
              setRefreshSequence((value) => value + 1);
            }}
            type="button"
            variant="secondary"
          >
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
        {page && page.items.length > 0 ? (
          <div className="table-scroll storage-inventory-table-wrap">
            <table className="data-table storage-inventory-table">
              <colgroup>
                <col className="storage-col-type" />
                <col className="storage-col-file" />
                <col className="storage-col-location" />
                <col className="storage-col-size" />
                <col className="storage-col-size" />
                <col className="storage-col-time" />
              </colgroup>
              <thead>
                <tr>
                  <th>类型</th>
                  <th>文件与逻辑路径</th>
                  <th>实际位置</th>
                  <th>内容大小</th>
                  <th>占用空间</th>
                  <th>更新时间</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((item) => (
                  <StorageRow item={item} key={item.id} timeZone={timeZone} />
                ))}
              </tbody>
            </table>
          </div>
        ) : page && !loading ? (
          <div className="inline-empty">当前筛选条件下没有文件或资源引用。</div>
        ) : null}
        <div className="storage-pagination">
          <span>
            第 {cursorHistory.length + 1} 页 · 本页 {page?.items.length ?? 0} 项
          </span>
          <div>
            <Button
              aria-label="上一页文件"
              disabled={loading || cursorHistory.length === 0}
              onClick={previousPage}
              type="button"
              variant="secondary"
            >
              <ChevronLeft size={15} /> 上一页
            </Button>
            <Button
              aria-label="下一页文件"
              disabled={loading || !page?.nextCursor}
              onClick={nextPage}
              type="button"
              variant="secondary"
            >
              下一页 <ChevronRight size={15} />
            </Button>
          </div>
        </div>
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

function StorageRow({ item, timeZone }: { item: StorageInventoryItem; timeZone: string }) {
  const locationLabel = {
    "data-directory": "数据目录",
    "object-store": "对象存储",
    "external-reference": "外部引用",
  }[item.location];
  return (
    <tr>
      <td>
        <span className={`status-badge storage-kind-${item.category}`}>
          {CATEGORY_LABELS[item.category]}
        </span>
      </td>
      <td>
        <span className="storage-file-cell">
          <strong title={item.name}>{item.name}</strong>
          <code title={item.logicalPath}>{item.logicalPath}</code>
          {item.detail ? <small>{item.detail}</small> : null}
          {item.projectId ? <small>项目：{item.projectId}</small> : null}
        </span>
      </td>
      <td>
        <span className="storage-path-cell">
          <small>{locationLabel}</small>
          <code title={item.storagePath}>{item.storagePath}</code>
        </span>
      </td>
      <td>{formatBytes(item.sizeBytes)}</td>
      <td>
        {item.location === "external-reference" ? (
          <span title="文件位于外部地址，不占用平台数据空间">0 B</span>
        ) : (
          formatBytes(item.allocatedBytes)
        )}
      </td>
      <td>
        {item.modifiedAt ? (
          <time dateTime={item.modifiedAt} title={`UTC：${item.modifiedAt}`}>
            {formatDate(item.modifiedAt, timeZone)}
          </time>
        ) : (
          "—"
        )}
      </td>
    </tr>
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
