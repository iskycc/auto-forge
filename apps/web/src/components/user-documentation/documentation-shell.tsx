"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { ArrowLeftOutlined, ReadOutlined, SearchOutlined } from "@ant-design/icons";
import { Button, Empty, Input, Menu, Typography } from "antd";
import { ColorModeToggle } from "@/components/color-mode-toggle";
import {
  documentationGroups,
  documentationHref,
  documentationSearchQuery,
  searchDocumentation,
  type DocumentationSummary,
} from "@/lib/user-documentation/model";

export function DocumentationShell({
  summaries,
  children,
}: {
  summaries: readonly DocumentationSummary[];
  children: ReactNode;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const query = documentationSearchQuery(searchParams.get("q") ?? "");
  const matches = searchDocumentation(summaries, query);
  function changeSearch(next: string) {
    const url = new URL(window.location.href);
    const value = documentationSearchQuery(next);
    if (value) url.searchParams.set("q", value);
    else url.searchParams.delete("q");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }
  const querySuffix = query ? `?${new URLSearchParams({ q: query })}` : "";
  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-20 border-b border-border bg-card">
        <div className="mx-auto flex h-16 max-w-[1480px] items-center justify-between gap-4 px-4 xl:px-6">
          <Link
            href="/docs"
            prefetch={false}
            className="flex min-w-0 items-center gap-3 text-foreground"
            aria-label="AutoForge 使用文档首页"
          >
            <ReadOutlined className="text-xl text-primary-text" />
            <span className="font-semibold">AutoForge</span>
            <Typography.Text type="secondary">使用文档</Typography.Text>
          </Link>
          <div className="flex shrink-0 items-center gap-2">
            <ColorModeToggle />
            <Button href="/" icon={<ArrowLeftOutlined />}>
              返回平台
            </Button>
          </div>
        </div>
      </header>
      <div className="mx-auto grid max-w-[1480px] grid-cols-[212px_minmax(0,1fr)] items-start gap-5 px-4 py-6 xl:grid-cols-[232px_minmax(0,1fr)] xl:gap-7 xl:px-6">
        <aside
          className="sticky top-[88px] grid max-h-[calc(100dvh-112px)] min-w-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-3"
          aria-label="文档导航"
        >
          <Input
            aria-label="搜索使用文档"
            placeholder="搜索功能或关键词"
            prefix={<SearchOutlined />}
            allowClear
            value={query}
            maxLength={80}
            onChange={(event) => changeSearch(event.target.value)}
          />
          <nav className="min-h-0 overflow-y-auto overscroll-contain">
            {matches.length ? (
              <Menu
                mode="inline"
                className="rounded-lg border-0 bg-transparent"
                selectedKeys={[pathname]}
                items={[
                  ...(!query
                    ? [
                        {
                          key: "/docs",
                          icon: <ReadOutlined />,
                          label: (
                            <Link href="/docs" prefetch={false}>
                              文档首页
                            </Link>
                          ),
                        },
                      ]
                    : []),
                  ...documentationGroups
                    .filter((group) => matches.some((entry) => entry.group === group))
                    .map((group) => ({
                      type: "group" as const,
                      key: group,
                      label: group,
                      children: matches
                        .filter((entry) => entry.group === group)
                        .map((entry) => ({
                          key: documentationHref(entry.topic),
                          label: (
                            <Link
                              href={`${documentationHref(entry.topic)}${querySuffix}`}
                              prefetch={false}
                            >
                              {entry.label}
                            </Link>
                          ),
                        })),
                    })),
                ]}
              />
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="未找到相关说明" />
            )}
          </nav>
          <div className="border-t border-border px-3 pt-3">
            <Typography.Text type="secondary">可匿名阅读 · 随平台离线提供</Typography.Text>
          </div>
        </aside>
        <main className="min-w-0" id="documentation-content">
          {children}
        </main>
      </div>
    </div>
  );
}
