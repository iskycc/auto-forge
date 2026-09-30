"use client";

import { DdtDebugChangeActions } from "./ddt-change-review";
import { Divider, Empty, Flex, Switch, Tag, Typography } from "antd";
import { Bug, Play, Terminal } from "lucide-react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { DdtScope, Runner, RunnerGroup, RunBatch } from "@autoforge/domain";
import { Button, Input, Select, Textarea } from "./ui";
import { Card } from "./ui/card";
import { Tabs } from "./ui/tabs";
import { TabContent } from "./ui/tab-content";
import { Segmented } from "./ui/segmented";
import { Notice } from "./ui/notice";
import { useToast } from "./ui-feedback";
import { createCaseDebugRunSchema } from "@autoforge/contracts";
import { ZodError } from "zod";
import { CaseDebugInput } from "./case-debug-input";
import { CaseDebugResults } from "./case-debug-results";
import { CaseDebugSplitter } from "./case-debug-splitter";
import { debugRequest } from "@/lib/case-debug-client";
import { LinkButton } from "./ui/link-button";
import { caseDebugDraftKey, createCaseDebugDraftStore } from "@/lib/case-debug-draft";

export type CaseDebugWorkspaceProps = {
  scope: DdtScope;
  ddtDebugAccess: { ownerUserId: string; accessKey: string };
  maxJarBytes: number;
  labels: { project: string; version: string; stage: string };
  permissions: { uploadJar: boolean; uploadDdt: boolean; readLogs: boolean; cancel: boolean };
};

export function CaseDebugWorkspace(props: CaseDebugWorkspaceProps) {
  const parameters = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const active = parameters.get("tab") === "ddt" ? "ddt" : "testng";
  const [visited, setVisited] = useState<Set<string>>(new Set([active]));
  const visible = new Set([...visited, active]);
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-3">
      <header className="flex min-w-0 shrink-0 flex-wrap items-center justify-between gap-3">
        <div>
          <Typography.Title level={2} className="!mb-1">
            用例调试
          </Typography.Title>
          <Typography.Text type="secondary">
            选择用例、配置执行，在本页查看日志与结果；JAR 导入正式库，DDT 数据仅保存在个人调试库。
          </Typography.Text>
        </div>
        <Flex gap="small" wrap className="min-w-0 max-w-full">
          <Tag className="!whitespace-normal [overflow-wrap:anywhere]">{props.labels.version}</Tag>
          <Tag>{props.labels.stage}</Tag>
        </Flex>
      </header>
      <Tabs
        label="用例调试类型"
        value={active}
        items={[
          { key: "testng", label: "普通用例调试" },
          { key: "ddt", label: "DDT 调试" },
        ]}
        onChange={(next) => {
          setVisited(visible);
          const query = new URLSearchParams(parameters);
          query.set("tab", next);
          router.replace(`${pathname}?${query}`, { scroll: false });
        }}
      />
      {(["testng", "ddt"] as const)
        .filter((kind) => visible.has(kind))
        .map((kind) => (
          <div
            key={caseDebugDraftKey({
              ...props.scope,
              userId: props.ddtDebugAccess.ownerUserId,
              kind,
            })}
            hidden={active !== kind}
            className="min-h-0 flex-1"
          >
            <TabContent activeKey={active} className="block h-full min-h-0">
              <DebugPanel {...props} kind={kind} active={active === kind} />
            </TabContent>
          </div>
        ))}
    </div>
  );
}

