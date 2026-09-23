"use client";
import { Badge } from "@/components/ui/badge";

import { Disclosure } from "@/components/ui/disclosure";

import { cn } from "@/lib/utils";

import type {
  StorageInventoryCategory,
  StorageInventoryItem,
  StorageInventoryLocation,
} from "@autoforge/contracts";
import {
  ChevronRight,
  Database,
  ExternalLink,
  File,
  FileArchive,
  FileCog,
  Folder,
  FolderTree,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { Button, Input } from "@/components/ui";

import type {
  StorageDirectoryNode,
  StorageFileNode,
  StorageLocationNode,
} from "./storage-inventory-tree-model";

const TREE_RENDER_BATCH_SIZE = 250;

type RuntimeAssetDeletionControls = {
  canManage: boolean;
  disabled: boolean;
  pendingRuntimeAssetIds: ReadonlySet<string>;
  selectedRuntimeAssetIds: ReadonlySet<string>;
  onDelete: (item: StorageInventoryItem) => void;
  onSelectionChange: (runtimeAssetId: string, selected: boolean) => void;
};

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

export function StorageInventoryTree({
  roots,
  forceOpen,
  timeZone,
  deletion,
}: {
  roots: readonly StorageLocationNode[];
  forceOpen: boolean;
  timeZone: string;
  deletion: RuntimeAssetDeletionControls;
}) {
  return (
    <div
      aria-label="存储文件目录"
      className={cn("storage-inventory-tree", storageInventoryTreeStyles["storage-inventory-tree"])}
      role="tree"
    >
      {roots.map((root) => (
        <StorageLocationBranch
          forceOpen={forceOpen}
          key={root.id}
          root={root}
          timeZone={timeZone}
          deletion={deletion}
        />
      ))}
    </div>
  );
}

function StorageLocationBranch({
  root,
  forceOpen,
  timeZone,
  deletion,
}: {
  root: StorageLocationNode;
  forceOpen: boolean;
  timeZone: string;
  deletion: RuntimeAssetDeletionControls;
}) {
  const [open, setOpen] = useState(true);
  const renderedOpen = forceOpen || open;
  return (
    <Disclosure
      showArrow={false}
      header={
        <>
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "storage-tree-chevron",
              storageInventoryTreeStyles["storage-tree-chevron"],
            )}
            size={16}
          />
          <LocationIcon location={root.location} />
          <span
            className={cn("storage-tree-name", storageInventoryTreeStyles["storage-tree-name"])}
          >
            <strong>{root.name}</strong>
            <code title={root.storagePath}>{root.storagePath}</code>
          </span>
          <DirectoryMetrics directory={root} />
        </>
      }
      className={cn("storage-tree-location", storageInventoryTreeStyles["storage-tree-location"])}
      data-tree-node-id={root.id}
      aria-selected={false}
      onOpenChange={(expanded) => setOpen(expanded)}
      open={renderedOpen}
      role="treeitem"
    >
      {renderedOpen ? (
        <StorageDirectoryChildren
          deletion={deletion}
          directory={root}
          forceOpen={forceOpen}
          timeZone={timeZone}
        />
      ) : null}
    </Disclosure>
  );
}

function StorageDirectoryBranch({
  directory,
  forceOpen,
  timeZone,
  deletion,
}: {
  directory: StorageDirectoryNode;
  forceOpen: boolean;
  timeZone: string;
  deletion: RuntimeAssetDeletionControls;
}) {
  const [open, setOpen] = useState(() => shouldOpenByDefault(directory));
  const renderedOpen = forceOpen || open;
  return (
    <Disclosure
      showArrow={false}
      header={
        <>
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "storage-tree-chevron",
              storageInventoryTreeStyles["storage-tree-chevron"],
            )}
            size={15}
          />
          <Folder aria-hidden="true" size={17} />
          <span
            className={cn("storage-tree-name", storageInventoryTreeStyles["storage-tree-name"])}
          >
            <strong>{directory.name}</strong>
            <code>{directory.logicalPath}</code>
          </span>
          <DirectoryMetrics directory={directory} />
        </>
      }
      headerTitle={directory.logicalPath}
      className={cn("storage-tree-directory", storageInventoryTreeStyles["storage-tree-directory"])}
      data-tree-node-id={directory.id}
      aria-selected={false}
      onOpenChange={(expanded) => setOpen(expanded)}
      open={renderedOpen}
      role="treeitem"
    >
      {renderedOpen ? (
        <StorageDirectoryChildren
          deletion={deletion}
          directory={directory}
          forceOpen={forceOpen}
          timeZone={timeZone}
        />
      ) : null}
    </Disclosure>
  );
}

