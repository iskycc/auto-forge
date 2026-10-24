"use client";
import { useEffect, useRef, useState } from "react";
import { Tag, Tooltip } from "antd";
import type { DdtSrTag, DdtSrTagMembers } from "@autoforge/contracts";
import { ddtSrTagLookupSchema, ddtSrTagMembersSchema } from "@autoforge/contracts";
import { requestDdtJson } from "@/lib/ddt-client";
import { collectSuiteSrTagMembers } from "@/lib/suite-sr-tag-selection";
import { DdtSrTagPicker } from "./ddt-sr-tag-picker";
import { Button } from "./ui/button";
import { Notice } from "./ui/notice";

export function SrTagBadges({ tags }: { tags: DdtSrTag[] }) {
  if (!tags.length) return null;
  return (
    <span className="inline-flex min-w-0 shrink-0 items-center gap-1" aria-label="SR 标签">
      {tags.slice(0, 2).map((tag) => (
        <Tooltip key={tag.id} title={tag.name}>
          <Tag className="!m-0 max-w-28 truncate">{tag.name}</Tag>
        </Tooltip>
      ))}
      {tags.length > 2 ? (
        <Tooltip
          title={tags
            .slice(2)
            .map((tag) => tag.name)
            .join("、")}
        >
          <Tag className="!m-0">+{tags.length - 2}</Tag>
        </Tooltip>
      ) : null}
    </span>
  );
}
export function useSuiteSrTags(suiteId: string, srNums: string[], revision: number) {
  const [snapshot, setSnapshot] = useState<{
    key: string;
    tags: Record<string, DdtSrTag[]>;
    error: string;
  }>({ key: "", tags: {}, error: "" });
  const [retry, setRetry] = useState(0);
  const key = JSON.stringify(srNums);
  const requestKey = JSON.stringify([suiteId, revision, key, retry]);
  useEffect(() => {
    const names = JSON.parse(key) as string[];
    if (!names.length) return;
    const controller = new AbortController();
    async function load() {
      try {
        for (let index = 0; index < names.length;) {
          const parameters = new URLSearchParams({ view: "lookup" });
          // Long multilingual SR names must stay below the HTTP request-line limit.
          for (let count = 0; index < names.length && count < 40; count++) {
            const candidate = new URLSearchParams(parameters);
            candidate.append("srNum", names[index]!);
            if (count > 0 && candidate.toString().length > 6000) break;
            parameters.append("srNum", names[index++]!);
          }
          const result = await requestDdtJson<Record<string, DdtSrTag[]>>(
            `/api/v1/case-suites/${encodeURIComponent(suiteId)}/sr-tags?${parameters}`,
            { cache: "reload", signal: controller.signal },
          );
          if (controller.signal.aborted) return;
          const page = ddtSrTagLookupSchema.parse(result);
          setSnapshot((current) => ({
            key: requestKey,
            tags: current.key === requestKey ? { ...current.tags, ...page } : page,
            error: "",
          }));
        }
      } catch (cause) {
        if (!controller.signal.aborted)
          setSnapshot((current) => ({
            key: requestKey,
            tags: current.key === requestKey ? current.tags : {},
            error: cause instanceof Error ? cause.message : "无法读取 SR 标签。",
          }));
      }
    }
    void load();
    return () => controller.abort();
  }, [suiteId, key, requestKey]);
  return {
    tags: snapshot.key === requestKey ? snapshot.tags : {},
    error: snapshot.key === requestKey ? snapshot.error : "",
    retry: () => setRetry((value) => value + 1),
  };
}
export function SuiteSrTagSelection({
  suiteId,
  revision,
  disabled,
  onBusyChange,
  onSelect,
}: {
  suiteId: string;
  revision: number;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onSelect: (members: DdtSrTagMembers["items"]) => void;
}) {
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [progress, setProgress] = useState<number>();
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const request = useRef<AbortController | null>(null);
  const url = `/api/v1/case-suites/${encodeURIComponent(suiteId)}/sr-tags`;
  useEffect(() => () => request.current?.abort(), []);
  async function select(match: "include" | "exclude") {
    const controller = new AbortController();
    request.current = controller;
    setProgress(0);
    setError("");
    setResult("");
    onBusyChange(true);
    try {
      const members = await collectSuiteSrTagMembers(
        async (cursor) => {
          const parameters = new URLSearchParams({
            view: "members",
            revision: String(revision),
            match,
          });
          for (const id of tagIds) parameters.append("tagId", id);
          if (cursor) parameters.set("cursor", cursor);
          return ddtSrTagMembersSchema.parse(
            await requestDdtJson<DdtSrTagMembers>(`${url}?${parameters}`, {
              cache: "reload",
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
            }),
          );
        },
        controller.signal,
        setProgress,
      );
      controller.signal.throwIfAborted();
      onSelect(members);
      setResult(`已选择 ${members.length} 个 DDT 用例`);
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : "按标签选择失败，请重试。");
    } finally {
      if (request.current === controller) {
        request.current = null;
        setProgress(undefined);
        onBusyChange(false);
      }
    }
  }
  const busy = progress !== undefined;
  return (
    <div className="grid gap-2 border-b border-border p-3" aria-label="按 SR 标签选择任务用例">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">按 SR 标签选择</span>
        <div className="min-w-56 flex-1">
          <DdtSrTagPicker
            url={url}
            value={tagIds}
            disabled={disabled || busy}
            onChange={setTagIds}
          />
        </div>
        <Button
          type="button"
          variant="secondary"
          disabled={!tagIds.length || disabled || busy}
          onClick={() => void select("include")}
        >
          选择带标签的用例
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={!tagIds.length || disabled || busy}
          onClick={() => void select("exclude")}
        >
          选择不带标签的用例
        </Button>
        {busy ? (
          <Button type="button" variant="ghost" onClick={() => request.current?.abort()}>
            取消选择
          </Button>
        ) : null}
      </div>
      <small className="text-muted-foreground" role="status">
        {busy
          ? `正在读取：${progress} 个用例…`
          : result || "多标签按任一匹配；不带标签包含未打标签的 SR。仅替换本任务 DDT 用例的勾选。"}
      </small>
      {error ? (
        <Notice tone="error" role="alert">
          {error}
        </Notice>
      ) : null}
    </div>
  );
}
