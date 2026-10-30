"use client";
import { CopyableText } from "@/components/ui/copyable-text";
import { SemanticStatusTag } from "@/components/ui/semantic-status-tag";
import { useEffect, useState, type Key } from "react";
import {
  Alert,
  Button,
  Card,
  DatePicker,
  Checkbox,
  InputNumber,
  Select,
  Tooltip,
  Flex,
  Form,
  Modal,
  Progress,
  Space,
  Table,
  Typography,
  theme,
} from "antd";
import {
  DownloadOutlined,
  FileZipOutlined,
  ReloadOutlined,
  SettingOutlined,
  DeleteOutlined,
} from "@ant-design/icons";
import type { Dayjs } from "dayjs";
import type { LogArchiveJob, LogArchiveOptions } from "@autoforge/contracts";
import { readApiError } from "@/lib/client-api";
import {
  archiveDownloadAvailable,
  archiveCopyRemovalBlocker,
} from "@/lib/log-archive-download-commands";
import { ArchiveDownloadCopy } from "./archive-download-copy";
type ArchiveFormOptions = LogArchiveOptions & { projectId?: string };

const labels: Record<LogArchiveJob["status"], string> = {
  queued: "等待归档",
  building: "压缩日志",
  verifying: "校验归档",
  ready: "已校验，待清理",
  cleaning: "清理原日志",
  completed: "已完成",
  failed: "处理失败",
  cancelled: "已取消",
};
function bytes(size: number) {
  return size >= 1024 ** 3
    ? `${(size / 1024 ** 3).toFixed(2)} GiB`
    : `${(size / 1024 ** 2).toFixed(1)} MiB`;
}
export function LogArchives({
  initial,
  canManage,
  projects = [],
}: {
  initial: { items: LogArchiveJob[]; nextCursor?: string };
  canManage: boolean;
  projects?: { id: string; name: string }[];
}) {
  const { token } = theme.useToken();
  const [page, setPage] = useState(initial);
  const [cursors, setCursors] = useState([""]);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [cleanup, setCleanup] = useState<LogArchiveJob>();
  const [removal, setRemoval] = useState<LogArchiveJob>();
  const [downloadVerified, setDownloadVerified] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [options, setOptions] = useState<ArchiveFormOptions>({
    targetVolumeMiB: 1024,
    minimumFreeMiB: 1024,
    minimumFreePercent: 10,
  });
  const [watchDownload, setWatchDownload] = useState<{ ids: string[]; until: number }>();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const selectedDownloads = page.items.filter(
    (job) => selectedIds.includes(job.id) && archiveDownloadAvailable(job),
  );
  async function refresh(cursor = cursors.at(-1)!) {
    const response = await fetch(
      `/api/v1/settings/log-archives${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
      { cache: "no-store" },
    );
    if (!response.ok) throw await readApiError(response, "归档列表读取失败。");
    setPage((await response.json()) as typeof initial);
  }
  useEffect(() => {
    if (
      !page.items.some(
        (job) =>
          ["queued", "building", "verifying", "cleaning"].includes(job.status) ||
          job.moreVolumesPending ||
          ["delete_requested", "deleting"].includes(job.copyState ?? ""),
      ) &&
      !(
        watchDownload &&
        watchDownload.until > Date.now() &&
        watchDownload.ids.some((id) => !page.items.find((job) => job.id === id)?.downloadedAt)
      )
    )
      return;
    const timer = setInterval(() => {
      if (document.hidden) return;
      void refresh().catch((cause) =>
        setError(cause instanceof Error ? cause.message : "归档状态读取失败。"),
      );
    }, 3000);
    return () => clearInterval(timer);
  });
  async function act(key: string, url: string, body?: unknown) {
    if (pending) return;
    setPending(key);
    setError("");
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      if (!response.ok) throw await readApiError(response, "日志归档操作失败。");
      await refresh("");
      setCursors([""]);
      setCleanup(undefined);
      setRemoval(undefined);
      setDownloadVerified(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "日志归档操作失败。");
    } finally {
      setPending("");
    }
  }
  async function changePage(next: string[]) {
    setError("");
    try {
      await refresh(next.at(-1)!);
      setCursors(next);
      setSelectedIds([]);
      setWatchDownload(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "翻页失败。");
    }
  }
  return (
    <Flex vertical gap="middle" aria-label="月度日志归档" style={{ minWidth: 0, maxWidth: "100%" }}>
      <Alert
        type="info"
        showIcon
        title="按执行结束月份归档 · 北京时间"
        description="按发起时已结束的批次逐卷归档，每卷独立校验并包含 Windows / Linux 离线查看器。清理原日志后仍可在线查看；完整下载并确认离线查看正常后，可单独删除平台归档副本以继续释放空间。"
      />
      <Card size="small" style={{ minWidth: 0, maxWidth: "100%" }}>
        <Flex justify="space-between" align="center" gap="middle" wrap>
          <Form
            layout="inline"
            onFinish={(values: { month: Dayjs }) =>
              void act("create", "/api/v1/settings/log-archives", {
                month: values.month.format("YYYY-MM"),
                ...options,
              })
            }
          >
            <Form.Item
              name="month"
              label="执行结束月份"
              rules={[{ required: true, message: "请选择月份。" }]}
            >
              <DatePicker picker="month" allowClear aria-label="执行结束月份" />
            </Form.Item>
            <Form.Item>
              <Button
                type="primary"
                aria-label="生成并校验归档包"
                icon={<FileZipOutlined />}
                htmlType="submit"
                disabled={!canManage || Boolean(pending)}
                loading={pending === "create"}
              >
                生成并校验归档包
              </Button>
            </Form.Item>
            <Form.Item>
              <Button
                aria-label="归档选项"
                icon={<SettingOutlined />}
                onClick={() => setOptionsOpen(true)}
              >
                归档选项
              </Button>
            </Form.Item>
          </Form>
          <Button
            aria-label="刷新状态"
            icon={<ReloadOutlined />}
            disabled={Boolean(pending)}
            onClick={() => void refresh().catch((cause) => setError(String(cause)))}
          >
            刷新状态
          </Button>
        </Flex>
        <Typography.Paragraph
          type="secondary"
          style={{ marginBottom: 0, marginTop: token.marginSM, overflowWrap: "anywhere" }}
        >
          范围：
          {options.projectId
            ? (projects.find((project) => project.id === options.projectId)?.name ?? "所选项目")
            : "全部项目"}
          {` · 按源存储约 ${options.targetVolumeMiB} MiB 分卷 · 安全余量 ${options.minimumFreeMiB} MiB / ${options.minimumFreePercent}%（取较大值）`}
        </Typography.Paragraph>
      </Card>
      {error ? <Alert type="error" showIcon title={error} /> : null}
      <Card title="归档记录" size="small" style={{ minWidth: 0, maxWidth: "100%" }}>
        {canManage ? (
          <Flex vertical gap="small" style={{ marginBottom: token.marginMD }}>
            <Flex align="center" justify="space-between" gap="small" wrap>
              <Typography.Text>
                已选 {selectedDownloads.length} 卷 · 可勾选本页已校验且保留副本的归档
              </Typography.Text>
              <ArchiveDownloadCopy
                archiveIds={selectedDownloads.map((job) => job.id)}
                onCopied={() =>
                  setWatchDownload({
                    ids: selectedDownloads.map((job) => job.id),
                    until: Date.now() + 600000,
                  })
                }
              />
            </Flex>
            <Typography.Text type="secondary">
              命令适用于 Linux／macOS Shell，逐卷下载到当前目录。临时直链最长 24
              小时有效，退出生成链接的登录会话或失去权限后失效，请妥善保管。
            </Typography.Text>
          </Flex>
        ) : null}
        <Table<LogArchiveJob>
          rowKey="id"
          pagination={false}
          dataSource={page.items}
          tableLayout="fixed"
          {...(canManage
            ? {
                rowSelection: {
                  selectedRowKeys: selectedDownloads.map((job) => job.id),
                  onChange: (keys: Key[]) => setSelectedIds(keys.map(String)),
                  getCheckboxProps: (job: LogArchiveJob) => ({
                    disabled: !archiveDownloadAvailable(job),
                    "aria-label": `选择归档 ${job.filename ?? job.id}`,
                  }),
                  columnWidth: 40,
                },
              }
            : {})}
          columns={[
            {
              title: "月份 / 归档",
              width: "28%",
              render: (_, job) => (
                <>
                  <Typography.Text strong>{job.month}</Typography.Text>
                  {job.groupId ? (
                    <Typography.Text
                      type="secondary"
                      style={{ marginLeft: token.marginXS }}
                      title={`归档组 ${job.groupId}`}
                    >
                      第 {job.volumeNumber ?? 1} 卷
                    </Typography.Text>
                  ) : null}
                  <Typography.Paragraph
                    type="secondary"
                    ellipsis={{ rows: 2, tooltip: job.filename }}
                    style={{ marginBottom: 0 }}
                  >
                    {job.filename ?? `归档 ${job.id.slice(-8)}`}
                  </Typography.Paragraph>
                  <Typography.Text
                    type="secondary"
                    title={`创建时间：${new Date(job.createdAt).toLocaleString("zh-CN", { hour12: false })}`}
                  >
                    {new Intl.DateTimeFormat("zh-CN", {
                      month: "2-digit",
                      day: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: false,
                    }).format(new Date(job.createdAt))}
                  </Typography.Text>
                </>
              ),
            },
            {
              title: "状态 / 进度",
              width: "24%",
              render: (_, job) => (
                <Space orientation="vertical" size={4} style={{ width: "100%" }}>
                  <SemanticStatusTag
                    tone={
                      job.status === "failed" || job.copyState === "delete_failed"
                        ? "danger"
                        : job.status === "completed"
                          ? "success"
                          : "info"
                    }
                  >
                    {copyStatusLabel(job) ?? labels[job.status]}
                  </SemanticStatusTag>
                  {job.sha256 &&
                  ["retained", "delete_failed"].includes(job.copyState ?? "retained") ? (
                    <Typography.Text type="secondary">
                      {job.downloadedAt ? "本账号已完整下载" : "本账号尚未完整下载"}
                    </Typography.Text>
                  ) : null}
                  {job.totalBatches ? (
                    <>
                      <Typography.Text type="secondary">
                        {job.status === "cleaning" || job.status === "completed"
                          ? job.cleanedBatches
                          : job.processedBatches}{" "}
                        / {job.totalBatches} 个批次
                      </Typography.Text>
                      <Progress
                        size="small"
                        percent={Math.round(
                          ((job.status === "cleaning" || job.status === "completed"
                            ? job.cleanedBatches
                            : job.processedBatches) /
                            job.totalBatches) *
                            100,
                        )}
                        showInfo={false}
                        status={
                          job.status === "completed"
                            ? "success"
                            : job.status === "failed"
                              ? "exception"
                              : "normal"
                        }
                      />
                    </>
                  ) : null}
                  {job.errorMessage || job.copyRemovalError ? (
                    <Typography.Paragraph
                      type="danger"
                      style={{ marginBottom: 0 }}
                      ellipsis={{ rows: 2, tooltip: job.copyRemovalError ?? job.errorMessage }}
                    >
                      {job.copyRemovalError ?? job.errorMessage}
                    </Typography.Paragraph>
                  ) : null}
                </Space>
              ),
            },
            {
              title: "日志 / 文件大小",
              width: "24%",
              render: (_, job) => (
                <Space orientation="vertical" size={0}>
                  <Typography.Text>{job.chunkCount.toLocaleString()} 个日志块</Typography.Text>
                  <Typography.Text type="secondary">正文 {bytes(job.sourceBytes)}</Typography.Text>
                  <Typography.Text type="secondary">归档 {bytes(job.archiveBytes)}</Typography.Text>
                  {job.estimatedTemporaryBytes ? (
                    <Tooltip
                      title={`临时空间估算包含分帧、ZIP、对象副本和元数据；安全余量 ${bytes(job.diskReservedBytes ?? 0)}`}
                    >
                      <Typography.Text type="secondary">
                        预计临时 {bytes(job.estimatedTemporaryBytes)}
                      </Typography.Text>
                    </Tooltip>
                  ) : null}
                </Space>
              ),
            },
            {
              title: "操作",
              width: "24%",
              render: (_, job) => (
                <Space wrap>
                  {canManage && archiveDownloadAvailable(job) ? (
                    <Button
                      aria-label="下载归档"
                      icon={<DownloadOutlined />}
                      href={`/api/v1/settings/log-archives/${job.id}/download`}
                      onClick={() =>
                        setWatchDownload({ ids: [job.id], until: Date.now() + 600000 })
                      }
                    >
                      下载归档
                    </Button>
                  ) : null}
                  {canManage &&
                  (job.status === "ready" || (job.status === "failed" && job.sha256)) ? (
                    <Button danger disabled={Boolean(pending)} onClick={() => setCleanup(job)}>
                      {job.status === "failed" ? "重试清理" : "清理原日志"}
                    </Button>
                  ) : null}
                  {canManage &&
                  job.sha256 &&
                  ["retained", "delete_failed"].includes(job.copyState ?? "retained") ? (
                    <Tooltip
                      title={
                        archiveCopyRemovalBlocker(job) ??
                        "确认下载后，单独删除平台保存的归档 ZIP 与索引。"
                      }
                    >
                      <span>
                        <Button
                          danger
                          aria-label={
                            job.copyState === "delete_failed" ? "重试删除副本" : "删除平台副本"
                          }
                          icon={<DeleteOutlined />}
                          disabled={Boolean(pending) || Boolean(archiveCopyRemovalBlocker(job))}
                          onClick={() => {
                            setRemoval(job);
                            setDownloadVerified(false);
                          }}
                        >
                          {job.copyState === "delete_failed" ? "重试删除副本" : "删除平台副本"}
                        </Button>
                      </span>
                    </Tooltip>
                  ) : null}
                  {canManage &&
                  job.sha256 &&
                  ["retained", "delete_failed"].includes(job.copyState ?? "retained") &&
                  archiveCopyRemovalBlocker(job) ? (
                    <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                      {archiveCopyRemovalBlocker(job)}
                    </Typography.Text>
                  ) : null}
                  {canManage && job.status === "failed" && !job.sha256 && !job.cancelRequested ? (
                    <Button
                      disabled={Boolean(pending)}
                      onClick={() =>
                        void act(`retry:${job.id}`, `/api/v1/settings/log-archives/${job.id}/retry`)
                      }
                    >
                      重试生成
                    </Button>
                  ) : null}
                  {canManage &&
                  ["queued", "building", "verifying", "failed"].includes(job.status) &&
                  !job.sha256 ? (
                    <Button
                      disabled={Boolean(pending) || job.cancelRequested}
                      onClick={() =>
                        void act(
                          `cancel:${job.id}`,
                          `/api/v1/settings/log-archives/${job.id}/cancel`,
                        )
                      }
                    >
                      {job.cancelRequested ? "正在取消" : "取消归档"}
                    </Button>
                  ) : null}
                </Space>
              ),
            },
          ]}
        />
        <Flex justify="space-between" align="center" style={{ marginTop: token.marginMD }}>
          <Typography.Text type="secondary">第 {cursors.length} 页 · 每页 20 条</Typography.Text>
          <Space>
            <Button
              disabled={cursors.length === 1}
              onClick={() => void changePage(cursors.slice(0, -1))}
            >
              上一页
            </Button>
            <Button
              disabled={!page.nextCursor}
              onClick={() => void changePage([...cursors, page.nextCursor!])}
            >
              下一页
            </Button>
          </Space>
        </Flex>
      </Card>
      <Modal
        open={optionsOpen}
        title="归档选项"
        footer={null}
        onCancel={() => setOptionsOpen(false)}
        destroyOnHidden
      >
        <Form<ArchiveFormOptions>
          layout="vertical"
          initialValues={options}
          onFinish={(values) => {
            setOptions(values);
            setOptionsOpen(false);
          }}
        >
          <Form.Item
            name="projectId"
            label="项目范围"
            extra="留空归档全部项目；选择项目后，本组所有分卷只收录该项目。"
          >
            <Select
              allowClear
              placeholder="全部项目"
              options={projects.map((project) => ({ value: project.id, label: project.name }))}
            />
          </Form.Item>
          <Form.Item
            name="targetVolumeMiB"
            label="分卷目标（MiB）"
            rules={[{ required: true }]}
            extra="按原日志当前存储大小规划。单个执行批次保持完整，超过目标时单独成卷；每卷都可独立离线查看。"
          >
            <InputNumber
              aria-label="分卷目标（MiB）"
              min={1}
              max={8192}
              precision={0}
              style={{ width: "100%" }}
            />
          </Form.Item>
          <Form.Item
            name="minimumFreeMiB"
            label="最小磁盘安全余量（MiB）"
            rules={[{ required: true }]}
          >
            <InputNumber
              aria-label="最小磁盘安全余量（MiB）"
              min={256}
              max={131072}
              precision={0}
              style={{ width: "100%" }}
            />
          </Form.Item>
          <Form.Item
            name="minimumFreePercent"
            label="磁盘安全余量比例（%）"
            rules={[{ required: true }]}
            extra="取固定容量与比例中较大的值。生成前另外预留本卷预计临时空间，运行期间持续检查；这些选项随本次归档保存。"
          >
            <InputNumber
              aria-label="磁盘安全余量比例（%）"
              min={1}
              max={50}
              precision={0}
              style={{ width: "100%" }}
            />
          </Form.Item>
          <Flex justify="end" gap="small">
            <Button onClick={() => setOptionsOpen(false)}>取消</Button>
            <Button type="primary" htmlType="submit">
              保存选项
            </Button>
          </Flex>
        </Form>
      </Modal>
      <Modal
        open={Boolean(removal)}
        title="确认下载并删除平台归档副本"
        onCancel={() => setRemoval(undefined)}
        okText="确认删除平台副本"
        cancelText="取消"
        confirmLoading={pending.startsWith("remove:")}
        okButtonProps={{ danger: true, disabled: !downloadVerified }}
        onOk={() =>
          removal &&
          void act(
            `remove:${removal.id}`,
            `/api/v1/settings/log-archives/${removal.id}/remove-copy`,
            { downloadedAndVerified: true, sha256: removal.sha256 },
          )
        }
      >
        <Typography.Paragraph>{removal?.filename}</Typography.Paragraph>
        <CopyableText text={removal?.sha256 ?? ""} block className="break-all">
          <Typography.Text type="secondary">SHA-256：{removal?.sha256}</Typography.Text>
        </CopyableText>
        <Alert
          type="warning"
          showIcon
          title="删除后仅能离线查看日志"
          description="平台将删除本卷的归档 ZIP 与索引；Full 存储位于 MinIO，Lite 存储位于本地。对应在线日志会显示已离线归档，执行记录、结果和轮次仍然保留。此操作不能撤销。"
        />
        <Checkbox
          checked={downloadVerified}
          onChange={(event) => setDownloadVerified(event.target.checked)}
          style={{ marginTop: token.marginMD }}
        >
          我已完整下载本卷，并确认离线查看正常
        </Checkbox>
      </Modal>
      <Modal
        open={Boolean(cleanup)}
        title="确认清理已归档的原日志"
        onCancel={() => setCleanup(undefined)}
        onOk={() =>
          cleanup &&
          void act(`cleanup:${cleanup.id}`, `/api/v1/settings/log-archives/${cleanup.id}/cleanup`, {
            confirm: true,
          })
        }
        confirmLoading={pending.startsWith("cleanup:")}
        okText="确认清理原日志"
        okButtonProps={{ danger: true }}
        cancelText="取消"
      >
        <Typography.Paragraph>
          请先下载并妥善保存 {cleanup?.month}{" "}
          的归档包。平台会再次核对归档完整性，然后删除对应数据库或 SQLite
          文件中的日志正文，保留执行记录及归档读取入口。
        </Typography.Paragraph>
        <Alert
          type="warning"
          showIcon
          title="清理原日志不能撤销"
          description="平台内的归档文件会继续提供历史日志访问。PostgreSQL 删除正文后仍可能保留数据库空闲页；安全删除空日期库后才实际释放该库占用。"
        />
      </Modal>
    </Flex>
  );
}

function copyStatusLabel(job: LogArchiveJob): string | undefined {
  switch (job.copyState) {
    case "delete_requested":
      return "等待删除副本";
    case "deleting":
      return "正在删除副本";
    case "deleted":
      return "已离线归档";
    case "delete_failed":
      return "副本删除失败";
    default:
      return undefined;
  }
}
