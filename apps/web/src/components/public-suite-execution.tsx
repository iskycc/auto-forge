"use client";

import { Alert, Card, Descriptions, Empty, Form, InputNumber, Select, Statistic, Tag } from "antd";
import { Clock3, ExternalLink, Play, RefreshCw, Square, UserRound } from "lucide-react";
import { useRef, useState } from "react";
import type { PublicSuiteBatch, PublicSuiteView } from "@autoforge/contracts";
import { CopyableText } from "./ui/copyable-text";
import { publicSuiteExecutionResultSchema } from "@autoforge/contracts";
import { Button } from "./ui/button";
import { ActionDialog } from "./action-dialog";
import { ColorModeToggle } from "./color-mode-toggle";
import { JenkinsTaskGuide } from "./jenkins-task-guide";
import { useLoginDialog } from "./login-dialog-provider";
import { SessionLoginButton } from "./session-login-button";
import { usePublicSuite } from "./use-public-suite";
import { PublicSuiteEnvironment } from "./public-suite-environment";
import { ExecutionEnvironmentAddresses } from "./execution-environment-addresses";
import { usePlatformNow } from "./platform-time";
import { ApiClientError, throwApiErrorResponse } from "@/lib/client-api";
import { createClientIdempotencyKey } from "@/lib/client-idempotency-key";
import { formatPlatformDateTime } from "@/lib/platform-date-time";