function StorageDirectoryChildren({
  directory,
  forceOpen,
  timeZone,
  deletion,
}: {
  directory: StorageDirectoryNode;
  forceOpen: boolean;
  timeZone: string;
  deletion: RuntimeAssetDeletionControls;
}) {
  const [visibleDirectoryCount, setVisibleDirectoryCount] = useState(TREE_RENDER_BATCH_SIZE);
  const [visibleFileCount, setVisibleFileCount] = useState(TREE_RENDER_BATCH_SIZE);
  return (
    <div
      className={cn("storage-tree-children", storageInventoryTreeStyles["storage-tree-children"])}
      role="group"
    >
      {directory.directories.slice(0, visibleDirectoryCount).map((child) => (
        <StorageDirectoryBranch
          directory={child}
          deletion={deletion}
          forceOpen={forceOpen}
          key={child.id}
          timeZone={timeZone}
        />
      ))}
      {directory.directories.length > visibleDirectoryCount ? (
        <Button
          onClick={() => setVisibleDirectoryCount((count) => count + TREE_RENDER_BATCH_SIZE)}
          type="button"
          variant="ghost"
        >
          加载更多目录（剩余 {directory.directories.length - visibleDirectoryCount}）
        </Button>
      ) : null}
      {directory.files.slice(0, visibleFileCount).map((file) => (
        <StorageFileBranch deletion={deletion} file={file} key={file.id} timeZone={timeZone} />
      ))}
      {directory.files.length > visibleFileCount ? (
        <Button
          onClick={() => setVisibleFileCount((count) => count + TREE_RENDER_BATCH_SIZE)}
          type="button"
          variant="ghost"
        >
          加载更多文件（剩余 {directory.files.length - visibleFileCount}）
        </Button>
      ) : null}
    </div>
  );
}

