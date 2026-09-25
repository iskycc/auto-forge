"use client";
import { Notice } from "@/components/ui/notice";

import { LoadingIcon } from "@/components/ui/loading-icon";

import { Radio } from "antd";
import { Card } from "@/components/ui/card";

import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import { Button, Input, Select, Textarea } from "@/components/ui";
import { ActionDialog } from "@/components/action-dialog";

import { apiErrorSchema, type CaseSuiteActivitySummary } from "@autoforge/contracts";
import type { CaseSuite } from "@autoforge/domain";
import { Copy, Layers3, Plus, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { CaseSuiteCard } from "./case-suite-card";
import { parseExportFilename } from "@/lib/run-batch-export";
import type { AdapterNameDefaults } from "@/lib/case-suite-adapter-defaults";

export function CaseSuiteManager({
  adapterNameDefaults,
  canManage,
  canReadExecutions,
  activitySummary,
  initialSuites,
  projectId: initialProjectId,
  selectedProjectVersionId,
  selectedProjectVersionName,
}: {
  adapterNameDefaults: AdapterNameDefaults;
  canManage: boolean;
  canReadExecutions: boolean;
  activitySummary?: CaseSuiteActivitySummary;
  initialSuites: CaseSuite[];
  projectId?: string | undefined;
  selectedProjectVersionId?: string | undefined;
  selectedProjectVersionName?: string | undefined;
}) {
  const router = useRouter();
  const [createdSuites, setCreatedSuites] = useState<CaseSuite[]>([]);
  const initialSuiteIds = new Set(initialSuites.map((suite) => suite.id));
  const suites = [
    ...createdSuites.filter((suite) => !initialSuiteIds.has(suite.id)),
    ...initialSuites,
  ];
  const statisticsBySuite = new Map(activitySummary?.items.map((entry) => [entry.suiteId, entry]));
  const [refreshing, startRefresh] = useTransition();
  const [createMode, setCreateMode] = useState<"blank" | "copy">("blank");
  const [sourceSuiteId, setSourceSuiteId] = useState(initialSuites[0]?.id ?? "");
  const [configurationOnly, setConfigurationOnly] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [adapterEnabled, setAdapterEnabled] = useState(false);
  const [adapterSuiteName, setAdapterSuiteName] = useState(adapterNameDefaults.suiteName);
  const [adapterTestName, setAdapterTestName] = useState(adapterNameDefaults.testName);
  const [environmentAddresses, setEnvironmentAddresses] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [exportingSuiteId, setExportingSuiteId] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const projectId = initialProjectId ?? "";

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
      setAdapterEnabled(false);
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
          当前版本「{selectedProjectVersionName ?? "尚未配置"}」共 {suites.length} 个任务
        </span>
        <div
          className={cn("suite-manager-actions", caseSuiteManagerStyles["suite-manager-actions"])}
        >
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
              exporting={exportingSuiteId === suite.id}
              exportDisabled={exportingSuiteId !== null}
              onExport={() => void exportSuiteCases(suite)}
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
  "suite-list": "grid grid-cols-2 items-start gap-4 max-[1181px]:grid-cols-[1fr]",
  "suite-list-feedback": "col-span-full",
  "suite-manager": "grid gap-3.5",
  "suite-manager-actions": "flex items-center gap-2",
  "suite-manager-toolbar": "flex items-center justify-between gap-3 text-muted-foreground text-sm",
  "suite-statistics-explanation": "m-0 text-muted-foreground text-xs leading-[1.6]",
} as const;
