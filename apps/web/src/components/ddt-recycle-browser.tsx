"use client";

import { Collapse, Tag } from "antd";
import {
  ChevronLeft,
  ChevronRight,
  Folder,
  FolderOpen,
  RotateCcw,
  Trash2,
  RefreshCw,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  ddtRecycleGroupPageSchema,
  ddtRecyclePurgePageSchema,
  ddtRecycleCasePageSchema,
  type DdtRecycleGroupPage,
} from "@autoforge/contracts";
import { Button } from "./ui/button";
import { OperationProgress } from "./ui";
import { EmptyState } from "./ui/empty-state";
import { Notice } from "./ui/notice";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "./ui/table";
import { useConfirm, useToast } from "./ui-feedback";
import { readApiError } from "@/lib/client-api";
import { clearBrowserSnapshots } from "@/lib/browser-read-cache";
import { formatPlatformDateTime } from "@/lib/platform-date-time";

type CasePage = ReturnType<typeof ddtRecycleCasePageSchema.parse>;
type RecycledCase = CasePage["items"][number];
type Endpoint = (path: string, parameters?: URLSearchParams) => string;
const EMPTY_GROUPS: DdtRecycleGroupPage = { items: [], totalCases: 0, totalGroups: 0 };

async function recycleRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store" });
  if (!response.ok)
    throw (
      (await readApiError(response, "回收站操作失败，请重试。")) ??
      new Error("回收站操作失败，请重试。")
    );
  return response.status === 204 ? (undefined as T) : (response.json() as Promise<T>);
}

