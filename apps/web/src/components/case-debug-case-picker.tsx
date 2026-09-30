"use client";

import { Empty, Flex, Spin, Tree, Typography, type TreeDataNode } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DirectoryBranch, ReadModelStatus } from "@autoforge/contracts";
import type { DdtScope } from "@autoforge/domain";
import { ActionDialog } from "./action-dialog";
import { Button, Input } from "./ui";
import { Notice } from "./ui/notice";
import { useDirectoryTree } from "./use-directory-tree";
import { debugRequest } from "@/lib/case-debug-client";
import { readLazyDirectoryBranch } from "@/lib/directory-tree";
import type { DirectoryProjection } from "@/lib/directory-projection";
import type { DebugInputChoice } from "./case-debug-input";

export function CaseDebugCasePicker({
  scope,
  value,
  onChoose,
  onClose,
}: {
  scope: DdtScope;
  value: DebugInputChoice | undefined;
  onChoose(choice: DebugInputChoice): void;
  onClose(): void;
}) {
  const [snapshot, setSnapshot] = useState<ReadModelStatus>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState(value);
  const scopeQuery = new URLSearchParams(scope).toString();
  useEffect(() => {
    const controller = new AbortController();
    void debugRequest<{ status: ReadModelStatus }>(
      `/api/v1/case-definitions/directory?${scopeQuery}`,
      {
        signal: controller.signal,
      },
    )
      .then((result) => {
        if (!controller.signal.aborted) setSnapshot(result.status);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "加载目录失败。");
      });
    return () => controller.abort();
  }, [scopeQuery, retry]);
  return (
    <ActionDialog
      open
      title="选择调试用例"
      description="按包目录展开选择，也可按类名或用例名称关键词搜索。仅显示当前项目、版本和测试阶段的用例。"
      onClose={onClose}
      className="w-[min(820px,calc(100vw-3rem))]"
      footer={
        <Flex gap="small" justify="space-between" align="center" className="min-w-0">
          <Typography.Text className="min-w-0 flex-1 [overflow-wrap:anywhere]" type="secondary">
            {selected ? `已选择：${selected.label}` : "请选择一个测试类"}
          </Typography.Text>
          <Button onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            disabled={!selected}
            onClick={() => selected && onChoose(selected)}
          >
            确认选择
          </Button>
        </Flex>
      }
    >
      {error ? (
        <Notice tone="error">
          {error}
          <Button
            onClick={() => {
              setError("");
              setRetry((value) => value + 1);
            }}
          >
            重试
          </Button>
        </Notice>
      ) : null}
      {snapshot ? (
        <CasePickerDirectory snapshot={snapshot} selected={selected} onSelect={setSelected} />
      ) : !error ? (
        <Spin aria-label="加载用例目录" />
      ) : null}
    </ActionDialog>
  );
}

function CasePickerDirectory({
  snapshot,
  selected,
  onSelect,
}: {
  snapshot: ReadModelStatus;
  selected: DebugInputChoice | undefined;
  onSelect(choice: DebugInputChoice): void;
}) {
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [retry, setRetry] = useState(0);
  const result = useDirectoryTree(
    snapshot,
    new URLSearchParams({ query: submittedQuery, outcome: "all" }).toString(),
  );
  return (
    <div className="grid min-w-0 gap-3">
      <Flex gap="small">
        <Input
          aria-label="搜索目录用例"
          placeholder="类名或用例名称关键词，不区分大小写"
          value={query}
          maxLength={200}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              setSubmittedQuery(query.trim());
            }
          }}
        />
        <Button onClick={() => setSubmittedQuery(query.trim())}>搜索</Button>
      </Flex>
      {result.error ? (
        <Notice tone="error">
          {result.error}
          <Button onClick={result.refresh}>重试</Button>
        </Notice>
      ) : null}
      <div
        className="h-[min(420px,48vh)] min-w-0 overflow-hidden rounded-lg border border-border bg-card p-2"
        aria-label="调试用例目录"
      >
        {result.loading ? (
          <Spin aria-label="加载目录搜索结果" />
        ) : result.projection ? (
          <LazyCaseTree
            key={`${result.projection.status.id}:${result.projection.status.generation}:${retry}`}
            projection={result.projection}
            selected={selected}
            onSelect={onSelect}
            onRetry={() => {
              setRetry((value) => value + 1);
              result.refresh();
            }}
          />
        ) : null}
      </div>
      <Typography.Text type="secondary" className="text-xs">
        目录展开时加载下级；搜索覆盖整个当前范围。选择后点击确认，取消不会修改调试配置。
      </Typography.Text>
    </div>
  );
}

type CaseTreeNode = TreeDataNode & {
  key: string;
  ordinal?: number;
  choice?: DebugInputChoice;
  continuation?: boolean;
  children?: CaseTreeNode[];
};

