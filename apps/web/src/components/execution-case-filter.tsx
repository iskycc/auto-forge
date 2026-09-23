"use client";
import { Notice } from "@/components/ui/notice";

import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import { useEffect, useRef, useState } from "react";
import { ActionDialog } from "./action-dialog";
import { Button, Input, Select } from "./ui";
import { readApiErrorMessage } from "@/lib/client-api";

type CaseChoice = {
  id: string;
  displayName?: string;
  className?: string;
  caseId?: string;
  srNum?: string;
};
type ChoicePage = { items: CaseChoice[]; nextCursor?: string };

export function ExecutionCaseFilter({
  initialId,
  projectId,
  projectVersionId,
  testStageId,
  canReadCases,
}: {
  initialId?: string | undefined;
  projectId?: string | undefined;
  projectVersionId?: string | undefined;
  testStageId?: string | undefined;
  canReadCases: boolean;
}) {
  const [id, setId] = useState(initialId ?? "");
  const [selectedName, setSelectedName] = useState("");
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState("testng");
  const [query, setQuery] = useState("");
  const [searchedQuery, setSearchedQuery] = useState("");
  const [choices, setChoices] = useState<ChoicePage>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const requestRef = useRef<AbortController | null>(null);
  useEffect(() => () => requestRef.current?.abort(), []);
  async function search(cursor?: string) {
    if (!projectId || !projectVersionId) return;
    requestRef.current?.abort();
    const request = new AbortController();
    requestRef.current = request;
    setPending(true);
    setError("");
    const keyword = cursor ? searchedQuery : query.trim();
    setSearchedQuery(keyword);
    try {
      const parameters = new URLSearchParams({
        projectId,
        projectVersionId,
        query: keyword,
        limit: "30",
      });
      if (testStageId) parameters.set("testStageId", testStageId);
      if (cursor) parameters.set("cursor", cursor);
      const response = await fetch(
        `/api/v1/${kind === "ddt" ? "ddt/cases" : "case-definitions"}?${parameters}`,
        {
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
        },
      );
      const message = await readApiErrorMessage(response, "查找用例失败，请重试。");
      if (message) throw new Error(message);
      const page = (await response.json()) as ChoicePage;
      if (!request.signal.aborted)
        setChoices((previous) => ({
          ...page,
          items: cursor ? [...(previous?.items ?? []), ...page.items] : page.items,
        }));
    } catch (failure) {
      if (!request.signal.aborted)
        setError(failure instanceof Error ? failure.message : "查找用例失败。");
    } finally {
      if (!request.signal.aborted) setPending(false);
    }
  }
  return (
    <div
      className={cn("execution-case-filter", executionCaseFilterStyles["execution-case-filter"])}
    >
      <label>
        用例 ID
        <Input
          name="caseDefinitionId"
          value={id}
          onChange={(event) => {
            setId(event.target.value);
            setSelectedName("");
          }}
          placeholder="选择用例或输入平台 ID"
        />
      </label>
      {canReadCases && projectVersionId ? (
        <Button type="button" size="compact" onClick={() => setOpen(true)}>
          查找用例
        </Button>
      ) : null}
      {selectedName ? <small title={selectedName}>{selectedName}</small> : null}
      <ActionDialog
        open={open}
        title="查找执行用例"
        description="按名称或类路径查找普通用例，按 CaseId 查找 DDT；选择后再应用页面筛选。"
        onClose={() => setOpen(false)}
      >
        <form
          className={cn("case-lookup-form", executionCaseFilterStyles["case-lookup-form"])}
          onSubmit={(event) => {
            event.preventDefault();
            void search();
          }}
        >
          <label>
            用例类型
            <Select
              aria-label="用例类型"
              value={kind}
              disabled={pending}
              onChange={(event) => {
                setKind(event.target.value);
                setChoices(undefined);
                setError("");
              }}
            >
              <option value="testng">普通用例</option>
              {testStageId ? <option value="ddt">DDT 用例</option> : null}
            </Select>
          </label>
          <label>
            查找关键词
            <Input
              type="search"
              maxLength={200}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={kind === "ddt" ? "CaseId" : "用例名称或类路径"}
            />
          </label>
          <Button type="submit" disabled={pending}>
            搜索用例
          </Button>
        </form>
        {error ? (
          <Notice tone="error" role="alert" className={cn("form-error", uiPatterns["form-error"])}>
            {error}
          </Notice>
        ) : null}
        {pending ? <p role="status">正在查找…</p> : null}
        <div
          className={cn("case-lookup-results", executionCaseFilterStyles["case-lookup-results"])}
        >
          {choices?.items.map((item) => (
            <Button
              key={item.id}
              type="button"
              onClick={() => {
                setId(item.id);
                setSelectedName(item.caseId ?? item.displayName ?? item.className ?? item.id);
                setOpen(false);
              }}
            >
              <strong>{item.caseId ?? item.displayName ?? item.className}</strong>
              <small>{item.className ?? item.srNum}</small>
            </Button>
          ))}
        </div>
        {choices && !choices.items.length && !pending ? (
          <p>没有匹配的用例，请检查关键词与当前项目范围。</p>
        ) : null}
        {choices?.nextCursor ? (
          <Button type="button" disabled={pending} onClick={() => void search(choices.nextCursor)}>
            加载更多用例
          </Button>
        ) : null}
      </ActionDialog>
    </div>
  );
}

const executionCaseFilterStyles = {
  "case-lookup-form":
    "grid grid-cols-[minmax(0,_1fr)_minmax(0,_2fr)_auto] items-end gap-2 [&_label]:grid [&_label]:min-w-0 [&_label]:gap-1",
  "case-lookup-results":
    "grid gap-2 my-3 [&_>_button]:grid [&_>_button]:justify-start [&_>_button]:text-left [&_>_button]:[overflow-wrap:anywhere] [&_small]:text-muted-foreground",
  "execution-case-filter":
    "grid grid-cols-[minmax(0,_1fr)_auto] items-end gap-1 min-w-0 [&_label]:min-w-0 [&_small]:col-span-full [&_small]:overflow-hidden [&_small]:text-ellipsis [&_small]:whitespace-nowrap",
} as const;
