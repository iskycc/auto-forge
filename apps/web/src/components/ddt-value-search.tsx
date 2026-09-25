"use client";
import { LoadingIcon } from "@/components/ui/loading-icon";

import { EmptyState } from "@/components/ui/empty-state";

import { Notice } from "@/components/ui/notice";

import { Disclosure } from "@/components/ui/disclosure";

import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { Search, Eye, Plus, X } from "lucide-react";
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
import { ExpandableText } from "./expandable-text";
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
    <section
      className={cn("ddt-value-search", ddtValueSearchStyles["ddt-value-search"])}
      aria-label="DDT 高级检索"
    >
      <div
        className={cn(
          "ddt-value-search-form surface-card",
          ddtValueSearchStyles["ddt-value-search-form"],
        )}
      >
        <div>
          <h2>按字段值检索用例</h2>
          <p>
            {labels.project} / {labels.version} / {labels.stage}
          </p>
        </div>
        <form onSubmit={submit}>
          <div
            className={cn(
              "ddt-value-search-conditions",
              ddtValueSearchStyles["ddt-value-search-conditions"],
            )}
          >
            {conditions.map((condition, index) => (
              <div
                className={cn(
                  "ddt-value-search-condition",
                  ddtValueSearchStyles["ddt-value-search-condition"],
                )}
                key={condition.id}
              >
                <label htmlFor={`ddt-value-keyword-${condition.id}`}>
                  {index === 0 ? "关键词" : `关键词 ${index + 1}`}
                </label>
                <div
                  className={cn(
                    "ddt-value-search-controls",
                    ddtValueSearchStyles["ddt-value-search-controls"],
                  )}
                >
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
          <div
            className={cn(
              "ddt-value-search-actions",
              ddtValueSearchStyles["ddt-value-search-actions"],
            )}
          >
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
              {pending ? <LoadingIcon size={16} /> : <Search size={16} />} 搜索
            </Button>
            {pending ? (
              <Button type="button" onClick={() => controller.current?.abort()}>
                取消检索
              </Button>
            ) : null}
          </div>
          <Disclosure
            header={<>搜索说明 · 多条件取并集，仅匹配字段值</>}
            className={cn("search-help", ddtValueSearchStyles["search-help"])}
          >
            <p>
              包括用户旅程各
              Step；不匹配字段名，不区分英文大小写。用例去重显示。点击搜索或按回车开始，输入时不会查询。
            </p>
            <p>
              最多 {DDT_VALUE_SEARCH_MAX_KEYWORDS} 个条件，合计 {DDT_VALUE_SEARCH_MAX_TEXT_LENGTH}{" "}
              个字符；空白条件自动忽略。
            </p>
          </Disclosure>
          {formError ? (
            <Notice
              tone="error"
              className={cn(
                "inline-notice error",
                uiPatterns["inline-notice"],
                uiPatterns["error"],
              )}
              role="alert"
            >
              {formError}
            </Notice>
          ) : null}
        </form>
      </div>
      {error ? (
        <Notice
          tone="error"
          className={cn("inline-notice error", uiPatterns["inline-notice"], uiPatterns["error"])}
          role="alert"
        >
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
        </Notice>
      ) : null}
      {!result ? (
        <EmptyState className={cn("empty-state", uiPatterns["empty-state"])}>
          输入关键词，检索当前范围内的 DDT 用例。
        </EmptyState>
      ) : (
        <>
          <p className={"ddt-value-search-status"} role="status">
            {result.keywords.map((keyword) => `“${keyword}”`).join(" 或 ")} ·{" "}
            {pending ? "正在检索…" : result.complete ? "检索完成" : "检索尚未完成"}
            {!result.complete
              ? ` · 已检索 ${result.scannedCount} 条用例，已匹配 ${result.totalCount} 条（总数统计中）`
              : ""}
          </p>
          {!pending && !error && result.complete && !result.totalCount ? (
            <EmptyState className={cn("empty-state", uiPatterns["empty-state"])}>
              没有匹配的字段值，请尝试其他关键词。
            </EmptyState>
          ) : null}
          <div
            className={cn(
              "ddt-value-search-results",
              ddtValueSearchStyles["ddt-value-search-results"],
            )}
          >
            {result.items.map((item) => (
              <article
                className={cn(
                  "ddt-value-search-result surface-card",
                  ddtValueSearchStyles["ddt-value-search-result"],
                )}
                key={item.id}
              >
                <header>
                  <div>
                    <h3>{item.caseId}</h3>
                    <div
                      className={cn(
                        "ddt-search-case-name",
                        ddtValueSearchStyles["ddt-search-case-name"],
                      )}
                    >
                      <span>CaseName · </span>
                      <ExpandableText text={item.caseName || "未填写"} label="用例名称" />
                    </div>
                    <span>
                      SR · {item.srNum} · {item.matchCount} 个字段匹配
                    </span>
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    className={cn(
                      "ddt-value-search-preview-trigger",
                      ddtValueSearchStyles["ddt-value-search-preview-trigger"],
                    )}
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
                      <dd>
                        <ExpandableText text={match.value} label="匹配字段值" />
                      </dd>
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
          <DdtSearchPagination
            totalCount={result.totalCount}
            complete={result.complete}
            page={result.page}
            disabled={pending || !result.complete}
            onPageChange={(page) => void changePage(page)}
          />
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

const ddtValueSearchStyles = {
  "ddt-search-case-name":
    "flex min-w-0 gap-1 text-muted-foreground text-xs [&_>_span:first-child]:[flex:0_0_auto]",
  "ddt-value-search":
    "grid min-w-0 gap-4 [&_:is(h2,_h3,_p,_dl,_dd)]:m-0 [&_:is(h2,_h3,_p,_dl,_dd)]:[overflow-wrap:anywhere] [&_h2]:text-lg [&_h3]:text-sm [&_:is(p,_dt,_header_span)]:text-muted-foreground [&_:is(p,_dt,_header_span)]:text-xs [&_:is(p,_dt,_header_span)]:leading-[1.6]",
  "ddt-value-search-actions": "flex min-w-0 items-center gap-3 flex-wrap",
  "ddt-value-search-condition":
    "grid min-w-0 gap-2 [grid-column:span_2] grid-cols-[subgrid] items-center [&:only-child]:col-span-full [&:only-child]:grid-cols-[auto_minmax(0,_1fr)]",
  "ddt-value-search-conditions":
    "grid min-w-0 gap-2 grid-cols-[auto_minmax(0,_1fr)_auto_minmax(0,_1fr)]",
  "ddt-value-search-controls":
    "flex min-w-0 items-center gap-3 [&_>_:first-child]:flex-1 [&_>_:first-child]:min-w-0",
  "ddt-value-search-form":
    "grid min-w-0 gap-2 p-3 border border-solid border-border rounded-lg bg-card [&_form]:grid [&_form]:min-w-0 [&_form]:gap-2",
  "ddt-value-search-preview-trigger": "shrink-0 gap-2",
  "ddt-value-search-result":
    "grid min-w-0 gap-2 py-2 px-3 border border-solid border-border rounded-lg bg-card [&_dl]:grid [&_dl]:min-w-0 [&_dl]:gap-1 [&_header]:flex [&_header]:min-w-0 [&_header]:items-center [&_header]:gap-3 [&_header_>_div]:flex-1 [&_header_>_div]:min-w-0 [&_dl_>_div]:grid [&_dl_>_div]:min-w-0 [&_dl_>_div]:grid-cols-[minmax(0,_1fr)_minmax(0,_3fr)] [&_dl_>_div]:items-start [&_dl_>_div]:gap-3 [&_dl_>_div]:pt-1 [&_dl_>_div]:border-t [&_dl_>_div]:border-solid [&_dl_>_div]:border-border [&_:is(dt,_dd)]:min-w-0 [&_:is(dt,_dd)]:[overflow-wrap:anywhere] [&_:is(dt,_dd)]:whitespace-pre-wrap",
  "ddt-value-search-results": "grid min-w-0 gap-2",
  "search-help":
    "[&_.ui-disclosure-label]:cursor-pointer [&_.ui-disclosure-label]:text-muted-foreground [&_.ui-disclosure-label]:text-xs [&[data-open=true]_p]:mt-2",
} as const;
