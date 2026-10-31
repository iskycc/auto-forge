"use client";
import { Notice } from "@/components/ui/notice";

import { LoadingIcon } from "@/components/ui/loading-icon";

import { Radio } from "antd";
import { Card } from "@/components/ui/card";

import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import { Button, Input, Select, Textarea } from "@/components/ui";
import { ActionDialog } from "@/components/action-dialog";
import { LinkButton } from "@/components/ui/link-button";

import {
  apiErrorSchema,
  archiveRerunSuitesResultSchema,
  type CaseSuiteActivitySummary,
} from "@autoforge/contracts";
import { orderCaseSuitesByPins, type CaseSuite } from "@autoforge/domain";
import { Copy, Layers3, Plus, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useOptimistic, useState, useTransition } from "react";

import { CaseSuiteCard } from "./case-suite-card";
import { parseExportFilename } from "@/lib/run-batch-export";
import {
  DEFAULT_EXECUTION_ADAPTER_ENABLED,
  type AdapterNameDefaults,
} from "@/lib/case-suite-adapter-defaults";

export function CaseSuiteManager({
  adapterNameDefaults,
  canManage,
  canReadExecutions,
  canExecute,
  activitySummary,
  initialSuites,
  initialPinnedSuiteIds,
  projectId: initialProjectId,
  selectedProjectVersionId,
  selectedProjectVersionName,
  status = "active",
}: {
  adapterNameDefaults: AdapterNameDefaults;
  canManage: boolean;
  canReadExecutions: boolean;
  canExecute: boolean;
  activitySummary?: CaseSuiteActivitySummary;
  initialSuites: CaseSuite[];
  initialPinnedSuiteIds: string[];
  projectId?: string | undefined;
  selectedProjectVersionId?: string | undefined;
  selectedProjectVersionName?: string | undefined;
  status?: "active" | "archived";
}) {
  const router = useRouter();
  const [createdSuites, setCreatedSuites] = useState<CaseSuite[]>([]);
  const [deletedSuiteIds, setDeletedSuiteIds] = useState<ReadonlySet<string>>(new Set());
  const [pinning, startPinChange] = useTransition();
  const [pinError, setPinError] = useState<string | null>(null);
  const [pinnedSuiteIds, changeOptimisticPin] = useOptimistic(
    initialPinnedSuiteIds,
    (current: string[], change: { suiteId: string; pinned: boolean }) => {
      const ids = new Set(current);
      if (change.pinned) ids.add(change.suiteId);
      else ids.delete(change.suiteId);
      return [...ids];
    },
  );
  const initialSuiteIds = new Set(initialSuites.map((suite) => suite.id));
  const pinnedIds = new Set(pinnedSuiteIds);
  const suitesByUpdatedAt = [
    ...createdSuites.filter((suite) => !initialSuiteIds.has(suite.id)),
    ...initialSuites,
  ]
    .filter((suite) => !deletedSuiteIds.has(suite.id))
    .sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id),
    );
  const suites = orderCaseSuitesByPins(suitesByUpdatedAt, pinnedIds);
  const statisticsBySuite = new Map(activitySummary?.items.map((entry) => [entry.suiteId, entry]));
  const [refreshing, startRefresh] = useTransition();
  const [createMode, setCreateMode] = useState<"blank" | "copy">("blank");
  const [sourceSuiteId, setSourceSuiteId] = useState(initialSuites[0]?.id ?? "");
  const [configurationOnly, setConfigurationOnly] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [adapterEnabled, setAdapterEnabled] = useState<boolean>(DEFAULT_EXECUTION_ADAPTER_ENABLED);
  const [adapterSuiteName, setAdapterSuiteName] = useState(adapterNameDefaults.suiteName);
  const [adapterTestName, setAdapterTestName] = useState(adapterNameDefaults.testName);
  const [environmentAddresses, setEnvironmentAddresses] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [exportingSuiteId, setExportingSuiteId] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const projectId = initialProjectId ?? "";
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [archiveNotice, setArchiveNotice] = useState("");
  const [archiveError, setArchiveError] = useState("");

  async function archiveReruns(): Promise<void> {
    if (!selectedProjectVersionId || archiving) return;
    setArchiving(true);
    setArchiveError("");
    let archived = 0;
    try {
      let hasMore = true;
      while (hasMore) {
        const response = await fetch("/api/v1/case-suites/archive-reruns", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId, projectVersionId: selectedProjectVersionId }),
        });
        if (!response.ok) throw await caseSuiteRequestError(response, "归档 Rerun 任务失败。");
        const result = archiveRerunSuitesResultSchema.parse(await response.json());
        if (result.hasMore && result.archivedIds.length === 0)
          throw new Error("归档未取得进展，请稍后重试剩余任务。");
        archived += result.archivedIds.length;
        setDeletedSuiteIds((current) => new Set([...current, ...result.archivedIds]));
        hasMore = result.hasMore;
        setArchiveNotice(
          `已归档 ${archived} 个 Rerun 任务${result.skippedActive ? `，${result.skippedActive} 个有执行中或待执行批次的任务已跳过` : ""}。`,
        );
      }
      setArchiveOpen(false);
      router.refresh();
    } catch (error) {
      setArchiveError(error instanceof Error ? error.message : "归档失败，请重试剩余任务。");
    } finally {
      setArchiving(false);
    }
  }

  function setSuitePinned(suiteId: string, pinned: boolean): void {
    if (pinning) return;
    setPinError(null);
    startPinChange(async () => {
      changeOptimisticPin({ suiteId, pinned });
      try {
        const response = await fetch(`/api/v1/case-suites/${encodeURIComponent(suiteId)}/pin`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pinned }),
        });
        if (!response.ok) throw await caseSuiteRequestError(response, "更新任务置顶状态失败。");
        startPinChange(() => router.refresh());
      } catch (caught) {
        setPinError(caught instanceof Error ? caught.message : "更新任务置顶状态失败。");
      }
    });
  }

  function openCreateDialog(): void {
    setError(null);
    setCreateMode("blank");
    setConfigurationOnly(false);
    setSourceSuiteId(suites[0]?.id ?? "");
    setCreateOpen(true);
  }

  async function createSuite(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      if (createMode === "copy") {
        const sourceSuite = suites.find((suite) => suite.id === sourceSuiteId);
        if (!sourceSuite) throw new Error("请选择要复制的已有任务。");
        const response = await fetch(
          `/api/v1/case-suites/${encodeURIComponent(sourceSuite.id)}/copy`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name, includeCases: !configurationOnly }),
          },
        );
        if (!response.ok) throw await caseSuiteRequestError(response, "复制用例任务失败。");
        const copiedSuite = (await response.json()) as CaseSuite;
        setCreateOpen(false);
        router.push(`/case-suites/${encodeURIComponent(copiedSuite.id)}`);
        return;
      }
      const response = await fetch("/api/v1/case-suites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(projectId ? { projectId } : {}),
          ...(selectedProjectVersionId ? { projectVersionId: selectedProjectVersionId } : {}),
          name,
          ...(description.trim() ? { description } : {}),
          adapter: {
            enabled: adapterEnabled,
            suiteName: adapterSuiteName,
            testName: adapterTestName,
            environmentAddresses: parseEnvironmentAddresses(environmentAddresses),
          },
        }),
      });
      if (!response.ok) throw await caseSuiteRequestError(response, "创建用例任务失败。");
      const suite = (await response.json()) as CaseSuite;
      setCreatedSuites((current) => [suite, ...current]);
      setName("");
      setDescription("");
      setAdapterEnabled(DEFAULT_EXECUTION_ADAPTER_ENABLED);
      setAdapterSuiteName(adapterNameDefaults.suiteName);
      setAdapterTestName(adapterNameDefaults.testName);
      setEnvironmentAddresses("");
      setCreateOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "创建用例任务失败。");
    } finally {
      setPending(false);
    }
  }

  async function exportSuiteCases(suite: CaseSuite): Promise<void> {
    if (exportingSuiteId) return;
    setExportingSuiteId(suite.id);
    setExportError(null);
    try {
      const response = await fetch(`/api/v1/case-suites/${encodeURIComponent(suite.id)}/export`, {
        cache: "no-store",
      });
      if (!response.ok) throw await caseSuiteRequestError(response, "导出任务用例失败。");
      const objectUrl = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = parseExportFilename(
        response.headers.get("content-disposition"),
        "case-suite-cases.xlsx",
      );
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (caught) {
      setExportError(caught instanceof Error ? caught.message : "导出任务用例失败。");
    } finally {
      setExportingSuiteId(null);
    }
  }

  return (
    <div className={cn("suite-manager", caseSuiteManagerStyles["suite-manager"])}>
      <div className={cn("suite-manager-toolbar", caseSuiteManagerStyles["suite-manager-toolbar"])}>
        <span>
          当前版本「{selectedProjectVersionName ?? "尚未配置"}」·{" "}
          {status === "archived" ? "已归档" : "活动"}任务 {suites.length} 个
        </span>
        <div
          className={cn("suite-manager-actions", caseSuiteManagerStyles["suite-manager-actions"])}
        >
          <LinkButton href={status === "active" ? "/case-suites?status=archived" : "/case-suites"}>
            {status === "active" ? "已归档任务" : "活动任务"}
          </LinkButton>
          {canManage && status === "active" && selectedProjectVersionId ? (
            <Button
              type="button"
              disabled={archiving}
              onClick={() => {
                setArchiveOpen(true);
                setArchiveError("");
              }}
            >
              一键归档 Rerun
            </Button>
          ) : null}
          <Button
            disabled={refreshing}
            onClick={() => startRefresh(() => router.refresh())}
            type="button"
            variant="ghost"
          >
            {refreshing ? <LoadingIcon size={15} /> : <RefreshCw size={15} />} 刷新任务列表
          </Button>
          {canManage ? (
            <Button onClick={openCreateDialog} type="button" variant="primary">
              <Plus size={16} /> 创建任务
            </Button>
          ) : null}
        </div>
      </div>
      {archiveNotice ? <Notice tone="info">{archiveNotice}</Notice> : null}
      <ActionDialog
        title="归档 Rerun 任务"
        open={archiveOpen}
        closeDisabled={archiving}
        onClose={() => !archiving && setArchiveOpen(false)}
        description="归档当前项目版本中由未通过用例创建的 Rerun 任务。执行中、排队中和倒计时任务会跳过；保留任务配置、用例及全部执行历史，可在已归档任务中恢复。"
        footer={
          <>
            <Button type="button" disabled={archiving} onClick={() => setArchiveOpen(false)}>
              取消
            </Button>
            <Button
              type="button"
              variant="primary"
              loading={archiving}
              onClick={() => void archiveReruns()}
            >
              确认归档
            </Button>
          </>
        }
      >
        {archiveError ? (
          <Notice tone="error">{archiveError}</Notice>
        ) : (
          <p>仅影响当前版本，普通任务保持原状态。关联的定时执行会停用。</p>
        )}
      </ActionDialog>
      {canReadExecutions ? (
        <p
          className={cn(
            "suite-statistics-explanation",
            caseSuiteManagerStyles["suite-statistics-explanation"],
          )}
        >
          近 7
          天按批次创建时间统计；均值为已结束且有用例的批次等权平均，包含执行异常与终止，不含日志诊断重跑。
        </p>
      ) : null}
      <ActionDialog
        description="创建空白任务，或将已有任务复制为可以独立修改的新任务。"
        onClose={() => !pending && setCreateOpen(false)}
        open={createOpen}
        title="创建用例任务"
        protectUnsavedChanges
        closeDisabled={pending}
        footer={
          <>
            <Button
              type="button"
              data-dialog-dismiss
              disabled={pending}
              onClick={() => setCreateOpen(false)}
            >
              取消
            </Button>{" "}
            <Button
              className={cn(
                "button button-primary",
                uiPatterns["button"],
                uiPatterns["button-primary"],
              )}
              type="submit"
              form="suite-create-form"
              disabled={
                pending ||
                !name.trim() ||
                !selectedProjectVersionId ||
                (createMode === "copy" && !sourceSuiteId)
              }
            >
              {pending ? (
                <LoadingIcon size={16} />
              ) : createMode === "copy" ? (
                <Copy size={16} />
              ) : (
                <Plus size={16} />
              )}{" "}
              {createMode === "copy" ? "复制并编辑" : "创建任务"}
            </Button>
          </>
        }
      >
        <form
          id="suite-create-form"
          className={cn(
            "stack-form action-dialog-form",
            caseSuiteManagerStyles["stack-form"],
            caseSuiteManagerStyles["action-dialog-form"],
          )}
          onSubmit={createSuite}
        >
          <div className="grid gap-2">
            <span className="text-xs font-semibold text-muted-foreground">创建方式</span>
            <Radio.Group
              className="suite-create-mode"
              aria-label="创建方式"
              block
              optionType="button"
              buttonStyle="solid"
              value={createMode}
              onChange={(event) => setCreateMode(event.target.value as "blank" | "copy")}
              options={[
                { value: "blank", label: "新建任务" },
                { value: "copy", label: "复制任务", disabled: suites.length === 0 },
              ]}
            />
            <p className="m-0 text-xs text-muted-foreground">
              {createMode === "copy"
                ? "复制已有任务的配置，可选择是否包含用例。"
                : "创建空白任务，随后添加用例和执行配置。"}
            </p>
          </div>
          <label className={caseSuiteManagerStyles["form-field"]}>
            <span>{createMode === "copy" ? "新任务名称" : "任务名称"}</span>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
              required
              placeholder="例如：每日冒烟测试"
            />
          </label>
          {createMode === "copy" ? (
            <>
              <label className={caseSuiteManagerStyles["form-field"]}>
                <span>来源任务</span>
                <Select
                  aria-label="来源任务"
                  value={sourceSuiteId}
                  onChange={(event) => setSourceSuiteId(event.target.value)}
                >
                  {suites.map((suite) => (
                    <option key={suite.id} value={suite.id}>
                      {suite.name} · {suite.caseCount} 个用例
                    </option>
                  ))}
                </Select>
              </label>
              <label
                className={cn("checkbox-field suite-copy-scope", uiPatterns["checkbox-field"])}
              >
                <Input
                  type="checkbox"
                  checked={configurationOnly}
                  disabled={pending}
                  onChange={(event) => setConfigurationOnly(event.target.checked)}
                />
                仅复制配置，不复制用例
              </label>
              <div
                className={cn(
                  "form-context-summary suite-copy-summary",
                  caseSuiteManagerStyles["form-context-summary"],
                  caseSuiteManagerStyles["suite-copy-summary"],
                )}
                aria-label="任务复制范围"
              >
                <span>独立副本</span>
                <strong>
                  {configurationOnly
                    ? "执行策略与恢复配置，不包含普通或 DDT 用例"
                    : "成员、执行策略与恢复配置"}
                </strong>
                <small>
                  新任务使用独立 ID 和成员记录；修改或删除副本不会影响来源任务。执行历史、计划触发和
                  Webhook 绑定不会复制。
                </small>
              </div>
            </>
          ) : (
            <label className={caseSuiteManagerStyles["form-field"]}>
              <span>说明</span>
              <Textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                maxLength={500}
                rows={4}
                placeholder="记录用途、范围或维护人"
              />
            </label>
          )}
          <div
            className={cn("form-context-summary", caseSuiteManagerStyles["form-context-summary"])}
            aria-label="任务项目版本"
          >
            <span>项目版本</span>
            <strong>{selectedProjectVersionName ?? "暂无可用版本"}</strong>
            <small>使用顶栏当前选择；任务创建后仍可在详情中调整。</small>
          </div>
          {createMode === "blank" ? (
            <div
              className={cn("suite-adapter-fields", caseSuiteManagerStyles["suite-adapter-fields"])}
            >
              <strong>Adapter 执行配置</strong>
              <p>配置随任务版本保存；多个环境地址会按任务中的用例顺序循环分配。</p>
              <label className={cn("checkbox-field", uiPatterns["checkbox-field"])}>
                <Input
                  checked={adapterEnabled}
                  onChange={(event) => setAdapterEnabled(event.target.checked)}
                  type="checkbox"
                />
                使用 CoTest TestNG Adapter
              </label>
              {adapterEnabled ? (
                <>
                  <label className={caseSuiteManagerStyles["form-field"]}>
                    <span>TestNG Suite Name</span>
                    <Input
                      value={adapterSuiteName}
                      onChange={(event) => setAdapterSuiteName(event.target.value)}
                      maxLength={512}
                    />
                  </label>
                  <label className={caseSuiteManagerStyles["form-field"]}>
                    <span>TestNG Test Name</span>
                    <Input
                      value={adapterTestName}
                      onChange={(event) => setAdapterTestName(event.target.value)}
                      maxLength={512}
                    />
                  </label>
                  <label className={caseSuiteManagerStyles["form-field"]}>
                    <span>环境 IP / 地址（每行一个）</span>
                    <Textarea
                      value={environmentAddresses}
                      onChange={(event) => setEnvironmentAddresses(event.target.value)}
                      rows={3}
                      placeholder={"10.0.0.11\n10.0.0.12"}
                    />
                  </label>
                </>
              ) : null}
            </div>
          ) : null}
          {error && (
            <Notice
              tone="error"
              className={cn("inline-error", caseSuiteManagerStyles["inline-error"])}
              role="alert"
            >
              {error}
            </Notice>
          )}
        </form>
      </ActionDialog>
      <section
        className={cn("suite-list", caseSuiteManagerStyles["suite-list"])}
        aria-label="用例任务列表"
      >
        {pinError ? (
          <Notice tone="error" role="alert" className="col-span-full">
            {pinError}
          </Notice>
        ) : null}
        {exportError ? (
          <Notice
            tone="error"
            className={cn(
              "inline-feedback error suite-list-feedback",
              caseSuiteManagerStyles["inline-feedback"],
              uiPatterns["error"],
              caseSuiteManagerStyles["suite-list-feedback"],
            )}
            role="alert"
          >
            {exportError}
          </Notice>
        ) : null}
        {suites.length === 0 ? (
          <Card
            as="div"
            className={cn(
              "card empty-state suite-empty",
              uiPatterns["card"],
              uiPatterns["empty-state"],
              caseSuiteManagerStyles["suite-empty"],
            )}
          >
            <span className={cn("empty-icon", uiPatterns["empty-icon"])}>
              <Layers3 size={25} />
            </span>
            <strong>还没有用例任务</strong>
            <p>先创建任务，再从用例管理批量勾选测试类。</p>
          </Card>
        ) : (
          suites.map((suite) => (
            <CaseSuiteCard
              key={suite.id}
              suite={suite}
              statistics={statisticsBySuite.get(suite.id)}
              canReadExecutions={canReadExecutions}
              canExecute={canExecute}
              canManage={canManage}
              onDeleted={() => setDeletedSuiteIds((current) => new Set([...current, suite.id]))}
              exporting={exportingSuiteId === suite.id}
              exportDisabled={exportingSuiteId !== null}
              onExport={() => void exportSuiteCases(suite)}
              pinned={pinnedIds.has(suite.id)}
              pinning={pinning}
              onPinnedChange={(pinned) => setSuitePinned(suite.id, pinned)}
            />
          ))
        )}
      </section>
    </div>
  );
}

