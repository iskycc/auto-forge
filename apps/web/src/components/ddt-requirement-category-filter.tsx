"use client";

import { Select } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DdtRequirementCategoryPage } from "@autoforge/domain";
import { requestDdtJson } from "@/lib/ddt-client";
import { Button } from "./ui/button";
import { Notice } from "./ui/notice";

type CategoryOption = { value: string; label: string };

export function DdtRequirementCategoryFilter({
  url,
  value,
  disabled,
  onChange,
}: {
  url: string;
  value: string[];
  disabled: boolean;
  onChange(ids: string[]): void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<CategoryOption[]>([]);
  const [selectedOptions, setSelectedOptions] = useState<CategoryOption[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const request = useRef<AbortController | null>(null);
  const selectedKey = JSON.stringify(value);
  const selectedIds = useMemo(() => JSON.parse(selectedKey) as string[], [selectedKey]);

  useEffect(() => {
    if (!selectedIds.length) return;
    const controller = new AbortController();
    const parameters = new URL(url, window.location.origin);
    parameters.searchParams.set("limit", "100");
    for (const id of selectedIds) parameters.searchParams.append("categoryId", id);
    void requestDdtJson<DdtRequirementCategoryPage>(parameters.toString(), {
      cache: "reload",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
    })
      .then((page) => {
        if (!controller.signal.aborted) {
          setSelectedOptions(page.items.map((item) => ({ value: item.id, label: item.name })));
          setError("");
        }
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted)
          setError(failure instanceof Error ? failure.message : "无法读取已选分类，请重试。");
      });
    return () => controller.abort();
  }, [url, selectedIds, retry]);

  const load = useCallback(
    async (cursor?: string) => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setBusy(true);
      setError("");
      const parameters = new URL(url, window.location.origin);
      parameters.searchParams.set("query", query);
      parameters.searchParams.set("limit", "50");
      if (cursor) parameters.searchParams.set("cursor", cursor);
      try {
        const page = await requestDdtJson<DdtRequirementCategoryPage>(parameters.toString(), {
          cache: "reload",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
        });
        if (controller.signal.aborted) return;
        const next = page.items.map((item) => ({ value: item.id, label: item.name }));
        setOptions((previous) => (cursor ? [...previous, ...next] : next));
        setNextCursor(page.nextCursor);
      } catch (failure) {
        if (!controller.signal.aborted)
          setError(failure instanceof Error ? failure.message : "无法读取需求分类，请重试。");
      } finally {
        if (request.current === controller) {
          request.current = null;
          setBusy(false);
        }
      }
    },
    [url, query],
  );

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => void load(), 250);
    return () => {
      window.clearTimeout(timer);
      request.current?.abort();
    };
  }, [load, open, retry]);

  const choices = new Map([...selectedOptions, ...options].map((option) => [option.value, option]));
  return (
    <div className="grid min-w-0 gap-1">
      <Select
        aria-label="DDT 需求分类"
        className="w-full min-w-0"
        mode="multiple"
        maxCount={100}
        maxTagCount="responsive"
        placeholder="全部需求分类，可多选"
        allowClear
        disabled={disabled}
        loading={busy}
        open={open}
        onOpenChange={setOpen}
        showSearch={{ filterOption: false, onSearch: setQuery }}
        options={[...choices.values()]}
        value={value.map((id) => ({ value: id, label: choices.get(id)?.label ?? "已选分类" }))}
        labelInValue
        onChange={(selected: CategoryOption[]) => {
          setSelectedOptions(selected);
          onChange(selected.map((option) => option.value));
        }}
        popupRender={(menu) => (
          <>
            {menu}
            {nextCursor ? (
              <div className="border-t border-border p-2">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void load(nextCursor)}
                >
                  加载更多分类
                </Button>
              </div>
            ) : null}
          </>
        )}
      />
      {error ? (
        <Notice tone="error" role="alert">
          {error}
          <Button type="button" variant="link" onClick={() => setRetry((count) => count + 1)}>
            重试
          </Button>
        </Notice>
      ) : null}
    </div>
  );
}
