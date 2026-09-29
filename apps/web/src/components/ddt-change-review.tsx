"use client";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Alert,
  Button,
  Collapse,
  Empty,
  Flex,
  Input,
  Select,
  Spin,
  Table,
  Tag,
  Typography,
} from "antd";
import type { DdtScope } from "@autoforge/domain";
import type {
  DdtChangeRequest,
  DdtChangeRequestSummary,
  DdtChangeStatus,
} from "@autoforge/application";
import type { ReviewDdtChangeRequest } from "@autoforge/contracts";
import { ActionDialog } from "./action-dialog";
import { DdtChangeDiff } from "./ddt-change-diff";
import { DdtChangeSubmitDialog } from "./ddt-change-submit-dialog";
import { debugRequest } from "@/lib/case-debug-client";
import { formatPlatformDateTime } from "@/lib/platform-date-time";
import { clearBrowserSnapshots } from "@/lib/browser-read-cache";
import { useConfirm, useToast } from "./ui-feedback";

const statuses = {
  pending: { text: "待审核", color: "processing" },
  approved: { text: "已合入", color: "success" },
  rejected: { text: "已退回", color: "error" },
  withdrawn: { text: "已撤回", color: "default" },
} as const;
type RequestPage = { items: DdtChangeRequestSummary[]; nextCursor?: string };

export function DdtDebugChangeActions({ scope }: { scope: DdtScope }) {
  const [dialog, setDialog] = useState<"submit" | "history">();
  return (
    <>
      <Flex gap="small" wrap>
        <Button type="primary" onClick={() => setDialog("submit")}>
          提交变更
        </Button>
        <Button onClick={() => setDialog("history")}>我的申请</Button>
      </Flex>
      {dialog === "submit" ? (
        <DdtChangeSubmitDialog
          scope={scope}
          onClose={() => setDialog(undefined)}
          onSubmitted={() => setDialog("history")}
        />
      ) : null}
      {dialog === "history" ? (
        <ActionDialog
          open
          title="我的 DDT 变更申请"
          description="跟踪当前版本和测试阶段的提交与审核结果。"
          className="w-[min(1000px,calc(100vw-3rem))]"
          onClose={() => setDialog(undefined)}
        >
          <DdtChangeReview scope={scope} canReview={false} />
        </ActionDialog>
      ) : null}
    </>
  );
}