function StorageFileBranch({
  file,
  timeZone,
  deletion,
}: {
  file: StorageFileNode;
  timeZone: string;
  deletion: RuntimeAssetDeletionControls;
}) {
  const item = file.primary;
  return (
    <Disclosure
      showArrow={false}
      header={
        <>
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "storage-tree-chevron",
              storageInventoryTreeStyles["storage-tree-chevron"],
            )}
            size={14}
          />
          <span
            className={cn(
              "storage-tree-file-selection",
              storageInventoryTreeStyles["storage-tree-file-selection"],
            )}
          >
            {canDeleteRuntimeAsset(item, deletion.canManage) ? (
              <Input
                aria-label={`选择${CATEGORY_LABELS[item.category]} ${item.name}`}
                checked={deletion.selectedRuntimeAssetIds.has(item.runtimeAssetId!)}
                disabled={
                  deletion.disabled || deletion.pendingRuntimeAssetIds.has(item.runtimeAssetId!)
                }
                onChange={(event) =>
                  deletion.onSelectionChange(item.runtimeAssetId!, event.currentTarget.checked)
                }
                onClick={(event) => event.stopPropagation()}
                type="checkbox"
              />
            ) : null}
          </span>
          <FileTypeIcon category={item.category} />
          <span
            className={cn(
              "storage-tree-file-identity",
              storageInventoryTreeStyles["storage-tree-file-identity"],
            )}
          >
            <strong
              className={cn(
                "storage-tree-file-name",
                storageInventoryTreeStyles["storage-tree-file-name"],
              )}
              title={item.name}
            >
              {item.name}
            </strong>
            {item.runBatchId ? (
              <span
                className={cn(
                  "storage-tree-file-batch",
                  storageInventoryTreeStyles["storage-tree-file-batch"],
                )}
              >
                {item.runBatchSequenceNumber
                  ? `任务批次 #${item.runBatchSequenceNumber}`
                  : "关联批次记录不可用"}
              </span>
            ) : null}
          </span>
          <Badge
            className={cn(
              storageInventoryTreeStyles["storage-kind"],
              storageInventoryTreeStyles["status-badge"],
              `status-badge storage-kind storage-kind-${item.category}`,
            )}
          >
            {CATEGORY_LABELS[item.category]}
            {file.kind === "sqlite-group" ? ` · ${file.physicalFiles.length} 个文件` : ""}
          </Badge>
          <span
            className={cn(
              "storage-tree-file-size",
              storageInventoryTreeStyles["storage-tree-file-size"],
            )}
          >
            {formatBytes(file.sizeBytes)}
          </span>
          <span
            className={cn(
              "storage-tree-file-allocation",
              storageInventoryTreeStyles["storage-tree-file-allocation"],
            )}
          >
            {item.location === "external-reference"
              ? "外部引用"
              : `占用 ${formatBytes(file.allocatedBytes)}`}
          </span>
          <FileTimeSummary
            createdAt={file.createdAt}
            modifiedAt={file.modifiedAt}
            timeZone={timeZone}
          />
        </>
      }
      aria-selected={false}
      className={cn(
        storageInventoryTreeStyles["storage-tree-file"],
        `storage-tree-file${file.kind === "sqlite-group" ? " storage-tree-sqlite-group" : ""}`,
      )}
      role="treeitem"
    >
      <div
        className={cn(
          "storage-tree-file-detail",
          storageInventoryTreeStyles["storage-tree-file-detail"],
        )}
      >
        <PathDetail label="逻辑路径" value={item.logicalPath} />
        <PathDetail label="实际位置" value={item.storagePath} />
        <dl>
          <div>
            <dt>内容大小</dt>
            <dd>{formatBytes(file.sizeBytes)}</dd>
          </div>
          <div>
            <dt>实际占用</dt>
            <dd>
              {item.location === "external-reference"
                ? "0 B（文件位于外部地址）"
                : formatBytes(file.allocatedBytes)}
            </dd>
          </div>
          {item.detail ? (
            <div>
              <dt>说明</dt>
              <dd>{item.detail}</dd>
            </div>
          ) : null}
          {item.projectId ? (
            <div>
              <dt>项目 ID</dt>
              <dd>{item.projectId}</dd>
            </div>
          ) : null}
          {item.runBatchId ? (
            <div>
              <dt>关联任务批次</dt>
              <dd>
                {item.runBatchSequenceNumber ? (
                  <Link
                    className={cn(
                      "storage-tree-batch-link",
                      storageInventoryTreeStyles["storage-tree-batch-link"],
                    )}
                    href={`/run-batches/${encodeURIComponent(item.runBatchId)}`}
                  >
                    查看任务批次 #{item.runBatchSequenceNumber}
                    <ExternalLink aria-hidden="true" size={13} />
                  </Link>
                ) : (
                  "批次记录已清理，无法跳转"
                )}
              </dd>
            </div>
          ) : null}
          <div>
            <dt>创建时间</dt>
            <dd>{renderTimestamp(file.createdAt, timeZone)}</dd>
          </div>
          <div>
            <dt>{file.kind === "sqlite-group" ? "最新修改时间" : "修改时间"}</dt>
            <dd>{renderTimestamp(file.modifiedAt, timeZone)}</dd>
          </div>
        </dl>
        {file.kind === "sqlite-group" ? (
          <SqlitePhysicalFiles files={file.physicalFiles} timeZone={timeZone} />
        ) : null}
        {canDeleteRuntimeAsset(item, deletion.canManage) ? (
          <div
            className={cn(
              "storage-tree-file-actions",
              storageInventoryTreeStyles["storage-tree-file-actions"],
            )}
          >
            <Button
              aria-label={`删除${CATEGORY_LABELS[item.category]} ${item.name}`}
              disabled={
                deletion.disabled || deletion.pendingRuntimeAssetIds.has(item.runtimeAssetId!)
              }
              onClick={() => deletion.onDelete(item)}
              type="button"
              variant="danger"
            >
              <Trash2 aria-hidden="true" size={15} />
              {deletion.pendingRuntimeAssetIds.has(item.runtimeAssetId!)
                ? "正在删除…"
                : `删除${CATEGORY_LABELS[item.category]}`}
            </Button>
          </div>
        ) : null}
      </div>
    </Disclosure>
  );
}