function mergeBranch(
  nodes: CaseTreeNode[],
  parent: string | undefined,
  children: CaseTreeNode[],
  append: boolean,
): CaseTreeNode[] {
  const merge = (existing: CaseTreeNode[]) =>
    append ? [...existing.filter((node) => !node.continuation), ...children] : children;
  if (!parent) return merge(nodes);
  return nodes.map((node) =>
    node.key === parent
      ? { ...node, children: merge(node.children ?? []) }
      : node.children
        ? { ...node, children: mergeBranch(node.children, parent, children, append) }
        : node,
  );
}

function branchNodes(
  branch: DirectoryBranch,
  parent: string | undefined,
  loadMore: (ordinal: number, parent: string | undefined, append: boolean) => Promise<void>,
): CaseTreeNode[] {
  const children: CaseTreeNode[] = [
    ...branch.directories
      .filter((entry) => entry.kind === "case")
      .map((entry) => ({
        key: `directory:${entry.path}`,
        ordinal: entry.ordinal,
        selectable: false,
        title: (
          <span className="[overflow-wrap:anywhere]">
            {entry.name}
            <span className="ml-2 text-muted-foreground">{entry.caseCount}</span>
          </span>
        ),
      })),
    ...branch.items.map((entry) => ({
      key: `case:${entry.id}`,
      isLeaf: true,
      choice: { id: entry.id, label: entry.className },
      title: (
        <span className="block min-w-0 py-0.5 [overflow-wrap:anywhere]">
          <span>{entry.displayName}</span>
          <span className="block text-xs text-muted-foreground">{entry.className}</span>
        </span>
      ),
    })),
  ];
  if (branch.nextOrdinal !== null)
    children.push({
      key: `${parent ?? "root"}:more`,
      isLeaf: true,
      selectable: false,
      continuation: true,
      title: (
        <Button
          onClick={(event) => {
            event.stopPropagation();
            void loadMore(branch.nextOrdinal!, parent, true);
          }}
        >
          加载更多用例或目录
        </Button>
      ),
    });
  return children;
}

function LazyCaseTree({
  projection,
  selected,
  onSelect,
  onRetry,
}: {
  projection: DirectoryProjection;
  selected: DebugInputChoice | undefined;
  onSelect(choice: DebugInputChoice): void;
  onRetry(): void;
}) {
  const [nodes, setNodes] = useState<CaseTreeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const controller = useRef<AbortController>(null);
  const pending = useRef(new Map<number, AbortSignal>());
  const viewport = useRef<HTMLDivElement>(null);
  const [treeHeight, setTreeHeight] = useState(300);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setTreeHeight(Math.max(1, Math.floor(entry.contentRect.height)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const loadBranch = useCallback(
    async function loadBranch(ordinal: number, parent?: string, append = false) {
      const signal = controller.current?.signal;
      if (!signal || signal.aborted) return;
      if (pending.current.get(ordinal) === signal) return;
      pending.current.set(ordinal, signal);
      setLoading(true);
      setError("");
      try {
        const branch = await readLazyDirectoryBranch({ projection, ordinal, signal });
        if (signal.aborted) return;
        setNodes((current) =>
          mergeBranch(current, parent, branchNodes(branch, parent, loadBranch), append),
        );
      } catch (cause) {
        if (!signal.aborted) setError(cause instanceof Error ? cause.message : "目录加载失败。");
      } finally {
        if (pending.current.get(ordinal) === signal) pending.current.delete(ordinal);
        if (!signal.aborted) setLoading(pending.current.size > 0);
      }
    },
    [projection],
  );
  useEffect(() => {
    const abort = new AbortController();
    controller.current = abort;
    const ordinal = projection.manifest?.rootOrdinal;
    if (ordinal !== undefined) void loadBranch(ordinal);
    return () => abort.abort();
  }, [loadBranch, projection.manifest?.rootOrdinal]);
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-2">
      {error ? (
        <Notice tone="error">
          {error}
          <Button onClick={onRetry}>重试</Button>
        </Notice>
      ) : null}
      {loading ? <Spin size="small" aria-label="加载目录分支" /> : null}
      {!loading && !nodes.length && !error ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的用例" />
      ) : null}
      <div ref={viewport} className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <Tree<CaseTreeNode>
          height={treeHeight}
          virtual
          blockNode
          showLine
          treeData={nodes}
          selectedKeys={selected ? [`case:${selected.id}`] : []}
          className="min-w-0 [&_.ant-tree-node-content-wrapper]:min-w-0 [&_.ant-tree-title]:whitespace-normal"
          loadData={(node) =>
            node.ordinal === undefined ? Promise.resolve() : loadBranch(node.ordinal, node.key)
          }
          onSelect={(_, { node }) => {
            if (node.choice) onSelect(node.choice);
          }}
        />
      </div>
    </div>
  );
}