export function DdtChangeReview({
  scope,
  canReview,
  syncFilters = false,
}: {
  scope: DdtScope;
  canReview: boolean;
  syncFilters?: boolean;
}) {
  const parameters = useSearchParams();
  const [localStatus, setLocalStatus] = useState<DdtChangeStatus | "all">("all");
  const [localMine, setLocalMine] = useState(!canReview);
  const status = syncFilters ? reviewStatus(parameters.get("reviewStatus")) : localStatus;
  const mine = !canReview || (syncFilters ? parameters.get("reviewMine") === "true" : localMine);
  function setStatus(value: DdtChangeStatus | "all") {
    if (syncFilters) updateFilter("reviewStatus", value);
    else setLocalStatus(value);
  }
  function setMine(value: boolean) {
    if (syncFilters) updateFilter("reviewMine", String(value));
    else setLocalMine(value);
  }
  const [page, setPage] = useState<RequestPage>({ items: [] });
  const [cursors, setCursors] = useState<string[]>([""]);
  const [revision, setRevision] = useState(0);
  const [loadedQuery, setLoadedQuery] = useState("");
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<string>();
  const endpoint = `/api/v1/ddt-changes?${new URLSearchParams(scope)}`;
  const filterKey = `${endpoint}:${mine}:${status}`;
  const [previousFilterKey, setPreviousFilterKey] = useState(filterKey);
  // URL history navigation changes filters without invoking Select.onChange.
  // Reset before rendering so a cursor from another result set is never fetched.
  if (previousFilterKey !== filterKey) {
    setPreviousFilterKey(filterKey);
    setCursors([""]);
    setSelectedId(undefined);
  }
  const cursor = cursors.at(-1) ?? "";
  const pageUrl = `${endpoint}&mine=${mine}&cursor=${encodeURIComponent(cursor)}${status === "all" ? "" : `&status=${status}`}`;
  const readKey = `${pageUrl}:${revision}`;
  const loading = loadedQuery !== readKey;
  useEffect(() => {
    const controller = new AbortController();
    void debugRequest<RequestPage>(pageUrl, { signal: controller.signal })
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
  return (
    <div className="grid min-w-0 gap-4" aria-label="DDT 变更审核">
      <Flex wrap justify="space-between" align="center" gap="middle">
        <div className="min-w-0">
          <Typography.Title level={4} className="!mb-1">
            {canReview ? "变更审核" : "我的申请"}
          </Typography.Title>
          <Typography.Text type="secondary">
            提交的差异独立留存；合入会追加正式用例历史。
          </Typography.Text>
        </div>
        <Flex wrap gap="small">
          {canReview ? (
            <Select
              aria-label="变更提交范围"
              className="min-w-32"
              value={mine ? "mine" : "all"}
              onChange={(value) => {
                setMine(value === "mine");
              }}
              options={[
                { value: "all", label: "全部申请" },
                { value: "mine", label: "我的申请" },
              ]}
            />
          ) : null}
          <Select
            aria-label="审核状态"
            className="min-w-32"
            value={status}
            onChange={(value) => {
              setStatus(value);
            }}
            options={[
              { value: "all", label: "全部状态" },
              ...Object.entries(statuses).map(([value, label]) => ({ value, label: label.text })),
            ]}
          />
          <Button
            aria-label="刷新"
            loading={loading}
            onClick={() => setRevision((value) => value + 1)}
          >
            刷新
          </Button>
        </Flex>
      </Flex>
      {error ? <Alert type="error" showIcon title={error} /> : null}
      <Table
        size="small"
        rowKey="id"
        tableLayout="fixed"
        pagination={false}
        loading={loading}
        dataSource={page.items}
        locale={{
          emptyText: (
            <Empty
              description="暂无变更申请，可在用例调试的 DDT 页提交差异。"
              image={Empty.PRESENTED_IMAGE_SIMPLE}
            />
          ),
        }}
        columns={[
          {
            title: "变更内容",
            key: "title",
            render: (_, item) => (
              <div className="grid min-w-0 gap-1">
                <Button
                  type="link"
                  className="!h-auto !min-h-8 !justify-start !p-0 !text-left !whitespace-normal [overflow-wrap:anywhere]"
                  onClick={() => setSelectedId(item.id)}
                >
                  {item.title}
                </Button>
                <Typography.Text type="secondary" className="text-xs">
                  {item.caseCount} 个用例 · {formatPlatformDateTime(item.createdAt)}
                </Typography.Text>
              </div>
            ),
          },
          {
            title: "提交人",
            dataIndex: "ownerName",
            width: "19%",
            render: (name: string) => <span className="[overflow-wrap:anywhere]">{name}</span>,
          },
          {
            title: "状态",
            width: 90,
            render: (_, item) => (
              <Tag color={statuses[item.status].color}>{statuses[item.status].text}</Tag>
            ),
          },
          {
            title: "操作",
            width: 90,
            render: (_, item) => (
              <Button size="small" onClick={() => setSelectedId(item.id)}>
                {canReview && item.status === "pending" ? "查看审核" : "查看详情"}
              </Button>
            ),
          },
        ]}
      />
      <Flex wrap justify="space-between" align="center" gap="small">
        <Typography.Text type="secondary">
          第 {cursors.length} 页 · 本页 {page.items.length} 条
        </Typography.Text>
        <Flex gap="small">
          <Button
            disabled={loading || cursors.length === 1}
            onClick={() => setCursors((previous) => previous.slice(0, -1))}
          >
            上一页
          </Button>
          <Button
            disabled={loading || !page.nextCursor}
            onClick={() => setCursors((previous) => [...previous, page.nextCursor!])}
          >
            下一页
          </Button>
        </Flex>
      </Flex>
      {selectedId ? (
        <DdtChangeReviewDialog
          scope={scope}
          id={selectedId}
          canReview={canReview}
          canWithdraw={mine}
          onClose={() => setSelectedId(undefined)}
          onChanged={() => setRevision((value) => value + 1)}
        />
      ) : null}
    </div>
  );
}

function DdtChangeReviewDialog({
  scope,
  id,
  canReview,
  canWithdraw,
  onClose,
  onChanged,
}: {
  scope: DdtScope;
  id: string;
  canReview: boolean;
  canWithdraw: boolean;
  onClose(): void;
  onChanged(): void;
}) {
  const [request, setRequest] = useState<DdtChangeRequest>();
  const [comment, setComment] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const endpoint = `/api/v1/ddt-changes/${id}?${new URLSearchParams(scope)}`;
  const confirm = useConfirm();
  const toast = useToast();
  useEffect(() => {
    const controller = new AbortController();
    void debugRequest<DdtChangeRequest>(endpoint, { signal: controller.signal })
      .then(setRequest)
      .catch((problem: unknown) => {
        if (!controller.signal.aborted) setError(message(problem));
      });
    return () => controller.abort();
  }, [endpoint]);
  async function review(action: ReviewDdtChangeRequest["action"]) {
    if (action === "reject" && !comment.trim()) {
      setError("退回时请填写原因，便于提交人修改。");
      return;
    }
    const verb = action === "approve" ? "合入" : action === "reject" ? "退回" : "撤回";
    if (
      !(await confirm({
        title: `确认${verb}变更`,
        description:
          action === "approve"
            ? `将本申请的 ${request?.caseCount} 个用例差异写入当前版本正式库。如正式数据已变化，整单停止合入并提示冲突。`
            : `${verb}后，本申请不会写入正式用例库；记录仍可查看。`,
        confirmLabel: `确认${verb}`,
        cancelLabel: "取消",
        tone: action === "approve" ? "default" : "warning",
      }))
    )
      return;
    setBusy(true);
    setError("");
    try {
      const result = await debugRequest<DdtChangeRequest>(endpoint.replace("?", "/review?"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, comment }),
      });
      setRequest(result);
      onChanged();
      if (action === "approve") clearBrowserSnapshots();
      toast.success(`变更已${verb}。`);
    } catch (problem) {
      setError(message(problem));
    } finally {
      setBusy(false);
    }
  }
  const pending = request?.status === "pending";
  return (
    <ActionDialog
      open
      title="DDT 变更详情"
      description={request?.title ?? "正在读取差异快照"}
      className="w-[min(1040px,calc(100vw-3rem))]"
      onClose={onClose}
      closeDisabled={busy}
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>
            关闭
          </Button>
          {pending && canWithdraw ? (
            <Button disabled={busy} onClick={() => void review("withdraw")}>
              撤回申请
            </Button>
          ) : null}
          {pending && canReview ? (
            <>
              <Button danger disabled={busy} onClick={() => void review("reject")}>
                退回修改
              </Button>
              <Button
                aria-label="审核并合入"
                type="primary"
                loading={busy}
                onClick={() => void review("approve")}
              >
                审核并合入
              </Button>
            </>
          ) : null}
        </>
      }
    >
      <div className="grid min-w-0 gap-4">
        {error ? <Alert type="error" showIcon title={error} /> : null}
        {!request && !error ? <Spin /> : null}
        {request ? (
          <>
            <Flex wrap gap="small" align="center">
              <Tag color={statuses[request.status].color}>{statuses[request.status].text}</Tag>
              <Typography.Text className="[overflow-wrap:anywhere]">
                {request.ownerName} · {formatPlatformDateTime(request.createdAt)}
              </Typography.Text>
              <Typography.Text type="secondary">{request.caseCount} 个用例</Typography.Text>
            </Flex>
            {request.description ? (
              <Typography.Paragraph className="!mb-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
                {request.description}
              </Typography.Paragraph>
            ) : null}
            <Collapse
              size="small"
              defaultActiveKey={request.items.length === 1 ? ["0"] : []}
              items={request.items.map((item, index) => ({
                key: String(index),
                label: (
                  <Flex className="min-w-0" align="start" gap="small">
                    <Tag color={item.baseId ? "blue" : "green"}>
                      {item.baseId ? "修改" : "新增"}
                    </Tag>
                    <span className="min-w-0 [overflow-wrap:anywhere]">{item.caseId}</span>
                  </Flex>
                ),
                children: <DdtChangeDiff item={item} />,
              }))}
            />
            {pending && canReview ? (
              <div className="grid gap-2">
                <label htmlFor="ddt-change-review-comment">审核意见（退回时必填）</label>
                <Input.TextArea
                  id="ddt-change-review-comment"
                  maxLength={4000}
                  autoSize={{ minRows: 2, maxRows: 5 }}
                  value={comment}
                  disabled={busy}
                  onChange={(event) => setComment(event.target.value)}
                />
              </div>
            ) : null}
            {!pending ? (
              <Alert
                type={request.status === "approved" ? "success" : "info"}
                showIcon
                title={`${request.reviewerName ?? "用户"} · ${request.reviewedAt ? formatPlatformDateTime(request.reviewedAt) : ""}`}
                description={
                  <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                    {request.reviewComment || "未填写意见"}
                  </span>
                }
              />
            ) : null}
          </>
        ) : null}
      </div>
    </ActionDialog>
  );
}
function message(problem: unknown) {
  return problem instanceof Error ? problem.message : "读取变更失败，请重试。";
}

function reviewStatus(value: string | null): DdtChangeStatus | "all" {
  return value === "pending" ||
    value === "approved" ||
    value === "rejected" ||
    value === "withdrawn"
    ? value
    : "all";
}
function updateFilter(name: string, value: string) {
  const url = new URL(window.location.href);
  url.searchParams.set(name, value);
  window.history.pushState(null, "", url);
}
