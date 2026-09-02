"use client";

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
} from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui";

import type { StorageDirectoryNode, StorageLocationNode } from "./storage-inventory-tree-model";

const TREE_RENDER_BATCH_SIZE = 250;

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
}: {
  roots: readonly StorageLocationNode[];
  forceOpen: boolean;
  timeZone: string;
}) {
  return (
    <div aria-label="存储文件目录" className="storage-inventory-tree" role="tree">
      {roots.map((root) => (
        <StorageLocationBranch
          forceOpen={forceOpen}
          key={root.id}
          root={root}
          timeZone={timeZone}
        />
      ))}
    </div>
  );
}

function StorageLocationBranch({
  root,
  forceOpen,
  timeZone,
}: {
  root: StorageLocationNode;
  forceOpen: boolean;
  timeZone: string;
}) {
  const [open, setOpen] = useState(true);
  const renderedOpen = forceOpen || open;
  return (
    <details
      className="storage-tree-location"
      aria-selected={false}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      open={renderedOpen}
      role="treeitem"
    >
      <summary>
        <ChevronRight aria-hidden="true" className="storage-tree-chevron" size={16} />
        <LocationIcon location={root.location} />
        <span className="storage-tree-name">
          <strong>{root.name}</strong>
          <code title={root.storagePath}>{root.storagePath}</code>
        </span>
        <DirectoryMetrics directory={root} />
      </summary>
      {renderedOpen ? (
        <StorageDirectoryChildren directory={root} forceOpen={forceOpen} timeZone={timeZone} />
      ) : null}
    </details>
  );
}

function StorageDirectoryBranch({
  directory,
  forceOpen,
  timeZone,
}: {
  directory: StorageDirectoryNode;
  forceOpen: boolean;
  timeZone: string;
}) {
  const [open, setOpen] = useState(() => shouldOpenByDefault(directory));
  const renderedOpen = forceOpen || open;
  return (
    <details
      className="storage-tree-directory"
      aria-selected={false}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      open={renderedOpen}
      role="treeitem"
    >
      <summary title={directory.logicalPath}>
        <ChevronRight aria-hidden="true" className="storage-tree-chevron" size={15} />
        <Folder aria-hidden="true" size={17} />
        <span className="storage-tree-name">
          <strong>{directory.name}</strong>
          <code>{directory.logicalPath}</code>
        </span>
        <DirectoryMetrics directory={directory} />
      </summary>
      {renderedOpen ? (
        <StorageDirectoryChildren directory={directory} forceOpen={forceOpen} timeZone={timeZone} />
      ) : null}
    </details>
  );
}

function StorageDirectoryChildren({
  directory,
  forceOpen,
  timeZone,
}: {
  directory: StorageDirectoryNode;
  forceOpen: boolean;
  timeZone: string;
}) {
  const [visibleDirectoryCount, setVisibleDirectoryCount] = useState(TREE_RENDER_BATCH_SIZE);
  const [visibleFileCount, setVisibleFileCount] = useState(TREE_RENDER_BATCH_SIZE);
  return (
    <div className="storage-tree-children" role="group">
      {directory.directories.slice(0, visibleDirectoryCount).map((child) => (
        <StorageDirectoryBranch
          directory={child}
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
      {directory.files.slice(0, visibleFileCount).map((item) => (
        <StorageFileNode item={item} key={item.id} timeZone={timeZone} />
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

function StorageFileNode({ item, timeZone }: { item: StorageInventoryItem; timeZone: string }) {
  return (
    <details aria-selected={false} className="storage-tree-file" role="treeitem">
      <summary>
        <ChevronRight aria-hidden="true" className="storage-tree-chevron" size={14} />
        <FileTypeIcon category={item.category} />
        <strong className="storage-tree-file-name" title={item.name}>
          {item.name}
        </strong>
        <span className={`status-badge storage-kind-${item.category}`}>
          {CATEGORY_LABELS[item.category]}
        </span>
        <span className="storage-tree-file-size">{formatBytes(item.sizeBytes)}</span>
        <span className="storage-tree-file-allocation">
          {item.location === "external-reference"
            ? "外部引用"
            : `占用 ${formatBytes(item.allocatedBytes)}`}
        </span>
      </summary>
      <div className="storage-tree-file-detail">
        <PathDetail label="逻辑路径" value={item.logicalPath} />
        <PathDetail label="实际位置" value={item.storagePath} />
        <dl>
          <div>
            <dt>内容大小</dt>
            <dd>{formatBytes(item.sizeBytes)}</dd>
          </div>
          <div>
            <dt>实际占用</dt>
            <dd>
              {item.location === "external-reference"
                ? "0 B（文件位于外部地址）"
                : formatBytes(item.allocatedBytes)}
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
          <div>
            <dt>更新时间</dt>
            <dd>
              {item.modifiedAt ? (
                <time dateTime={item.modifiedAt} title={`UTC：${item.modifiedAt}`}>
                  {formatDate(item.modifiedAt, timeZone)}
                </time>
              ) : (
                "—"
              )}
            </dd>
          </div>
        </dl>
      </div>
    </details>
  );
}

function DirectoryMetrics({ directory }: { directory: StorageDirectoryNode }) {
  return (
    <span className="storage-tree-directory-metrics">
      <span>{directory.fileCount.toLocaleString()} 个文件</span>
      <strong>{formatBytes(directory.allocatedBytes)}</strong>
    </span>
  );
}

function PathDetail({ label, value }: { label: string; value: string }) {
  return (
    <div className="storage-tree-path-detail">
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
