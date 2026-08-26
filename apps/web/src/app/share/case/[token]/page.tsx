import { Braces, CheckCircle2, CircleOff, Layers3, Link2Off, ShieldCheck } from "lucide-react";
import type { Metadata } from "next";

import { formatMethodSignature } from "@/lib/jvm-signature";
import { readPermanentShareToken } from "@/lib/permanent-share-token";
import { getPlatformServices } from "@/lib/services";
import { formatPlatformDateTime } from "@/lib/platform-date-time";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "用例详情公开访问",
};

export default async function SharedCasePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const services = await getPlatformServices();
  const timeZone = services.configurationStore.read().web.timeZone;
  const caseDefinitionId = readPermanentShareToken(
    services.config.masterKey,
    token,
    "case_definition",
  );
  if (!caseDefinitionId) return <InvalidCaseShare />;
  const definition = await services.caseDefinitions.get(caseDefinitionId).catch(() => null);
  if (!definition) return <InvalidCaseShare />;
  const structure = await services.projectStructures.list(definition.projectId).catch(() => null);
  const projectVersion = structure?.versions.find(
    (version) => version.id === definition.projectVersionId,
  );
  const testStage = projectVersion?.stages.find((stage) => stage.id === definition.testStageId);
  const parameters = Object.entries(definition.parameters);

  return (
    <main className="shared-case-page">
      <section className="shared-case-shell">
        <header className="shared-case-hero">
          <div>
            <span className="eyebrow">SHARED CASE DEFINITION</span>
            <h1>{definition.displayName}</h1>
            <code>{definition.className}</code>
          </div>
          <span className="shared-case-trust">
            <ShieldCheck size={18} aria-hidden="true" /> 永久只读链接
          </span>
        </header>

        {definition.description ? (
          <p className="shared-case-description">{definition.description}</p>
        ) : null}

        <dl className="shared-case-facts">
          <div>
            <dt>状态</dt>
            <dd className={definition.enabled && !definition.archived ? "is-enabled" : "is-muted"}>
              {definition.enabled && !definition.archived ? (
                <CheckCircle2 size={17} aria-hidden="true" />
              ) : (
                <CircleOff size={17} aria-hidden="true" />
              )}
              {definition.archived ? "已归档" : definition.enabled ? "已启用" : "已禁用"}
            </dd>
          </div>
          <div>
            <dt>版本与测试阶段</dt>
            <dd>
              {projectVersion && testStage ? `${projectVersion.name} · ${testStage.name}` : "—"}
            </dd>
          </div>
          <div>
            <dt>包名</dt>
            <dd>{definition.packageName || "—"}</dd>
          </div>
          <div>
            <dt>当前修订</dt>
            <dd>第 {definition.revision} 次修订</dd>
          </div>
          <div>
            <dt>分组</dt>
            <dd>{definition.groups.join("、") || "—"}</dd>
          </div>
          <div>
            <dt>最近更新</dt>
            <dd>
              <time dateTime={definition.updatedAt} title={`UTC ${definition.updatedAt}`}>
                {formatDate(definition.updatedAt, timeZone)}
              </time>
            </dd>
          </div>
        </dl>

        <section className="shared-case-section" aria-labelledby="shared-case-parameters">
          <header>
            <Braces size={19} aria-hidden="true" />
            <div>
              <h2 id="shared-case-parameters">参数</h2>
              <p>{parameters.length} 个只读参数</p>
            </div>
          </header>
          {parameters.length > 0 ? (
            <dl className="shared-case-parameters">
              {parameters.map(([name, value]) => (
                <div key={name}>
                  <dt>{name}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="shared-case-empty">当前用例没有参数。</p>
          )}
        </section>

        <section className="shared-case-section" aria-labelledby="shared-case-methods">
          <header>
            <Layers3 size={19} aria-hidden="true" />
            <div>
              <h2 id="shared-case-methods">测试方法</h2>
              <p>{definition.methods.length} 个方法</p>
            </div>
          </header>
          <div className="shared-case-methods">
            {definition.methods.map((method) => (
              <article key={method.id}>
                <div>
                  <strong>{method.methodName}</strong>
                  <span className={method.enabled ? "is-enabled" : "is-muted"}>
                    {method.enabled ? "已启用" : "已禁用"}
                  </span>
                </div>
                <code>{formatMethodSignature(method.descriptor)}</code>
                <small>
                  {method.groups.length > 0 ? `分组：${method.groups.join("、")}` : "未分组"}
                </small>
              </article>
            ))}
          </div>
        </section>

        <footer className="shared-case-footer">
          此页面仅展示分享时所指向用例的当前只读详情，不包含源码、执行控制和项目其他数据。
        </footer>
      </section>
    </main>
  );
}

function InvalidCaseShare() {
  return (
    <main className="shared-case-page shared-case-page-center">
      <section className="shared-case-invalid" aria-label="用例永久分享链接不可用">
        <span aria-hidden="true">
          <Link2Off size={30} strokeWidth={1.8} />
        </span>
        <h1>链接无效</h1>
        <p>该用例永久分享链接无效，或对应的用例已经被删除。</p>
      </section>
    </main>
  );
}

function formatDate(value: string, timeZone: string): string {
  return formatPlatformDateTime(value, timeZone, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
