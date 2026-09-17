"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { Search, ArrowRight, LoaderCircle } from "lucide-react";
import { ddtValueSearchPageSchema, type DdtValueSearchPage } from "@autoforge/contracts";
import type { DdtScope } from "@autoforge/domain";
import type { DdtScopeLabels } from "./ddt-api-reference";
import { Button, Input } from "./ui";
import { readApiErrorMessage } from "@/lib/client-api";
import {
  browserCacheEpoch,
  readBrowserSnapshot,
  writeBrowserSnapshot,
} from "@/lib/browser-read-cache";

type SearchResult = DdtValueSearchPage & {
  complete: boolean;
  keyword: string;
  startCursor: string;
  previous: string[];
};

export function DdtValueSearch({ scope, labels }: { scope: DdtScope; labels: DdtScopeLabels }) {
  const parameters = useSearchParams();
  const urlKeyword = parameters.get("ddtSearch") ?? "";
  const activeWorkspace = parameters.get("tab");
  const scopeQuery = new URLSearchParams(scope).toString();
  const cacheKey = `ddt-value-search:v1:${scopeQuery}:`;
  const [keyword, setKeyword] = useState(urlKeyword);
  const [result, setResult] = useState<SearchResult | undefined>(
    () => readBrowserSnapshot(cacheKey + urlKeyword) as SearchResult | undefined,
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const committedKeyword = useRef(urlKeyword);

  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (activeWorkspace !== "ddt") controller.current?.abort();
  }, [activeWorkspace]);
  useEffect(() => {
    if (committedKeyword.current === urlKeyword) return;
    committedKeyword.current = urlKeyword;
    controller.current?.abort();
    const timer = window.setTimeout(() => {
      setKeyword(urlKeyword);
      setResult(readBrowserSnapshot(cacheKey + urlKeyword) as SearchResult | undefined);
      setPending(false);
      setError("");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [urlKeyword, cacheKey]);

  async function search(searchKeyword: string, startCursor = "", previous: string[] = []) {
    if (controller.current && !controller.current.signal.aborted) return;
    const request = new AbortController();
    controller.current = request;
    const epoch = browserCacheEpoch();
    setPending(true);
    setError("");
    const next: SearchResult = {
      complete: false,
      keyword: searchKeyword,
      items: [],
      scannedCount: 0,
      startCursor,
      previous,
    };
    setResult({ ...next });
    let cursor = startCursor;
    const startedAt = performance.now();
    try {
      // One explicit search advances serially through bounded slices, with no polling or writes.
      for (let slice = 0; slice < 60; slice += 1) {
        const query = new URLSearchParams(scopeQuery);
        query.set("keyword", searchKeyword);
        query.set("limit", String(20 - next.items.length));
        if (cursor) query.set("cursor", cursor);
        const response = await fetch(`/api/v1/ddt/value-search?${query}`, {
          cache: "no-store",
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
        });
        const message = await readApiErrorMessage(response, "检索失败，请稍后重试。");
        if (message) throw new Error(message);
        const page = ddtValueSearchPageSchema.parse(await response.json());
        if (request.signal.aborted) return;
        next.items = [...next.items, ...page.items];
        next.scannedCount += page.scannedCount;
        next.nextCursor = page.nextCursor;
        next.complete = !page.nextCursor;
        setResult({ ...next });
        if (!page.nextCursor || next.items.length >= 20 || performance.now() - startedAt >= 30_000)
          break;
        if (page.nextCursor === cursor) throw new Error("检索未能继续，请重试。");
        cursor = page.nextCursor;
      }
      writeBrowserSnapshot(cacheKey + searchKeyword, next, epoch);
    } catch (failure) {
      if (!request.signal.aborted)
        setError(failure instanceof Error ? failure.message : "检索失败，请重试。");
    } finally {
      if (controller.current === request) {
        controller.current = null;
        setPending(false);
      }
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = keyword.trim();
    if (!trimmed || pending) return;
    committedKeyword.current = trimmed;
    const url = new URL(window.location.href);
    url.searchParams.set("ddtSearch", trimmed);
    window.history.pushState(null, "", url);
    void search(trimmed);
  }

  function caseUrl(caseId: string) {
    const query = new URLSearchParams(parameters.toString());
    for (const name of ["ddtGroup", "ddtField", "ddtOperator", "ddtValue"]) query.delete(name);
    query.set("ddtView", "cases");
    query.set("ddtQuery", caseId);
    return `/cases?${query}`;
  }

  return (
    <section className="ddt-value-search" aria-label="DDT 高级检索">
      <div className="ddt-value-search-form surface-card">
        <div>
          <h2>按字段值检索用例</h2>
          <p>
            {labels.project} / {labels.version} / {labels.stage}
          </p>
          <p>匹配任意字段值，包括用户旅程各 Step；不匹配字段名，不区分英文大小写。</p>
        </div>
        <form onSubmit={submit}>
          <label htmlFor="ddt-value-keyword">关键词</label>
          <div className="ddt-value-search-controls">
            <Input
              id="ddt-value-keyword"
              value={keyword}
              maxLength={512}
              placeholder="输入字段值，例如：钱包、支付成功、订单号"
              onChange={(event) => setKeyword(event.target.value)}
            />
            <Button type="submit" variant="primary" disabled={pending || !keyword.trim()}>
              {pending ? <LoaderCircle className="spin" size={16} /> : <Search size={16} />} 搜索
            </Button>
            {pending ? (
              <Button type="button" onClick={() => controller.current?.abort()}>
                取消检索
              </Button>
            ) : null}
          </div>
          <p>点击“搜索”或按回车开始检索，输入时不会发送查询。</p>
        </form>
      </div>
      {error ? (
        <div className="inline-notice error" role="alert">
          <span>{error}</span>
          <Button
            disabled={pending}
            onClick={() =>
              result && void search(result.keyword, result.startCursor, result.previous)
            }
          >
            重试检索
          </Button>
        </div>
      ) : null}
      {!result ? (
        <p className="empty-state">输入关键词，检索当前范围内的 DDT 用例。</p>
      ) : (
        <>
          <p className="ddt-value-search-status" role="status">
            “{result.keyword}” · 本批已检索 {result.scannedCount} 条用例，展示 {result.items.length}{" "}
            条匹配用例
            {pending
              ? " · 正在检索…"
              : result.nextCursor
                ? " · 还有用例可继续检索"
                : result.complete
                  ? " · 已检索到末尾"
                  : " · 检索尚未完成"}
          </p>
          {!pending && !error && (result.complete || result.nextCursor) && !result.items.length ? (
            <p className="empty-state">
              本批没有匹配的字段值。
              {result.nextCursor ? "可继续检索剩余用例。" : "请尝试其他关键词。"}
            </p>
          ) : null}
          <div className="ddt-value-search-results">
            {result.items.map((item) => (
              <article className="ddt-value-search-result surface-card" key={item.id}>
                <header>
                  <div>
                    <h3>{item.caseId}</h3>
                    <span>
                      SR · {item.srNum} · {item.matchCount} 个字段匹配
                    </span>
                  </div>
                  <a className="button button-secondary" href={caseUrl(item.caseId)}>
                    查看用例 <ArrowRight size={15} />
                  </a>
                </header>
                <dl>
                  {item.matches.map((match, index) => (
                    <div key={index}>
                      <dt>{match.path.join(" › ")}</dt>
                      <dd>{match.value}</dd>
                    </div>
                  ))}
                </dl>
                {item.matchCount > item.matches.length ? (
                  <p>显示前 {item.matches.length} 个匹配字段，可进入用例查看完整内容。</p>
                ) : null}
              </article>
            ))}
          </div>
          <div className="button-row">
            {result.previous.length ? (
              <Button
                disabled={pending}
                onClick={() =>
                  void search(result.keyword, result.previous.at(-1)!, result.previous.slice(0, -1))
                }
              >
                上一批
              </Button>
            ) : null}
            {result.nextCursor ? (
              <Button
                disabled={pending}
                onClick={() =>
                  void search(result.keyword, result.nextCursor, [
                    ...result.previous,
                    result.startCursor,
                  ])
                }
              >
                {result.items.length ? "下一批" : "继续检索"}
              </Button>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}
