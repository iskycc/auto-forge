"use client";
import { useEffect, useState } from "react";
import { Input, Select, Space, Table } from "antd";
import { Tags } from "lucide-react";
import type {
  DdtSrTag,
  DdtSrTagGroups,
  DdtSrTagPage,
  DdtSrTagScope,
  DdtSrTagMutation,
} from "@autoforge/contracts";
import { ddtSrTagGroupsSchema, ddtSrTagPageSchema, ddtSrTagSchema } from "@autoforge/contracts";
import { requestDdtJson } from "@/lib/ddt-client";
import { SrTagFileTransfer } from "./sr-tag-file-transfer";
import { ActionDialog } from "./action-dialog";
import { Button } from "./ui/button";
import { Notice } from "./ui/notice";

export function DdtSrTagManager({
  scope,
  canManage,
}: {
  scope: DdtSrTagScope;
  canManage: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
        <Tags size={15} /> SR 标签
      </Button>
      <ActionDialog
        open={open}
        inactive={importOpen}
        onClose={() => setOpen(false)}
        title="SR 标签"
        description="标签在本项目版本的所有测试阶段共用，与 SR 测试类关联独立。"
      >
        {open ? (
          <SrTagEditor
            scope={scope}
            canManage={canManage}
            importOpen={importOpen}
            onImportOpenChange={setImportOpen}
          />
        ) : null}
      </ActionDialog>
    </>
  );
}
function SrTagEditor({
  scope,
  canManage,
  importOpen,
  onImportOpenChange,
}: {
  scope: DdtSrTagScope;
  canManage: boolean;
  importOpen: boolean;
  onImportOpenChange: (open: boolean) => void;
}) {
  const url = `/api/v1/ddt/sr-tags?${new URLSearchParams(scope)}`;
  const [query, setQuery] = useState("");
  const [page, setPage] = useState<DdtSrTagGroups>({ items: [] });
  const [history, setHistory] = useState<Array<string | undefined>>([undefined]);
  const cursor = history.at(-1);
  const [tags, setTags] = useState<DdtSrTag[]>([]);
  const [tagQuery, setTagQuery] = useState("");
  const [tagCursor, setTagCursor] = useState<string>();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      void requestDdtJson<DdtSrTagGroups>(
        `${url}&view=groups&limit=20&query=${encodeURIComponent(query)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        { cache: "reload", signal: controller.signal },
      )
        .then((result) => {
          if (!controller.signal.aborted) setPage(ddtSrTagGroupsSchema.parse(result));
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted) setError(message(cause));
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 200);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [url, query, cursor, refresh]);
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void requestDdtJson<DdtSrTagPage>(`${url}&limit=50&query=${encodeURIComponent(tagQuery)}`, {
        cache: "reload",
        signal: controller.signal,
      })
        .then((result) => {
          if (!controller.signal.aborted) {
            setTags(ddtSrTagPageSchema.parse(result).items);
            setTagCursor(result.nextCursor);
          }
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted) setError(message(cause));
        });
    }, 200);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [url, tagQuery, refresh]);
  function refreshAssociations() {
    setLoading(true);
    setRefresh((value) => value + 1);
  }
  async function mutate(input: DdtSrTagMutation) {
    setBusy(true);
    setError("");
    try {
      const result = await requestDdtJson<unknown>(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (input.operation === "create") {
        const created = ddtSrTagSchema.parse(result);
        setTags((current) => [created, ...current.filter((tag) => tag.id !== created.id)]);
        setName("");
      }
      refreshAssociations();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }
  async function moreTags() {
    if (!tagCursor) return;
    setBusy(true);
    setError("");
    try {
      const result = await requestDdtJson<DdtSrTagPage>(
        `${url}&limit=50&query=${encodeURIComponent(tagQuery)}&cursor=${encodeURIComponent(tagCursor)}`,
        { cache: "reload" },
      );
      setTags((current) => [...current, ...ddtSrTagPageSchema.parse(result).items]);
      setTagCursor(result.nextCursor);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="grid min-w-0 gap-4">
      <SrTagFileTransfer
        key={`${scope.projectId}:${scope.projectVersionId}`}
        url={url}
        canManage={canManage}
        disabled={busy || loading}
        open={importOpen}
        onOpenChange={onImportOpenChange}
        onBusyChange={setBusy}
        onImported={refreshAssociations}
      />
      {error ? (
        <Notice tone="error" role="alert">
          {error}
          <Button
            type="button"
            variant="link"
            onClick={() => {
              setError("");
              refreshAssociations();
            }}
          >
            重试
          </Button>
        </Notice>
      ) : null}
      {canManage ? (
        <Space.Compact className="w-full">
          <Input
            aria-label="新标签名称"
            maxLength={64}
            placeholder="新建标签，例如 Wallet、回归范围"
            value={name}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
            onPressEnter={() => {
              if (name.trim()) void mutate({ operation: "create", name: name.trim() });
            }}
          />
          <Button
            type="button"
            disabled={busy || !name.trim()}
            onClick={() => void mutate({ operation: "create", name: name.trim() })}
          >
            新建标签
          </Button>
        </Space.Compact>
      ) : null}
      <Input.Search
        aria-label="搜索 SR 标签关联"
        placeholder="搜索 SR"
        allowClear
        value={query}
        disabled={busy}
        onChange={(event) => {
          setQuery(event.target.value);
          setHistory([undefined]);
        }}
      />
      <Table
        size="small"
        className="[&_.ant-table-body]:min-h-[min(20rem,35dvh)]"
        rowKey="srNum"
        loading={loading}
        pagination={false}
        dataSource={page.items}
        scroll={{ y: "min(320px, 35dvh)", x: 560 }}
        columns={[
          { title: "SR", dataIndex: "srNum", width: 180, ellipsis: true },
          { title: "用例数", dataIndex: "caseCount", width: 80 },
          {
            title: "标签",
            render: (_, row) => (
              <Select
                aria-label={`SR ${row.srNum} 的标签`}
                className="w-full min-w-0"
                mode="multiple"
                maxTagCount="responsive"
                placeholder="选择标签"
                value={row.tags.map((tag) => tag.id)}
                disabled={!canManage || busy || loading}
                showSearch={{ filterOption: false, onSearch: setTagQuery }}
                options={[
                  ...new Map(
                    [...tags, ...row.tags].map((tag) => [
                      tag.id,
                      { value: tag.id, label: tag.name },
                    ]),
                  ).values(),
                ]}
                onSelect={(tagId: string) =>
                  void mutate({ operation: "assign", tagId, srNum: row.srNum, assigned: true })
                }
                onDeselect={(tagId: string) =>
                  void mutate({ operation: "assign", tagId, srNum: row.srNum, assigned: false })
                }
                popupRender={(menu) => (
                  <>
                    {menu}
                    {tagCursor ? (
                      <Button
                        type="button"
                        variant="link"
                        disabled={busy}
                        onClick={() => void moreTags()}
                      >
                        加载更多标签
                      </Button>
                    ) : null}
                  </>
                )}
              />
            ),
          },
        ]}
      />
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
        <span>每页 20 个 SR · 标签修改后自动保存</span>
        <Space>
          <Button
            type="button"
            variant="secondary"
            disabled={busy || loading || history.length === 1}
            onClick={() => setHistory((current) => current.slice(0, -1))}
          >
            上一页
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={busy || loading || !page.nextCursor}
            onClick={() => setHistory((current) => [...current, page.nextCursor])}
          >
            下一页
          </Button>
        </Space>
      </div>
    </div>
  );
}
function message(cause: unknown) {
  return cause instanceof Error ? cause.message : "无法读取或保存 SR 标签，请重试。";
}
