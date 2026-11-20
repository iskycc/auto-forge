"use client";

import {
  Alert,
  Button,
  Card,
  Flex,
  Form,
  Input,
  Modal,
  Select,
  Table,
  Tag,
  Typography,
  Upload,
} from "antd";
import { useEffect, useState } from "react";
import {
  CASE_SUITE_MARKER_FILE_BYTES,
  CASE_SUITE_MARKER_HEADERS,
  CASE_SUITE_MARKER_TEXT_LIMIT,
  type CaseSuiteChangedMember,
  type CaseSuiteMarkerMember,
  type CaseSuiteMemberChange,
  type CaseSuiteMemberKind,
  type CaseSuiteMembershipPage,
} from "@autoforge/contracts";
import { throwApiErrorResponse } from "@/lib/client-api";
import { formatPlatformDateTime } from "@/lib/platform-date-time";
import { useCaseSuiteRevision } from "./case-suite-revision";
import { useConcurrentModificationFeedback } from "./concurrent-modification-feedback";

function useMembershipPage<T extends CaseSuiteMembershipPage<unknown>>(
  url: string,
  revision: number,
  enabled = true,
) {
  const [reply, setReply] = useState<{ key: string; page?: T; error?: string }>();
  const key = `${revision}:${url}`;
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(url, { cache: "no-store", signal: controller.signal });
        if (!response.ok) await throwApiErrorResponse(response, "读取任务用例信息失败。");
        const page = (await response.json()) as T;
        if (!controller.signal.aborted) setReply({ key, page });
      } catch (cause) {
        if (!controller.signal.aborted)
          setReply({
            key,
            error: cause instanceof Error ? cause.message : "读取任务用例信息失败。",
          });
      }
    }
    void load();
    return () => controller.abort();
  }, [url, key, enabled]);
  return {
    page: reply?.key === key ? reply.page : undefined,
    error: reply?.key === key ? reply.error : undefined,
    loading: reply?.key !== key,
  };
}

function PageActions({
  cursor,
  next,
  onPage,
}: {
  cursor?: string | undefined;
  next?: string | undefined;
  onPage(cursor?: string): void;
}) {
  return (
    <Flex justify="end" gap="small" wrap className="mt-3">
      <Button disabled={!cursor} onClick={() => onPage()}>
        回到首页
      </Button>
      <Button disabled={!next} onClick={() => onPage(next)}>
        下一页
      </Button>
    </Flex>
  );
}

function caseKindLabel(kind: CaseSuiteMemberKind) {
  return kind === "ddt" ? "DDT 用例" : "普通用例";
}

export function CaseSuiteMemberHistory({
  suiteId,
  timeZone,
}: {
  suiteId: string;
  timeZone: string;
}) {
  const { revision } = useCaseSuiteRevision();
  const [cursor, setCursor] = useState<string>();
  const [selected, setSelected] = useState<CaseSuiteMemberChange>();
  const base = `/api/v1/case-suites/${encodeURIComponent(suiteId)}/member-changes`;
  const url = cursor ? `${base}?cursor=${encodeURIComponent(cursor)}` : base;
  const { page, error, loading } = useMembershipPage<
    CaseSuiteMembershipPage<CaseSuiteMemberChange>
  >(url, revision);
  return (
    <Card title="用例变更记录">
      {error ? <Alert type="error" title={error} /> : null}
      <Table<CaseSuiteMemberChange>
        rowKey="id"
        size="small"
        pagination={false}
        tableLayout="fixed"
        loading={loading}
        dataSource={page?.items ?? []}
        locale={{ emptyText: "暂无新增或移除记录" }}
        columns={[
          {
            title: "操作时间",
            width: 160,
            render: (_, row) => formatPlatformDateTime(row.changedAt, timeZone),
          },
          {
            title: "变更",
            width: 128,
            render: (_, row) => (
              <Flex gap="small" align="center">
                <Tag color={row.operation === "add" ? "green" : "orange"} className="!me-0">
                  {row.operation === "add" ? "新增" : "移除"}
                </Tag>
                {row.count.toLocaleString()} 条
              </Flex>
            ),
          },
          { title: "用例类型", width: 92, render: (_, row) => caseKindLabel(row.kind) },
          {
            title: "操作人",
            width: 130,
            dataIndex: "actorName",
            ellipsis: true,
            render: (name: string | null) => name ?? "系统",
          },
          {
            title: "备注",
            dataIndex: "remark",
            ellipsis: true,
            render: (remark: string) => remark || "—",
          },
          {
            title: "操作",
            width: 104,
            render: (_, row) => (
              <Button type="link" size="small" onClick={() => setSelected(row)}>
                查看用例
              </Button>
            ),
          },
        ]}
      />
      <PageActions cursor={cursor} next={page?.nextCursor} onPage={setCursor} />
      {selected ? (
        <ChangeMemberDialog base={base} change={selected} onClose={() => setSelected(undefined)} />
      ) : null}
    </Card>
  );
}

