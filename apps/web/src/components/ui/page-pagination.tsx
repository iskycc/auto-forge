"use client";

import { Pagination } from "antd";
import { useRouter } from "next/navigation";

/** Numbered navigation for lists with a known total; URL filters remain intact. */
export function PagePagination({
  current,
  total,
  pageSize,
  href,
  parameter = "page",
  label,
}: {
  current: number;
  total: number;
  pageSize: number;
  href: string;
  parameter?: string;
  label: string;
}) {
  const router = useRouter();
  return (
    <Pagination
      aria-label={label}
      current={current}
      total={total}
      pageSize={pageSize}
      showSizeChanger={false}
      showLessItems
      showTotal={(count, range) => `共 ${count} 条 · ${range[0]}–${range[1]}`}
      onChange={(page) => {
        const url = new URL(href, window.location.origin);
        url.searchParams.set(parameter, String(page));
        router.push(url.pathname + url.search);
      }}
    />
  );
}
