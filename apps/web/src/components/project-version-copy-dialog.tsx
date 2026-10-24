"use client";

import { useEffect, useRef, useState } from "react";
import { Alert, Descriptions, Progress, Radio, Tag } from "antd";
import { Copy } from "lucide-react";
import {
  projectVersionCopySchema,
  projectVersionCopyTargetsSchema,
  type ProjectVersionCopy,
  type ProjectVersionCopyTargets,
} from "@autoforge/contracts";
import { ActionDialog } from "./action-dialog";
import { Button, Input, Select } from "./ui";
import { readApiError } from "@/lib/client-api";

const PHASES: Record<ProjectVersionCopy["phase"], string> = {
  snapshot: "生成一致性快照",
  files: "复制文件与附件",
  records: "复制业务记录",
  logs: "复制执行日志",
  verify: "校验副本",
  cleanup: "清理未完成的副本",
  done: "复制完成",
};
const STATUSES: Record<ProjectVersionCopy["status"], string> = {
  queued: "等待后台处理",
  running: "正在复制",
  cancelling: "正在取消并清理",
  completed: "复制完成",
  failed: "复制失败",
  cancelled: "已取消",
};
const active = (job: ProjectVersionCopy) =>
  ["queued", "running", "cancelling"].includes(job.status);
type Target = { id: string; name: string };

export function ProjectVersionCopyButton({
  projectId,
  versionId,
  versionName,
  onCompleted,
}: {
  projectId: string;
  versionId: string;
  versionName: string;
  onCompleted: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        <Copy size={15} aria-hidden="true" />
        复制整个版本
      </Button>
      {open ? (
        <VersionCopyDialog
          projectId={projectId}
          versionId={versionId}
          versionName={versionName}
          onClose={() => setOpen(false)}
          onCompleted={onCompleted}
        />
      ) : null}
    </>
  );
}

