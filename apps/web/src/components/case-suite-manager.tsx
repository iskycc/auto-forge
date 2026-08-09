"use client";

import { apiErrorSchema } from "@autoforge/contracts";
import type { CaseSuite } from "@autoforge/domain";
import { ArrowRight, Layers3, LoaderCircle, Plus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

export function CaseSuiteManager({ initialSuites }: { initialSuites: CaseSuite[] }) {
  const [suites, setSuites] = useState(initialSuites);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createSuite(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/case-suites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, ...(description.trim() ? { description } : {}) }),
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
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "创建用例任务失败。");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="suite-layout">
      <section className="card suite-create-card">
        <div className="card-heading">
          <div>
            <span className="eyebrow">新建</span>
            <h2>创建用例任务</h2>
            <p>任务保存可复用的用例选择；执行时再固化版本快照。</p>
          </div>
          <Plus size={22} />
        </div>
        <form className="stack-form" onSubmit={createSuite}>
          <label>
            <span>任务名称</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
              required
              placeholder="例如：每日冒烟测试"
            />
          </label>
          <label>
            <span>说明</span>
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={500}
              rows={4}
              placeholder="记录用途、范围或维护人"
            />
          </label>
          {error && (
            <span className="inline-error" role="alert">
              {error}
            </span>
          )}
          <button
            className="button button-primary"
            type="submit"
            disabled={pending || !name.trim()}
          >
            {pending ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />} 创建任务
          </button>
        </form>
      </section>
      <section className="suite-list" aria-label="用例任务列表">
        {suites.length === 0 ? (
          <div className="card empty-state suite-empty">
            <span className="empty-icon">
              <Layers3 size={25} />
            </span>
            <strong>还没有用例任务</strong>
            <p>先创建任务，再从用例库批量勾选测试类。</p>
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
