"use client";

import { Checkbox, Descriptions, Empty, Flex, Spin, Tag, Typography } from "antd";
import type { AttemptLogPage } from "@autoforge/contracts";
import {
  isTerminalBatchStatus,
  type DdtScope,
  type RunAttempt,
  type RunBatchDetails,
} from "@autoforge/domain";
import { useEffect, useRef, useState } from "react";
import { ExternalLink, RefreshCw, Square } from "lucide-react";

import { Button, Select } from "./ui";
import { LinkButton } from "./ui/link-button";
import { Notice } from "./ui/notice";
import { Segmented } from "./ui/segmented";
import { debugRequest } from "@/lib/case-debug-client";
import { parseSafeAnsi } from "@/lib/safe-ansi";
import { highlightLogLevels } from "@/lib/log-levels";
import { ApiClientError } from "@/lib/client-api";
import { debugLogWindow } from "@/lib/case-debug-log-window";
import { useConfirm, useToast } from "./ui-feedback";

const statusLabels: Record<string, string> = {
  queued: "等待调度",
  dispatching: "正在调度",
  scheduled: "已分配",
  assigned: "已分配",
  running: "执行中",
  succeeded: "执行通过",
  failed: "执行失败",
  timed_out: "执行超时",
  cancelled: "已终止",
  uploading: "上传结果",
  claimed: "已领取",
};

