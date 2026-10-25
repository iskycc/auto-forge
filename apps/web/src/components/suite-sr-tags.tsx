"use client";
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { Tag, Tooltip } from "antd";
import type { DdtSrTag, DdtSrTagMembers } from "@autoforge/contracts";
import { ddtSrTagLookupSchema, ddtSrTagMembersSchema } from "@autoforge/contracts";
import { requestDdtJson } from "@/lib/ddt-client";
import { collectSuiteSrTagMembers } from "@/lib/suite-sr-tag-selection";
import { DdtSrTagPicker } from "./ddt-sr-tag-picker";
import { Button } from "./ui/button";
import { Notice } from "./ui/notice";

export function SrTagBadges({
  tags,
  disabled,
  onSelectTag,
}: {
  tags: DdtSrTag[];
  disabled?: boolean;
  onSelectTag?: ((tag: DdtSrTag) => void) | undefined;
}) {
  if (!tags.length) return null;
  return (
    <span className="inline-flex min-w-0 shrink-0 items-center gap-1" aria-label="SR 标签">
      {tags.slice(0, 2).map((tag) => (
        <Tooltip
          key={tag.id}
          title={onSelectTag ? `勾选本任务中带「${tag.name}」标签的全部 SR 及其用例` : tag.name}
        >
          {onSelectTag ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="min-w-0 max-w-28 !px-2 !text-xs"
              aria-label={`勾选带 ${tag.name} 标签的 SR`}
              disabled={disabled}
              onClick={(event) => {
                event.stopPropagation();
                onSelectTag(tag);
              }}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <span className="truncate">{tag.name}</span>
            </Button>
          ) : (
            <Tag className="!m-0 max-w-28 truncate">{tag.name}</Tag>
          )}
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
function useSuiteSrTagSelection({
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
  useEffect(() => () => request.current?.abort(), [suiteId, revision]);
  async function select(match: "include" | "exclude", selectedTags = tagIds) {
    if (disabled || request.current || selectedTags.length === 0) return;
    const controller = new AbortController();
    request.current = controller;
    setTagIds(selectedTags);
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
          for (const id of selectedTags) parameters.append("tagId", id);
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
      const srCount = new Set(members.map((member) => member.srNum)).size;
      setResult(`已勾选 ${srCount} 个 SR 分组，包含 ${members.length} 个 DDT 用例`);
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
  return {
    url,
    tagIds,
    setTagIds,
    progress,
    error,
    result,
    busy,
    select,
    cancel: () => request.current?.abort(),
  };
}

export function SuiteSrTagSelection({
  selectionRef,
  ...options
}: {
  selectionRef: Ref<SuiteSrTagSelectionActions>;
  suiteId: string;
  revision: number;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onSelect: (members: DdtSrTagMembers["items"]) => void;
}) {
  const { url, tagIds, setTagIds, busy, select, cancel, progress, error, result } =
    useSuiteSrTagSelection(options);
  const { disabled } = options;
  // Keep paged progress local to this toolbar instead of re-rendering the task tree per page.
  useImperativeHandle(selectionRef, () => ({
    selectTag: (tagId) => void select("include", [tagId]),
  }));
  return (
    <div className="grid gap-2 border-b border-border p-3" aria-label="按标签勾选任务 SR">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">按标签勾选 SR</span>
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
          勾选带标签的 SR
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={!tagIds.length || disabled || busy}
          onClick={() => void select("exclude")}
        >
          勾选不带标签的 SR
        </Button>
        {busy ? (
          <Button type="button" variant="ghost" onClick={cancel}>
            取消勾选
          </Button>
        ) : null}
      </div>
      <small className="text-muted-foreground" role="status">
        {busy
          ? `正在读取：${progress} 个用例…`
          : result ||
            "点击 SR 旁的标签可直接勾选同标签的全部 SR；包含未展开分组的任务内用例，多标签按任一匹配。仅替换 DDT 勾选。"}
      </small>
      {error ? (
        <Notice tone="error" role="alert">
          {error}
        </Notice>
      ) : null}
    </div>
  );
}

export type SuiteSrTagSelectionActions = {
  selectTag(tagId: string): void;
};