function canDeleteRuntimeAsset(item: StorageInventoryItem, canManage: boolean): boolean {
  return (
    canManage &&
    Boolean(item.runtimeAssetId) &&
    (item.category === "jdk" || item.category === "dependency")
  );
}

function FileTimeSummary({
  createdAt,
  modifiedAt,
  timeZone,
}: {
  createdAt: string | undefined;
  modifiedAt: string | undefined;
  timeZone: string;
}) {
  return (
    <span
      className={cn(
        "storage-tree-file-times",
        storageInventoryTreeStyles["storage-tree-file-times"],
      )}
    >
      <span>创建 {createdAt ? timestampElement(createdAt, timeZone) : "—"}</span>
      <strong>修改 {modifiedAt ? timestampElement(modifiedAt, timeZone) : "—"}</strong>
    </span>
  );
}

function SqlitePhysicalFiles({
  files,
  timeZone,
}: {
  files: readonly StorageInventoryItem[];
  timeZone: string;
}) {
  return (
    <section
      className={cn(
        "storage-sqlite-components",
        storageInventoryTreeStyles["storage-sqlite-components"],
      )}
    >
      <header>
        <strong>SQLite 文件组成</strong>
        <span>{files.length} 个物理文件，已合并计入上方大小</span>
      </header>
      <ul>
        {files.map((file) => (
          <li key={file.id}>
            <span
              className={cn(
                "storage-sqlite-component-role",
                storageInventoryTreeStyles["storage-sqlite-component-role"],
              )}
            >
              {sqliteFileRole(file)}
            </span>
            <span
              className={cn(
                "storage-sqlite-component-path",
                storageInventoryTreeStyles["storage-sqlite-component-path"],
              )}
            >
              <strong title={file.name}>{file.name}</strong>
              <code title={file.storagePath}>{file.storagePath}</code>
            </span>
            <span
              className={cn(
                "storage-sqlite-component-size",
                storageInventoryTreeStyles["storage-sqlite-component-size"],
              )}
            >
              <strong>{formatBytes(file.sizeBytes)}</strong>
              <small>占用 {formatBytes(file.allocatedBytes)}</small>
            </span>
            <FileTimeSummary
              createdAt={file.createdAt}
              modifiedAt={file.modifiedAt}
              timeZone={timeZone}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function sqliteFileRole(item: StorageInventoryItem): string {
  if (item.logicalPath.endsWith("-wal")) return "WAL";
  if (item.logicalPath.endsWith("-shm")) return "SHM";
  return "主文件";
}

function renderTimestamp(value: string | undefined, timeZone: string) {
  return value ? timestampElement(value, timeZone) : "—";
}

function timestampElement(value: string, timeZone: string) {
  return (
    <time dateTime={value} title={`UTC：${value}`}>
      {formatDate(value, timeZone)}
    </time>
  );
}

function DirectoryMetrics({ directory }: { directory: StorageDirectoryNode }) {
  return (
    <span
      className={cn(
        "storage-tree-directory-metrics",
        storageInventoryTreeStyles["storage-tree-directory-metrics"],
      )}
    >
      <span>{directory.fileCount.toLocaleString()} 个文件</span>
      <strong>{formatBytes(directory.allocatedBytes)}</strong>
    </span>
  );
}

function PathDetail({ label, value }: { label: string; value: string }) {
  return (
    <div
      className={cn(
        "storage-tree-path-detail",
        storageInventoryTreeStyles["storage-tree-path-detail"],
      )}
    >
      <span>{label}</span>
      <code title={value}>{value}</code>
    </div>
  );
}

function LocationIcon({ location }: { location: StorageInventoryLocation }) {
  switch (location) {
    case "data-directory":
      return <FolderTree aria-hidden="true" size={18} />;
    case "object-store":
      return <Database aria-hidden="true" size={18} />;
    case "external-reference":
      return <ExternalLink aria-hidden="true" size={18} />;
  }
}

function FileTypeIcon({ category }: { category: StorageInventoryCategory }) {
  if (category === "database" || category === "execution-log") {
    return <Database aria-hidden="true" size={16} />;
  }
  if (category === "configuration") return <FileCog aria-hidden="true" size={16} />;
  if (
    category === "jdk" ||
    category === "dependency" ||
    category === "case-source" ||
    category === "ddt-import" ||
    category === "artifact" ||
    category === "analytics-export"
  ) {
    return <FileArchive aria-hidden="true" size={16} />;
  }
  return <File aria-hidden="true" size={16} />;
}

function shouldOpenByDefault(directory: StorageDirectoryNode): boolean {
  return (
    directory.depth === 1 ||
    (directory.fileCount <= TREE_RENDER_BATCH_SIZE &&
      directory.files.length === 0 &&
      directory.directories.length === 1)
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

const storageInventoryTreeStyles = {
  "status-badge":
    "inline-flex w-fit items-center gap-[5px] rounded-full py-[5px] px-2 text-xs font-semibold whitespace-nowrap",
  "storage-inventory-tree": "overflow-hidden border border-solid border-border rounded-xl bg-card",
  "storage-kind":
    "[&.storage-kind-database]:bg-info/10 [&.storage-kind-database]:text-info [&.storage-kind-execution-log]:bg-info/10 [&.storage-kind-execution-log]:text-info [&.storage-kind-configuration]:bg-info/10 [&.storage-kind-configuration]:text-info [&.storage-kind-jdk]:bg-info/10 [&.storage-kind-jdk]:text-info [&.storage-kind-dependency]:bg-info/10 [&.storage-kind-dependency]:text-info [&.storage-kind-case-source]:bg-info/10 [&.storage-kind-case-source]:text-info [&.storage-kind-ddt-import]:bg-info/10 [&.storage-kind-ddt-import]:text-info [&.storage-kind-artifact]:bg-success/10 [&.storage-kind-artifact]:text-success [&.storage-kind-analytics-export]:bg-success/10 [&.storage-kind-analytics-export]:text-success",
  "storage-sqlite-component-path":
    "grid min-w-0 gap-0.5 [&_strong]:overflow-hidden [&_strong]:text-ellipsis [&_strong]:whitespace-nowrap [&_strong]:text-foreground [&_strong]:text-xs [&_code]:overflow-hidden [&_code]:text-ellipsis [&_code]:whitespace-nowrap [&_code]:text-muted-foreground [&_code]:text-xs",
  "storage-sqlite-component-role":
    "rounded-full py-[3px] px-[7px] bg-muted text-muted-foreground text-xs text-center",
  "storage-sqlite-component-size":
    "grid min-w-0 gap-0.5 text-right whitespace-nowrap [&_strong]:text-foreground [&_strong]:text-xs [&_small]:text-muted-foreground [&_small]:text-xs",
  "storage-sqlite-components":
    "overflow-hidden border border-solid border-border rounded-lg bg-card [&_>_header]:flex [&_>_header]:min-h-9.5 [&_>_header]:items-center [&_>_header]:justify-between [&_>_header]:gap-3 [&_>_header]:py-[7px] [&_>_header]:px-2.5 [&_>_header]:bg-info/10 [&_>_header_strong]:text-info [&_>_header_strong]:text-sm [&_>_header_span]:text-muted-foreground [&_>_header_span]:text-xs [&_ul]:grid [&_ul]:m-0 [&_ul]:p-0 [&_ul]:[list-style:none] [&_li]:grid [&_li]:min-w-0 [&_li]:grid-cols-[62px_minmax(140px,_1fr)_minmax(76px,_auto)_minmax(164px,_auto)] [&_li]:items-center [&_li]:gap-2.5 [&_li]:py-2 [&_li]:px-2.5 [&_li_+_li]:border-t [&_li_+_li]:border-solid [&_li_+_li]:border-transparent max-[1181px]:[&_li]:grid-cols-[58px_minmax(120px,_1fr)_minmax(70px,_auto)_minmax(164px,_auto)]",
  "storage-tree-batch-link":
    "inline-flex w-fit items-center gap-[5px] text-info font-semibold [text-decoration:none] [&:hover]:[text-decoration:underline] [&:hover]:[text-underline-offset:2px] [&:focus-visible]:rounded-md [&:focus-visible]:[outline:2px_solid_var(--info)] [&:focus-visible]:[outline-offset:2px]",
  "storage-tree-chevron":
    "[flex:0_0_auto] text-muted-foreground transition-colors duration-150 motion-reduce:transition-none",
  "storage-tree-children": "grid min-w-0 ml-3.5 border-l border-solid border-border pl-2",
  "storage-tree-directory":
    "[&_.ui-disclosure-label]:grid [&_.ui-disclosure-label]:min-w-0 [&_.ui-disclosure-label]:items-center [&_.ui-disclosure-label]:gap-[9px] [&_.ui-disclosure-label]:cursor-pointer [&_.ui-disclosure-label]:[list-style:none] [&_.ui-disclosure-label]:min-h-10.5 [&_.ui-disclosure-label]:grid-cols-[auto_auto_minmax(0,_1fr)_auto] [&_.ui-disclosure-label]:rounded-lg [&_.ui-disclosure-label]:py-[5px] [&_.ui-disclosure-label]:px-[9px] [&_.ui-disclosure-label::-webkit-details-marker]:hidden [&_.ui-disclosure-label:hover]:[background:color-mix(in_srgb,_color-mix(in_srgb,_var(--info)_10%,_transparent)_46%,_var(--card))] [&[data-open=true]_.ui-disclosure-label_>_.storage-tree-chevron]:[transform:rotate(90deg)] [&_.ui-disclosure-label_>_svg:not(.storage-tree-chevron)]:text-warning",
  "storage-tree-directory-metrics":
    "inline-flex items-center gap-3 text-muted-foreground text-xs whitespace-nowrap [&_strong]:min-w-18 [&_strong]:text-foreground [&_strong]:text-right",
  "storage-tree-file":
    "[&_.ui-disclosure-label]:grid [&_.ui-disclosure-label]:min-w-0 [&_.ui-disclosure-label]:items-center [&_.ui-disclosure-label]:gap-[9px] [&_.ui-disclosure-label]:cursor-pointer [&_.ui-disclosure-label]:[list-style:none] [&_.ui-disclosure-label]:min-h-11.5 [&_.ui-disclosure-label]:grid-cols-[auto_22px_auto_minmax(120px,_1fr)_auto_minmax(72px,_auto)_minmax(92px,_auto)_minmax(164px,_auto)] [&_.ui-disclosure-label]:rounded-lg [&_.ui-disclosure-label]:py-1.5 [&_.ui-disclosure-label]:px-[9px] [&_.ui-disclosure-label::-webkit-details-marker]:hidden [&_.ui-disclosure-label:hover]:[background:color-mix(in_srgb,_color-mix(in_srgb,_var(--info)_10%,_transparent)_46%,_var(--card))] [&[data-open=true]_.ui-disclosure-label_>_.storage-tree-chevron]:[transform:rotate(90deg)] min-w-0 [&_+_.storage-tree-file]:border-t [&_+_.storage-tree-file]:border-solid [&_+_.storage-tree-file]:border-transparent [&_.ui-disclosure-label_>_svg:not(.storage-tree-chevron)]:text-info max-[1181px]:[&_.ui-disclosure-label]:grid-cols-[auto_22px_auto_minmax(120px,_1fr)_auto_minmax(70px,_auto)_minmax(_164px,_auto_)]",
  "storage-tree-file-actions": "flex justify-end border-t border-solid border-border pt-2.5",
  "storage-tree-file-allocation":
    "text-muted-foreground text-xs text-right whitespace-nowrap max-[1181px]:hidden",
  "storage-tree-file-batch": "overflow-hidden text-info text-xs text-ellipsis whitespace-nowrap",
  "storage-tree-file-detail":
    "grid gap-[9px] [margin:0_9px_9px_80px] border border-solid border-border rounded-lg py-[11px] px-[13px] bg-muted [&_dl]:grid [&_dl]:min-w-0 [&_dl]:gap-1 [&_dl]:grid-cols-3 [&_dl]:m-0 [&_dl_>_div]:grid [&_dl_>_div]:min-w-0 [&_dl_>_div]:gap-1 [&_dl_>_div]:[align-content:start] [&_dt]:text-muted-foreground [&_dt]:text-xs [&_dd]:m-0 [&_dd]:[overflow-wrap:anywhere] [&_dd]:text-muted-foreground [&_dd]:text-xs [&_dd]:leading-[1.5]",
  "storage-tree-file-identity": "grid min-w-0 gap-0.5",
  "storage-tree-file-name": "[overflow-wrap:anywhere] whitespace-normal text-sm",
  "storage-tree-file-selection": 'grid w-5.5 place-items-center [&_.ui-input[type="checkbox"]]:m-0',
  "storage-tree-file-size": "text-muted-foreground text-xs text-right whitespace-nowrap",
  "storage-tree-file-times":
    "text-muted-foreground text-xs text-right whitespace-nowrap grid min-w-0 gap-px [&_strong]:text-foreground [&_strong]:font-semibold",
  "storage-tree-location":
    "[&_+_.storage-tree-location]:border-t [&_+_.storage-tree-location]:border-solid [&_+_.storage-tree-location]:border-border [&_.ui-disclosure-label]:grid [&_.ui-disclosure-label]:min-w-0 [&_.ui-disclosure-label]:items-center [&_.ui-disclosure-label]:gap-[9px] [&_.ui-disclosure-label]:cursor-pointer [&_.ui-disclosure-label]:[list-style:none] [&_.ui-disclosure-label]:min-h-13.5 [&_.ui-disclosure-label]:grid-cols-[auto_auto_minmax(0,_1fr)_auto] [&_.ui-disclosure-label]:py-2 [&_.ui-disclosure-label]:px-3.5 [&_.ui-disclosure-label]:bg-muted [&_.ui-disclosure-label::-webkit-details-marker]:hidden [&_.ui-disclosure-label:hover]:[background:color-mix(in_srgb,_color-mix(in_srgb,_var(--info)_10%,_transparent)_46%,_var(--card))] [&[data-open=true]_.ui-disclosure-label_>_.storage-tree-chevron]:[transform:rotate(90deg)] [&_.ui-disclosure-body_>_.storage-tree-children]:m-0 [&_.ui-disclosure-body_>_.storage-tree-children]:border-l-0 [&_.ui-disclosure-body_>_.storage-tree-children]:[padding:6px_8px_9px]",
  "storage-tree-name":
    "grid min-w-0 gap-0.5 [&_strong]:[overflow-wrap:anywhere] [&_strong]:whitespace-normal [&_code]:[overflow-wrap:anywhere] [&_code]:whitespace-normal [&_code]:text-muted-foreground [&_code]:text-xs",
  "storage-tree-path-detail":
    "grid min-w-0 gap-1 [&_>_span]:text-muted-foreground [&_>_span]:text-xs [&_code]:m-0 [&_code]:[overflow-wrap:anywhere] [&_code]:text-muted-foreground [&_code]:text-xs [&_code]:leading-[1.5]",
} as const;
