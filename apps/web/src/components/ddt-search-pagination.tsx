"use client";

import { Fragment } from "react";
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
  const visiblePages = [...new Set([1, page - 1, page, page + 1, totalPages])]
    .filter((number) => number > 0 && number <= totalPages)
    .sort((left, right) => left - right);
  return (
    <nav className="ddt-search-pagination" aria-label="检索结果分页">
      <p>
        {complete ? "共" : "已匹配"} {totalCount} 条 · {complete ? "共" : "当前"} {totalPages} 页
        {totalPages ? ` · 第 ${page} 页` : ""} · 每页 {DDT_VALUE_SEARCH_PAGE_SIZE} 条
      </p>
      <div className="button-row">
        <Button disabled={disabled || page <= 1} onClick={() => onPageChange(page - 1)}>
          上一页
        </Button>
        {visiblePages.map((number, index) => (
          <Fragment key={number}>
            {index > 0 && number - visiblePages[index - 1]! > 1 ? (
              <span aria-hidden="true">…</span>
            ) : null}
            <Button
              size="compact"
              variant={number === page ? "primary" : "secondary"}
              aria-label={`第 ${number} 页`}
              aria-current={number === page ? "page" : undefined}
              disabled={disabled}
              onClick={() => onPageChange(number)}
            >
              {number}
            </Button>
          </Fragment>
        ))}
        <Button disabled={disabled || page >= totalPages} onClick={() => onPageChange(page + 1)}>
          下一页
        </Button>
      </div>
    </nav>
  );
}