export function CaseDebugResults({
  batchId,
  scope,
  visible,
  canReadLogs,
  canCancel,
  onActiveChange,
}: {
  batchId: string;
  scope: DdtScope;
  visible: boolean;
  canReadLogs: boolean;
  canCancel: boolean;
  onActiveChange: (active: boolean) => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [batch, setBatch] = useState<RunBatchDetails>();
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [selectedAttempt, setSelectedAttempt] = useState("");
  const [stopping, setStopping] = useState(false);
  const active = batch ? !isTerminalBatchStatus(batch.status) : !error;
  const attempt =
    batch?.attempts.find((item) => item.id === selectedAttempt) ?? batch?.attempts.at(-1);

  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let inFlight = false;
    let terminal = false;
    async function poll() {
      if (inFlight || controller.signal.aborted || document.hidden) return;
      inFlight = true;
      try {
        const current = await debugRequest<RunBatchDetails>(
          `/api/v1/run-batches/${encodeURIComponent(batchId)}`,
          { signal: controller.signal },
        );
        if (
          current.projectId !== scope.projectId ||
          current.policy?.projectVersionId !== scope.projectVersionId
        ) {
          terminal = true;
          onActiveChange(false);
          throw new Error("此执行记录不属于当前项目版本，请切回原范围查看或开始新的调试。");
        }
        setBatch(current);
        setError("");
        terminal = isTerminalBatchStatus(current.status);
        onActiveChange(!terminal);
      } catch (problem) {
        if (problem instanceof ApiClientError && [401, 403, 404].includes(problem.status)) {
          terminal = true;
          onActiveChange(false);
        }
        if (!controller.signal.aborted)
          setError(problem instanceof Error ? problem.message : "执行状态读取失败。");
      } finally {
        inFlight = false;
        if (!controller.signal.aborted && !terminal) timer = setTimeout(() => void poll(), 2_000);
      }
    }
    function visible() {
      if (!document.hidden && !terminal) {
        clearTimeout(timer);
        void poll();
      }
    }
    void poll();
    document.addEventListener("visibilitychange", visible);
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [batchId, refresh, onActiveChange, visible, scope.projectId, scope.projectVersionId]);

  async function stop() {
    if (
      !(await confirm({
        title: "停止本次调试",
        description: "将通知执行机终止本次用例，并保留已经产生的日志和结果。",
        confirmLabel: "停止执行",
        tone: "danger",
      }))
    )
      return;
    setStopping(true);
    try {
      await debugRequest(`/api/v1/run-batches/${encodeURIComponent(batchId)}/terminate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "用户在用例调试页终止执行" }),
      });
      toast.success("已发送终止请求，正在等待执行机结束。");
      setRefresh((value) => value + 1);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "终止失败。");
    } finally {
      setStopping(false);
    }
  }

  return (
    <section className="grid min-w-0 gap-4" aria-label="调试执行结果">
      <Flex align="center" justify="space-between" gap="small" wrap>
        <Flex align="center" gap="small" wrap>
          <Typography.Title level={4} className="!m-0">
            日志与结果
          </Typography.Title>
          <Tag color={active ? "processing" : batch?.status === "succeeded" ? "success" : "error"}>
            {batch ? (statusLabels[batch.status] ?? batch.status) : "正在获取执行状态"}
          </Tag>
        </Flex>
        <Flex gap="small" wrap>
          <Button onClick={() => setRefresh((value) => value + 1)} aria-label="刷新调试结果">
            <RefreshCw size={15} />
          </Button>
          {active && canCancel ? (
            <Button
              variant="danger"
              disabled={stopping || Boolean(batch?.terminationRequestedAt)}
              onClick={() => void stop()}
            >
              <Square size={14} />
              {stopping || batch?.terminationRequestedAt ? "正在终止" : "停止执行"}
            </Button>
          ) : null}
          <LinkButton
            href={`/run-batches/${encodeURIComponent(batchId)}`}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink size={14} />
            完整记录
          </LinkButton>
        </Flex>
      </Flex>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {batch ? (
        <Descriptions
          size="small"
          column={1}
          items={[
            {
              key: "case",
              label: "本次用例",
              children: (
                <span className="[overflow-wrap:anywhere]">{batch.runs[0]?.displayName}</span>
              ),
            },
            {
              key: "class",
              label: "执行类",
              children: (
                <span className="[overflow-wrap:anywhere]">{batch.runs[0]?.className}</span>
              ),
            },
            {
              key: "attempt-status",
              label: "执行尝试",
              children: attempt ? (statusLabels[attempt.status] ?? attempt.status) : "等待领取",
            },
            ...(attempt?.durationMs !== undefined
              ? [
                  {
                    key: "duration",
                    label: "耗时",
                    children: `${(attempt.durationMs / 1_000).toFixed(2)} 秒`,
                  },
                ]
              : []),
            ...(attempt?.resultCode
              ? [
                  {
                    key: "code",
                    label: "结果码",
                    children: (
                      <span className="[overflow-wrap:anywhere]">{attempt.resultCode}</span>
                    ),
                  },
                ]
              : []),
            ...(attempt?.testNg
              ? [
                  {
                    key: "counts",
                    label: "方法结果",
                    children: (
                      <Flex gap="small" wrap>
                        <Tag color="success">通过 {attempt.testNg.passed}</Tag>
                        <Tag color="error">失败 {attempt.testNg.failed}</Tag>
                        <Tag color="warning">跳过 {attempt.testNg.skipped}</Tag>
                        {attempt.testNg.configurationFailures ? (
                          <Tag color="error">配置失败 {attempt.testNg.configurationFailures}</Tag>
                        ) : null}
                      </Flex>
                    ),
                  },
                ]
              : []),
            {
              key: "result",
              label: "结果",
              children: (
                <span className="max-h-32 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere]">
                  {attempt?.resultSummary ?? (active ? "执行结束后显示结果" : "尚无执行结果")}
                </span>
              ),
            },
          ]}
        />
      ) : (
        <Spin tip="读取执行状态">
          <div className="min-h-24" />
        </Spin>
      )}
      {batch && batch.attempts.length > 1 ? (
        <Select
          aria-label="调试执行尝试"
          value={attempt?.id ?? ""}
          onChange={(event) => setSelectedAttempt(event.target.value)}
        >
          {batch.attempts.map((item) => (
            <option key={item.id} value={item.id}>
              第 {item.attemptNumber} 次 · {statusLabels[item.status] ?? item.status}
            </option>
          ))}
        </Select>
      ) : null}
      {attempt ? (
        <CaseDebugLogs key={attempt.id} attempt={attempt} canRead={canReadLogs} visible={visible} />
      ) : (
        <Empty
          description={
            active ? "等待 Runner 领取，日志会自动显示在这里" : "本次执行没有产生执行尝试"
          }
        />
      )}
    </section>
  );
}

function CaseDebugLogs({
  attempt,
  canRead,
  visible,
}: {
  attempt: RunAttempt;
  canRead: boolean;
  visible: boolean;
}) {
  const [stream, setStream] = useState<"stdout" | "stderr" | "agent">("stdout");
  const [logPage, setLogPage] = useState<AttemptLogPage>();
  const [error, setError] = useState("");
  const [afterSequence, setAfterSequence] = useState(-1);
  const [view, setView] = useState<"live" | "paused" | "page">("live");
  const following = view === "live";
  const cursor = useRef(-1);
  const [trimmed, setTrimmed] = useState(false);
  const logViewport = useRef<HTMLPreElement>(null);
  const [refresh, setRefresh] = useState(0);
  const terminal = ["succeeded", "failed", "timed_out", "cancelled"].includes(attempt.status);

  useEffect(() => {
    if (!canRead || !visible || view === "paused") return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let inFlight = false;
    let more = false;
    async function load() {
      if (inFlight || document.hidden || controller.signal.aborted) return;
      inFlight = true;
      try {
        const query = new URLSearchParams({
          stream,
          afterSequence: String(following ? cursor.current : afterSequence),
          limit: following ? "200" : "1",
        });
        const current = await debugRequest<AttemptLogPage>(
          `/api/v1/run-attempts/${encodeURIComponent(attempt.id)}/logs?${query}`,
          { signal: controller.signal },
        );
        more = following && current.nextSequence !== undefined;
        if (following) {
          cursor.current = current.items.at(-1)?.sequence ?? cursor.current;
          setLogPage((previous) => {
            const window = debugLogWindow(previous?.items ?? [], current.items);
            if (window.trimmed) setTrimmed(true);
            return { ...current, items: window.items };
          });
        } else {
          const window = debugLogWindow([], current.items);
          setTrimmed(window.trimmed);
          setLogPage({ ...current, items: window.items });
        }
        setError("");
      } catch (problem) {
        if (!controller.signal.aborted)
          setError(problem instanceof Error ? problem.message : "日志读取失败。");
      } finally {
        inFlight = false;
        if (following && (!terminal || more) && !controller.signal.aborted)
          timer = setTimeout(() => void load(), more ? 100 : 2_000);
      }
    }
    function visible() {
      if (!document.hidden) {
        clearTimeout(timer);
        void load();
      }
    }
    void load();
    document.addEventListener("visibilitychange", visible);
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [attempt.id, stream, afterSequence, terminal, canRead, refresh, following, visible, view]);

  useEffect(() => {
    if (following && logViewport.current)
      logViewport.current.scrollTop = logViewport.current.scrollHeight;
  }, [logPage, following]);

  if (!canRead) return <Notice>当前账号没有读取执行日志的权限。</Notice>;
  const segments = highlightLogLevels(
    parseSafeAnsi(logPage?.items.map((chunk) => chunk.content).join("") ?? ""),
  );
  return (
    <div className="grid min-w-0 gap-3">
      <Flex gap="small" align="center" justify="space-between" wrap>
        <Segmented
          label="调试日志流"
          value={stream}
          onChange={(value) => {
            setStream(value);
            if (view === "paused") setView("page");
            cursor.current = -1;
            setTrimmed(false);
            setAfterSequence(-1);
            setLogPage(undefined);
          }}
          options={[
            { value: "stdout", label: "标准输出" },
            { value: "stderr", label: "错误输出" },
            { value: "agent", label: "Agent 诊断" },
          ]}
        />
        <Checkbox
          checked={following}
          onChange={(event) => setView(event.target.checked ? "live" : "paused")}
        >
          跟随最新
        </Checkbox>
        <Button
          onClick={() => {
            if (view === "paused") setView("live");
            setRefresh((value) => value + 1);
          }}
        >
          {view === "paused" ? "继续更新" : "刷新日志"}
        </Button>
      </Flex>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {logPage?.truncated ? (
        <Notice tone="warning">日志已达到保留上限，后续内容被截断。</Notice>
      ) : null}
      <pre
        ref={logViewport}
        aria-label="调试日志内容"
        className="m-0 h-96 min-w-0 overflow-auto rounded-lg border border-border bg-muted/40 p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]"
      >
        {segments.length
          ? segments.map((segment, index) => (
              <span className={segment.classes.join(" ")} key={index}>
                {segment.text}
              </span>
            ))
          : "当前日志流暂无内容。"}
      </pre>
      <Flex justify="space-between" gap="small">
        <Typography.Text type="secondary">
          {trimmed ? "仅显示最近内容，可回到开头分段查看" : "实时保留最近 200 块；历史逐块查看"}
        </Typography.Text>
        <Flex gap="small">
          {afterSequence >= 0 || view !== "page" ? (
            <Button
              onClick={() => {
                setView("page");
                setAfterSequence(-1);
                setLogPage(undefined);
              }}
            >
              回到开头
            </Button>
          ) : null}
          {view === "page" && logPage?.nextSequence !== undefined ? (
            <Button
              onClick={() => {
                setAfterSequence(logPage.nextSequence!);
                setLogPage(undefined);
              }}
            >
              下一段日志
            </Button>
          ) : null}
        </Flex>
      </Flex>
    </div>
  );
}