function ChangeMemberDialog({
  base,
  change,
  onClose,
}: {
  base: string;
  change: CaseSuiteMemberChange;
  onClose(): void;
}) {
  const [cursor, setCursor] = useState<string>();
  const query = new URLSearchParams({ changeId: change.id, ...(cursor ? { cursor } : {}) });
  const { page, error, loading } = useMembershipPage<
    CaseSuiteMembershipPage<CaseSuiteChangedMember>
  >(`${base}?${query}`, 0);
  return (
    <Modal
      open
      title={`${change.operation === "add" ? "新增" : "移除"}的${caseKindLabel(change.kind)}（${change.count.toLocaleString()} 条）`}
      onCancel={onClose}
      footer={<Button onClick={onClose}>关闭</Button>}
      width={680}
    >
      {change.remark ? (
        <Typography.Paragraph className="whitespace-pre-wrap break-all">
          {change.remark}
        </Typography.Paragraph>
      ) : null}
      {error ? <Alert type="error" title={error} /> : null}
      <Table<CaseSuiteChangedMember>
        size="small"
        rowKey="caseId"
        loading={loading}
        pagination={false}
        scroll={{ y: "min(44vh, 420px)" }}
        dataSource={page?.items ?? []}
        columns={[{ title: "类路径 / CaseID", dataIndex: "caseLabel", ellipsis: true }]}
      />
      <PageActions cursor={cursor} next={page?.nextCursor} onPage={setCursor} />
    </Modal>
  );
}