export function PublicSuiteExecution({
  initial,
  baseUrl,
}: {
  initial: PublicSuiteView;
  baseUrl: string | undefined;
}) {
  const { view, error: refreshError, refresh } = usePublicSuite(initial);
  const { session, openLogin } = useLoginDialog();
  const [mode, setMode] = useState<"immediate" | "delay">("immediate");
  const [delay, setDelay] = useState<number | null>(60);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [stop, setStop] = useState<PublicSuiteBatch | null>(null);
  const [progressPath, setProgressPath] = useState("");
  const [environmentOverride, setEnvironmentOverride] = useState<string[]>();
  const [unconfirmedRequest, setUnconfirmedRequest] = useState(false);
  const requestKey = useRef<string | null>(null);
  const submitting = useRef(false);
  const authenticated = session.status === "authenticated";
  const endpoint = `/api/v1/public/case-suites/${encodeURIComponent(view.suiteId)}`;
  const query = new URLSearchParams({ PublisherId: view.publisher.id });

  async function start() {
    if (submitting.current) return;
    submitting.current = true;
    setPending(true);
    setError("");
    try {
      requestKey.current ??= createClientIdempotencyKey();
      const response = await fetch(`${endpoint}/executions?${query}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestKey: requestKey.current,
          delaySeconds: mode === "delay" ? delay : 0,
          ...(view.adapterEnabled && environmentOverride
            ? { environmentAddresses: environmentOverride }
            : {}),
        }),
      });
      if (!response.ok) await throwApiErrorResponse(response, "执行请求失败，请重试。");
      const result = publicSuiteExecutionResultSchema.parse(await response.json());
      setProgressPath(result.progressPath);
      requestKey.current = null;
      setUnconfirmedRequest(false);
      setEnvironmentOverride(undefined);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "执行失败。");
      if (cause instanceof ApiClientError && cause.status === 401) openLogin();
      // No request was submitted if key generation failed; recovery needs no status fetch.
      if (requestKey.current) await refresh();
      if (cause instanceof ApiClientError && cause.status >= 400 && cause.status < 500)
        requestKey.current = null;
      setUnconfirmedRequest(!!requestKey.current);
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }
  async function terminate() {
    if (!stop || submitting.current) return;
    submitting.current = true;
    setPending(true);
    setError("");
    try {
      const response = await fetch(
        `${endpoint}/executions/${encodeURIComponent(stop.id)}/terminate?${query}`,
        { method: "POST" },
      );
      if (!response.ok) await throwApiErrorResponse(response, "终止请求失败，请重试。");
      setStop(null);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "终止失败。");
      if (cause instanceof ApiClientError && cause.status === 401) openLogin();
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }
  return (
    <main className="min-h-screen bg-background p-6 lg:p-8">
      <div className="mx-auto grid max-w-[1360px] min-w-0 gap-6">
        <header className="flex min-w-0 items-center justify-between gap-4 border-b border-border pb-5">
          <div>
            <span className="text-sm font-bold tracking-widest text-primary">AUTOFORGE</span>
            <span className="ml-3 border-l border-border pl-3 text-sm text-muted-foreground">
              任务公开执行
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            {authenticated ? (
              <Tag icon={<UserRound size={13} className="mr-1 inline" />}>已登录</Tag>
            ) : (
              <SessionLoginButton />
            )}
            <ColorModeToggle />
          </div>
        </header>
        <section className="grid min-w-0 grid-cols-[minmax(0,1fr)_340px] items-start gap-6 min-[1440px]:grid-cols-[minmax(0,1fr)_380px]">
          <div className="grid min-w-0 gap-6">
            <div className="min-w-0">
              <Tag color="blue" className="max-w-full !whitespace-normal [overflow-wrap:anywhere]">
                {view.projectName} · {view.versionName}
              </Tag>
              <h1 className="mb-3 mt-4 text-3xl font-semibold leading-snug [overflow-wrap:anywhere]">
                {view.name}
              </h1>
              <p className="m-0 whitespace-pre-wrap leading-7 text-muted-foreground [overflow-wrap:anywhere]">
                {view.description || "本任务未填写说明。"}
              </p>
            </div>
            <Card title="任务概览">
              <div className="mb-6 grid grid-cols-3 gap-4">
                <Statistic title="用例总数" value={view.caseCount} />
                <Statistic title="并发上限" value={view.concurrency} />
                <Statistic title="重跑上限" value={view.retryLimit} suffix="次" />
              </div>
              <Descriptions
                column={1}
                size="small"
                items={[
                  { key: "publisher", label: "链接分享人", children: view.publisher.username },
                  {
                    key: "source",
                    label: "执行配置",
                    children: "使用任务最新保存的配置，并在拉起时固化快照",
                  },
                  {
                    key: "id",
                    label: "任务 ID",
                    children: (
                      <CopyableText
                        text={view.suiteId}
                        className="font-mono text-xs [overflow-wrap:anywhere]"
                      />
                    ),
                  },
                ]}
              />
              <PublicSuiteEnvironment
                addresses={
                  view.adapterEnabled ? (environmentOverride ?? view.environmentAddresses) : []
                }
                enabled={view.adapterEnabled}
                disabled={
                  !authenticated ||
                  pending ||
                  view.active.length > 0 ||
                  !!refreshError ||
                  unconfirmedRequest
                }
                overridden={view.adapterEnabled && !!environmentOverride}
                onChange={setEnvironmentOverride}
              />
            </Card>
          </div>
          <Card
            title={
              <span className="flex items-center gap-2">
                <Play size={17} />
                执行任务
              </span>
            }
          >
            <div className="grid gap-4">
              <Alert
                type={view.active.length ? "warning" : "info"}
                showIcon
                title={view.active.length ? "任务正在执行或等待启动" : "任务就绪"}
                description={
                  view.active.length
                    ? "所有访问者看到相同状态，请在当前批次结束后再执行。"
                    : "登录后即可执行，无需额外项目权限。"
                }
              />
              {!view.executable ? <Alert type="warning" title={view.unavailableReason} /> : null}
              <Form layout="vertical">
                <Form.Item label="启动方式" className="!mb-3">
                  <Select
                    aria-label="启动方式"
                    virtual={false}
                    value={mode}
                    disabled={pending || view.active.length > 0 || unconfirmedRequest}
                    onChange={setMode}
                    options={[
                      { value: "immediate", label: "立即执行" },
                      { value: "delay", label: "倒计时执行" },
                    ]}
                  />
                </Form.Item>
                {mode === "delay" ? (
                  <Form.Item
                    label="倒计时（秒）"
                    extra="1 秒至 7 天，提交后由服务端计时，关闭页面仍会执行。"
                    className="!mb-0"
                  >
                    <InputNumber
                      aria-label="倒计时秒数"
                      min={1}
                      max={604800}
                      precision={0}
                      value={delay}
                      onChange={setDelay}
                      disabled={pending || view.active.length > 0 || unconfirmedRequest}
                      className="!w-full"
                    />
                  </Form.Item>
                ) : null}
              </Form>
              {authenticated ? (
                <Button
                  type="button"
                  variant="default"
                  loading={pending && !stop}
                  disabled={
                    pending ||
                    !view.executable ||
                    view.active.length > 0 ||
                    !!refreshError ||
                    (mode === "delay" && (!delay || delay < 1 || delay > 604800))
                  }
                  onClick={() => void start()}
                >
                  <Play size={16} />
                  {mode === "delay" ? "开始倒计时" : "执行任务"}
                </Button>
              ) : (
                <SessionLoginButton label="登录后执行任务" />
              )}
              <p className="m-0 text-xs leading-6 text-muted-foreground">
                执行记录会保存链接分享人和实际拉起人。终止操作也会记录操作人。
              </p>
              {progressPath ? (
                <a
                  href={progressPath}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-center gap-2 rounded-lg border border-primary p-3 font-semibold text-primary"
                >
                  <ExternalLink size={16} />
                  新标签页查看执行进展
                </a>
              ) : null}
            </div>
          </Card>
        </section>
        {error || refreshError ? (
          <Alert
            type="error"
            showIcon
            title={error || refreshError}
            action={
              <Button type="button" variant="ghost" onClick={() => void refresh()}>
                重试刷新
              </Button>
            }
          />
        ) : null}
        <Card
          title="当前执行"
          extra={
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              每 5 秒自动刷新
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="刷新任务状态"
                onClick={() => void refresh()}
              >
                <RefreshCw size={15} />
              </Button>
            </span>
          }
        >
          {view.active.length ? (
            <div className="grid gap-3">
              {view.active.map((batch) => (
                <ExecutionRow
                  key={batch.id}
                  batch={batch}
                  canStop={authenticated && !pending && !refreshError}
                  onStop={() => {
                    setError("");
                    setStop(batch);
                  }}
                />
              ))}
            </div>
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前没有执行中的批次" />
          )}
        </Card>
        <Card
          title="最近公开执行"
          extra={<span className="text-xs text-muted-foreground">保留展示最近 5 次</span>}
        >
          {view.recent.length ? (
            <div className="grid gap-3">
              {view.recent.map((batch) => (
                <ExecutionRow key={batch.id} batch={batch} />
              ))}
            </div>
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚无公开执行记录" />
          )}
        </Card>
        <JenkinsTaskGuide suiteId={view.suiteId} baseUrl={baseUrl} />
        <footer className="text-center text-xs leading-6 text-muted-foreground">
          AutoForge · 任务配置由平台维护 · 请仅向可信人员提供此执行入口
        </footer>
        <ActionDialog
          open={!!stop}
          title="终止任务执行"
          onClose={() => setStop(null)}
          closeDisabled={pending}
          footer={
            <>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => setStop(null)}
              >
                返回
              </Button>
              <Button
                type="button"
                variant="destructive"
                loading={pending}
                onClick={() => void terminate()}
              >
                确认终止
              </Button>
            </>
          }
        >
          <Alert
            type="warning"
            showIcon
            title={`确定终止批次 #${stop?.sequenceNumber ?? ""}？`}
            description="停止后续派发和重跑；已领取的用例会按现有平滑终止规则完成并上传。终止不一定立即结束，操作人会写入执行记录。"
          />
          {error ? <Alert type="error" title={error} className="mt-4" /> : null}
        </ActionDialog>
      </div>
    </main>
  );
}

function ExecutionRow({
  batch,
  canStop = false,
  onStop,
}: {
  batch: PublicSuiteBatch;
  canStop?: boolean;
  onStop?: () => void;
}) {
  const active = ["queued", "dispatching", "scheduled", "running"].includes(batch.status);
  const now = usePlatformNow(active);
  const seconds = Math.max(0, Math.ceil((Date.parse(batch.scheduledFor) - now) / 1000));
  const label =
    batch.terminationRequestedAt && active
      ? "正在终止"
      : seconds > 0 && active
        ? "倒计时"
        : {
            queued: "排队中",
            dispatching: "调度中",
            scheduled: "待领取",
            running: "执行中",
            succeeded: "执行完成",
            failed: "执行异常",
            cancelled: "已终止",
          }[batch.status];
  return (
    <article
      className="flex min-w-0 flex-wrap items-center justify-between gap-4 rounded-lg border border-border bg-muted p-4"
      aria-label={`执行批次 ${batch.sequenceNumber}`}
    >
      <div className="grid min-w-0 flex-1 gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <strong>批次 #{batch.sequenceNumber}</strong>
          <Tag color={active ? "blue" : batch.status === "failed" ? "error" : "default"}>
            {label}
          </Tag>
          <span className="text-sm text-muted-foreground">
            {batch.totalRuns} 个用例 · 第 {batch.currentRound} 轮
          </span>
          {seconds > 0 && active ? (
            <span className="flex items-center gap-1 text-sm text-primary">
              <Clock3 size={14} />
              {seconds} 秒后启动
            </span>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">
          <span>拉起人：{batch.requestedBy ?? "未记录"}</span>
          <span>分享人：{batch.publisher ?? "平台入口"}</span>
          {batch.terminatedBy ? <span>终止人：{batch.terminatedBy}</span> : null}
          <time title={batch.createdAt}>{formatPlatformDateTime(batch.createdAt)}</time>
        </div>
        {batch.environmentAddresses.length ? (
          <div className="grid min-w-0 gap-2">
            <span className="text-xs text-muted-foreground">本次执行环境 IP</span>
            <ExecutionEnvironmentAddresses addresses={batch.environmentAddresses} />
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {batch.progressPath ? (
          <a
            href={batch.progressPath}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-sm font-semibold text-primary"
          >
            <ExternalLink size={15} />
            查看进展
          </a>
        ) : (
          <span className="text-xs text-muted-foreground">平台发起的执行</span>
        )}
        {active && batch.publicExecution ? (
          <Button
            type="button"
            variant="destructive"
            disabled={!canStop || !!batch.terminationRequestedAt}
            onClick={onStop}
          >
            <Square size={14} />
            {batch.terminationRequestedAt ? "正在终止" : "终止执行"}
          </Button>
        ) : null}
      </div>
    </article>
  );
}