function DebugPanel({
  scope,
  ddtDebugAccess,
  maxJarBytes,
  labels,
  permissions,
  kind,
  active,
}: CaseDebugWorkspaceProps & { kind: "testng" | "ddt"; active: boolean }) {
  const parameters = useSearchParams();
  const toast = useToast();
  const [draftStore] = useState(() =>
    createCaseDebugDraftStore(
      caseDebugDraftKey({ ...scope, userId: ddtDebugAccess.ownerUserId, kind }),
      {
        runnerKind: "runner",
        runnerId: "",
        groupId: "",
        adapterEnabled: kind === "ddt",
        suiteName: labels.project,
        testName: `${labels.version} ${labels.stage}`,
        addresses: "",
      },
      () => window.localStorage,
    ),
  );
  const { draft, status: draftStatus } = useSyncExternalStore(
    draftStore.subscribe,
    draftStore.getSnapshot,
    draftStore.getServerSnapshot,
  );
  const {
    executionClass,
    ddtCase,
    runnerKind,
    runnerId,
    groupId,
    adapterEnabled,
    suiteName,
    testName,
    addresses,
  } = draft;
  const [runners, setRunners] = useState<Runner[]>([]);
  const [groups, setGroups] = useState<RunnerGroup[]>([]);
  const batchScope = new URLSearchParams(scope).toString();
  const [batchId, setBatchId] = useState(
    parameters.get(`${kind}Scope`) === batchScope ? (parameters.get(`${kind}Batch`) ?? "") : "",
  );
  const [running, setRunning] = useState(Boolean(batchId));
  const [submitting, setSubmitting] = useState(false);
  const editingDisabled = submitting || draftStatus === "loading";
  const [error, setError] = useState("");
  const [resourcesRevision, setResourcesRevision] = useState(0);
  const onActiveChange = useCallback((value: boolean) => setRunning(value), []);
  const browserOrigin = useSyncExternalStore(
    subscribeOrigin,
    browserOriginSnapshot,
    serverOriginSnapshot,
  );
  const publicApiPath = `${browserOrigin}/api/v1/public/ddt/projects/${encodeURIComponent(scope.projectId)}/versions/${encodeURIComponent(scope.projectVersionId)}/stages/${encodeURIComponent(scope.testStageId)}/users/${encodeURIComponent(ddtDebugAccess.ownerUserId)}/debug/${encodeURIComponent(ddtDebugAccess.accessKey)}/case`;

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void Promise.all([
      debugRequest<{ items: Runner[] }>("/api/v1/runners?limit=500", { signal: controller.signal }),
      debugRequest<{ items: RunnerGroup[] }>("/api/v1/runner-groups", {
        signal: controller.signal,
      }),
    ])
      .then(([runnerPage, groupPage]) => {
        setRunners(runnerPage.items);
        setGroups(groupPage.items);
      })
      .catch((problem: unknown) => {
        if (!controller.signal.aborted)
          setError(problem instanceof Error ? problem.message : "执行资源加载失败。");
      });
    return () => controller.abort();
  }, [active, resourcesRevision]);

  async function execute() {
    setError("");
    if (!executionClass || (kind === "ddt" && !ddtCase)) {
      setError("请选择待调试用例和执行类。");
      return;
    }
    if (!(runnerKind === "runner" ? runnerId : groupId)) {
      setError("请选择执行机或执行机组。");
      return;
    }
    setSubmitting(true);
    try {
      const batch = await debugRequest<RunBatch>(
        `/api/v1/case-debug/runs?${new URLSearchParams(scope)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            createCaseDebugRunSchema.parse({
              ...scope,
              kind,
              caseDefinitionId: executionClass.id,
              ...(ddtCase ? { ddtCaseId: ddtCase.id } : {}),
              execution: {
                runnerIds: runnerKind === "runner" ? [runnerId] : [],
                ...(runnerKind === "group" ? { runnerGroupId: groupId } : {}),
                retryLimit: 0,
                retryMode: "round",
                artifactPatterns: ["reports/testng/**"],
                adapter: {
                  enabled: kind === "ddt" || adapterEnabled,
                  suiteName,
                  testName,
                  environmentAddresses: [
                    ...new Set(
                      addresses
                        .split("\n")
                        .map((line) => line.trim())
                        .filter(Boolean),
                    ),
                  ],
                },
              },
            }),
          ),
        },
      );
      toast.success("调试执行已创建，日志将在右侧自动显示。");
      setBatchId(batch.id);
      setRunning(true);
      const url = new URL(window.location.href);
      url.searchParams.set(`${kind}Batch`, batch.id);
      url.searchParams.set(`${kind}Scope`, batchScope);
      window.history.replaceState(null, "", url);
    } catch (problem) {
      setError(
        problem instanceof ZodError
          ? problem.issues.map((issue) => issue.message).join("；")
          : problem instanceof Error
            ? problem.message
            : "调试执行创建失败。",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <CaseDebugSplitter
      direction="columns"
      first={
        <Card
          className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
          as="section"
          aria-label={`${kind === "ddt" ? "DDT" : "普通用例"}调试配置`}
        >
          <div className="grid shrink-0 gap-2 border-b border-border p-3">
            <Flex gap="small" align="center">
              <Bug size={18} className="text-primary" />
              <Typography.Title level={4} className="!m-0">
                调试配置
              </Typography.Title>
            </Flex>
            <Typography.Text
              type={
                draftStatus === "unavailable" || draftStatus === "invalid" ? "warning" : "secondary"
              }
              className="text-xs"
              aria-label="调试配置保存状态"
            >
              {draftStatus === "loading"
                ? "正在恢复调试配置…"
                : draftStatus === "unavailable"
                  ? "浏览器无法保存配置；当前填写仍可使用，刷新后可能丢失。"
                  : draftStatus === "invalid"
                    ? "已保存配置无法读取，请重新选择；修改后将重新保存。"
                    : draftStatus === "saved"
                      ? "配置已自动保存到当前浏览器"
                      : "填写后自动保存到当前浏览器，按账号和项目范围分别记忆。"}
            </Typography.Text>
          </div>
          <div
            role="region"
            aria-label="调试配置内容"
            tabIndex={0}
            className="grid min-h-0 flex-1 content-start gap-4 overflow-y-auto overscroll-contain p-3"
          >
            {kind === "ddt" ? (
              <Card className="grid min-w-0 gap-2 bg-muted/30 p-3" aria-label="个人 DDT API">
                <Typography.Text strong>个人 DDT API</Typography.Text>
                <Typography.Paragraph
                  className="!mb-0 break-all text-xs [&_.ant-typography-copy]:!h-8 [&_.ant-typography-copy]:!w-8"
                  copyable={{ text: publicApiPath }}
                >
                  {publicApiPath}
                </Typography.Paragraph>
                <Typography.Text type="secondary" className="text-xs">
                  自动传入 setDdtInsightUrl；查询时附加
                  ?caseId=CaseId。完整链接可读取本人的调试数据，请按测试数据权限分享。
                </Typography.Text>
                <DdtDebugChangeActions scope={scope} />
              </Card>
            ) : null}
            {kind === "ddt" ? (
              <>
                <CaseDebugInput
                  kind="ddt"
                  scope={scope}
                  maxJarBytes={maxJarBytes}
                  scopeLabels={labels}
                  active={active}
                  disabled={editingDisabled}
                  canUpload={permissions.uploadDdt}
                  value={ddtCase}
                  onChange={(choice) => {
                    draftStore.update({
                      ddtCase: choice,
                      ...(choice?.suggestedClass ? { executionClass: choice.suggestedClass } : {}),
                    });
                  }}
                />
                <Divider className="!my-0" />
              </>
            ) : null}
            {kind === "ddt" ? (
              <Typography.Text type="secondary">
                执行类仅对本次调试生效，不修改 SR 关联。
              </Typography.Text>
            ) : null}
            <CaseDebugInput
              kind="jar"
              maxJarBytes={maxJarBytes}
              scopeLabels={labels}
              scope={scope}
              active={active}
              disabled={editingDisabled}
              canUpload={permissions.uploadJar}
              value={executionClass}
              onChange={(executionClass) => draftStore.update({ executionClass })}
            />
            <Divider className="!my-0" />
            <Flex gap="small" align="center" justify="space-between">
              <Typography.Text strong>执行资源</Typography.Text>
              <Button onClick={() => setResourcesRevision((value) => value + 1)}>刷新资源</Button>
            </Flex>
            <Segmented
              label="调试资源类型"
              value={runnerKind}
              onChange={(runnerKind) => draftStore.update({ runnerKind })}
              options={[
                { value: "runner", label: "执行机", disabled: editingDisabled },
                { value: "group", label: "执行机组", disabled: editingDisabled },
              ]}
              block
            />
            {runnerKind === "runner" ? (
              <Select
                aria-label="调试执行机"
                value={runnerId}
                disabled={editingDisabled}
                onChange={(event) => draftStore.update({ runnerId: event.target.value })}
              >
                <option value="">选择执行机</option>
                {runnerId &&
                !runners.some((runner) => runner.id === runnerId && !runner.deregisteredAt) ? (
                  <option value={runnerId} disabled>
                    已保存的执行机暂不可用，请刷新资源或重新选择
                  </option>
                ) : null}
                {runners
                  .filter((runner) => !runner.deregisteredAt)
                  .map((runner) => (
                    <option
                      key={runner.id}
                      value={runner.id}
                      disabled={runner.state === "disabled" || runner.state === "draining"}
                    >
                      {runner.name} · {runner.state === "online" ? "在线" : "离线"}
                    </option>
                  ))}
              </Select>
            ) : (
              <Select
                aria-label="调试执行机组"
                value={groupId}
                disabled={editingDisabled}
                onChange={(event) => draftStore.update({ groupId: event.target.value })}
              >
                <option value="">选择执行机组</option>
                {groupId && !groups.some((group) => group.id === groupId) ? (
                  <option value={groupId} disabled>
                    已保存的执行机组暂不可用，请刷新资源或重新选择
                  </option>
                ) : null}
                {groups.map((group) => (
                  <option key={group.id} value={group.id} disabled={!group.runnerIds.length}>
                    {group.name} · {group.runnerIds.length} 台
                  </option>
                ))}
              </Select>
            )}
            <label className="flex min-h-8 cursor-pointer items-center justify-between gap-2">
              <Typography.Text strong>CoTest Adapter</Typography.Text>
              <Switch
                aria-label="调试启用 Adapter"
                checked={kind === "ddt" || adapterEnabled}
                disabled={kind === "ddt" || editingDisabled}
                onChange={(adapterEnabled) => draftStore.update({ adapterEnabled })}
              />
            </label>
            {kind === "ddt" || adapterEnabled ? (
              <div className="grid min-w-0 gap-3">
                <Notice>
                  Adapter 使用当前版本的 JDK 和完整依赖包；更新代码需同步更新依赖包。
                  <LinkButton href="/settings/projects" target="_blank" rel="noreferrer">
                    配置运行依赖
                  </LinkButton>
                </Notice>
                <label className="grid min-w-0 gap-1">
                  Suite Name
                  <Input
                    aria-label="调试 Suite Name"
                    value={suiteName}
                    maxLength={512}
                    disabled={editingDisabled}
                    onChange={(event) => draftStore.update({ suiteName: event.target.value })}
                  />
                </label>
                <label className="grid min-w-0 gap-1">
                  Test Name
                  <Input
                    aria-label="调试 Test Name"
                    value={testName}
                    maxLength={512}
                    disabled={editingDisabled}
                    onChange={(event) => draftStore.update({ testName: event.target.value })}
                  />
                </label>
                <label className="grid min-w-0 gap-1">
                  环境地址
                  <Textarea
                    aria-label="调试环境地址"
                    rows={2}
                    className="min-h-16"
                    placeholder="每行一个 IP 或地址"
                    value={addresses}
                    disabled={editingDisabled}
                    onChange={(event) => draftStore.update({ addresses: event.target.value })}
                  />
                </label>
              </div>
            ) : null}
            {error ? <Notice tone="error">{error}</Notice> : null}
          </div>
          <div className="grid shrink-0 gap-2 border-t border-border p-3">
            <Typography.Text type="secondary" className="text-xs">
              每次执行一个用例，使用平台时限，不自动重跑。
            </Typography.Text>
            <Button
              variant="primary"
              disabled={
                editingDisabled || running || !executionClass || (kind === "ddt" && !ddtCase)
              }
              onClick={() => void execute()}
            >
              <Play size={16} />
              {submitting
                ? "正在创建执行…"
                : running
                  ? "本次调试执行中"
                  : batchId
                    ? "再次执行"
                    : "开始调试"}
            </Button>
          </div>
        </Card>
      }
      second={
        <Card className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden p-3">
          {batchId ? (
            <CaseDebugResults
              key={batchId}
              batchId={batchId}
              scope={scope}
              visible={active}
              canReadLogs={permissions.readLogs}
              canCancel={permissions.cancel}
              onActiveChange={onActiveChange}
            />
          ) : (
            <div className="grid min-h-0 flex-1 content-center gap-4 overflow-auto text-center">
              <Terminal size={36} className="mx-auto text-muted-foreground" />
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="配置完成后开始调试，日志与结果将在这里展示"
              />
            </div>
          )}
        </Card>
      }
    />
  );
}

function subscribeOrigin() {
  return () => {};
}
function browserOriginSnapshot() {
  return window.location.origin;
}
function serverOriginSnapshot() {
  return "";
}