async function caseSuiteRequestError(response: Response, fallback: string): Promise<Error> {
  const payload: unknown = await response.json().catch(() => null);
  const parsed = apiErrorSchema.safeParse(payload);
  return new Error(
    parsed.success ? parsed.data.error.message : `${fallback}（HTTP ${response.status}）`,
  );
}

function parseEnvironmentAddresses(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\n,，]/u)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

const caseSuiteManagerStyles = {
  "action-dialog-form": "mt-0",
  "form-context-summary":
    "grid grid-cols-[minmax(0,_1fr)_auto] items-center gap-[4px_12px] py-3 px-3.5 border border-solid border-border rounded-lg bg-muted [&_>_span]:text-muted-foreground [&_>_span]:text-xs [&_>_small]:text-muted-foreground [&_>_small]:text-xs [&_>_small]:col-span-full [&_>_strong]:[grid-column:2] [&_>_strong]:[grid-row:1]",
  "inline-error": "text-destructive text-xs leading-[1.35]",
  "inline-feedback":
    "border-b border-solid border-border py-2.5 px-4.5 bg-success/10 text-success text-xs [&.error]:border-destructive/10 [&.error]:bg-destructive/10 [&.error]:text-destructive",
  "stack-form": "flex flex-col gap-3.5 mt-5 [&_.button]:self-start",
  "form-field": "flex min-w-0 flex-col gap-2 text-xs font-semibold text-muted-foreground",
  "suite-adapter-fields":
    "grid gap-3 p-3.5 border border-solid border-border rounded-lg bg-muted [&_>_strong]:text-sm [&_>_p]:[margin:-6px_0_0] [&_>_p]:text-muted-foreground [&_>_p]:text-xs [&_>_p]:leading-[1.5]",
  "suite-copy-summary":
    "[&_small]:text-muted-foreground [&_small]:text-xs [&_small]:font-normal [&_small]:leading-[1.45]",
  "suite-empty": "min-h-[280px]",
  "suite-list": "grid grid-cols-1 items-start gap-4 min-[1440px]:grid-cols-2",
  "suite-list-feedback": "col-span-full",
  "suite-manager": "grid gap-3.5",
  "suite-manager-actions": "flex flex-wrap items-center justify-end gap-2",
  "suite-manager-toolbar":
    "flex flex-wrap items-center justify-between gap-3 text-muted-foreground text-sm",
  "suite-statistics-explanation": "m-0 text-muted-foreground text-xs leading-[1.6]",
} as const;
