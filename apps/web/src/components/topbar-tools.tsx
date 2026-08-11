"use client";

import { Button, Input } from "@/components/ui";

import type { GlobalSearchResult, Notification } from "@autoforge/contracts";
import { Bell, Check, Search, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

export function TopbarTools() {
  const [query, setQuery] = useState("");
  const [searchItems, setSearchItems] = useState<GlobalSearchResult["items"]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [error, setError] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  const searchResults = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function focusSearch(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase("en-US") === "k") {
        event.preventDefault();
        searchInput.current?.focus();
      }
      if (event.key === "Escape") {
        setSearchOpen(false);
        setNotificationsOpen(false);
      }
    }
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  useEffect(() => {
    if (query.trim().length < 2) {
      return;
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      void requestJson<GlobalSearchResult>(
        `/api/v1/search?query=${encodeURIComponent(query.trim())}&limit=20`,
        { signal: controller.signal },
      )
        .then((result) => {
          setSearchItems(result.items);
          setSearchOpen(true);
          setError("");
        })
        .catch((problem: unknown) => {
          if (problem instanceof DOMException && problem.name === "AbortError") return;
          setError(problem instanceof Error ? problem.message : "搜索失败。");
        });
    }, 180);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [query]);

  function updateQuery(value: string) {
    setQuery(value);
    if (value.trim().length < 2) setSearchOpen(false);
  }

  async function openNotifications() {
    const nextOpen = !notificationsOpen;
    setNotificationsOpen(nextOpen);
    setSearchOpen(false);
    if (!nextOpen) return;
    try {
      const page = await requestJson<{ items: Notification[] }>(
        "/api/v1/notifications?unreadOnly=false&limit=30",
      );
      setNotifications(page.items);
      setError("");
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "读取通知失败。");
    }
  }

  async function markRead(notification: Notification) {
    if (notification.readAt) return;
    await requestJson(`/api/v1/notifications/${encodeURIComponent(notification.id)}/read`, {
      method: "POST",
    });
    setNotifications((current) =>
      current.map((item) =>
        item.id === notification.id ? { ...item, readAt: new Date().toISOString() } : item,
      ),
    );
  }

  const unreadCount = notifications.filter((notification) => !notification.readAt).length;
  return (
    <div className="topbar-tools">
      <div className="global-search-shell">
        <div className="global-search" role="search">
          <Search size={17} aria-hidden="true" />
          <Input
            aria-label="全局搜索"
            onChange={(event) => updateQuery(event.target.value)}
            onFocus={() => query.trim().length >= 2 && setSearchOpen(true)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowDown") return;
              const firstResult = searchResults.current?.querySelector<HTMLAnchorElement>("a");
              if (!firstResult) return;
              event.preventDefault();
              firstResult.focus();
            }}
            placeholder="搜索用例、任务、执行、Runner…"
            ref={searchInput}
            type="search"
            value={query}
          />
          <kbd>⌘ K</kbd>
        </div>
        {searchOpen ? (
          <div
            aria-label="搜索结果"
            className="topbar-popover search-results"
            ref={searchResults}
            role="listbox"
          >
            <div className="popover-heading">
              <strong>全局搜索</strong>
              <Button aria-label="关闭搜索结果" onClick={() => setSearchOpen(false)} type="button">
                <X size={15} />
              </Button>
            </div>
            {searchItems.length === 0 ? (
              <p className="popover-empty">没有匹配的可访问资源。</p>
            ) : (
              searchItems.map((item) => (
                <Link
                  href={item.href}
                  key={`${item.kind}:${item.id}`}
                  onClick={() => setSearchOpen(false)}
                  onKeyDown={(event) => moveSearchFocus(event, searchResults.current)}
                  role="option"
                >
                  <span className="search-result-kind">{kindLabel(item.kind)}</span>
                  <span>
                    <strong>{item.title}</strong>
                    <small>{item.subtitle}</small>
                  </span>
                </Link>
              ))
            )}
          </div>
        ) : null}
      </div>
      <div className="notification-shell">
        <Button
          aria-expanded={notificationsOpen}
          aria-label={unreadCount > 0 ? `${unreadCount} 条未读通知` : "通知"}
          className="icon-button"
          onClick={() => void openNotifications()}
          type="button"
        >
          <Bell size={19} />
          {unreadCount > 0 ? <span className="notification-count">{unreadCount}</span> : null}
        </Button>
        {notificationsOpen ? (
          <div className="topbar-popover notification-panel">
            <div className="popover-heading">
              <strong>通知中心</strong>
              <Button
                aria-label="关闭通知"
                onClick={() => setNotificationsOpen(false)}
                type="button"
              >
                <X size={15} />
              </Button>
            </div>
            {notifications.length === 0 ? (
              <p className="popover-empty">暂时没有站内通知。</p>
            ) : (
              notifications.map((notification) => (
                <Button
                  className={notification.readAt ? "notification-item read" : "notification-item"}
                  key={notification.id}
                  onClick={() => void markRead(notification)}
                  type="button"
                >
                  <span className={`notification-severity ${notification.severity}`} />
                  <span>
                    <strong>{notification.title}</strong>
                    <small>{notification.message}</small>
                    <time>{formatDate(notification.createdAt)}</time>
                  </span>
                  {notification.readAt ? <Check size={14} aria-label="已读" /> : null}
                </Button>
              ))
            )}
          </div>
        ) : null}
      </div>
      {error ? (
        <span className="topbar-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

function moveSearchFocus(
  event: ReactKeyboardEvent<HTMLAnchorElement>,
  container: HTMLDivElement | null,
): void {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const options = [...(container?.querySelectorAll<HTMLAnchorElement>("a") ?? [])];
  const currentIndex = options.indexOf(event.currentTarget);
  if (currentIndex < 0) return;
  const offset = event.key === "ArrowDown" ? 1 : -1;
  const next = options[(currentIndex + offset + options.length) % options.length];
  if (!next) return;
  event.preventDefault();
  next.focus();
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: "no-store", ...init });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? "请求失败。");
  }
  return (await response.json()) as T;
}

function kindLabel(kind: GlobalSearchResult["items"][number]["kind"]): string {
  return { case: "用例", suite: "任务", batch: "批次", run: "执行", runner: "Runner" }[kind];
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
