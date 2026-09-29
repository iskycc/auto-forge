"use client";
import { useEffect, useRef, useState } from "react";
import { Alert, Button, Flex, Input, Table, Tag, Typography } from "antd";
import type { DdtScope } from "@autoforge/domain";
import type { DdtChangeCandidate, DdtChangeItem } from "@autoforge/application";
import type { DdtChangeSelection } from "@autoforge/contracts";
import { ActionDialog } from "./action-dialog";
import { DdtChangeDiff } from "./ddt-change-diff";
import { debugRequest } from "@/lib/case-debug-client";
import { useToast } from "./ui-feedback";

type CandidatePage = { items: DdtChangeCandidate[]; nextCursor?: string };
export function DdtChangeSubmitDialog({
  scope,
  onClose,
  onSubmitted,
}: {
  scope: DdtScope;
  onClose(): void;
  onSubmitted(): void;
}) {
  const baseUrl = `/api/v1/ddt-changes?${new URLSearchParams(scope)}`;
  const [page, setPage] = useState<CandidatePage>({ items: [] });
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [cursors, setCursors] = useState<string[]>([""]);
  const [selected, setSelected] = useState<Map<string, DdtChangeSelection>>(new Map());
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");
  const [loadedQuery, setLoadedQuery] = useState("");
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<DdtChangeItem>();
  const [detailError, setDetailError] = useState("");
  const [fields, setFields] = useState<string[]>();
  const [openingCase, setOpeningCase] = useState("");
  const requestId = useRef("");
  const toast = useToast();
  const cursor = cursors.at(-1) ?? "";
  const pageUrl =
    baseUrl.replace("?", "/candidates?") +
    `&query=${encodeURIComponent(appliedQuery)}&cursor=${encodeURIComponent(cursor)}`;
  const readKey = `${pageUrl}:${refreshRevision}`;
  const loading = loadedQuery !== readKey;
  useEffect(() => {
    const controller = new AbortController();
    void debugRequest<CandidatePage>(pageUrl, { signal: controller.signal })
      .then((next) => {
        if (!controller.signal.aborted) {
          setPage(next);
          setError("");
        }
      })
      .catch((problem: unknown) => {
        if (!controller.signal.aborted) setError(message(problem));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadedQuery(readKey);
      });
    return () => controller.abort();
  }, [pageUrl, readKey]);
  async function inspect(candidate: DdtChangeCandidate) {
    setOpeningCase(candidate.caseId);
    setError("");
    try {
      const item = await debugRequest<DdtChangeItem>(
        baseUrl.replace("?", `/candidates/${encodeURIComponent(candidate.caseId)}?`),
      );
      setDetail(item);
      setFields(selected.get(item.caseId)?.fields);
      setDetailError("");
    } catch (problem) {
      setError(message(problem));
    } finally {
      setOpeningCase("");
    }
  }
  function select(item: DdtChangeCandidate | DdtChangeItem, nextFields?: string[]) {
    if (!selected.has(item.caseId) && selected.size >= 50) {
      setDetailError("单次最多提交 50 个用例，请分批提交。");
      return false;
    }
    setSelected((previous) =>
      new Map(previous).set(item.caseId, {
        caseId: item.caseId,
        personalRevision: item.personalRevision,
        baseId: item.baseId,
        baseRevision: item.baseRevision,
        ...(nextFields ? { fields: nextFields } : {}),
      }),
    );
    return true;
  }
  async function submit() {
    if (!title.trim()) {
      setError("请填写变更标题。");
      return;
    }
    setBusy(true);
    setError("");
    requestId.current ||= crypto.randomUUID();
    try {
      await debugRequest(baseUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: requestId.current,
          title,
          description,
          cases: [...selected.values()],
        }),
      });
      toast.success("变更已提交，等待具有用例管理权限的管理员审核。");
      onSubmitted();
    } catch (problem) {
      setError(message(problem));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <ActionDialog
        open
        title="提交 DDT 变更"
        description="将选中的个人调试差异提交至当前版本和测试阶段，审核通过后才更新正式库。"
        onClose={onClose}
        closeDisabled={busy || !!openingCase}
        inactive={!!detail}
        protectUnsavedChanges
        className="w-[min(960px,calc(100vw-3rem))]"
        footer={
          <>
            <Button disabled={busy} onClick={onClose}>
              取消
            </Button>
            <Button
              type="primary"
              loading={busy}
              disabled={!selected.size || loading}
              onClick={() => void submit()}
            >
              提交审核（{selected.size}）
            </Button>
          </>
        }
      >
        <div className="grid min-w-0 gap-4">
          <Alert
            showIcon
            type="info"
            title="只显示有差异的个人用例"
            description="可在“选择字段”中排除个人账号等调试数据。相同数据不会提交；未选择的正式用例保持原样。"
          />
          {error ? <Alert showIcon type="error" title={error} /> : null}
          <div className="grid gap-2">
            <label htmlFor="ddt-change-title">变更标题</label>
            <Input
              id="ddt-change-title"
              maxLength={160}
              value={title}
              disabled={busy}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="说明这批用例修改的目的"
            />
          </div>
          <div className="grid gap-2">
            <label htmlFor="ddt-change-description">变更说明（可选）</label>
            <Input.TextArea
              id="ddt-change-description"
              maxLength={4000}
              autoSize={{ minRows: 2, maxRows: 4 }}
              value={description}
              disabled={busy}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <Flex wrap gap="small" align="center" justify="space-between">
            <Input.Search
              aria-label="筛选差异 CaseId"
              placeholder="按 CaseId 筛选"
              maxLength={512}
              className="!w-72 !max-w-full"
              value={query}
              disabled={busy || loading}
              onChange={(e) => setQuery(e.target.value)}
              onSearch={() => {
                setAppliedQuery(query.trim());
                setCursors([""]);
              }}
              enterButton="查找"
            />
            <Button
              disabled={busy || loading}
              onClick={() => {
                setSelected(new Map());
                setCursors([""]);
                setRefreshRevision((value) => value + 1);
              }}
            >
              刷新差异
            </Button>
            <Button disabled={busy || !selected.size} onClick={() => setSelected(new Map())}>
              清空选择（{selected.size}）
            </Button>
          </Flex>
          <Table
            size="small"
            rowKey="caseId"
            tableLayout="fixed"
            pagination={false}
            loading={loading}
            dataSource={page.items}
            locale={{ emptyText: "当前这页没有差异；可继续查看下一页，或先导入、编辑个人数据。" }}
            rowSelection={{
              columnWidth: 36,
              preserveSelectedRowKeys: true,
              selectedRowKeys: [...selected.keys()],
              getCheckboxProps: (item) => ({
                disabled: busy || (!selected.has(item.caseId) && selected.size >= 50),
                "aria-label": `选择 ${item.caseId}`,
              }),
              onSelect: (item, checked) => {
                if (checked) select(item);
                else
                  setSelected((previous) => {
                    const next = new Map(previous);
                    next.delete(item.caseId);
                    return next;
                  });
              },
              onSelectAll: (checked, _, changed) =>
                setSelected((previous) => {
                  const next = new Map(previous);
                  for (const item of changed) {
                    if (checked && next.size < 50)
                      next.set(item.caseId, {
                        caseId: item.caseId,
                        personalRevision: item.personalRevision,
                        baseId: item.baseId,
                        baseRevision: item.baseRevision,
                      });
                    else if (!checked) next.delete(item.caseId);
                  }
                  return next;
                }),
            }}
            columns={[
              {
                title: "CaseId",
                dataIndex: "caseId",
                render: (value: string) => (
                  <Typography.Text
                    className="[overflow-wrap:anywhere] [&_.ant-typography-copy]:!h-8 [&_.ant-typography-copy]:!w-8"
                    copyable
                  >
                    {value}
                  </Typography.Text>
                ),
              },
              {
                title: "差异",
                width: 130,
                render: (_, item) => (
                  <>
                    <Tag color={item.baseId ? "blue" : "green"}>
                      {item.baseId ? "修改" : "新增"}
                    </Tag>
                    <Typography.Text type="secondary">
                      {selected.get(item.caseId)?.fields?.length ?? item.changeCount} 项
                    </Typography.Text>
                  </>
                ),
              },
              {
                title: "操作",
                width: 110,
                render: (_, item) => (
                  <Button
                    type="link"
                    size="small"
                    disabled={busy || !!openingCase}
                    loading={openingCase === item.caseId}
                    onClick={() => void inspect(item)}
                  >
                    选择字段
                  </Button>
                ),
              },
            ]}
          />
          <Flex align="center" justify="space-between" gap="small" wrap>
            <Typography.Text type="secondary">
              第 {cursors.length} 页 · 已选 {selected.size} / 50 个用例
            </Typography.Text>
            <Flex gap="small">
              <Button
                disabled={loading || busy || cursors.length === 1}
                onClick={() => setCursors((previous) => previous.slice(0, -1))}
              >
                上一页
              </Button>
              <Button
                disabled={loading || busy || !page.nextCursor}
                onClick={() => setCursors((previous) => [...previous, page.nextCursor!])}
              >
                下一页
              </Button>
            </Flex>
          </Flex>
        </div>
      </ActionDialog>
      {detail ? (
        <ActionDialog
          open
          title="选择合入字段"
          description={detail.caseId}
          className="w-[min(900px,calc(100vw-3rem))]"
          onClose={() => setDetail(undefined)}
          footer={
            <>
              <Button onClick={() => setDetail(undefined)}>取消</Button>
              <Button
                type="primary"
                disabled={fields?.length === 0}
                onClick={() => {
                  if (select(detail, fields)) setDetail(undefined);
                }}
              >
                保存选择
              </Button>
            </>
          }
        >
          <div className="grid min-w-0 gap-3">
            {detailError ? <Alert type="error" title={detailError} showIcon /> : null}
            {!detail.baseId ? (
              <Alert
                type="info"
                title="新增用例提交完整数据；如需调整个人字段，请先编辑个人调试数据。"
              />
            ) : null}
            <DdtChangeDiff
              item={detail}
              fields={fields}
              {...(detail.baseId ? { onFieldsChange: setFields } : {})}
            />
          </div>
        </ActionDialog>
      ) : null}
    </>
  );
}
function message(problem: unknown) {
  return problem instanceof Error ? problem.message : "操作失败，请重试。";
}
