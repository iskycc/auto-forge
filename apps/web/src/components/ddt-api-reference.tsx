"use client";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";

import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import type { DdtScope } from "@autoforge/domain";
import { Copy, Globe2, LoaderCircle, Play } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";

import { Button, Input, Select } from "./ui";
import { useToast } from "./ui-feedback";
import { copyTextToClipboard } from "@/lib/client-clipboard";
import { ddtPublicApiPath, ddtPublicCaseUrl } from "@/lib/ddt-public-url";
import { ddtApiExample, type DdtApiExampleLanguage } from "@/lib/ddt-api-examples";

const RESPONSE_PREVIEW_CHARACTERS = 24_000;
const subscribeToOrigin = () => () => undefined;
const browserOrigin = () => window.location.origin;
const serverOrigin = () => "";

type QueryResult = { status: number; duration: string; body: string };
export type DdtScopeLabels = { project: string; version: string; stage: string };

export function DdtApiReference({ scope, labels }: { scope: DdtScope; labels: DdtScopeLabels }) {
  const toast = useToast();
  const origin = useSyncExternalStore(subscribeToOrigin, browserOrigin, serverOrigin);
  const [caseId, setCaseId] = useState("CASE-001");
  const [language, setLanguage] = useState<DdtApiExampleLanguage>("curl");
  const [result, setResult] = useState<QueryResult>();
  const [querying, setQuerying] = useState(false);
  const requestController = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    return () => requestController.current?.abort();
  }, []);

  const baseUrl = `${origin}${ddtPublicApiPath(scope)}`;
  const queryUrl = ddtPublicCaseUrl(baseUrl, caseId);
  const pathUrl = `${baseUrl}/cases/${encodeURIComponent(caseId.trim())}`;
  const example = ddtApiExample(language, baseUrl, caseId);

  async function copy(content: string) {
    try {
      await copyTextToClipboard(content);
      toast.success("已复制到剪贴板。");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "复制失败，请手动选择并复制。");
    }
  }

  async function query(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!caseId.trim() || querying) return;
    const controller = new AbortController();
    requestController.current?.abort();
    requestController.current = controller;
    setQuerying(true);
    setResult(undefined);
    try {
      const response = await fetch(queryUrl, {
        credentials: "omit",
        cache: "no-store",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      });
      const body = JSON.stringify(await response.json(), null, 2);
      if (!controller.signal.aborted) {
        setResult({
          status: response.status,
          duration: response.headers.get("X-Response-Time") ?? "—",
          body,
        });
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        toast.error(
          error instanceof Error && error.name === "TimeoutError"
            ? "查询超时，请稍后重试。"
            : "查询失败，请检查网络连接后重试。",
        );
      }
    } finally {
      if (!controller.signal.aborted) setQuerying(false);
    }
  }

  return (
    <section
      className={cn("ddt-api-reference", ddtApiReferenceStyles["ddt-api-reference"])}
      aria-label="DDT 开放 API"
    >
      <Card
        as="article"
        className={cn(
          "card ddt-api-card",
          uiPatterns["card"],
          ddtApiReferenceStyles["ddt-api-card"],
        )}
      >
        <header className={cn("ddt-api-heading", ddtApiReferenceStyles["ddt-api-heading"])}>
          <Globe2 size={21} aria-hidden="true" />
          <div>
            <h2>开放 API</h2>
            <p>按 CaseID 读取用例原始 JSON，可直接用于测试脚本。</p>
          </div>
          <Badge className={cn("ddt-api-badge", ddtApiReferenceStyles["ddt-api-badge"])}>
            公开 · 只读
          </Badge>
        </header>
        <dl
          className={cn("ddt-api-scope", ddtApiReferenceStyles["ddt-api-scope"])}
          aria-label="接口数据范围"
        >
          {(
            [
              ["项目", labels.project],
              ["项目版本", labels.version],
              ["测试阶段", labels.stage],
            ] as const
          ).map(([label, name]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd title={name}>{name}</dd>
            </div>
          ))}
        </dl>
        <p>
          无需登录或 API
          Key。接口地址固定对应上述范围；切换顶栏会生成新地址，已复制的地址仍指向原范围。同一 CaseID
          在不同范围独立查询。
        </p>
        <form
          className={cn("ddt-api-query", ddtApiReferenceStyles["ddt-api-query"])}
          onSubmit={(event) => void query(event)}
        >
          <label>
            <span>CaseID</span>
            <Input
              value={caseId}
              maxLength={512}
              required
              disabled={querying}
              onChange={(event) => {
                setCaseId(event.target.value);
                setResult(undefined);
              }}
              placeholder="输入当前范围内的 CaseID"
            />
          </label>
          <Button
            className={cn(
              "button button-primary",
              uiPatterns["button"],
              uiPatterns["button-primary"],
            )}
            type="submit"
            disabled={!origin || !caseId.trim() || querying}
          >
            {querying ? (
              <LoaderCircle size={16} className={cn("spin", uiPatterns["spin"])} />
            ) : (
              <Play size={16} />
            )}{" "}
            {querying ? "查询中" : "查询用例"}
          </Button>
        </form>
        {(
          [
            ["查询参数形式", queryUrl],
            ["路径形式", pathUrl],
          ] as const
        ).map(([label, url]) => (
          <div
            className={cn("ddt-api-endpoint", ddtApiReferenceStyles["ddt-api-endpoint"])}
            key={label}
          >
            <div
              className={cn(
                "ddt-api-endpoint-heading",
                ddtApiReferenceStyles["ddt-api-endpoint-heading"],
              )}
            >
              <strong>{label}</strong>
              <Button
                type="button"
                onClick={() => void copy(url)}
                disabled={!origin || !caseId.trim()}
                aria-label={`复制${label}地址`}
              >
                <Copy size={14} /> 复制地址
              </Button>
            </div>
            <code>
              <span>GET</span> {url}
            </code>
          </div>
        ))}
        <p>
          两种形式返回相同内容。中文、空格、斜杠等字符需 URL
          编码；含特殊字符时建议使用查询参数形式。
        </p>
        {result ? (
          <section
            className={cn("ddt-api-result", ddtApiReferenceStyles["ddt-api-result"])}
            aria-label="查询结果"
          >
            <div
              className={cn(
                "ddt-api-endpoint-heading",
                ddtApiReferenceStyles["ddt-api-endpoint-heading"],
              )}
            >
              <strong role="status">
                HTTP {result.status} · {result.duration}
              </strong>
              <Button type="button" onClick={() => void copy(result.body)}>
                <Copy size={14} /> 复制完整响应
              </Button>
            </div>
            <pre tabIndex={0}>{result.body.slice(0, RESPONSE_PREVIEW_CHARACTERS)}</pre>
            {result.body.length > RESPONSE_PREVIEW_CHARACTERS ? (
              <p>
                响应较长，仅预览前 {RESPONSE_PREVIEW_CHARACTERS.toLocaleString()}{" "}
                个字符；可复制完整响应。
              </p>
            ) : null}
          </section>
        ) : null}
      </Card>

      <div className={cn("ddt-api-guide-grid", ddtApiReferenceStyles["ddt-api-guide-grid"])}>
        <Card
          as="article"
          className={cn(
            "card ddt-api-card",
            uiPatterns["card"],
            ddtApiReferenceStyles["ddt-api-card"],
          )}
        >
          <div
            className={cn(
              "ddt-api-endpoint-heading",
              ddtApiReferenceStyles["ddt-api-endpoint-heading"],
            )}
          >
            <h3>调用示例</h3>
            <Select
              aria-label="示例语言"
              value={language}
              onChange={(event) => setLanguage(event.target.value as DdtApiExampleLanguage)}
            >
              <option value="curl">cURL</option>
              <option value="javascript">JavaScript</option>
              <option value="groovy">Groovy</option>
            </Select>
            <Button type="button" disabled={!origin} onClick={() => void copy(example)}>
              <Copy size={14} /> 复制示例
            </Button>
          </div>
          <pre tabIndex={0} aria-label="调用示例代码">
            {example}
          </pre>
          <p>
            示例已填入当前范围和 CaseID。JavaScript / Groovy 返回对象或 Map，未找到用例返回
            null；其他失败抛出异常。
          </p>
        </Card>
        <Card
          as="article"
          className={cn(
            "card ddt-api-card",
            uiPatterns["card"],
            ddtApiReferenceStyles["ddt-api-card"],
          )}
        >
          <h3>响应说明</h3>
          <p>
            成功时直接返回字段对象，不包裹 data 或管理元数据。用户旅程保留“用户旅程 →
            step1、step2…”结构，数字、布尔值与 null 保持原类型。
          </p>
          <dl className={cn("ddt-api-responses", ddtApiReferenceStyles["ddt-api-responses"])}>
            <div>
              <dt>200</dt>
              <dd>当前范围内的最新用例数据</dd>
            </div>
            <div>
              <dt>400</dt>
              <dd>CaseID 缺失、空白或参数格式不正确</dd>
            </div>
            <div>
              <dt>404</dt>
              <dd>当前范围无此用例，或用例已移入回收站</dd>
            </div>
            <div>
              <dt>503</dt>
              <dd>平台暂时繁忙，请稍后重试</dd>
            </div>
          </dl>
          <p>
            失败响应使用 error.code、error.message 和 error.requestId。支持跨域 GET /
            OPTIONS，响应不缓存，更新后再次查询即可读取最新数据。
          </p>
          <p>
            此入口只公开单条用例的字段内容。编辑、导入、历史、回收站和批量管理仍使用需鉴权的管理接口。
          </p>
        </Card>
      </div>
    </section>
  );
}

