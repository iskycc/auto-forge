"use client";

import { Button, Input, Textarea } from "@/components/ui";
import { ActionDialog } from "@/components/action-dialog";

import { apiErrorSchema } from "@autoforge/contracts";
import type { CaseSuite } from "@autoforge/domain";
import { ArrowRight, Layers3, LoaderCircle, Plus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

export function CaseSuiteManager({
  canManage,
  initialSuites,
  projectId: initialProjectId,
}: {
  canManage: boolean;
  initialSuites: CaseSuite[];
  projectId?: string | undefined;
}) {
  const [suites, setSuites] = useState(initialSuites);
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

  async function createSuite(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/case-suites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(projectId ? { projectId } : {}),
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
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        const parsed = apiErrorSchema.safeParse(payload);
        throw new Error(
          parsed.success ? parsed.data.error.message : `请求失败（HTTP ${response.status}）。`,
        );
      }
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
          <span>当前项目共 {suites.length} 个任务</span>
          <Button onClick={() => setCreateOpen(true)} type="button" variant="primary">
            <Plus size={16} /> 创建任务
          </Button>
        </div>
      ) : null}
      <ActionDialog
        description="任务保存可复用的用例选择；执行时再固化版本快照。"
        onClose={() => !pending && setCreateOpen(false)}
        open={createOpen}
        title="创建用例任务"
      >
        <form className="stack-form action-dialog-form" onSubmit={createSuite}>
          <label>
            <span>任务名称</span>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
              required
              placeholder="例如：每日冒烟测试"
            />
          </label>
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
            <label>
              <span>TestNG Suite Name</span>
              <Input
                value={adapterSuiteName}
                onChange={(event) => setAdapterSuiteName(event.target.value)}
                maxLength={512}
                disabled={!adapterEnabled}
              />
            </label>
            <label>
              <span>TestNG Test Name</span>
              <Input
                value={adapterTestName}
                onChange={(event) => setAdapterTestName(event.target.value)}
                maxLength={512}
                disabled={!adapterEnabled}
              />
            </label>
            <label>
              <span>环境 IP / 地址（每行一个）</span>
              <Textarea
                value={environmentAddresses}
                onChange={(event) => setEnvironmentAddresses(event.target.value)}
                rows={3}
                placeholder={"10.0.0.11\n10.0.0.12"}
                disabled={!adapterEnabled}
              />
            </label>
          </div>
          {error && (
            <span className="inline-error" role="alert">
              {error}
            </span>
          )}
          <Button
            className="button button-primary"
            type="submit"
            disabled={pending || !name.trim()}
          >
            {pending ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />} 创建任务
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
            <Link className="card suite-card" href={`/case-suites/${suite.id}`} key={suite.id}>
              <span className="suite-icon">
                <Layers3 size={20} />
              </span>
              <span className="suite-copy">
                <strong>{suite.name}</strong>
                <small>{suite.description || "暂无说明"}</small>
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
