"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { Search, Eye, LoaderCircle, Plus, X } from "lucide-react";
import {
  DDT_VALUE_SEARCH_MAX_KEYWORDS,
  DDT_VALUE_SEARCH_MAX_TEXT_LENGTH,
  DDT_VALUE_SEARCH_PAGE_SIZE,
  ddtValueSearchKeywordsSchema,
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
  keywords: string[];
  scannedCount: number;
  totalCount: number;
  pageCursors: string[];
  nextCursor: string | undefined;
  page: number;
  items: DdtValueSearchPage["items"];
};

function cachedResult(
  cacheKey: string,
  keywords: string[],
  page: number,
): SearchResult | undefined {
  const latest = readBrowserSnapshot(`${cacheKey}query:${JSON.stringify(keywords)}`) as
    SearchResult | undefined;
  if (!latest || latest.page === page) return latest;
  return readBrowserSnapshot(`${cacheKey}page:${latest.generation}:${page}`) as
    SearchResult | undefined;
}

function searchConditions(keywords: string[]) {
  return (keywords.length ? keywords : [""]).map((keyword, id) => ({ id, keyword }));
}

export function DdtValueSearch({ scope, labels }: { scope: DdtScope; labels: DdtScopeLabels }) {
  const parameters = useSearchParams();
  const urlKeywords = useMemo(() => parameters.getAll("ddtSearch"), [parameters]);
  const requestedPage = Number(parameters.get("ddtSearchPage") ?? 1);
  const urlPage = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const activeWorkspace = parameters.get("tab");
  const scopeQuery = new URLSearchParams(scope).toString();
  const cacheKey = `ddt-value-search:v4:${scopeQuery}:`;
  const [conditions, setConditions] = useState(() => searchConditions(urlKeywords));
  const nextConditionId = useRef(Math.max(urlKeywords.length, DDT_VALUE_SEARCH_MAX_KEYWORDS));
  const conditionInputs = useRef(new Map<number, HTMLInputElement>());
  const [formError, setFormError] = useState("");
  const [result, setResult] = useState<SearchResult | undefined>(() =>
    cachedResult(cacheKey, urlKeywords, urlPage),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [failedPage, setFailedPage] = useState<number>();
  const [previewCaseId, setPreviewCaseId] = useState<string>();
  const controller = useRef<AbortController | null>(null);
  const committedLocation = useRef(JSON.stringify([urlKeywords, urlPage]));

  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (activeWorkspace === "ddt") return;
    controller.current?.abort();
    const timer = window.setTimeout(() => setPreviewCaseId(undefined), 0);
    return () => window.clearTimeout(timer);
  }, [activeWorkspace]);
  useEffect(() => {
    const location = JSON.stringify([urlKeywords, urlPage]);
    if (committedLocation.current === location) return;
    committedLocation.current = location;
    controller.current?.abort();
    const timer = window.setTimeout(() => {
      setConditions(searchConditions(urlKeywords));
      nextConditionId.current = Math.max(nextConditionId.current, urlKeywords.length);
      setFormError("");
      setResult(cachedResult(cacheKey, urlKeywords, urlPage));
      setPending(false);
      setError("");
      setFailedPage(undefined);
      setPreviewCaseId(undefined);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [urlKeywords, urlPage, cacheKey]);

  function saveResult(next: SearchResult, epoch: number) {
    setResult(next);
    writeBrowserSnapshot(`${cacheKey}query:${JSON.stringify(next.keywords)}`, next, epoch);
    writeBrowserSnapshot(`${cacheKey}page:${next.generation}:${next.page}`, next, epoch);
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
      for (const keyword of index.keywords) query.append("keyword", keyword);
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

  async function search(searchKeywords: string[], resume?: SearchResult) {
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
      keywords: searchKeywords,
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
        for (const keyword of searchKeywords) query.append("keyword", keyword);
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

  function setLocation(searchKeywords: string[], page: number) {
    committedLocation.current = JSON.stringify([searchKeywords, page]);
    const url = new URL(window.location.href);
    url.searchParams.delete("ddtSearch");
    for (const keyword of searchKeywords) url.searchParams.append("ddtSearch", keyword);
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
      const cached = readBrowserSnapshot(`${cacheKey}page:${result.generation}:${page}`) as
        SearchResult | undefined;
      const next = cached && result.complete ? cached : await readPage(result, page, request);
      request.signal.throwIfAborted();
      saveResult(next, epoch);
      setLocation(result.keywords, page);
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
    if (pending) return;
    const parsed = ddtValueSearchKeywordsSchema.safeParse(
      conditions.map((condition) => condition.keyword.trim()).filter(Boolean),
    );
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? "请检查搜索条件。");
      return;
    }
    setFormError("");
    setLocation(parsed.data, 1);
    void search(parsed.data);
  }

  function addCondition() {
    if (conditions.length >= DDT_VALUE_SEARCH_MAX_KEYWORDS) return;
    const id = nextConditionId.current++;
    setConditions([...conditions, { id, keyword: "" }]);
    setFormError("");
    requestAnimationFrame(() => conditionInputs.current.get(id)?.focus());
  }

  function removeCondition(id: number) {
    if (conditions.length === 1) return;
    const index = conditions.findIndex((condition) => condition.id === id);
    const remaining = conditions.filter((condition) => condition.id !== id);
    setConditions(remaining);
    setFormError("");
    conditionInputs.current.get(remaining[Math.min(index, remaining.length - 1)]!.id)?.focus();
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
          <div className="ddt-value-search-conditions">
            {conditions.map((condition, index) => (
              <div className="ddt-value-search-condition" key={condition.id}>
                <label htmlFor={`ddt-value-keyword-${condition.id}`}>
                  {index === 0 ? "关键词" : `关键词 ${index + 1}`}
                </label>
                <div className="ddt-value-search-controls">
                  <Input
                    id={`ddt-value-keyword-${condition.id}`}
                    ref={(element) => {
                      if (element) conditionInputs.current.set(condition.id, element);
                      else conditionInputs.current.delete(condition.id);
                    }}
                    value={condition.keyword}
                    maxLength={DDT_VALUE_SEARCH_MAX_TEXT_LENGTH}
                    placeholder="输入字段值，例如：钱包、支付成功、订单号"
                    onChange={(event) => {
                      setFormError("");
                      setConditions(
                        conditions.map((current) =>
                          current.id === condition.id
                            ? { ...current, keyword: event.target.value }
                            : current,
                        ),
                      );
                    }}
                  />
                  {conditions.length > 1 ? (
                    <Button
                      type="button"
                      aria-label={`移除搜索条件 ${index + 1}`}
                      onClick={() => removeCondition(condition.id)}
                    >
                      <X size={16} />
                    </Button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
          <div className="ddt-value-search-actions">
            <Button
              type="button"
              onClick={addCondition}
              disabled={conditions.length >= DDT_VALUE_SEARCH_MAX_KEYWORDS}
              aria-label="添加搜索条件"
            >
              <Plus size={16} /> 添加条件
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={pending || !conditions.some((condition) => condition.keyword.trim())}
            >
              {pending ? <LoaderCircle className="spin" size={16} /> : <Search size={16} />} 搜索
            </Button>
            {pending ? (
              <Button type="button" onClick={() => controller.current?.abort()}>
                取消检索
              </Button>
            ) : null}
          </div>
          <p>
            满足任一条件即匹配（并集），用例不重复显示。点击“搜索”或按回车开始，输入或增删条件时不会查询。
          </p>
          <p>
            最多 {DDT_VALUE_SEARCH_MAX_KEYWORDS} 个条件，合计 {DDT_VALUE_SEARCH_MAX_TEXT_LENGTH}{" "}
            个字符；空白条件自动忽略。
          </p>
          {formError ? (
            <p className="inline-notice error" role="alert">
              {formError}
            </p>
          ) : null}
        </form>
      </div>
      {error ? (
        <div className="inline-notice error" role="alert">
          <span>{error}</span>
          <Button
            disabled={pending}
            onClick={() => {
              if (failedPage) void changePage(failedPage);
              else if (result) void search(result.keywords, result);
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
            {result.keywords.map((keyword) => `“${keyword}”`).join(" 或 ")} ·{" "}
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
            <Button onClick={() => void search(result.keywords, result)}>继续统计</Button>
          ) : null}
          {!pending &&
          !error &&
          result.complete &&
          result.totalCount > 0 &&
          !result.items.length ? (
            <Button onClick={() => void search(result.keywords, result)}>加载当前页</Button>
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
