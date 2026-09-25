"use client";

import { Alert, Checkbox, Empty, Flex, Steps, Tag, Typography } from "antd";
import { useEffect, useRef, useState } from "react";
import type { CaseSuite, ProjectStructure } from "@autoforge/domain";
import {
  versionInitializationResultSchema,
  type VersionInitializationInput,
  type VersionInitializationResult,
} from "@autoforge/contracts";
import { ActionDialog } from "./action-dialog";
import { Button, Input, Select } from "./ui";
import { useToast } from "./ui-feedback";
import { readApiError } from "@/lib/client-api";
import { useConcurrentModificationFeedback } from "./concurrent-modification-feedback";
import type { ProjectContext } from "./create-project-hierarchy-dialog";

const steps = [
  {
    title: "测试阶段",
    hint: "可继承来源版本的阶段名称与说明，也可以手动新建。已有同名阶段直接复用。",
  },
  {
    title: "运行依赖",
    hint: "可继承 JDK 与完整依赖 JAR 压缩包的引用，无需重新上传。目标已有配置时保留，不会覆盖。",
  },
  {
    title: "普通用例",
    hint: "可继承 TestNG 用例及 JAR 来源。按目标阶段匹配完整类名，已有用例跳过，版本历史独立。",
  },
  {
    title: "DDT 用例",
    hint: "可继承 CaseID、SR、字段和用户旅程。已有 CaseID 跳过，数据独立维护，执行历史不复制。",
  },
  {
    title: "SR 关联",
    hint: "可继承候选测试类、需求分类与 SR 关联。执行类按目标阶段的完整类名重新匹配；请先准备普通和 DDT 用例。",
  },
  {
    title: "用例任务",
    hint: "可继承任务配置，并选择是否复制成员。按阶段、完整类名或 CaseID 匹配目标用例；新任务默认停用，不复制执行历史、计划或通知绑定。",
  },
] as const;
type Version = ProjectStructure["versions"][number];
type Progress = {
  queue: VersionInitializationInput[];
  index: number;
  cursor?: string;
  inheritedCount: number;
  skippedCount: number;
  warnings: string[];
  complete: boolean;
};

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: "no-store", ...init });
  const error = await readApiError(response, "初始化请求失败，请稍后继续。");
  if (error) throw error;
  return response.json() as Promise<T>;
}

