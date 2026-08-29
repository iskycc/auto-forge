"use client";

import { Button, Input, Select, Textarea } from "@/components/ui";
import { ActionDialog } from "@/components/action-dialog";

import { apiErrorSchema } from "@autoforge/contracts";
import type { CaseSuite } from "@autoforge/domain";
import { ArrowRight, Copy, Layers3, LoaderCircle, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { formatLocalDateTime } from "@/lib/run-batch-presentation";

export function CaseSuiteManager({
  canManage,
  initialSuites,
  projectId: initialProjectId,
  selectedProjectVersionId,
  selectedProjectVersionName,
}: {
  canManage: boolean;
  initialSuites: CaseSuite[];
  projectId?: string | undefined;
  selectedProjectVersionId?: string | undefined;
  selectedProjectVersionName?: string | undefined;
}) {
  const router = useRouter();
  const [suites, setSuites] = useState(initialSuites);
  const [createMode, setCreateMode] = useState<"blank" | "copy">("blank");
  const [sourceSuiteId, setSourceSuiteId] = useState(initialSuites[0]?.id ?? "");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [adapterEnabled, setAdapterEnabled] = useState(false);
  const [adapterSuiteName, setAdapterSuiteName] = useState("");
  const [adapterTestName, setAdapterTestName] = useState("");
  const [environmentAddresses, setEnvironmentAddresses] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const projectId = initialProjectId ?? "";

  function openCreateDialog(): void {
    setError(null);
    setCreateMode("blank");
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
            body: JSON.stringify({ name }),
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
      setSuites((current) => [suite, ...current]);
      setName("");
      setDescription("");
      setAdapterEnabled(false);
      setAdapterSuiteName("");
      setAdapterTestName("");
      setEnvironmentAddresses("");
      setCreateOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "创建用例任务失败。");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="suite-manager">
      {canManage ? (
        <div className="suite-manager-toolbar">
          <span>
            当前版本「{selectedProjectVersionName ?? "尚未配置"}」共 {suites.length} 个任务
          </span>
          <Button onClick={openCreateDialog} type="button" variant="primary">
            <Plus size={16} /> 创建任务
          </Button>
        </div>
      ) : null}
      <ActionDialog
        description="创建空白任务，或将已有任务复制为可以独立修改的新任务。"
        onClose={() => !pending && setCreateOpen(false)}
        open={createOpen}
        title="创建用例任务"
      >
        <form className="stack-form action-dialog-form" onSubmit={createSuite}>
          <fieldset className="suite-create-mode">
            <legend>创建方式</legend>
            <label className={createMode === "blank" ? "selected" : ""}>
              <Input
                checked={createMode === "blank"}
                name="createMode"
                onChange={() => setCreateMode("blank")}
                type="radio"
                value="blank"
              />
              <span>
                <strong>空白创建</strong>
                <small>新建一个不包含用例的任务</small>
              </span>
            </label>
            <label className={createMode === "copy" ? "selected" : ""}>
              <Input
                checked={createMode === "copy"}
                disabled={suites.length === 0}
                name="createMode"
                onChange={() => setCreateMode("copy")}
                type="radio"
                value="copy"
              />
              <span>
                <strong>复制已有任务</strong>
                <small>复制成员和执行配置，随后直接编辑</small>
              </span>
            </label>
          </fieldset>
          <label>
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
              <label>
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
              <div className="form-context-summary suite-copy-summary" aria-label="任务复制范围">
                <span>独立副本</span>
                <strong>成员、执行策略与恢复配置</strong>
                <small>
                  新任务使用独立 ID 和成员记录；修改或删除副本不会影响来源任务。执行历史、计划触发和
                  Webhook 绑定不会复制。
                </small>
              </div>
            </>
          ) : (
            <label>
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
          <div className="form-context-summary" aria-label="任务项目版本">
            <span>项目版本</span>
            <strong>{selectedProjectVersionName ?? "暂无可用版本"}</strong>
            <small>使用顶栏当前选择；任务创建后仍可在详情中调整。</small>
          </div>
          {createMode === "blank" ? (
            <div className="suite-adapter-fields">
              <strong>Adapter 执行配置</strong>
              <p>配置随任务版本保存；多个环境地址会按任务中的用例顺序循环分配。</p>
              <label className="checkbox-field">
                <Input
                  checked={adapterEnabled}
                  onChange={(event) => setAdapterEnabled(event.target.checked)}
                  type="checkbox"
                />
                使用 CoTest TestNG Adapter
              </label>
              {adapterEnabled ? (
                <>
                  <label>
                    <span>TestNG Suite Name</span>
                    <Input
                      value={adapterSuiteName}
                      onChange={(event) => setAdapterSuiteName(event.target.value)}
                      maxLength={512}
                    />
                  </label>
                  <label>
                    <span>TestNG Test Name</span>
                    <Input
                      value={adapterTestName}
                      onChange={(event) => setAdapterTestName(event.target.value)}
                      maxLength={512}
                    />
                  </label>
                  <label>
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
            <span className="inline-error" role="alert">
              {error}
            </span>
          )}
          <Button
            className="button button-primary"
            type="submit"
            disabled={
              pending ||
              !name.trim() ||
              !selectedProjectVersionId ||
              (createMode === "copy" && !sourceSuiteId)
            }
          >
            {pending ? (
              <LoaderCircle className="spin" size={16} />
            ) : createMode === "copy" ? (
              <Copy size={16} />
            ) : (
              <Plus size={16} />
            )}{" "}
            {createMode === "copy" ? "复制并编辑" : "创建任务"}
          </Button>
        </form>
      </ActionDialog>
      <section className="suite-list" aria-label="用例任务列表">
        {suites.length === 0 ? (
          <div className="card empty-state suite-empty">
            <span className="empty-icon">
              <Layers3 size={25} />
            </span>
            <strong>还没有用例任务</strong>
            <p>先创建任务，再从用例管理批量勾选测试类。</p>
          </div>
        ) : (
          suites.map((suite) => (
            <Link
              className={`card suite-card ${suite.status === "archived" ? "suite-card-archived" : ""} ${!suite.enabled ? "suite-card-disabled" : ""}`.trim()}
              href={`/case-suites/${suite.id}`}
              key={suite.id}
            >
              <span className="suite-icon">
                <Layers3 size={20} />
              </span>
              <span className="suite-copy">
                <span className="suite-title-line">
                  <strong>{suite.name}</strong>
                  <span
                    className={`status-badge ${suite.status === "archived" || !suite.enabled ? "warning" : ""}`.trim()}
                  >
                    {suite.status === "archived" ? "已归档" : suite.enabled ? "已启用" : "已停用"}
                  </span>
                </span>
                <small>{suite.description || "暂无说明"}</small>
                <small>
                  v{suite.version} · 更新于 {formatLocalDateTime(suite.updatedAt)}
                </small>
              </span>
              <span className="suite-count">
                <strong>{suite.caseCount}</strong>
                <small>个用例</small>
              </span>
              <ArrowRight size={18} className="muted" />
            </Link>
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
