"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { Search, Eye, LoaderCircle } from "lucide-react";
import {
  DDT_VALUE_SEARCH_PAGE_SIZE,
  ddtValueSearchPageSchema,
  type DdtValueSearchPage,
} from "@autoforge/contracts";
import type { DdtScope } from "@autoforge/domain";
import type { DdtScopeLabels } from "./ddt-api-reference";
import { Button, Input } from "./ui";
import { DdtCaseDataDialog } from "./ddt-case-data-dialog";
import { DdtSearchPagination } from "./ddt-search-pagination";
import { readApiErrorMessage } from "@/lib/client-api";
import { createClientIdempotencyKey } from "@/lib/client-idempotency-key";
import {
  browserCacheEpoch,
  readBrowserSnapshot,
  writeBrowserSnapshot,
} from "@/lib/browser-read-cache";

type SearchResult = {
  generation: string;
  complete: boolean;
  keyword: string;
  scannedCount: number;
  totalCount: number;
  pageCursors: string[];
  nextCursor: string | undefined;
  page: number;
  items: DdtValueSearchPage["items"];
};

function cachedResult(cacheKey: string, keyword: string, page: number): SearchResult | undefined {
  const latest = readBrowserSnapshot(cacheKey + keyword) as SearchResult | undefined;
  if (!latest || latest.page === page) return latest;
  return readBrowserSnapshot(`${cacheKey}${latest.generation}:${page}`) as SearchResult | undefined;
}