export function VersionInitializationDialog({
  projectId,
  projectName,
  versionId,
  versionName,
  onFinish,
  onClose,
}: {
  projectId: string;
  projectName: string;
  versionId: string;
  versionName: string;
  onFinish(context: ProjectContext): Promise<void>;
  onClose(): void;
}) {
  const toast = useToast();
  const showConcurrentModification = useConcurrentModificationFeedback();
  const [structure, setStructure] = useState<ProjectStructure>();
  const [step, setStep] = useState(0);
  const [sourceId, setSourceId] = useState("");
  const [stageIds, setStageIds] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [stageName, setStageName] = useState("");
  const [suites, setSuites] = useState<CaseSuite[]>([]);
  const [suiteCursor, setSuiteCursor] = useState<string>();
  const [suiteIds, setSuiteIds] = useState<string[]>([]);
  const [includeCases, setIncludeCases] = useState(true);
  const [pending, setPending] = useState(false);
  const [inheriting, setInheriting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [statuses, setStatuses] = useState<Record<number, string>>({});
  const [progress, setProgress] = useState<Progress>();
  const stopping = useRef(false);
  const running = useRef(false);
  const controller = useRef<AbortController | undefined>(undefined);
  const source = structure?.versions.find((version) => version.id === sourceId);
  const target = structure?.versions.find((version) => version.id === versionId);
  const sourceStages = source?.stages.filter((stage) => stage.status === "active") ?? [];
  const targetStages = target?.stages.filter((stage) => stage.status === "active") ?? [];
  const path = `/api/v1/projects/${projectId}/versions/${versionId}/initialize`;
  const labels = steps[step]!;

  async function refresh() {
    const next = await requestJson<ProjectStructure>(`/api/v1/projects/${projectId}/structure`);
    setStructure(next);
    return next;
  }
  useEffect(() => {
    let active = true;
    const abort = new AbortController();
    void requestJson<ProjectStructure>(`/api/v1/projects/${projectId}/structure`, {
      signal: abort.signal,
    })
      .then((next) => {
        if (active) setStructure(next);
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      abort.abort();
      stopping.current = true;
      controller.current?.abort();
    };
  }, [projectId]);

  function targetStageId(sourceStageId: string): string {
    const stage = sourceStages.find((item) => item.id === sourceStageId);
    return (
      mapping[sourceStageId] ??
      targetStages.find(
        (item) => item.name.trim().toLocaleLowerCase() === stage?.name.trim().toLocaleLowerCase(),
      )?.id ??
      ""
    );
  }
  function chooseSource(value: string) {
    setSourceId(value);
    setStatuses({});
    setStageIds(
      structure?.versions
        .find((version) => version.id === value)
        ?.stages.filter((stage) => stage.status === "active")
        .map((stage) => stage.id) ?? [],
    );
    setMapping({});
    setSuites([]);
    setSuiteIds([]);
    setSuiteCursor(undefined);
    setProgress(undefined);
    setError("");
  }
  function changeStep(index: number, skipped = false) {
    if (pending) return;
    if (skipped) setStatuses((current) => ({ ...current, [step]: "已跳过，可稍后补充" }));
    setStep(index);
    setProgress(undefined);
    setError("");
  }
  async function finish() {
    if (running.current) return;
    setPending(true);
    setError("");
    try {
      await onFinish({
        projectId,
        projectVersionId: versionId,
        ...(targetStages[0] ? { testStageId: targetStages[0].id } : {}),
      });
      toast.success("已进入项目版本；跳过的配置可从版本下拉中的初始化入口继续补充。");
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }
  function queueForStep(): VersionInitializationInput[] {
    const common = {
      sourceProjectVersionId: sourceId,
      includeCases,
      stageMappings: sourceStages
        .map((stage) => ({
          sourceTestStageId: stage.id,
          targetTestStageId: targetStageId(stage.id),
        }))
        .filter((item) => item.targetTestStageId),
    };
    if (step === 1) return [{ ...common, step: "runtime" }];
    if (step === 5)
      return suites
        .filter((suite) => suiteIds.includes(suite.id))
        .map((suite) => ({
          ...common,
          step: "suite",
          sourceSuiteId: suite.id,
          sourceSuiteRevision: suite.revision,
        }));
    const operations: VersionInitializationInput["step"][] =
      step === 0
        ? ["stage"]
        : step === 2
          ? ["testng"]
          : step === 3
            ? ["ddt"]
            : ["range", "categories", "sr"];
    return sourceStages
      .filter((stage) => stageIds.includes(stage.id))
      .flatMap((stage) =>
        operations.map((operation) => ({
          ...common,
          step: operation,
          sourceTestStageId: stage.id,
          ...(targetStageId(stage.id) ? { targetTestStageId: targetStageId(stage.id) } : {}),
        })),
      );
  }
  async function inherit() {
    if (running.current) return;
    const queue = progress?.queue ?? queueForStep();
    if (!sourceId || !queue.length) {
      setError("请选择来源版本及需要继承的项目，也可以跳过此步骤。");
      return;
    }
    if (
      queue.some(
        (item) => !["stage", "runtime", "suite"].includes(item.step) && !item.targetTestStageId,
      )
    ) {
      setError("请为所选来源阶段选择目标阶段，或返回第一步创建；不需要的阶段可以取消勾选。");
      return;
    }
    running.current = true;
    setInheriting(true);
    stopping.current = false;
    setPending(true);
    setError("");
    let current: Progress = progress ?? {
      queue,
      index: 0,
      inheritedCount: 0,
      skippedCount: 0,
      warnings: [],
      complete: false,
    };
    const pauseTimer = window.setTimeout(() => {
      stopping.current = true;
    }, 30_000);
    try {
      while (current.index < queue.length && !stopping.current) {
        const abort = new AbortController();
        controller.current = abort;
        const input = queue[current.index]!;
        const result: VersionInitializationResult = versionInitializationResultSchema.parse(
          await requestJson<unknown>(path, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              ...input,
              ...(current.cursor ? { cursor: current.cursor } : {}),
            }),
            signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]),
          }),
        );
        if (result.nextCursor && result.nextCursor === current.cursor)
          throw new Error("继承游标未推进，请关闭后重新进入。");
        if (result.targetTestStageId && input.sourceTestStageId)
          setMapping((existing) => ({
            ...existing,
            [input.sourceTestStageId!]: result.targetTestStageId!,
          }));
        const index = current.index + (result.nextCursor ? 0 : 1);
        current = {
          queue,
          index,
          ...(result.nextCursor ? { cursor: result.nextCursor } : {}),
          inheritedCount: current.inheritedCount + result.inheritedCount,
          skippedCount: current.skippedCount + result.skippedCount,
          warnings: [...current.warnings, ...result.warnings].slice(0, 50),
          complete: index === queue.length,
        };
        setProgress(current);
      }
      if (current.complete) {
        setStatuses((existing) => ({
          ...existing,
          [step]: current.warnings.length ? "已处理，请检查提示" : "已处理",
        }));
        toast.success(
          `${labels.title}继承已处理：新增或匹配 ${current.inheritedCount} 项，跳过 ${current.skippedCount} 项。`,
        );
      }
      await refresh();
    } catch (cause) {
      setProgress(current);
      setError(`${errorMessage(cause)} 已完成部分保留，可继续或跳过。`);
      await showConcurrentModification(cause);
    } finally {
      window.clearTimeout(pauseTimer);
      running.current = false;
      setInheriting(false);
      controller.current = undefined;
      setPending(false);
    }
  }
  async function createStage() {
    if (!stageName.trim() || pending) return;
    setPending(true);
    setError("");
    try {
      await requestJson(`/api/v1/projects/${projectId}/versions/${versionId}/stages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: stageName.trim(), description: "" }),
      });
      setStageName("");
      await refresh();
      toast.success("测试阶段已创建。");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }
  async function loadSuites(cursor?: string) {
    if (!sourceId || pending) return;
    setPending(true);
    setError("");
    try {
      const page = await requestJson<{ items: CaseSuite[]; nextCursor?: string }>(
        `${path}?${new URLSearchParams({ sourceProjectVersionId: sourceId, ...(cursor ? { cursor } : {}) })}`,
      );
      setSuites((current) => (cursor ? [...current, ...page.items] : page.items));
      setSuiteCursor(page.nextCursor);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  const sourceOptions = structure?.versions.filter((version) => version.id !== versionId) ?? [];
  const frozen = pending || Boolean(progress);
  return (
    <ActionDialog
      open
      title="版本初始化"
      description={`${projectName} / ${versionName} · 每一步都可以跳过，也可以随时结束后再补充。`}
      onClose={() => {
        if (!pending) onClose();
      }}
      closeDisabled={pending}
      className="!w-[min(960px,calc(100vw-48px))] !max-w-[calc(100vw-48px)]"
      footer={
        <>
          <Button disabled={pending} onClick={() => void finish()}>
            稍后配置
          </Button>
          <div className="flex-1" />
          <Button disabled={pending || step === 0} onClick={() => changeStep(step - 1)}>
            上一步
          </Button>
          <Button
            disabled={pending}
            onClick={() => (step === steps.length - 1 ? void finish() : changeStep(step + 1, true))}
          >
            跳过此步
          </Button>
          <Button
            variant="primary"
            disabled={pending}
            onClick={() => (step === steps.length - 1 ? void finish() : changeStep(step + 1))}
          >
            {step === steps.length - 1 ? "完成并进入版本" : "下一步"}
          </Button>
        </>
      }
    >
      <div className="grid min-w-0 gap-4">
        <Steps
          size="small"
          current={step}
          onChange={(index) => changeStep(index)}
          items={steps.map((item, index) => ({
            title: item.title,
            description: statuses[index],
            disabled: pending,
          }))}
        />
        {error ? <Alert type="error" showIcon title={error} /> : null}
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-4 rounded-lg bg-muted/40 p-3">
          <label className="grid gap-1 text-sm">
            继承来源（可选）
            <Select
              value={sourceId}
              disabled={frozen || loading}
              onChange={(event) => chooseSource(event.target.value)}
            >
              <option value="">暂不继承，从空白开始</option>
              {sourceOptions.map((version) => (
                <option key={version.id} value={version.id}>
                  {version.name}
                </option>
              ))}
            </Select>
          </label>
          <div className="grid content-center gap-1 text-sm">
            <strong className="break-all">目标版本：{versionName}</strong>
            <span className="text-muted-foreground">
              {loading
                ? "正在读取可继承配置…"
                : sourceOptions.length
                  ? "选择其他版本后，可按步骤选择继承内容。"
                  : "当前项目没有其他版本，可跳过继承，稍后手动配置。"}
            </span>
          </div>
        </div>
        <Flex align="center" gap="small">
          <Typography.Title level={5} style={{ margin: 0 }}>
            {labels.title}
          </Typography.Title>
          <Tag color={sourceOptions.length ? "blue" : "default"}>
            {sourceOptions.length ? "支持从其他版本继承" : "暂无可继承版本"}
          </Tag>
          <Tag>可跳过</Tag>
        </Flex>
        <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
          {labels.hint}
        </Typography.Paragraph>
        {step === 0 ? (
          <div className="grid gap-3">
            <Flex gap="small" wrap align="center">
              <Input
                aria-label="新测试阶段名称"
                placeholder="也可手动输入阶段，例如 SIT"
                maxLength={128}
                value={stageName}
                onChange={(event) => setStageName(event.target.value)}
                disabled={pending}
                className="!w-72"
              />
              <Button disabled={pending || !stageName.trim()} onClick={() => void createStage()}>
                添加阶段
              </Button>
            </Flex>
            <Flex gap="small" wrap>
              {targetStages.length ? (
                targetStages.map((stage) => <Tag key={stage.id}>{stage.name}</Tag>)
              ) : (
                <Typography.Text type="secondary">
                  目标版本尚无测试阶段，可以暂时保持为空。
                </Typography.Text>
              )}
            </Flex>
          </div>
        ) : null}
        {step === 1 ? (
          <div className="grid grid-cols-2 gap-3">
            {[
              { title: "来源运行依赖", version: source },
              { title: "目标运行依赖", version: target },
            ].map(({ title, version }) => (
              <div key={title} className="grid min-w-0 gap-2 rounded-lg border border-border p-3">
                <strong>{title}</strong>
                <RuntimeAssets version={version} />
              </div>
            ))}
          </div>
        ) : null}
        {[0, 2, 3, 4].includes(step) && source ? (
          <div className="grid gap-2">
            <Flex justify="space-between" align="center">
              <strong className="text-sm">选择需要继承的测试阶段</strong>
              <Flex gap="small">
                <Button
                  disabled={frozen}
                  onClick={() => setStageIds(sourceStages.map((item) => item.id))}
                >
                  全选
                </Button>
                <Button disabled={frozen} onClick={() => setStageIds([])}>
                  取消全选
                </Button>
              </Flex>
            </Flex>
            <div className="grid max-h-56 gap-2 overflow-y-auto rounded-lg border border-border p-3">
              {sourceStages.length ? (
                sourceStages.map((stage) => (
                  <div
                    key={stage.id}
                    className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-4"
                  >
                    <Checkbox
                      disabled={frozen}
                      checked={stageIds.includes(stage.id)}
                      onChange={(event) =>
                        setStageIds((current) =>
                          event.target.checked
                            ? [...current, stage.id]
                            : current.filter((id) => id !== stage.id),
                        )
                      }
                    >
                      <span className="break-all">{stage.name}</span>
                    </Checkbox>
                    {step === 0 ? (
                      <span className="text-xs text-muted-foreground">
                        {targetStageId(stage.id) ? "复用目标同名阶段" : "可继承为新阶段"}
                      </span>
                    ) : (
                      <Select
                        aria-label={`${stage.name} 的目标阶段`}
                        value={targetStageId(stage.id)}
                        disabled={frozen || !stageIds.includes(stage.id)}
                        onChange={(event) =>
                          setMapping((current) => ({ ...current, [stage.id]: event.target.value }))
                        }
                      >
                        <option value="">请选择目标阶段</option>
                        {targetStages.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name}
                          </option>
                        ))}
                      </Select>
                    )}
                  </div>
                ))
              ) : (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="来源版本没有启用的测试阶段"
                />
              )}
            </div>
          </div>
        ) : null}
        {step === 5 ? (
          <div className="grid gap-3">
            <Flex gap="small" wrap align="center">
              <Button disabled={!sourceId || frozen} onClick={() => void loadSuites()}>
                读取可继承任务
              </Button>
              <Checkbox
                checked={includeCases}
                disabled={frozen}
                onChange={(event) => setIncludeCases(event.target.checked)}
              >
                同时复制匹配的普通／DDT 用例成员
              </Checkbox>
            </Flex>
            <Typography.Text type="secondary">
              任务按同名阶段或此前选择的阶段对应关系匹配成员；缺失项会逐项提示。继承后请到任务设置确认并启用。
            </Typography.Text>
            {suites.length ? (
              <>
                <Flex gap="small">
                  <Button
                    disabled={frozen}
                    onClick={() => setSuiteIds(suites.map((suite) => suite.id))}
                  >
                    全选已加载任务
                  </Button>
                  <Button disabled={frozen} onClick={() => setSuiteIds([])}>
                    取消选择任务
                  </Button>
                </Flex>
                <div className="grid max-h-56 gap-2 overflow-y-auto rounded-lg border border-border p-3">
                  {suites.map((suite) => (
                    <Checkbox
                      key={suite.id}
                      disabled={frozen}
                      checked={suiteIds.includes(suite.id)}
                      onChange={(event) =>
                        setSuiteIds((current) =>
                          event.target.checked
                            ? [...current, suite.id]
                            : current.filter((id) => id !== suite.id),
                        )
                      }
                    >
                      <span className="break-all">{suite.name}</span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        {suite.caseCount} 个用例
                      </span>
                    </Checkbox>
                  ))}
                </div>
              </>
            ) : null}
            {suiteCursor ? (
              <Button disabled={frozen} onClick={() => void loadSuites(suiteCursor)}>
                加载更多任务
              </Button>
            ) : null}
          </div>
        ) : null}
        {progress ? (
          <Alert
            showIcon
            type={progress.warnings.length ? "warning" : progress.complete ? "success" : "info"}
            title={`${progress.complete ? "本步已处理" : pending ? "正在继承" : "已暂停，可继续"}：新增或匹配 ${progress.inheritedCount} 项，跳过 ${progress.skippedCount} 项`}
            description={
              progress.warnings.length ? (
                <div className="max-h-32 overflow-y-auto break-all">
                  {progress.warnings.map((warning, index) => (
                    <div key={index}>{warning}</div>
                  ))}
                  {progress.warnings.length === 50 ? (
                    <div>仅显示前 50 条提示，请检查目标版本。</div>
                  ) : null}
                </div>
              ) : (
                "已保存内容不会因跳过、关闭或暂停而撤销。"
              )
            }
          />
        ) : null}
        <Flex justify="end" gap="small">
          {progress && !pending ? (
            <Button onClick={() => setProgress(undefined)}>重新选择内容</Button>
          ) : null}
          {inheriting ? (
            <Button
              onClick={() => {
                stopping.current = true;
              }}
            >
              当前批次后暂停
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={pending || loading || !sourceId || progress?.complete}
              onClick={() => void inherit()}
            >
              {progress && !progress.complete ? "继续继承" : "继承所选内容"}
            </Button>
          )}
        </Flex>
      </div>
    </ActionDialog>
  );
}

function RuntimeAssets({ version }: { version: Version | undefined }) {
  return (
    <>
      <span className="break-all text-sm">
        JDK：{version?.adapterConfiguration.jdkAsset?.fileName ?? "未配置"}
      </span>
      <span className="break-all text-sm">
        依赖 JAR：{version?.adapterConfiguration.jarBundleAsset?.fileName ?? "未配置"}
      </span>
    </>
  );
}
function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : "请求未完成，请稍后重试。";
}