export function DdtRecycleBrowser({
  endpoint,
  canManage,
  onCountChange,
}: {
  endpoint: Endpoint;
  canManage: boolean;
  onCountChange(count: number): void;
}) {
  const confirm = useConfirm();
  const toast = useToast();
  const [groups, setGroups] = useState(EMPTY_GROUPS);
  const [groupCursors, setGroupCursors] = useState<Array<string | undefined>>([undefined]);
  const [activeSr, setActiveSr] = useState<string | null>(null);
  const [cases, setCases] = useState<CasePage>({ items: [] });
  const [caseCursors, setCaseCursors] = useState<Array<string | undefined>>([undefined]);
  const [loading, setLoading] = useState(true);
  const [caseLoading, setCaseLoading] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState("");
  const [clearedCount, setClearedCount] = useState<number>();
  const groupsRequest = useRef<AbortController | null>(null);
  const folderRequest = useRef<AbortController | null>(null);
  const caseMutationRequest = useRef<AbortController | null>(null);
  const clearRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    groupsRequest.current = controller;
    void recycleRequest<unknown>(endpoint("recycle/groups"), { signal: controller.signal })
      .then((value) => {
        const page = ddtRecycleGroupPageSchema.parse(value);
        if (!controller.signal.aborted) {
          setGroups(page);
          onCountChange(page.totalCases);
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      groupsRequest.current?.abort();
      folderRequest.current?.abort();
      caseMutationRequest.current?.abort();
      clearRequest.current?.abort();
    };
  }, [endpoint, onCountChange]);

  async function readGroups(cursors = groupCursors) {
    groupsRequest.current?.abort();
    const controller = new AbortController();
    groupsRequest.current = controller;
    setLoading(true);
    try {
      const parameters = new URLSearchParams();
      const cursor = cursors.at(-1);
      if (cursor !== undefined) parameters.set("cursor", cursor);
      const page = ddtRecycleGroupPageSchema.parse(
        await recycleRequest(endpoint("recycle/groups", parameters), { signal: controller.signal }),
      );
      if (controller.signal.aborted) return;
      setGroups(page);
      setGroupCursors(cursors);
      onCountChange(page.totalCases);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  async function readFolder(srNum: string, cursors: Array<string | undefined> = [undefined]) {
    folderRequest.current?.abort();
    const controller = new AbortController();
    folderRequest.current = controller;
    if (activeSr !== srNum) {
      setCases({ items: [] });
      setCaseCursors([undefined]);
    }
    setActiveSr(srNum);
    setCaseLoading(true);
    setError("");
    try {
      const parameters = new URLSearchParams({ srNum, limit: "60" });
      const cursor = cursors.at(-1);
      if (cursor !== undefined) parameters.set("cursor", cursor);
      const page = ddtRecycleCasePageSchema.parse(
        await recycleRequest(endpoint("recycle", parameters), { signal: controller.signal }),
      );
      if (controller.signal.aborted) return;
      setCases(page);
      setCaseCursors(cursors);
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorMessage(cause));
    } finally {
      if (!controller.signal.aborted) setCaseLoading(false);
    }
  }

  async function changeGroupPage(cursors: Array<string | undefined>) {
    setError("");
    folderRequest.current?.abort();
    setActiveSr(null);
    setCases({ items: [] });
    try {
      await readGroups(cursors);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function mutateCase(item: RecycledCase, action: "restore" | "purge") {
    const restore = action === "restore";
    const srNum = activeSr ?? item.srNum;
    if (
      !restore &&
      !(await confirm({
        title: "永久删除 DDT 用例",
        description: `确认永久删除“${item.caseId}”？删除后无法恢复。`,
        confirmLabel: "永久删除",
        tone: "danger",
      }))
    )
      return;
    const controller = new AbortController();
    caseMutationRequest.current = controller;
    setMutating(true);
    setError("");
    try {
      await recycleRequest(
        endpoint(`recycle/${encodeURIComponent(item.id)}${restore ? "/restore" : ""}`),
        { method: restore ? "POST" : "DELETE", signal: controller.signal },
      );
      controller.signal.throwIfAborted();
      clearBrowserSnapshots();
      await readGroups([undefined]);
      await readFolder(srNum);
      toast.success(restore ? `已恢复 ${item.caseId}` : `已永久删除 ${item.caseId}`);
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorMessage(cause));
    } finally {
      if (!controller.signal.aborted) setMutating(false);
    }
  }

  async function clearRecycle() {
    if (
      !(await confirm({
        title: "清空 DDT 回收站",
        description: `将永久删除当前项目、版本和测试阶段回收站中的全部用例（当前 ${groups.totalCases} 条），不受当前展开的 SR 或分页影响。删除后无法恢复。`,
        confirmLabel: "确认清空",
        tone: "danger",
      }))
    )
      return;
    const controller = new AbortController();
    clearRequest.current = controller;
    setMutating(true);
    setClearedCount(0);
    setError("");
    let completed = 0;
    let deletedBefore: string | undefined;
    try {
      for (;;) {
        controller.signal.throwIfAborted();
        const page = ddtRecyclePurgePageSchema.parse(
          await recycleRequest(endpoint("recycle"), {
            method: "DELETE",
            signal: controller.signal,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ deletedBefore }),
          }),
        );
        deletedBefore = page.deletedBefore;
        completed += page.deletedCount;
        setClearedCount(completed);
        if (!page.hasMore) break;
        if (page.deletedCount === 0)
          throw new Error("剩余记录正在被其他操作使用，请稍后重试清空。");
      }
      toast.success(`已清空 ${completed} 条回收站记录。`);
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(`已清理 ${completed} 条。${errorMessage(cause)}，可重试清空剩余记录。`);
    } finally {
      clearBrowserSnapshots();
      if (!controller.signal.aborted) {
        setActiveSr(null);
        setCases({ items: [] });
        try {
          await readGroups([undefined]);
        } catch (cause) {
          setError(`已清理 ${completed} 条，刷新失败：${errorMessage(cause)}。请手动刷新回收站。`);
        }
        setMutating(false);
        setClearedCount(undefined);
      }
    }
  }

  return (
    <section className="ddt-recycle-browser grid min-w-0 gap-4" aria-label="DDT 回收站">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="m-0 text-base font-semibold">回收站</h3>
          <p className="m-0 mt-1 text-sm text-muted-foreground">
            按 SR 文件夹整理 · 共 {groups.totalCases} 条用例，{groups.totalGroups} 个 SR
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            disabled={mutating || loading}
            onClick={() => void changeGroupPage([undefined])}
          >
            <RefreshCw size={15} />
            刷新回收站
          </Button>
          {canManage ? (
            <Button
              type="button"
              variant="destructive"
              disabled={loading || mutating || !groups.totalCases}
              loading={clearedCount !== undefined}
              onClick={() => void clearRecycle()}
            >
              <Trash2 size={15} />
              清空回收站
            </Button>
          ) : null}
        </div>
      </header>
      {error ? (
        <Notice tone="error" role="alert">
          {error}
        </Notice>
      ) : null}
      {clearedCount !== undefined ? (
        <OperationProgress
          label="正在清空回收站"
          detail={`已永久删除 ${clearedCount} 条记录`}
          value={0}
          indeterminate
        />
      ) : null}
      {loading && !groups.items.length ? (
        <div role="status" className="p-6 text-center text-muted-foreground">
          正在读取 SR 文件夹…
        </div>
      ) : groups.items.length ? (
        <>
          <Collapse
            accordion
            destroyOnHidden
            activeKey={activeSr === null ? [] : [JSON.stringify(activeSr)]}
            onChange={(keys) => {
              if (mutating || loading) return;
              const key = Array.isArray(keys) ? keys[0] : keys;
              if (key === undefined) {
                folderRequest.current?.abort();
                setActiveSr(null);
                setCases({ items: [] });
              } else void readFolder(JSON.parse(key) as string);
            }}
            items={groups.items.map((group) => ({
              key: JSON.stringify(group.srNum),
              label: (
                <span className="inline-flex max-w-full items-center gap-2">
                  <span className="text-primary">
                    {activeSr === group.srNum ? <FolderOpen size={18} /> : <Folder size={18} />}
                  </span>
                  <span className="min-w-0 break-all font-medium">
                    {group.srNum || "未填写 SR"}
                  </span>
                  <Tag>{group.count} 条用例</Tag>
                </span>
              ),
              forceRender: false,
              children: (
                <div className="grid min-w-0 gap-3" aria-busy={caseLoading}>
                  {caseLoading ? (
                    <div role="status" className="p-4 text-muted-foreground">
                      正在读取用例…
                    </div>
                  ) : (
                    <>
                      <div className="max-h-[440px] min-w-0 overflow-auto">
                        <Table className="ddt-recycle-table w-full table-fixed">
                          <TableHeader>
                            <TableRow>
                              <TableHead>CaseID</TableHead>
                              <TableHead>来源</TableHead>
                              <TableHead className="w-52 whitespace-nowrap">删除时间</TableHead>
                              <TableHead className="w-56">操作</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {cases.items.map((item) => (
                              <TableRow key={item.id}>
                                <TableCell className="break-all font-medium">
                                  {item.caseId}
                                </TableCell>
                                <TableCell className="break-all">
                                  {item.sourceName || "—"}
                                </TableCell>
                                <TableCell className="whitespace-nowrap">
                                  {formatPlatformDateTime(item.deletedAt)}
                                </TableCell>
                                <TableCell>
                                  <div className="flex flex-nowrap items-center gap-1">
                                    {canManage ? (
                                      <>
                                        <Button
                                          type="button"
                                          variant="link"
                                          size="sm"
                                          disabled={mutating}
                                          onClick={() => void mutateCase(item, "restore")}
                                        >
                                          <RotateCcw size={14} />
                                          恢复
                                        </Button>
                                        <Button
                                          type="button"
                                          variant="link"
                                          size="sm"
                                          disabled={mutating}
                                          onClick={() => void mutateCase(item, "purge")}
                                        >
                                          <Trash2 size={14} />
                                          永久删除
                                        </Button>
                                      </>
                                    ) : (
                                      "—"
                                    )}
                                  </div>
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                      <RecyclePager
                        label="SR 用例"
                        page={caseCursors.length}
                        hasNext={cases.nextCursor !== undefined}
                        busy={mutating || caseLoading}
                        onPrevious={() => void readFolder(group.srNum, caseCursors.slice(0, -1))}
                        onNext={() =>
                          void readFolder(group.srNum, [...caseCursors, cases.nextCursor])
                        }
                      />
                    </>
                  )}
                </div>
              ),
            }))}
          />
          <RecyclePager
            label="SR 文件夹"
            page={groupCursors.length}
            hasNext={groups.nextCursor !== undefined}
            busy={loading || mutating}
            onPrevious={() => void changeGroupPage(groupCursors.slice(0, -1))}
            onNext={() => void changeGroupPage([...groupCursors, groups.nextCursor])}
          />
        </>
      ) : (
        <EmptyState>回收站为空，被删除的 DDT 用例将在此按 SR 整理。</EmptyState>
      )}
    </section>
  );
}

function RecyclePager({
  label,
  page,
  hasNext,
  busy,
  onPrevious,
  onNext,
}: {
  label: string;
  page: number;
  hasNext: boolean;
  busy: boolean;
  onPrevious(): void;
  onNext(): void;
}) {
  if (page === 1 && !hasNext) return null;
  return (
    <nav
      aria-label={`${label}分页`}
      className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3"
    >
      <span className="mr-2 text-sm text-muted-foreground">第 {page} 页</span>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={page === 1 || busy}
        onClick={onPrevious}
        aria-label={`上一页${label}`}
      >
        <ChevronLeft size={14} />
        上一页
      </Button>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={!hasNext || busy}
        onClick={onNext}
        aria-label={`下一页${label}`}
      >
        下一页
        <ChevronRight size={14} />
      </Button>
    </nav>
  );
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : "回收站操作失败，请重试。";
}