export function DdtValueSearch({ scope, labels }: { scope: DdtScope; labels: DdtScopeLabels }) {
  const parameters = useSearchParams();
  const urlKeyword = parameters.get("ddtSearch") ?? "";
  const requestedPage = Number(parameters.get("ddtSearchPage") ?? 1);
  const urlPage = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const activeWorkspace = parameters.get("tab");
  const scopeQuery = new URLSearchParams(scope).toString();
  const cacheKey = `ddt-value-search:v3:${scopeQuery}:`;
  const [keyword, setKeyword] = useState(urlKeyword);
  const [result, setResult] = useState<SearchResult | undefined>(() =>
    cachedResult(cacheKey, urlKeyword, urlPage),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [failedPage, setFailedPage] = useState<number>();
  const [previewCaseId, setPreviewCaseId] = useState<string>();
  const controller = useRef<AbortController | null>(null);
  const committedLocation = useRef(`${urlKeyword}:${urlPage}`);

  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (activeWorkspace === "ddt") return;
    controller.current?.abort();
    const timer = window.setTimeout(() => setPreviewCaseId(undefined), 0);
    return () => window.clearTimeout(timer);
  }, [activeWorkspace]);
  useEffect(() => {
    const location = `${urlKeyword}:${urlPage}`;
    if (committedLocation.current === location) return;
    committedLocation.current = location;
    controller.current?.abort();
    const timer = window.setTimeout(() => {
      setKeyword(urlKeyword);
      setResult(cachedResult(cacheKey, urlKeyword, urlPage));
      setPending(false);
      setError("");
      setFailedPage(undefined);
      setPreviewCaseId(undefined);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [urlKeyword, urlPage, cacheKey]);

  function saveResult(next: SearchResult, epoch: number) {
    setResult(next);
    writeBrowserSnapshot(cacheKey + next.keyword, next, epoch);
    writeBrowserSnapshot(`${cacheKey}${next.generation}:${next.page}`, next, epoch);
  }

  async function readSlice(query: URLSearchParams, request: AbortController) {
    const response = await fetch(`/api/v1/ddt/value-search?${query}`, {
      cache: "no-store",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
    });
    const message = await readApiErrorMessage(response, "检索失败，请稍后重试。");
    if (message) throw new Error(message);
    const slice = ddtValueSearchPageSchema.parse(await response.json());
    request.signal.throwIfAborted();
    return slice;
  }

  async function readPage(index: SearchResult, page: number, request: AbortController) {
    const items: DdtValueSearchPage["items"] = [];
    const pageSize = Math.min(
      DDT_VALUE_SEARCH_PAGE_SIZE,
      index.totalCount - (page - 1) * DDT_VALUE_SEARCH_PAGE_SIZE,
    );
    let cursor = index.pageCursors[page - 1];
    if (cursor === undefined) return { ...index, page: 1, items };
    const startedAt = performance.now();
    // A page starts immediately before its first match, but may span sparse windows.
    for (let slice = 0; slice < 60; slice += 1) {
      const query = new URLSearchParams(scopeQuery);
      query.set("keyword", index.keyword);
      query.set("limit", String(pageSize - items.length));
      if (cursor) query.set("cursor", cursor);
      const response = await readSlice(query, request);
      items.push(...response.items);
      if (!response.nextCursor || items.length >= pageSize) return { ...index, page, items };
      if (performance.now() - startedAt >= 30_000) break;
      if (response.nextCursor === cursor) throw new Error("检索未能继续，请重试。");
      cursor = response.nextCursor;
    }
    throw new Error("本页读取时间较长，请重试；若用例已发生变化，请重新搜索。");
  }

  async function search(searchKeyword: string, resume?: SearchResult) {
    if (controller.current && !controller.current.signal.aborted) return;
    const request = new AbortController();
    controller.current = request;
    const epoch = browserCacheEpoch();
    setPending(true);
    setPreviewCaseId(undefined);
    setError("");
    setFailedPage(undefined);
    let next: SearchResult = resume ?? {
      generation: createClientIdempotencyKey(),
      complete: false,
      keyword: searchKeyword,
      items: [],
      scannedCount: 0,
      totalCount: 0,
      pageCursors: [],
      nextCursor: undefined,
      page: 1,
    };
    setResult(next);
    const startedAt = performance.now();
    try {
      for (let slice = 0; !next.complete && slice < 60; slice += 1) {
        const query = new URLSearchParams(scopeQuery);
        query.set("keyword", searchKeyword);
        query.set("indexOffset", String(next.totalCount % DDT_VALUE_SEARCH_PAGE_SIZE));
        if (next.nextCursor) query.set("cursor", next.nextCursor);
        const response = await readSlice(query, request);
        if (!response.index) throw new Error("检索统计不可用，请刷新页面后重试。");
        if (response.nextCursor && response.nextCursor === next.nextCursor)
          throw new Error("检索未能继续，请重试。");
        next = {
          ...next,
          totalCount: next.totalCount + response.index.matchedCount,
          pageCursors: [...next.pageCursors, ...response.index.pageCursors],
          scannedCount: next.scannedCount + response.scannedCount,
          nextCursor: response.nextCursor,
          complete: !response.nextCursor,
        };
        setResult(next);
        if (next.complete || performance.now() - startedAt >= 30_000) break;
      }
      saveResult(await readPage(next, next.page, request), epoch);
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

  function setLocation(searchKeyword: string, page: number) {
    committedLocation.current = `${searchKeyword}:${page}`;
    const url = new URL(window.location.href);
    url.searchParams.set("ddtSearch", searchKeyword);
    url.searchParams.set("ddtSearchPage", String(page));
    window.history.pushState(null, "", url);
  }

  async function changePage(page: number) {
    if (!result || pending || page === result.page) return;
    const request = new AbortController();
    controller.current = request;
    const epoch = browserCacheEpoch();
    setPending(true);
    setError("");
    setFailedPage(undefined);
    setPreviewCaseId(undefined);
    try {
      const cached = readBrowserSnapshot(`${cacheKey}${result.generation}:${page}`) as
        SearchResult | undefined;
      const next = cached && result.complete ? cached : await readPage(result, page, request);
      request.signal.throwIfAborted();
      saveResult(next, epoch);
      setLocation(result.keyword, page);
    } catch (failure) {
      if (!request.signal.aborted) {
        setFailedPage(page);
        setError(failure instanceof Error ? failure.message : "读取分页失败，请重试。");
      }
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
    setLocation(trimmed, 1);
    void search(trimmed);
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
            onClick={() => {
              if (failedPage) void changePage(failedPage);
              else if (result) void search(result.keyword, result);
            }}
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
            “{result.keyword}” ·{" "}
            {pending ? "正在检索…" : result.complete ? "检索完成" : "检索尚未完成"}
            {!result.complete
              ? ` · 已检索 ${result.scannedCount} 条用例，已匹配 ${result.totalCount} 条（总数统计中）`
              : ""}
          </p>
          <DdtSearchPagination
            totalCount={result.totalCount}
            complete={result.complete}
            page={result.page}
            disabled={pending || !result.complete}
            onPageChange={(page) => void changePage(page)}
          />
          {!pending && !error && result.complete && !result.totalCount ? (
            <p className="empty-state">没有匹配的字段值，请尝试其他关键词。</p>
          ) : null}
          <div className="ddt-value-search-results">
            {result.items.map((item) => (
              <article className="ddt-value-search-result surface-card" key={item.id}>
                <header>
                  <div>
                    <h3>{item.caseId}</h3>
                    <p>CaseName · {item.caseName || "未填写"}</p>
                    <span>
                      SR · {item.srNum} · {item.matchCount} 个字段匹配
                    </span>
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    className="ddt-value-search-preview-trigger"
                    aria-haspopup="dialog"
                    onClick={() => setPreviewCaseId(item.caseId)}
                  >
                    查看用例 <Eye size={15} />
                  </Button>
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
                  <p>显示前 {item.matches.length} 个匹配字段，可点击“查看用例”查看完整内容。</p>
                ) : null}
              </article>
            ))}
          </div>
          {!pending && !error && !result.complete ? (
            <Button onClick={() => void search(result.keyword, result)}>继续统计</Button>
          ) : null}
          {!pending &&
          !error &&
          result.complete &&
          result.totalCount > 0 &&
          !result.items.length ? (
            <Button onClick={() => void search(result.keyword, result)}>加载当前页</Button>
          ) : null}
        </>
      )}
      {previewCaseId && activeWorkspace === "ddt" ? (
        <DdtCaseDataDialog
          key={previewCaseId}
          scope={scope}
          caseId={previewCaseId}
          onClose={() => setPreviewCaseId(undefined)}
        />
      ) : null}
    </section>
  );
}