export function CaseSuiteMarkersDialogButton({
  suiteId,
  canManage,
}: {
  suiteId: string;
  canManage: boolean;
}) {
  const { revision, acceptMutation } = useCaseSuiteRevision();
  const showConcurrentModification = useConcurrentModificationFeedback();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<CaseSuiteMemberKind>("standard");
  const [search, setSearch] = useState("");
  const [cursor, setCursor] = useState<string>();
  const [selected, setSelected] = useState<{ member: CaseSuiteMarkerMember; revision: number }>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ type: "success" | "error"; text: string }>();
  const [reload, setReload] = useState(0);
  const route = `/api/v1/case-suites/${encodeURIComponent(suiteId)}/markers`;
  const query = new URLSearchParams({ kind, search, ...(cursor ? { cursor } : {}) });
  const { page, error, loading } = useMembershipPage<
    CaseSuiteMembershipPage<CaseSuiteMarkerMember> & { revision: number }
  >(`${route}?${query}`, revision + reload, open);
  const closeDisabled = busy || selected !== undefined;

  function closeDialog() {
    if (!closeDisabled) setOpen(false);
  }

  async function mutate(request: RequestInit, expectedRevision: number, importing: boolean) {
    setBusy(true);
    setNotice(undefined);
    try {
      const response = await fetch(
        importing ? `${route}?revision=${expectedRevision}` : route,
        request,
      );
      if (!response.ok) await throwApiErrorResponse(response, "保存任务用例标识失败。");
      const saved = (await response.json()) as { revision: number; updatedCount: number };
      acceptMutation(expectedRevision, saved.revision);
      setReload((value) => value + 1);
      setSelected(undefined);
      setNotice({
        type: "success",
        text: importing
          ? `已导入 ${saved.updatedCount.toLocaleString()} 条用例标识。`
          : "用例标识已保存。",
      });
    } catch (cause) {
      if (await showConcurrentModification(cause)) return;
      setNotice({
        type: "error",
        text: cause instanceof Error ? cause.message : "保存任务用例标识失败。",
      });
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Button
        aria-haspopup="dialog"
        className="!h-9"
        color="default"
        variant="filled"
        onClick={() => {
          setNotice(undefined);
          setReload((value) => value + 1);
          setOpen(true);
        }}
      >
        用例标识
      </Button>
      <Modal
        open={open}
        title="任务用例标识"
        width={980}
        centered
        destroyOnHidden
        closable={!closeDisabled}
        keyboard={!closeDisabled}
        mask={{ closable: false }}
        onCancel={closeDialog}
        footer={
          <Button onClick={closeDialog} disabled={closeDisabled}>
            关闭
          </Button>
        }
      >
        <Flex vertical gap="middle">
          <Typography.Text type="secondary">
            每个用例可填写五个标识。导出失败结果时读取当前标识，历史执行也适用。
          </Typography.Text>
          <Flex justify="space-between" align="center" gap="small" wrap>
            <Flex gap="small" wrap align="center">
              <Select
                aria-label="标识用例类型"
                value={kind}
                options={[
                  { value: "standard", label: "普通用例" },
                  { value: "ddt", label: "DDT 用例" },
                ]}
                onChange={(value) => {
                  setKind(value);
                  setCursor(undefined);
                }}
              />
              <Input.Search
                aria-label="搜索标识用例"
                placeholder="搜索类路径 / CaseID"
                defaultValue={search}
                allowClear
                onSearch={(value) => {
                  setSearch(value.trim());
                  setCursor(undefined);
                }}
                className="!w-56"
              />
            </Flex>
            <Flex gap="small" wrap>
              <Button href={`${route}/export`}>导出标识</Button>
              {canManage ? (
                <Upload
                  accept=".xlsx"
                  maxCount={1}
                  showUploadList={false}
                  disabled={busy || !page}
                  beforeUpload={(file) => {
                    if (!page) return Upload.LIST_IGNORE;
                    if (file.size > CASE_SUITE_MARKER_FILE_BYTES) {
                      setNotice({ type: "error", text: "标识表不能超过 16 MiB。" });
                      return Upload.LIST_IGNORE;
                    }
                    const body = new FormData();
                    body.append("file", file);
                    void mutate({ method: "POST", body }, page.revision, true);
                    return Upload.LIST_IGNORE;
                  }}
                >
                  <Button loading={busy && !selected} disabled={busy || !page}>
                    导入标识
                  </Button>
                </Upload>
              ) : null}
            </Flex>
          </Flex>
          {notice && !selected ? <Alert type={notice.type} showIcon title={notice.text} /> : null}
          {error ? <Alert type="error" title={error} /> : null}
          <Table<CaseSuiteMarkerMember>
            rowKey="memberId"
            size="small"
            pagination={false}
            tableLayout="fixed"
            scroll={{ y: "min(42vh, 460px)" }}
            loading={loading}
            dataSource={page?.items ?? []}
            locale={{ emptyText: "没有匹配的任务用例" }}
            columns={[
              { title: "类路径 / CaseID", dataIndex: "caseLabel", ellipsis: true },
              ...CASE_SUITE_MARKER_HEADERS.map((title, index) => ({
                title,
                width: "11%",
                ellipsis: true,
                render: (_: unknown, row: CaseSuiteMarkerMember) => row.markers[index] || "—",
              })),
              ...(canManage
                ? [
                    {
                      title: "操作",
                      width: 88,
                      render: (_: unknown, row: CaseSuiteMarkerMember) => (
                        <Button
                          type="link"
                          size="small"
                          disabled={!page || busy}
                          onClick={() => {
                            if (page) {
                              setNotice(undefined);
                              setSelected({ member: row, revision: page.revision });
                            }
                          }}
                        >
                          编辑标识
                        </Button>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        </Flex>
        <PageActions cursor={cursor} next={page?.nextCursor} onPage={setCursor} />
        {selected ? (
          <MarkerEditor
            member={selected.member}
            busy={busy}
            error={notice?.type === "error" ? notice.text : undefined}
            onClose={() => setSelected(undefined)}
            onSave={(markers) =>
              void mutate(
                {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    expectedRevision: selected.revision,
                    edit: {
                      kind: selected.member.kind,
                      memberId: selected.member.memberId,
                      markers,
                    },
                  }),
                },
                selected.revision,
                false,
              )
            }
          />
        ) : null}
      </Modal>
    </>
  );
}

function MarkerEditor({
  member,
  busy,
  error,
  onClose,
  onSave,
}: {
  member: CaseSuiteMarkerMember;
  busy: boolean;
  error?: string | undefined;
  onClose(): void;
  onSave(values: string[]): void;
}) {
  const [form] = Form.useForm<{ markers: string[] }>();
  return (
    <Modal
      open
      title="编辑用例标识"
      okText="保存标识"
      cancelText="取消"
      confirmLoading={busy}
      onCancel={() => {
        if (!busy) onClose();
      }}
      onOk={() => form.submit()}
    >
      <Typography.Paragraph className="break-all">{member.caseLabel}</Typography.Paragraph>
      {error ? <Alert type="error" showIcon title={error} className="mb-3" /> : null}
      <Form
        form={form}
        layout="vertical"
        disabled={busy}
        initialValues={{
          markers: CASE_SUITE_MARKER_HEADERS.map((_, index) => member.markers[index] ?? ""),
        }}
        onFinish={({ markers }) => onSave(markers)}
      >
        {CASE_SUITE_MARKER_HEADERS.map((label, index) => (
          <Form.Item
            key={label}
            name={["markers", index]}
            label={label}
            rules={[{ max: CASE_SUITE_MARKER_TEXT_LIMIT }]}
          >
            <Input maxLength={CASE_SUITE_MARKER_TEXT_LIMIT} allowClear />
          </Form.Item>
        ))}
      </Form>
    </Modal>
  );
}
