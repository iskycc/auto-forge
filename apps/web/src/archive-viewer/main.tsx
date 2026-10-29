import { useUrlFilter } from "./url-filter";
import { SemanticStatusTag } from "../components/ui/semantic-status-tag";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Alert,
  App,
  Button,
  Card,
  ConfigProvider,
  Drawer,
  Empty,
  Flex,
  Input,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Typography,
  theme,
} from "antd";
import zhCN from "antd/locale/zh_CN";
import { ArrowLeftOutlined, FileTextOutlined, MoonOutlined, SunOutlined } from "@ant-design/icons";
import type { LogArchiveManifest, LogArchiveBatch, LogArchiveAttempt } from "@autoforge/contracts";
import { platformThemes } from "../lib/ant-design-theme";
import "antd/dist/reset.css";
import "antd/dist/antd.css";

type Chunk = { sequence: number; content: string; recordedAt: string };
type Page<T> = { items: T[]; hasMore: boolean; nextCursor?: string };
const statusLabels: Record<string, string> = {
  succeeded: "通过",
  failed: "失败",
  cancelled: "已取消",
  timed_out: "超时",
  running: "执行中",
  assigned: "待领取",
};
function result(status: string) {
  return (
    <SemanticStatusTag
      tone={
        status === "succeeded"
          ? "success"
          : status === "failed" || status === "timed_out"
            ? "danger"
            : "neutral"
      }
    >
      {statusLabels[status] ?? status}
    </SemanticStatusTag>
  );
}

async function request<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({ message: "离线归档读取失败" }))) as {
      message: string;
    };
    throw new Error(body.message);
  }
  return response.json() as Promise<T>;
}
function usePage<T>(path: string | null) {
  const [state, setState] = useState<{ path: string; data?: T; error?: string }>({ path: "" });
  useEffect(() => {
    if (path === null) return;
    const abort = new AbortController();
    void request<T>(path, abort.signal).then(
      (data) => {
        if (!abort.signal.aborted) setState({ path, data });
      },
      (cause) => {
        if (!abort.signal.aborted)
          setState({ path, error: cause instanceof Error ? cause.message : "读取失败" });
      },
    );
    return () => abort.abort();
  }, [path]);
  return {
    ...state,
    loading: path !== null && state.path !== path,
    error: state.path === path ? state.error : undefined,
  };
}

