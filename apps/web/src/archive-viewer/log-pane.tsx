import { useMemo, useState, type CSSProperties } from "react";
import {
  Alert,
  App,
  Button,
  Empty,
  Flex,
  Input,
  Pagination,
  Segmented,
  Space,
  Spin,
  Switch,
  Typography,
  theme,
} from "antd";
import type { LogArchiveAttempt } from "@autoforge/contracts";
import type { AnsiParserState } from "../lib/safe-ansi";
import { layoutThemeAliases } from "../lib/ant-design-theme";
import { presentArchiveLogPage } from "./log-presentation";
import { usePage, type CursorPage } from "./use-page";
import "./log-pane.css";

type Chunk = { sequence: number; content: string; recordedAt: string };
type LogCursor = { after: number; state?: AnsiParserState };

export function LogPane({ batchId, attempt }: { batchId: string; attempt: LogArchiveAttempt }) {
  const { token } = theme.useToken();
  const { message } = App.useApp();
  const [stream, setStream] = useState("stdout");
  const [cursors, setCursors] = useState<LogCursor[]>([{ after: -1 }]);
  const [windowIndex, setWindowIndex] = useState(0);
  const [wrap, setWrap] = useState(true);
  const [query, setQuery] = useState("");
  const cursor = cursors.at(-1)!;
  const page = usePage<CursorPage<Chunk>>(
    `/api/logs?${new URLSearchParams({ batchId, attemptId: attempt.id, stream, afterSequence: String(cursor.after) })}`,
  );
  const presentation = useMemo(
    () => presentArchiveLogPage(page.data?.items ?? [], cursor.state),
    [page.data, cursor.state],
  );
  const visible = presentation.windows[windowIndex] ?? [];
  const highlightBudget = { remaining: 500 };
  const text = visible.map((segment) => segment.text).join("");
  const variables = Object.fromEntries(
    Object.entries(layoutThemeAliases(token)).map(([name, value]) => [`--${name}`, value]),
  ) as CSSProperties;
  function move(next: LogCursor[]) {
    setCursors(next);
    setWindowIndex(0);
    setQuery("");
  }
  function search(value: string) {
    setQuery(value);
    if (!value) return;
    const position = presentation.text.toLowerCase().indexOf(value.toLowerCase());
    let consumed = 0;
    const matching =
      position < 0
        ? -1
        : presentation.windows.findIndex((window) => {
            consumed += window.reduce((length, segment) => length + segment.text.length, 0);
            return consumed > position;
          });
    if (matching >= 0) setWindowIndex(matching);
    else void message.info("当前日志页没有匹配项，可翻页继续查找。");
  }
  return (
    <Flex vertical gap="middle" style={{ minWidth: 0, ...variables }}>
      <Typography.Text type="secondary">
        第 {attempt.roundIndex} 轮 · 第 {attempt.attemptNumber} 次尝试 · 日志只读
      </Typography.Text>
      <Flex justify="space-between" align="center" wrap gap="small">
        <Segmented
          aria-label="日志流"
          value={stream}
          options={["stdout", "stderr", { label: "Agent 诊断", value: "agent" }]}
          onChange={(value) => {
            setStream(String(value));
            move([{ after: -1 }]);
          }}
        />
        <Button
          disabled={!text || page.loading}
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
      <Flex align="center" gap="middle" wrap>
        <Input.Search
          aria-label="查找当前日志页"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          maxLength={200}
          placeholder="查找当前日志页中的文字"
          allowClear
          onSearch={search}
          style={{ flex: "1 1 240px", minWidth: 0 }}
        />
        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: token.marginXS,
            minHeight: token.controlHeightSM,
          }}
        >
          <Switch aria-label="自动换行" checked={wrap} onChange={setWrap} />
          <Typography.Text>自动换行</Typography.Text>
        </label>
      </Flex>
      {page.error ? (
        <Alert
          type="error"
          showIcon
          title={page.error}
          action={<Button onClick={page.retry}>重试读取</Button>}
        />
      ) : null}
      <Spin spinning={page.loading}>
        <div
          className="archive-log-output"
          style={{ borderRadius: token.borderRadius, padding: token.padding }}
          aria-label="归档日志正文"
          aria-busy={page.loading}
        >
          {text ? (
            <pre data-wrap={wrap} tabIndex={0}>
              {visible.map((segment, index) => (
                <span className={segment.classes.join(" ")} key={index}>
                  {markMatches(segment.text, query, highlightBudget)}
                </span>
              ))}
            </pre>
          ) : page.loading ? (
            <Typography.Text type="secondary">正在读取日志…</Typography.Text>
          ) : (
            <Empty description="此日志流暂无内容" />
          )}
        </div>
      </Spin>
      {presentation.windows.length > 1 ? (
        <Flex vertical gap="small">
          <Typography.Text type="secondary">
            当前日志页较大，分段显示全部内容，每段最多 64 Ki 字符。
          </Typography.Text>
          <Pagination
            size="small"
            simple
            current={windowIndex + 1}
            pageSize={1}
            total={presentation.windows.length}
            onChange={(value) => setWindowIndex(value - 1)}
            aria-label="日志内容分段"
          />
        </Flex>
      ) : null}
      <Flex
        role="group"
        aria-label="日志分页"
        justify="space-between"
        align="center"
        gap="small"
        wrap
      >
        <Typography.Text type="secondary">第 {cursors.length} 页 · 单页最多 1 MiB</Typography.Text>
        <Space>
          <Button
            disabled={page.loading || cursors.length === 1}
            onClick={() => move(cursors.slice(0, -1))}
          >
            上一页
          </Button>
          <Button
            disabled={page.loading || !page.data?.hasMore || !page.data.items.length}
            onClick={() =>
              move([
                ...cursors,
                { after: page.data!.items.at(-1)!.sequence, state: presentation.ansiState },
              ])
            }
          >
            下一页
          </Button>
        </Space>
      </Flex>
    </Flex>
  );
}

function markMatches(text: string, query: string, budget: { remaining: number }) {
  if (!query || budget.remaining === 0) return text;
  const parts = [];
  let offset = 0;
  const source = text.toLowerCase(),
    needle = query.toLowerCase();
  for (;;) {
    const index = source.indexOf(needle, offset);
    if (index < 0 || budget.remaining === 0) break;
    parts.push(
      text.slice(offset, index),
      <mark key={index}>{text.slice(index, index + query.length)}</mark>,
    );
    offset = index + query.length;
    budget.remaining--;
  }
  parts.push(text.slice(offset));
  return parts;
}
