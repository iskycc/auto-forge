"use client";

import {
  Alert,
  Button,
  Checkbox,
  Descriptions,
  Empty,
  Flex,
  Form,
  Spin,
  Tabs,
  Tag,
  Typography,
} from "antd";
import { ExternalLink, Play, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  isJenkinsDependencyBuildActive,
  jenkinsDependencyViewSchema,
  saveJenkinsDependencyConfigurationSchema,
  type JenkinsDependencyView,
  type SaveJenkinsDependencyConfiguration,
} from "@autoforge/contracts";
import { useConcurrentModificationFeedback } from "./concurrent-modification-feedback";
import { ActionDialog } from "./action-dialog";
import { readApiError } from "@/lib/client-api";
import { createClientIdempotencyKey } from "@/lib/client-idempotency-key";
import { JenkinsDependencyBuildStatus } from "./jenkins-dependency-build-status";
import { JenkinsDependencyConfigurationForm } from "./jenkins-dependency-configuration-form";

export function JenkinsDependencyBuildButton({
  projectId,
  versionId,
  versionName,
  disabled,
  timeZone,
  onCompleted,
}: {
  projectId: string;
  versionId: string;
  versionName: string;
  disabled: boolean;
  timeZone: string;
  onCompleted: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button icon={<Play size={15} />} disabled={disabled} onClick={() => setOpen(true)}>
        Jenkins 构建依赖
      </Button>
      {open ? (
        <JenkinsDependencyBuildDialog
          projectId={projectId}
          versionId={versionId}
          versionName={versionName}
          timeZone={timeZone}
          onCompleted={onCompleted}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function JenkinsDependencyBuildDialog({
  projectId,
  versionId,
  versionName,
  timeZone,
  onCompleted,
  onClose,
}: {
  projectId: string;
  versionId: string;
  versionName: string;
  timeZone: string;
  onCompleted: () => void;
  onClose: () => void;
}) {
  const base = `/api/v1/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(versionId)}/jenkins-dependency`;
  const [form] = Form.useForm<SaveJenkinsDependencyConfiguration>();
  const showConcurrentModification = useConcurrentModificationFeedback();
  const [view, setView] = useState<JenkinsDependencyView>();
  const [tab, setTab] = useState("build");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dirty, setDirty] = useState(false);
  const [pollFailed, setPollFailed] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const lifetime = useRef<AbortController | null>(null);
  const completionNotified = useRef<string | undefined>(undefined);
  const active = view?.build ? isJenkinsDependencyBuildActive(view.build.status) : false;

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    void requestView(base, controller.signal)
      .then((next) => {
        setView(next);
        fillConfiguration(form, next);
        if (!next.configuration) setTab("configuration");
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(errorText(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [base, form]);

  useEffect(() => {
    if (
      !view?.build ||
      view.build.status !== "succeeded" ||
      completionNotified.current === view.build.id
    )
      return;
    completionNotified.current = view.build.id;
    onCompleted();
  }, [view?.build, onCompleted]);

  useEffect(() => {
    if (
      loading ||
      busy ||
      pollFailed ||
      tab !== "build" ||
      !view?.build ||
      !["submitting", "queued", "running"].includes(view.build.status)
    )
      return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      if (document.visibilityState !== "visible") {
        setView((current) => (current ? { ...current } : current));
        return;
      }
      void requestView(base + "?refresh=1", controller.signal)
        .then(setView)
        .catch((cause: unknown) => {
          if (!controller.signal.aborted) {
            setError(errorText(cause));
            setPollFailed(true);
          }
        });
    }, 4000);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [base, view, loading, busy, pollFailed, tab]);

  async function run(operation: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
    } catch (cause) {
      if (await showConcurrentModification(cause)) return;
      if (!lifetime.current?.signal.aborted) setError(errorText(cause));
    } finally {
      if (!lifetime.current?.signal.aborted) setBusy(false);
    }
  }
  async function action(path: string, body?: unknown) {
    return requestJson(base + path, {
      method: "POST",
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: lifetime.current?.signal ?? null,
    });
  }
  async function refresh() {
    const next = await requestView(base + "?refresh=1", lifetime.current?.signal);
    setView(next);
    setPollFailed(false);
    setAcknowledged(false);
    if (!dirty) fillConfiguration(form, next);
  }
  async function save(values: SaveJenkinsDependencyConfiguration) {
    const parsed = saveJenkinsDependencyConfigurationSchema.safeParse({
      ...values,
      expectedRevision: view?.revision ?? 0,
      apiToken: values.apiToken || undefined,
      parameters: values.parameters ?? [],
    });
    if (!parsed.success) {
      setError(parsed.error.issues.map((issue) => issue.message).join("；"));
      return;
    }
    await run(async () => {
      const next = jenkinsDependencyViewSchema.parse(
        await requestJson(base, {
          method: "PUT",
          body: JSON.stringify(parsed.data),
          signal: lifetime.current?.signal ?? null,
        }),
      );
      setView(next);
      fillConfiguration(form, next);
      setDirty(false);
      setTab("build");
      setNotice("流水线配置已保存，可检查连接后触发构建。");
    });
  }

  return (
    <ActionDialog
      open
      title="Jenkins 构建依赖"
      description={`当前版本：${versionName} · 参数化构建与依赖更新`}
      className="!w-[min(820px,calc(100vw-64px))]"
      onClose={onClose}
      closeDisabled={busy}
      protectUnsavedChanges
      dirty={dirty}
      footer={
        tab === "configuration" ? (
          <>
            <Button
              disabled={busy || loading || !view?.configuration || dirty}
              onClick={() =>
                void run(async () => {
                  const inspected = await action("/inspect");
                  setNotice(
                    isBuildableInspection(inspected)
                      ? `连接成功，任务「${inspected.name}」可构建。`
                      : "连接成功，但该 Jenkins 任务当前不可构建。",
                  );
                })
              }
            >
              检查连接
            </Button>
            <Button
              type="primary"
              loading={busy}
              disabled={loading || active}
              onClick={() => form.submit()}
            >
              保存配置
            </Button>
          </>
        ) : (
          <>
            <Button
              icon={<RefreshCw size={14} />}
              disabled={busy || loading}
              onClick={() => void run(refresh)}
            >
              刷新状态
            </Button>
            <Button
              type="primary"
              icon={<Play size={14} />}
              loading={busy}
              disabled={loading || !view?.configuration || active || dirty}
              onClick={() =>
                void run(async () => {
                  if (!view) return;
                  const next = jenkinsDependencyViewSchema.parse(
                    await action("/trigger", {
                      requestId: createClientIdempotencyKey(),
                      expectedRevision: view.revision,
                      expectedBuildRevision: view.buildRevision,
                    }),
                  );
                  setView(next);
                  setPollFailed(false);
                })
              }
            >
              触发构建
            </Button>
          </>
        )
      }
    >
      <div className="grid min-w-0 gap-4">
        {error ? (
          <Alert
            type="error"
            showIcon
            title={error}
            description="如果提交连接中断，请先刷新状态核对构建是否已经开始。"
          />
        ) : null}
        {notice ? <Alert type="info" showIcon title={notice} /> : null}
        {loading ? (
          <Flex justify="center" className="py-12">
            <Spin description="正在读取流水线配置" />
          </Flex>
        ) : !view ? (
          <Button onClick={() => void run(refresh)}>重新加载</Button>
        ) : (
          <Tabs
            activeKey={tab}
            onChange={setTab}
            items={[
              {
                key: "build",
                label: "构建状态",
                children: (
                  <div className="grid min-w-0 gap-4">
                    <Descriptions
                      size="small"
                      bordered
                      column={1}
                      styles={{
                        label: { width: "8rem", whiteSpace: "nowrap" },
                        content: { minWidth: 0, overflowWrap: "anywhere" },
                      }}
                      items={[
                        {
                          key: "version",
                          label: "目标版本",
                          children: <span className="break-all">{versionName}</span>,
                        },
                        {
                          key: "job",
                          label: "Jenkins 任务",
                          children: view.configuration ? (
                            <Typography.Link
                              href={view.configuration.jobUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="break-all"
                            >
                              {view.configuration.jobUrl}{" "}
                              <ExternalLink size={12} className="inline" />
                            </Typography.Link>
                          ) : (
                            "尚未配置"
                          ),
                        },
                        {
                          key: "parameters",
                          label: "构建参数",
                          children: (
                            <Flex wrap gap="small">
                              {view.configuration?.parameters.length
                                ? view.configuration.parameters.map((parameter) => (
                                    <Tag
                                      className="!m-0 max-w-full whitespace-normal break-all"
                                      key={parameter.name}
                                    >
                                      {parameter.name} = {parameter.value || "（空字符串）"}
                                    </Tag>
                                  ))
                                : "使用 Jenkins 默认参数"}
                            </Flex>
                          ),
                        },
                      ]}
                    />
                    {view.build ? (
                      <JenkinsDependencyBuildStatus build={view.build} timeZone={timeZone} />
                    ) : (
                      <Empty
                        image={Empty.PRESENTED_IMAGE_SIMPLE}
                        description="此版本尚未从平台触发构建"
                      />
                    )}
                    {view.build?.status === "unknown" ? (
                      <div className="grid gap-3 rounded-lg border border-border p-4">
                        <Checkbox
                          checked={acknowledged}
                          onChange={(event) => setAcknowledged(event.target.checked)}
                        >
                          我已在 Jenkins 核对本次构建，确认可以再次提交
                        </Checkbox>
                        <div>
                          <Button
                            disabled={!acknowledged || busy}
                            onClick={() =>
                              void run(async () => {
                                setView(
                                  jenkinsDependencyViewSchema.parse(
                                    await action("/acknowledge", {
                                      buildRevision: view.buildRevision,
                                    }),
                                  ),
                                );
                                setAcknowledged(false);
                              })
                            }
                          >
                            解除提交保护
                          </Button>
                        </div>
                      </div>
                    ) : null}
                    <Alert
                      type="info"
                      showIcon
                      title="构建成功后，由流水线中的 AutoForge 插件上传依赖包。"
                      description="依赖更新用于后续新建的执行；正在执行的任务仍使用原快照。关闭弹窗不会停止 Jenkins 构建，重新打开可继续查看状态。"
                    />
                  </div>
                ),
              },
              {
                key: "configuration",
                label: "流水线配置",
                forceRender: true,
                children: (
                  <JenkinsDependencyConfigurationForm
                    form={form}
                    active={active}
                    busy={busy}
                    apiTokenConfigured={view.configuration?.apiTokenConfigured ?? false}
                    onSave={(values) => void save(values)}
                    onChange={() => setDirty(true)}
                  />
                ),
              },
            ]}
          />
        )}
      </div>
    </ActionDialog>
  );
}

function fillConfiguration(
  form: ReturnType<typeof Form.useForm<SaveJenkinsDependencyConfiguration>>[0],
  view: JenkinsDependencyView,
) {
  form.setFieldsValue({
    ...view.configuration,
    apiToken: "",
    parameters: view.configuration?.parameters ?? [],
  });
}
async function requestJson(url: string, options: RequestInit = {}): Promise<unknown> {
  const response = await fetch(url, {
    ...options,
    headers: { "content-type": "application/json" },
    cache: "no-store",
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(25000)])
      : AbortSignal.timeout(25000),
  });
  const error = await readApiError(response, "Jenkins 操作失败，请稍后重试。");
  if (error) throw error;
  return response.json();
}
async function requestView(url: string, signal?: AbortSignal) {
  return jenkinsDependencyViewSchema.parse(await requestJson(url, { signal: signal ?? null }));
}
function errorText(cause: unknown) {
  return cause instanceof Error ? cause.message : "Jenkins 操作失败，请稍后重试。";
}
function isBuildableInspection(value: unknown): value is { name: string; buildable: true } {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string" &&
    "buildable" in value &&
    value.buildable === true
  );
}
