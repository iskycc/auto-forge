"use client";

import { Pagination } from "antd";
import { DDT_VALUE_SEARCH_PAGE_SIZE } from "@autoforge/contracts";
import { Button } from "./ui";

export function DdtSearchPagination({
  totalCount,
  complete,
  page,
  disabled,
  onPageChange,
}: {
  totalCount: number;
  complete: boolean;
  page: number;
  disabled: boolean;
  onPageChange(page: number): void;
}) {
  const totalPages = Math.ceil(totalCount / DDT_VALUE_SEARCH_PAGE_SIZE);
  return (
    <nav
      className="ddt-search-pagination flex min-w-0 flex-wrap items-center justify-between gap-3"
      aria-label="检索结果分页"
    >
      <p>
        {complete ? "共" : "已匹配"} {totalCount} 条 · {complete ? "共" : "当前"} {totalPages} 页
        {totalPages ? ` · 第 ${page} 页` : ""} · 每页 {DDT_VALUE_SEARCH_PAGE_SIZE} 条
      </p>
      <Pagination
        current={page}
        total={totalCount}
        pageSize={DDT_VALUE_SEARCH_PAGE_SIZE}
        disabled={disabled}
        showSizeChanger={false}
        showLessItems
        onChange={onPageChange}
        className="[&_.ant-pagination-prev]:w-auto [&_.ant-pagination-next]:w-auto [&_.ant-pagination-item]:border-0"
        itemRender={(number, type, original) => {
          if (type === "prev")
            return (
              <Button size="compact" disabled={disabled || page <= 1}>
                上一页
              </Button>
            );
          if (type === "next")
            return (
              <Button size="compact" disabled={disabled || page >= totalPages}>
                下一页
              </Button>
            );
          if (type === "page")
            return (
              <Button
                size="compact"
                variant={number === page ? "primary" : "secondary"}
                aria-label={`第 ${number} 页`}
                aria-current={number === page ? "page" : undefined}
                disabled={disabled}
              >
                {number}
              </Button>
            );
          return original;
        }}
      />
    </nav>
  );
}