function VersionCopyDialog({
  projectId,
  versionId,
  versionName,
  onClose,
  onCompleted,
}: {
  projectId: string;
  versionId: string;
  versionName: string;
  onClose: () => void;
  onCompleted: () => void;
}) {
  const [targets, setTargets] = useState<Target[]>([]);
  const [jobs, setJobs] = useState<ProjectVersionCopy[]>([]);
  const [job, setJob] = useState<ProjectVersionCopy | null>(null);
  const [targetProjectId, setTargetProjectId] = useState(projectId);
  const [targetMode, setTargetMode] = useState<"new" | "existing">("new");
  const [targetVersionId, setTargetVersionId] = useState("");
  const [versionOptions, setVersionOptions] = useState<ProjectVersionCopyTargets>({ items: [] });
  const [versionPages, setVersionPages] = useState([""]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionsError, setVersionsError] = useState("");
  const [name, setName] = useState(`${versionName.slice(0, 115)}-副本`);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const requestKey = useRef<string>("");
  const completed = useRef(new Set<string>());
  const completionCallback = useRef(onCompleted);
  const pollingJobId = job && active(job) ? job.id : undefined;
  useEffect(() => {
    completionCallback.current = onCompleted;
  }, [onCompleted]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const response = await fetch(
        `/api/v1/project-version-copies?${new URLSearchParams({ projectId })}`,
        { cache: "no-store", signal: controller.signal },
      );
      const failure = await readApiError(response, "读取版本复制任务失败。");
      if (failure) throw failure;
      const result = (await response.json()) as { targets: Target[]; jobs: unknown[] };
      const recent = result.jobs.map((value) => projectVersionCopySchema.parse(value));
      setTargets(result.targets);
      setJobs(recent);
      if (!result.targets.some((target) => target.id === projectId))
        setTargetProjectId(result.targets[0]?.id ?? "");
      setJob(
        recent.find(
          (candidate) =>
            candidate.sourceVersionId === versionId &&
            (active(candidate) || candidate.status === "failed"),
        ) ?? null,
      );
    })()
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "读取失败。");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [projectId, versionId]);

  const versionCursor = versionPages.at(-1)!;
  useEffect(() => {
    if (job || targetMode !== "existing" || !targetProjectId) return;
    const controller = new AbortController();
    void (async () => {
      const parameters = new URLSearchParams({ projectId, targetProjectId });
      if (versionCursor) parameters.set("afterId", versionCursor);
      const response = await fetch(`/api/v1/project-version-copies?${parameters}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const failure = await readApiError(response, "读取已有版本失败。");
      if (failure) throw failure;
      const page = projectVersionCopyTargetsSchema.parse(await response.json());
      if (!controller.signal.aborted) setVersionOptions(page);
    })()
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setVersionsError(cause instanceof Error ? cause.message : "读取已有版本失败。");
      })
      .finally(() => {
        if (!controller.signal.aborted) setVersionsLoading(false);
      });
    return () => controller.abort();
  }, [projectId, targetProjectId, targetMode, versionCursor, job]);

  function resetVersionSelection() {
    setTargetVersionId("");
    setVersionPages([""]);
    setVersionOptions({ items: [] });
    setVersionsLoading(true);
    setVersionsError("");
    requestKey.current = "";
  }
  function changeVersionPage(pages: string[]) {
    setVersionPages(pages);
    setTargetVersionId("");
    setVersionsLoading(true);
    setVersionsError("");
    requestKey.current = "";
  }

  useEffect(() => {
    if (!pollingJobId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const response = await fetch(`/api/v1/project-version-copies/${pollingJobId}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const failure = await readApiError(response, "读取复制进度失败。");
        if (failure) throw failure;
        const next = projectVersionCopySchema.parse(await response.json());
        if (controller.signal.aborted) return;
        setJob(next);
        setJobs((previous) =>
          [next, ...previous.filter((candidate) => candidate.id !== next.id)].slice(0, 50),
        );
        setError("");
        if (next.status === "completed" && !completed.current.has(next.id)) {
          completed.current.add(next.id);
          completionCallback.current();
        }
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "读取进度失败。");
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 3000);
    };
    timer = setTimeout(() => void poll(), 1000);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [pollingJobId]);

  async function submit(action?: "retry" | "cancel") {
    setPending(true);
    setError("");
    try {
      requestKey.current ||= crypto.randomUUID();
      const response = await fetch(
        action && job
          ? `/api/v1/project-version-copies/${job.id}`
          : "/api/v1/project-version-copies",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            action
              ? { action }
              : {
                  sourceProjectId: projectId,
                  sourceVersionId: versionId,
                  targetProjectId,
                  ...(targetMode === "existing"
                    ? { targetVersionId }
                    : { targetVersionName: name }),
                  requestKey: requestKey.current,
                },
          ),
        },
      );
      const failure = await readApiError(response, "提交版本复制失败。");
      if (failure) throw failure;
      const next = projectVersionCopySchema.parse(await response.json());
      setJob(next);
      setJobs((previous) =>
        [next, ...previous.filter((candidate) => candidate.id !== next.id)].slice(0, 50),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "提交失败。");
    } finally {
      setPending(false);
    }
  }

  const recent = jobs.filter((candidate) => candidate.sourceVersionId === versionId).slice(0, 5);
  const selectedTargetIsEmpty = versionOptions.items.some(
    (version) => version.id === targetVersionId && version.empty && version.id !== versionId,
  );
  return (
    <ActionDialog
      open
      title="复制整个版本"
      description="复制到本站目标项目的新版本或已有空版本，来源版本继续保留。"
      onClose={onClose}
      closeDisabled={pending}
      footer={
        <>
          <Button type="button" onClick={onClose} disabled={pending}>
            关闭
          </Button>
          {!job ? (
            <Button
              variant="primary"
              type="submit"
              form="version-copy-form"
              disabled={
                loading ||
                pending ||
                !targetProjectId ||
                (targetMode === "existing" &&
                  (versionsLoading || Boolean(versionsError) || !selectedTargetIsEmpty))
              }
            >
              {pending ? "正在提交…" : "开始复制"}
            </Button>
          ) : active(job) ? (
            <Button
              variant="danger"
              type="button"
              disabled={pending || job.status === "cancelling"}
              onClick={() => void submit("cancel")}
            >
              取消复制
            </Button>
          ) : (
            <>
              {job.status === "failed" ? (
                <>
                  <Button type="button" disabled={pending} onClick={() => void submit("cancel")}>
                    清理副本
                  </Button>
                  <Button
                    variant="primary"
                    type="button"
                    disabled={pending}
                    onClick={() => void submit("retry")}
                  >
                    {job.phase === "cleanup" ? "重试清理" : "重试复制"}
                  </Button>
                </>
              ) : null}
              <Button
                type="button"
                disabled={pending}
                onClick={() => {
                  setJob(null);
                  resetVersionSelection();
                  setError("");
                }}
              >
                新建副本
              </Button>
            </>
          )}
        </>
      }
    >
      <div className="grid min-w-0 gap-4">
        {error ? <Alert type="error" title={error} showIcon /> : null}
        {!job ? (
          <form
            id="version-copy-form"
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <Descriptions
              size="small"
              column={1}
              items={[
                {
                  key: "source",
                  label: "来源版本",
                  children: <span className="break-all">{versionName}</span>,
                },
              ]}
            />
            <label className="grid gap-2 text-sm font-medium">
              目标项目
              <Select
                aria-label="目标项目"
                required
                value={targetProjectId}
                disabled={loading || pending}
                onChange={(event) => {
                  setTargetProjectId(event.target.value);
                  resetVersionSelection();
                }}
              >
                {targets.map((target) => (
                  <option key={target.id} value={target.id}>
                    {target.name}
                  </option>
                ))}
              </Select>
            </label>
            <div className="grid gap-2 text-sm font-medium">
              <span id="version-copy-target-mode">目标版本</span>
              <Radio.Group
                aria-labelledby="version-copy-target-mode"
                value={targetMode}
                disabled={loading || pending}
                options={[
                  { value: "new", label: "新建版本" },
                  { value: "existing", label: "已有空版本" },
                ]}
                onChange={(event) => {
                  setTargetMode(event.target.value as "new" | "existing");
                  resetVersionSelection();
                }}
              />
            </div>
            {targetMode === "new" ? (
              <label className="grid gap-2 text-sm font-medium">
                新版本名称
                <Input
                  aria-label="新版本名称"
                  required
                  maxLength={120}
                  value={name}
                  disabled={loading || pending}
                  onChange={(event) => {
                    setName(event.target.value);
                    requestKey.current = "";
                  }}
                />
              </label>
            ) : (
              <div className="grid gap-2">
                <label className="grid gap-2 text-sm font-medium">
                  已有空版本
                  <Select
                    aria-label="已有空版本"
                    required
                    value={targetVersionId}
                    disabled={loading || pending || versionsLoading || Boolean(versionsError)}
                    onChange={(event) => {
                      setTargetVersionId(event.target.value);
                      requestKey.current = "";
                    }}
                  >
                    <option value="">
                      {versionsLoading ? "正在读取版本…" : "请选择已有空版本"}
                    </option>
                    {versionOptions.items.map((version) => (
                      <option
                        key={version.id}
                        value={version.id}
                        disabled={!version.empty || version.id === versionId}
                      >
                        {version.name}
                        {version.id === versionId
                          ? "（来源版本）"
                          : !version.empty
                            ? "（非空）"
                            : version.status === "archived"
                              ? "（已归档）"
                              : ""}
                      </option>
                    ))}
                  </Select>
                </label>
                <p className="m-0 text-xs text-muted-foreground">
                  需无测试阶段、用例、任务、执行记录及版本资源配置。保留目标名称与
                  ID；取消后仍保留原版本。
                </p>
                {versionsError ? <Alert type="error" showIcon title={versionsError} /> : null}
                {!versionsLoading &&
                !versionsError &&
                !versionOptions.items.some(
                  (version) => version.empty && version.id !== versionId,
                ) ? (
                  <Alert type="info" showIcon title="当前页没有可选的空版本" />
                ) : null}
                {versionPages.length > 1 || versionOptions.nextCursor ? (
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      disabled={pending || versionsLoading || versionPages.length === 1}
                      onClick={() => {
                        changeVersionPage(versionPages.slice(0, -1));
                      }}
                    >
                      上一页
                    </Button>
                    <span className="text-xs text-muted-foreground">
                      第 {versionPages.length} 页
                    </span>
                    <Button
                      type="button"
                      disabled={pending || versionsLoading || !versionOptions.nextCursor}
                      onClick={() => {
                        changeVersionPage([...versionPages, versionOptions.nextCursor!]);
                      }}
                    >
                      下一页
                    </Button>
                  </div>
                ) : null}
              </div>
            )}
            <Alert
              type="info"
              showIcon
              title="复制范围"
              description="包含测试阶段、普通与 DDT 用例、导入记录、任务与快照、历史执行及日志、附件和分析记录。执行机和用户仍引用本站原有记录，项目成员及平台设置不复制。"
            />
            <Alert
              type="warning"
              showIcon
              title="来源版本需先结束执行和导入"
              description="副本任务、计划和通知配置默认停用；既有公开访问授权随记录复制。内网上传资源会生成独立文件副本，URL 资源保留原地址。完成前目标版本不可见，关闭此窗口不影响后台复制。"
            />
            {!loading && !targets.length ? (
              <Alert type="warning" title="没有具备完整复制权限的目标项目，请联系项目管理员。" />
            ) : null}
          </form>
        ) : (
          <section aria-label="版本复制进度" className="grid min-w-0 gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <strong className="min-w-0 break-all">{job.targetVersionName}</strong>
              <Tag
                color={
                  job.status === "completed"
                    ? "success"
                    : job.status === "failed"
                      ? "error"
                      : "processing"
                }
              >
                {STATUSES[job.status]}
              </Tag>
            </div>
            <p className="m-0 text-sm text-muted-foreground">
              {PHASES[job.phase]} · 可关闭窗口，稍后从本入口继续查看
            </p>
            <Progress
              percent={job.progressPercent}
              status={
                job.status === "failed"
                  ? "exception"
                  : job.status === "completed"
                    ? "success"
                    : "normal"
              }
            />
            <Descriptions
              size="small"
              column={1}
              items={[
                {
                  key: "records",
                  label: "业务记录",
                  children: `${job.copiedRows.toLocaleString()} / ${job.totalRows.toLocaleString()}`,
                },
                {
                  key: "files",
                  label: "文件与附件",
                  children: `${job.copiedObjects.toLocaleString()} / ${job.totalObjects.toLocaleString()}`,
                },
                {
                  key: "logs",
                  label: "执行日志",
                  children: `${job.copiedAttempts.toLocaleString()} / ${job.totalAttempts.toLocaleString()} 次执行尝试`,
                },
              ]}
            />
            {job.errorMessage ? (
              <Alert type="error" showIcon title={job.errorMessage} description={job.errorCode} />
            ) : null}
            {job.status === "completed" ? (
              <Alert
                type="success"
                showIcon
                title="副本已校验并开放使用"
                description="请切换到目标项目和目标版本查看；确认执行配置后再启用任务与计划。"
              />
            ) : null}
          </section>
        )}
        {recent.length ? (
          <section className="grid gap-2 border-t border-border pt-3" aria-label="最近的版本复制">
            <strong className="text-sm">最近复制</strong>
            {recent.map((candidate) => (
              <Button
                key={candidate.id}
                type="button"
                variant="ghost"
                className="h-auto min-h-8 min-w-0 justify-between gap-3 text-left"
                disabled={pending}
                onClick={() => {
                  setJob(candidate);
                  setError("");
                }}
              >
                <span className="min-w-0 truncate">{candidate.targetVersionName}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {STATUSES[candidate.status]}
                </span>
              </Button>
            ))}
          </section>
        ) : null}
      </div>
    </ActionDialog>
  );
}
