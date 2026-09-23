"use client";
import { Badge } from "@/components/ui/badge";

import { Notice } from "@/components/ui/notice";

import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import { useEffect, useRef, useState } from "react";
import { Button, Input } from "./ui";
import { readApiErrorMessage } from "@/lib/client-api";

export type UserChoice = {
  id: string;
  username: string;
  displayName: string;
  status: string;
  source: string;
};
export function UserPicker({
  name = "userId",
  purpose,
  projectId,
  multiple = false,
}: {
  name?: string;
  purpose: "project-member" | "project-owner" | "system-role" | "password";
  projectId?: string;
  multiple?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [items, setItems] = useState<UserChoice[]>([]);
  const [selected, setSelected] = useState<UserChoice[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function search(nextCursor?: string) {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setPending(true);
    setError("");
    try {
      const parameters = new URLSearchParams({
        purpose,
        query: nextCursor ? submittedQuery : query,
        limit: "25",
      });
      if (projectId) parameters.set("projectId", projectId);
      if (nextCursor) parameters.set("cursor", nextCursor);
      const response = await fetch(`/api/v1/user-candidates?${parameters}`, {
        signal: request.signal,
      });
      if (!response.ok)
        throw new Error(
          (await readApiErrorMessage(response, "读取候选用户失败。")) ?? "读取失败。",
        );
      const result = (await response.json()) as { items: UserChoice[]; nextCursor?: string };
      setItems(result.items);
      if (!nextCursor) setSubmittedQuery(query);
      setCursor(result.nextCursor);
    } catch (cause) {
      if (!request.signal.aborted)
        setError(cause instanceof Error ? cause.message : "读取用户失败。");
    } finally {
      if (controller.current === request) setPending(false);
    }
  }
  return (
    <div
      className={cn(
        "user-picker settings-wide-field",
        userPickerStyles["user-picker"],
        uiPatterns["settings-wide-field"],
      )}
    >
      <div className={cn("management-toolbar", uiPatterns["management-toolbar"])}>
        <label>
          查找用户
          <Input
            value={query}
            placeholder="姓名或账号；留空查看可选用户"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void search();
              }
            }}
          />
        </label>
        <Button disabled={pending} onClick={() => void search()} type="button">
          {pending ? "查询中…" : "查询用户"}
        </Button>
      </div>
      <p className={cn("settings-note", uiPatterns["settings-note"])}>
        {multiple ? `已选 ${selected.length} 人，最多 50 人。` : "请选择一位用户。"}
        点击查询获取候选，不受主页面筛选影响。
      </p>
      {error ? (
        <Notice tone="error" className={cn("form-error", uiPatterns["form-error"])} role="alert">
          {error}
        </Notice>
      ) : null}
      {selected.map((user) => (
        <Badge className={cn("permission-chip", uiPatterns["permission-chip"])} key={user.id}>
          <input name={name} type="hidden" value={user.id} />
          {user.displayName}
          <Button
            aria-label={`取消选择 ${user.displayName}`}
            onClick={() => setSelected((current) => current.filter((item) => item.id !== user.id))}
            size="compact"
            type="button"
          >
            ×
          </Button>
        </Badge>
      ))}
      <div className={cn("user-picker-results", userPickerStyles["user-picker-results"])}>
        {items.map((user) => (
          <label
            key={user.id}
            className={cn("ui-checkbox-option", userPickerStyles["ui-checkbox-option"])}
          >
            <Input
              type={multiple ? "checkbox" : "radio"}
              checked={selected.some((item) => item.id === user.id)}
              disabled={
                user.status !== "active" ||
                (multiple && selected.length >= 50 && !selected.some((item) => item.id === user.id))
              }
              onChange={(event) =>
                setSelected((current) =>
                  event.target.checked
                    ? multiple
                      ? [...current, user]
                      : [user]
                    : current.filter((item) => item.id !== user.id),
                )
              }
            />
            <span>
              <strong>{user.displayName}</strong>
              <small>
                {user.username} · {user.status === "active" ? "启用" : "禁用"}
              </small>
            </span>
          </label>
        ))}
        {!pending && !items.length ? (
          <p className={cn("settings-note", uiPatterns["settings-note"])}>
            尚无候选结果，请点击查询或调整关键词。
          </p>
        ) : null}
      </div>
      {cursor ? (
        <Button disabled={pending} onClick={() => void search(cursor)} type="button">
          下一页候选
        </Button>
      ) : null}
    </div>
  );
}

const userPickerStyles = {
  "ui-checkbox-option":
    "min-w-0 [overflow-wrap:anywhere] grid! grid-cols-[18px_minmax(0,_1fr)] items-start gap-[9px]! rounded-md p-2 cursor-pointer [&:hover]:bg-muted [&_>_.ui-input]:w-4.5! [&_>_.ui-input]:mt-px [&_>_span]:grid [&_>_span]:min-w-0 [&_>_span]:gap-0.5 [&_strong]:text-foreground [&_strong]:text-xs [&_small]:text-muted-foreground [&_small]:text-xs [&_small]:font-medium [&_small]:leading-[1.4]",
  "user-picker":
    "min-w-0 [&_.permission-chip]:inline-flex [&_.permission-chip]:max-w-full [&_.permission-chip]:[overflow-wrap:anywhere] [&_.permission-chip]:gap-2 [&_.permission-chip]:items-center [&_.permission-chip]:m-1",
  "user-picker-results":
    "grid grid-cols-2 gap-2 max-h-[300px] overflow-auto max-[1201px]:grid-cols-[minmax(0,_1fr)]",
} as const;