const ddtApiReferenceStyles = {
  "ddt-api-badge": "py-1 px-3 rounded-full bg-info/10 text-info text-xs",
  "ddt-api-card":
    "grid min-w-0 gap-4 [align-content:start] p-5 [&_:is(h2,_h3,_p,_dl,_dd,_pre)]:m-0 [&_h2]:text-lg [&_h3]:text-sm [&_p]:text-muted-foreground [&_p]:text-xs [&_p]:leading-[1.6] [&_dt]:text-muted-foreground [&_dt]:text-xs [&_dt]:leading-[1.6] [&_pre]:block [&_pre]:min-w-0 [&_pre]:max-h-[360px] [&_pre]:overflow-auto [&_pre]:[overflow-wrap:anywhere] [&_pre]:whitespace-pre-wrap [&_pre]:p-3 [&_pre]:border [&_pre]:border-solid [&_pre]:border-border [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:font-mono [&_pre]:text-xs [&_pre]:leading-[1.6]",
  "ddt-api-endpoint":
    "grid min-w-0 gap-2 [&_>_code]:block [&_>_code]:min-w-0 [&_>_code]:max-h-[360px] [&_>_code]:overflow-auto [&_>_code]:[overflow-wrap:anywhere] [&_>_code]:whitespace-pre-wrap [&_>_code]:p-3 [&_>_code]:border [&_>_code]:border-solid [&_>_code]:border-border [&_>_code]:rounded-lg [&_>_code]:bg-muted [&_>_code]:font-mono [&_>_code]:text-xs [&_>_code]:leading-[1.6] [&_code_>_span]:text-success [&_code_>_span]:font-semibold",
  "ddt-api-endpoint-heading":
    "flex items-center flex-wrap gap-3 [&_>_:first-child]:min-w-0 [&_>_:first-child]:mr-auto [&_>_.ui-select]:[flex:0_1_140px] [&_>_.ui-select]:w-[140px]",
  "ddt-api-guide-grid":
    "grid min-w-0 grid-cols-[minmax(0,_1.2fr)_minmax(0,_1fr)] gap-4 max-[1181px]:grid-cols-[minmax(0,_1fr)]",
  "ddt-api-heading": "flex items-center flex-wrap gap-3 [&_>_div]:min-w-0 [&_>_div]:mr-auto",
  "ddt-api-query":
    "flex items-end flex-wrap gap-3 [&_label]:grid [&_label]:min-w-0 [&_label]:flex-1 [&_label]:gap-2",
  "ddt-api-reference": "grid min-w-0 gap-4",
  "ddt-api-responses":
    "grid gap-3 [&_>_div]:grid [&_>_div]:grid-cols-[auto_minmax(0,_1fr)] [&_>_div]:gap-3",
  "ddt-api-result": "grid min-w-0 gap-2",
  "ddt-api-scope": "grid grid-cols-3 gap-4 [&_dd]:[overflow-wrap:anywhere] [&_dd]:font-semibold",
} as const;
