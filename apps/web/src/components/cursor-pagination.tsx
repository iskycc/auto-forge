"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Button } from "./ui";

export function CursorPagination({
  nextCursor,
  count,
  label = "列表分页",
  cursorKey = "cursor",
}: {
  nextCursor?: string | undefined;
  count: number;
  label?: string;
  cursorKey?: string;
}) {
  const pathname = usePathname();
  const current = useSearchParams();
  const trailKey = `${cursorKey}Trail`;
  const pageKey = `${cursorKey}Page`;
  const page = Math.max(1, Number.parseInt(current.get(pageKey) ?? "1", 10) || 1);
  let trail: string[] = [];
  try {
    const parsed: unknown = JSON.parse(current.get(trailKey) ?? "[]");
    if (Array.isArray(parsed))
      trail = parsed
        .filter((item): item is string => typeof item === "string" && item.length <= 512)
        .slice(-5);
  } catch {
    /* Invalid history affects navigation only; start at the current window. */
  }
  function destination(next: boolean): string {
    const parameters = new URLSearchParams(current.toString());
    const cursor = next ? nextCursor : trail.at(-1);
    const history = next ? [...trail, current.get(cursorKey) ?? ""] : trail.slice(0, -1);
    if (cursor) parameters.set(cursorKey, cursor);
    else parameters.delete(cursorKey);
    parameters.set(pageKey, String(next ? page + 1 : Math.max(1, page - 1)));
    if (history.length) parameters.set(trailKey, JSON.stringify(history.slice(-5)));
    else parameters.delete(trailKey);
    return `${pathname}?${parameters}`;
  }
  return (
    <nav className="management-pagination" aria-label={label}>
      <span>
        第 {page} 页 · 本页 {count} 条
      </span>
      <div>
        {page > 1 ? (
          <Link
            className="button button-secondary"
            href={(() => {
              const parameters = new URLSearchParams(current.toString());
              for (const key of [cursorKey, trailKey, pageKey]) parameters.delete(key);
              return `${pathname}?${parameters}`;
            })()}
          >
            第一页
          </Link>
        ) : null}
        {trail.length ? (
          <Link className="button button-secondary" href={destination(false)}>
            上一页
          </Link>
        ) : (
          <Button disabled type="button">
            上一页
          </Button>
        )}
        {nextCursor ? (
          <Link className="button button-secondary" href={destination(true)}>
            下一页
          </Link>
        ) : (
          <Button disabled type="button">
            下一页
          </Button>
        )}
      </div>
    </nav>
  );
}
