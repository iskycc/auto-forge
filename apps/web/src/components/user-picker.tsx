"use client";
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
    <div className="user-picker settings-wide-field">
      <div className="management-toolbar">
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
      <p className="settings-note">
        {multiple ? `已选 ${selected.length} 人，最多 50 人。` : "请选择一位用户。"}
        点击查询获取候选，不受主页面筛选影响。
      </p>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {selected.map((user) => (
        <span className="permission-chip" key={user.id}>
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
        </span>
      ))}
      <div className="user-picker-results">
        {items.map((user) => (
          <label key={user.id} className="ui-checkbox-option">
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
          <p className="settings-note">尚无候选结果，请点击查询或调整关键词。</p>
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