function Viewer() {
  const [mode, setMode] = useState<"light" | "dark">(() =>
    localStorage.getItem("autoforge-archive-theme") === "dark" ? "dark" : "light",
  );
  return (
    <ConfigProvider locale={zhCN} theme={platformThemes[mode]}>
      <App>
        <ArchiveContent
          mode={mode}
          toggle={() =>
            setMode((current) => {
              const next = current === "light" ? "dark" : "light";
              localStorage.setItem("autoforge-archive-theme", next);
              return next;
            })
          }
        />
      </App>
    </ConfigProvider>
  );
}
function ArchiveContent({ mode, toggle }: { mode: "light" | "dark"; toggle(): void }) {
  const { token } = theme.useToken();
  const manifest = usePage<LogArchiveManifest>("/api/manifest");
  const [batchId, setBatchId] = useUrlFilter("batchId");
  const [batchQuery] = useUrlFilter("batchQuery"),
    [caseQuery] = useUrlFilter("caseQuery");
  const detail = usePage<Page<LogArchiveBatch>>(
    batchId ? `/api/batches?batchId=${encodeURIComponent(batchId)}` : null,
  );
  const batch = detail.data?.items.find((item) => item.id === batchId);
  return (
    <main
      style={{
        minHeight: "100vh",
        background: token.colorBgLayout,
        color: token.colorText,
        padding: token.paddingLG,
      }}
    >
      <div
        style={{
          maxWidth: 1800,
          margin: "0 auto",
          display: "flex",
          flexDirection: "column",
          gap: token.marginLG,
        }}
      >
        <Flex justify="space-between" align="center" gap="middle">
          <Space align="start">
            <FileTextOutlined style={{ fontSize: 28, color: token.colorPrimary, marginTop: 6 }} />
            <div>
              <Typography.Title level={2} style={{ margin: 0 }}>
                AutoForge 日志归档
              </Typography.Title>
              <Typography.Text type="secondary">
                {manifest.data?.month ?? "月度日志"}
                {manifest.data?.volumeNumber ? ` · 第 ${manifest.data.volumeNumber} 卷` : ""} ·
                离线查看 · 北京时间
              </Typography.Text>
            </div>
          </Space>
          <Button icon={mode === "light" ? <MoonOutlined /> : <SunOutlined />} onClick={toggle}>
            {mode === "light" ? "深色模式" : "浅色模式"}
          </Button>
        </Flex>
        {manifest.data?.volumeNumber ? (
          <Alert
            type="info"
            showIcon
            title="当前显示本卷的执行日志"
            description="同月其他分卷请分别解压并打开查看器；每个执行批次完整保存在对应的一卷中。"
          />
        ) : null}
        {manifest.error ? <Alert type="error" showIcon title={manifest.error} /> : null}
        <Flex gap="middle">
          {[
            ["执行批次", manifest.data?.batchCount],
            ["执行尝试", manifest.data?.attemptCount],
            ["日志块", manifest.data?.chunkCount],
            [
              "原始日志",
              manifest.data ? `${(manifest.data.rawBytes / 1024 / 1024).toFixed(1)} MiB` : "—",
            ],
          ].map(([label, value]) => (
            <Card key={label} size="small" style={{ flex: 1 }}>
              <Statistic title={label} value={value ?? "—"} />
            </Card>
          ))}
        </Flex>
        {batch ? (
          <>
            <Flex align="center" gap="middle">
              <Button icon={<ArrowLeftOutlined />} onClick={() => setBatchId("")}>
                返回执行批次
              </Button>
              <Typography.Title level={4} ellipsis style={{ margin: 0, minWidth: 0, flex: 1 }}>
                #{batch.sequenceNumber} {batch.suiteName}
              </Typography.Title>
              {result(batch.status)}
            </Flex>
            <AttemptList key={`${batch.id}:${caseQuery}`} batch={batch} />
          </>
        ) : batchId ? (
          <Card>
            <Spin spinning={detail.loading}>
              {detail.error ? (
                <Alert type="error" title={detail.error} />
              ) : !detail.loading ? (
                <Alert type="warning" title="该执行批次不在此归档中。" />
              ) : null}
              <Button onClick={() => setBatchId("")}>返回执行批次</Button>
            </Spin>
          </Card>
        ) : (
          <BatchList key={batchQuery} onSelect={(item) => setBatchId(item.id)} />
        )}
        <Typography.Text type="secondary">
          归档内容只读，所有查询均在本机处理。无需连接原平台或数据库。{" "}
          <Typography.Link href="/licenses.txt" target="_blank" rel="noopener noreferrer">
            开源许可
          </Typography.Link>
        </Typography.Text>
      </div>
    </main>
  );
}
function Pager({
  hasMore,
  cursors,
  onChange,
  lastId,
}: {
  hasMore: boolean;
  cursors: string[];
  onChange(next: string[]): void;
  lastId?: string | undefined;
}) {
  return (
    <Flex justify="space-between" align="center" style={{ marginTop: 16 }}>
      <Typography.Text type="secondary">第 {cursors.length} 页 · 每页最多 50 条</Typography.Text>
      <Space>
        <Button disabled={cursors.length === 1} onClick={() => onChange(cursors.slice(0, -1))}>
          上一页
        </Button>
        <Button disabled={!hasMore || !lastId} onClick={() => onChange([...cursors, lastId!])}>
          下一页
        </Button>
      </Space>
    </Flex>
  );
}
function BatchList({ onSelect }: { onSelect(batch: LogArchiveBatch): void }) {
  const [cursors, setCursors] = useState([""]);
  const [query, setQuery] = useUrlFilter("batchQuery");
  const page = usePage<Page<LogArchiveBatch>>(
    `/api/batches?cursor=${encodeURIComponent(cursors.at(-1)!)}&query=${encodeURIComponent(query)}`,
  );
  return (
    <Card
      title="执行批次"
      extra={
        <Input.Search
          defaultValue={query}
          aria-label="搜索任务"
          placeholder="搜索任务、项目或版本"
          allowClear
          onSearch={(value) => {
            setQuery(value);
            setCursors([""]);
          }}
          style={{ width: 300 }}
        />
      }
    >
      {page.error ? <Alert type="error" title={page.error} /> : null}
      <Table<LogArchiveBatch>
        size="middle"
        scroll={{ y: "50vh" }}
        rowKey="id"
        pagination={false}
        loading={page.loading}
        dataSource={page.data?.items ?? []}
        tableLayout="fixed"
        columns={[
          {
            title: "任务",
            dataIndex: "suiteName",
            width: "31%",
            ellipsis: true,
            render: (value: string, item) => (
              <Button
                type="link"
                onClick={() => onSelect(item)}
                style={{
                  padding: 0,
                  maxWidth: "100%",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                #{item.sequenceNumber} {value}
              </Button>
            ),
          },
          {
            title: "项目 / 版本",
            width: "23%",
            ellipsis: true,
            render: (_, item) => `${item.projectName} / ${item.projectVersionName || "—"}`,
          },
          { title: "测试阶段", dataIndex: "testStageName", width: "12%", ellipsis: true },
          { title: "结果", dataIndex: "status", width: "12%", render: result },
          {
            title: "结束时间",
            dataIndex: "finishedAt",
            width: "22%",
            render: (value: string) =>
              new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }),
          },
        ]}
      />
      <Pager
        hasMore={page.data?.hasMore ?? false}
        cursors={cursors}
        onChange={setCursors}
        lastId={page.data?.nextCursor ?? page.data?.items.at(-1)?.id}
      />
    </Card>
  );
}
function AttemptList({ batch }: { batch: LogArchiveBatch }) {
  const { token } = theme.useToken();
  const [cursors, setCursors] = useState([""]);
  const [query, setQuery] = useUrlFilter("caseQuery");
  const [selected, setSelected] = useState<LogArchiveAttempt>();
  const page = usePage<Page<LogArchiveAttempt>>(
    `/api/attempts?batchId=${batch.id}&cursor=${encodeURIComponent(cursors.at(-1)!)}&query=${encodeURIComponent(query)}`,
  );
  return (
    <Card
      title="用例执行记录"
      extra={
        <Input.Search
          defaultValue={query}
          aria-label="搜索用例"
          placeholder="用例名称、类路径或 ID"
          allowClear
          onSearch={(value) => {
            setQuery(value);
            setCursors([""]);
          }}
          style={{ width: 300 }}
        />
      }
    >
      {page.error ? <Alert type="error" title={page.error} /> : null}
      <Table<LogArchiveAttempt>
        size="middle"
        scroll={{ y: "50vh" }}
        locale={{
          emptyText: page.data?.hasMore
            ? "当前检索窗口暂无匹配，可继续下一页搜索剩余用例。"
            : "暂无匹配用例",
        }}
        rowKey="id"
        loading={page.loading}
        dataSource={page.data?.items ?? []}
        pagination={false}
        tableLayout="fixed"
        columns={[
          {
            title: "用例",
            ellipsis: true,
            render: (_, item) => (
              <div>
                <Typography.Text ellipsis>{item.displayName}</Typography.Text>
                <br />
                <Typography.Text type="secondary" ellipsis>
                  {item.className}
                </Typography.Text>
              </div>
            ),
          },
          {
            title: "类型",
            dataIndex: "caseType",
            width: 90,
            render: (value: string) => <Tag>{value === "ddt" ? "DDT" : "普通用例"}</Tag>,
          },
          {
            title: "轮次 / 尝试",
            width: 120,
            render: (_, item) => `第 ${item.roundIndex} 轮 / ${item.attemptNumber}`,
          },
          { title: "结果", dataIndex: "status", width: 100, render: result },
          {
            title: "开始时间",
            dataIndex: "startedAt",
            width: 185,
            render: (value: string) =>
              value
                ? new Date(value).toLocaleString("zh-CN", {
                    timeZone: "Asia/Shanghai",
                    hour12: false,
                  })
                : "—",
          },
          {
            title: "操作",
            width: 100,
            render: (_, item) => <Button onClick={() => setSelected(item)}>查看日志</Button>,
          },
        ]}
      />
      <Pager
        hasMore={page.data?.hasMore ?? false}
        cursors={cursors}
        onChange={setCursors}
        lastId={page.data?.nextCursor ?? page.data?.items.at(-1)?.id}
      />
      <Drawer
        title={
          selected ? (
            <Typography.Text
              ellipsis={{ tooltip: `${selected.displayName} · 第 ${selected.roundIndex} 轮` }}
              style={{ fontSize: token.fontSizeLG }}
            >
              {selected.displayName} · 第 {selected.roundIndex} 轮
            </Typography.Text>
          ) : (
            "用例日志"
          )
        }
        open={Boolean(selected)}
        onClose={() => setSelected(undefined)}
        size="large"
        styles={{
          body: { padding: token.padding },
          close: { width: token.controlHeightSM, height: token.controlHeightSM },
        }}
        destroyOnHidden
      >
        {selected ? <LogPane batchId={batch.id} attempt={selected} /> : null}
      </Drawer>
    </Card>
  );
}
function LogPane({ batchId, attempt }: { batchId: string; attempt: LogArchiveAttempt }) {
  const { token } = theme.useToken();
  const { message } = App.useApp();
  const [stream, setStream] = useState("stdout");
  const [cursors, setCursors] = useState([-1]);
  const page = usePage<Page<Chunk>>(
    `/api/logs?batchId=${batchId}&attemptId=${attempt.id}&stream=${stream}&afterSequence=${cursors.at(-1)!}`,
  );
  const text = (page.data?.items ?? []).map((chunk) => chunk.content).join("");
  return (
    <Flex vertical gap="middle">
      <Flex justify="space-between" align="center" wrap gap="small">
        <Space>
          {["stdout", "stderr", "agent"].map((value) => (
            <Button
              key={value}
              type={stream === value ? "primary" : "default"}
              onClick={() => {
                setStream(value);
                setCursors([-1]);
              }}
            >
              {value === "agent" ? "Agent 诊断" : value}
            </Button>
          ))}
        </Space>
        <Button
          disabled={!text}
          onClick={() =>
            void navigator.clipboard.writeText(text).then(
              () => message.success("当前页日志已复制"),
              () => message.error("浏览器禁止复制，请手动选择日志。"),
            )
          }
        >
          复制当前页
        </Button>
      </Flex>
      {page.error ? <Alert type="error" title={page.error} /> : null}
      <Spin spinning={page.loading}>
        <div
          style={{
            background: token.colorFillAlter,
            border: `1px solid ${token.colorBorderSecondary}`,
            borderRadius: token.borderRadius,
            padding: token.padding,
            minHeight: 420,
            maxHeight: "65vh",
            overflow: "auto",
          }}
        >
          {text ? (
            <pre
              style={{
                margin: 0,
                fontSize: 13,
                fontFamily: "ui-monospace, monospace",
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
              }}
            >
              {text}
            </pre>
          ) : (
            <Empty description="此日志流暂无内容" />
          )}
        </div>
      </Spin>
      <Flex justify="space-between" align="center">
        <Typography.Text type="secondary">第 {cursors.length} 页 · 单页最多 1 MiB</Typography.Text>
        <Space>
          <Button disabled={cursors.length === 1} onClick={() => setCursors(cursors.slice(0, -1))}>
            上一页
          </Button>
          <Button
            disabled={!page.data?.hasMore}
            onClick={() => setCursors([...cursors, page.data!.items.at(-1)!.sequence])}
          >
            下一页
          </Button>
        </Space>
      </Flex>
    </Flex>
  );
}
createRoot(document.getElementById("root")!).render(<Viewer />);
