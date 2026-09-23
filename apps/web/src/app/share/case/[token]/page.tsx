import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";
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
    <main className={cn("shared-case-page", pageStyles["shared-case-page"])}>
      <section className={cn("shared-case-shell", pageStyles["shared-case-shell"])}>
        <header className={cn("shared-case-hero", pageStyles["shared-case-hero"])}>
          <div>
            <span className={cn("eyebrow", uiPatterns["eyebrow"])}>SHARED CASE DEFINITION</span>
            <h1>{definition.displayName}</h1>
            <code>{definition.className}</code>
          </div>
          <span className={cn("shared-case-trust", pageStyles["shared-case-trust"])}>
            <ShieldCheck size={18} aria-hidden="true" /> 永久只读链接
          </span>
        </header>

        {definition.description ? (
          <p className={cn("shared-case-description", pageStyles["shared-case-description"])}>
            {definition.description}
          </p>
        ) : null}

        <dl className={cn("shared-case-facts", pageStyles["shared-case-facts"])}>
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

        <section
          className={cn("shared-case-section", pageStyles["shared-case-section"])}
          aria-labelledby="shared-case-parameters"
        >
          <header>
            <Braces size={19} aria-hidden="true" />
            <div>
              <h2 id="shared-case-parameters">参数</h2>
              <p>{parameters.length} 个只读参数</p>
            </div>
          </header>
          {parameters.length > 0 ? (
            <dl className={cn("shared-case-parameters", pageStyles["shared-case-parameters"])}>
              {parameters.map(([name, value]) => (
                <div key={name}>
                  <dt>{name}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className={cn("shared-case-empty", pageStyles["shared-case-empty"])}>
              当前用例没有参数。
            </p>
          )}
        </section>

        <section
          className={cn("shared-case-section", pageStyles["shared-case-section"])}
          aria-labelledby="shared-case-methods"
        >
          <header>
            <Layers3 size={19} aria-hidden="true" />
            <div>
              <h2 id="shared-case-methods">测试方法</h2>
              <p>{definition.methods.length} 个方法</p>
            </div>
          </header>
          <div className={cn("shared-case-methods", pageStyles["shared-case-methods"])}>
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

        <footer className={cn("shared-case-footer", pageStyles["shared-case-footer"])}>
          此页面仅展示分享时所指向用例的当前只读详情，不包含源码、执行控制和项目其他数据。
        </footer>
      </section>
    </main>
  );
}

function InvalidCaseShare() {
  return (
    <main
      className={cn(
        "shared-case-page shared-case-page-center",
        pageStyles["shared-case-page"],
        pageStyles["shared-case-page-center"],
      )}
    >
      <section
        className={cn("shared-case-invalid", pageStyles["shared-case-invalid"])}
        aria-label="用例永久分享链接不可用"
      >
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

const pageStyles = {
  "shared-case-description":
    "border border-solid border-border [background:color-mix(in_srgb,_var(--card)_96%,_transparent)] shadow-xs m-0 rounded-lg py-4 px-5 text-muted-foreground text-sm leading-[1.7] [overflow-wrap:anywhere]",
  "shared-case-empty": "mt-[3px] text-muted-foreground text-xs",
  "shared-case-facts":
    "border border-solid border-border [background:color-mix(in_srgb,_var(--card)_96%,_transparent)] shadow-xs grid grid-cols-3 m-0 overflow-hidden rounded-xl [&_>_div]:grid [&_>_div]:min-w-0 [&_>_div]:gap-[7px] [&_>_div]:border-r [&_>_div]:border-solid [&_>_div]:border-border [&_>_div]:border-b [&_>_div]:py-5 [&_>_div]:px-5.5 [&_>_div:nth-child(3n)]:border-r-0 [&_>_div:nth-last-child(-n_+_3)]:border-b-0 [&_dt]:text-muted-foreground [&_dt]:text-xs [&_dt]:font-semibold [&_dd]:flex [&_dd]:min-w-0 [&_dd]:items-center [&_dd]:gap-[7px] [&_dd]:m-0 [&_dd]:font-semibold [&_dd]:[overflow-wrap:anywhere] max-[1101px]:grid-cols-2 max-[1101px]:[&_>_div:nth-child(3n)]:border-r max-[1101px]:[&_>_div:nth-child(3n)]:border-solid max-[1101px]:[&_>_div:nth-child(3n)]:border-border max-[1101px]:[&_>_div:nth-child(2n)]:border-r-0 max-[1101px]:[&_>_div:nth-last-child(-n_+_3)]:border-b max-[1101px]:[&_>_div:nth-last-child(-n_+_3)]:border-solid max-[1101px]:[&_>_div:nth-last-child(-n_+_3)]:border-border max-[1101px]:[&_>_div:nth-last-child(-n_+_2)]:border-b-0",
  "shared-case-footer":
    "border border-solid border-border [background:color-mix(in_srgb,_var(--card)_96%,_transparent)] shadow-none m-0 rounded-lg py-4 px-5 text-muted-foreground text-sm leading-[1.7] [overflow-wrap:anywhere] text-center",
  "shared-case-hero":
    "border border-solid border-border [background:color-mix(in_srgb,_var(--card)_96%,_transparent)] shadow-xs flex min-w-0 items-start justify-between gap-6 rounded-xl py-8 px-8.5 [&_>_div]:min-w-0 [&_h1]:my-2 [&_h1]:mx-0 [&_h1]:text-2xl [&_h1]:tracking-tight [&_h1]:[overflow-wrap:anywhere] [&_code]:text-muted-foreground [&_code]:font-mono [&_code]:[overflow-wrap:anywhere] [&_code]:whitespace-normal",
  "shared-case-invalid":
    "border border-solid border-border [background:color-mix(in_srgb,_var(--card)_96%,_transparent)] shadow-xs grid justify-items-center gap-2.5 w-[min(420px,_100%)] rounded-xl py-11 px-9 text-center [&_>_span]:grid [&_>_span]:w-14 [&_>_span]:h-14 [&_>_span]:place-items-center [&_>_span]:rounded-full [&_>_span]:bg-warning/10 [&_>_span]:text-warning [&_h1]:m-0 [&_p]:m-0 [&_p]:text-muted-foreground [&_p]:text-sm [&_p]:leading-[1.7]",
  "shared-case-methods":
    "[&_code]:text-muted-foreground [&_code]:font-mono [&_code]:[overflow-wrap:anywhere] [&_code]:whitespace-normal grid grid-cols-2 gap-2.5 m-0 [&_>_article]:min-w-0 [&_>_article]:border [&_>_article]:border-solid [&_>_article]:border-border [&_>_article]:rounded-lg [&_>_article]:py-3.5 [&_>_article]:px-4 [&_>_article]:bg-muted [&_>_article]:grid [&_>_article]:gap-[9px] [&_article_>_div]:flex [&_article_>_div]:min-w-0 [&_article_>_div]:items-center [&_article_>_div]:justify-between [&_article_>_div]:gap-3 [&_article_strong]:min-w-0 [&_article_strong]:[overflow-wrap:anywhere] [&_article_span]:text-xs [&_article_span]:[flex:0_0_auto] [&_article_span]:font-semibold [&_article_small]:text-xs [&_article_small]:text-muted-foreground [&_article_small]:[overflow-wrap:anywhere]",
  "shared-case-page":
    "min-h-screen p-12 bg-card [&_.is-enabled]:text-success [&_.is-muted]:text-muted-foreground max-[1101px]:p-8",
  "shared-case-page-center": "grid place-items-center",
  "shared-case-parameters":
    "grid grid-cols-2 gap-2.5 m-0 [&_>_div]:min-w-0 [&_>_div]:border [&_>_div]:border-solid [&_>_div]:border-border [&_>_div]:rounded-lg [&_>_div]:py-3.5 [&_>_div]:px-4 [&_>_div]:bg-muted [&_>_div]:grid [&_>_div]:grid-cols-[minmax(100px,_0.42fr)_minmax(0,_1fr)] [&_>_div]:gap-3 [&_dt]:text-muted-foreground [&_dt]:font-mono [&_dt]:text-xs [&_dt]:font-semibold [&_dt]:[overflow-wrap:anywhere] [&_dd]:m-0 [&_dd]:[overflow-wrap:anywhere]",
  "shared-case-section":
    "border border-solid border-border [background:color-mix(in_srgb,_var(--card)_96%,_transparent)] shadow-xs min-w-0 rounded-xl p-6 [&_>_header]:flex [&_>_header]:items-center [&_>_header]:gap-2.5 [&_>_header]:mb-4.5 [&_h2]:m-0 [&_h2]:text-lg [&_p]:m-0 [&_header_p]:mt-[3px] [&_header_p]:text-muted-foreground [&_header_p]:text-xs",
  "shared-case-shell": "grid w-[min(1120px,_100%)] gap-5 my-0 mx-auto",
  "shared-case-trust":
    "inline-flex [flex:0_0_auto] items-center gap-[7px] border border-solid border-border rounded-full py-2 px-3 bg-success/10 text-success text-xs font-semibold",
} as const;
