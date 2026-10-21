"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { DdtCaseSummary } from "@autoforge/domain";

const ROW_HEIGHT = 52;
const OVERSCAN_ROWS = 6;
const VIRTUALIZE_AFTER = 120;

/** Retain summary navigation and selection while mounting only the visible rows. */
export function DdtCaseNavigationWindow({
  cases,
  activeCaseId,
  refreshing,
  onOpen,
  renderRow,
  children,
}: {
  cases: DdtCaseSummary[];
  activeCaseId: string;
  refreshing: boolean;
  onOpen(caseId: string): void;
  renderRow(item: DdtCaseSummary): ReactNode;
  children: ReactNode;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 600 });
  const activeIndex = cases.findIndex((item) => item.caseId === activeCaseId);
  const virtual = cases.length > VIRTUALIZE_AFTER;
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(() =>
      setViewport((current) => ({ ...current, height: element.clientHeight })),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const element = container.current;
    if (!element || activeIndex < 0) return;
    const top = activeIndex * ROW_HEIGHT;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight)
      element.scrollTop = top + ROW_HEIGHT - element.clientHeight;
  }, [activeIndex]);
  const start = virtual ? Math.max(0, Math.floor(viewport.top / ROW_HEIGHT) - OVERSCAN_ROWS) : 0;
  const end = virtual
    ? Math.min(
        cases.length,
        Math.ceil((viewport.top + viewport.height) / ROW_HEIGHT) + OVERSCAN_ROWS,
      )
    : cases.length;
  return (
    <div
      ref={container}
      className="ddt-case-list min-h-0 flex-1 overflow-auto p-1"
      aria-busy={refreshing}
      onScroll={(event) =>
        setViewport({
          top: event.currentTarget.scrollTop,
          height: event.currentTarget.clientHeight,
        })
      }
      onKeyDown={(event) => {
        if (
          !(event.target instanceof HTMLButtonElement) ||
          !event.target.dataset.caseId ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey
        )
          return;
        const direction = ["ArrowDown", "j"].includes(event.key)
          ? 1
          : ["ArrowUp", "k"].includes(event.key)
            ? -1
            : 0;
        if (!direction) return;
        const index = cases.findIndex(
          (item) => item.caseId === (event.target as HTMLButtonElement).dataset.caseId,
        );
        const next = cases[index + direction];
        if (!next) return;
        event.preventDefault();
        const element = event.currentTarget;
        if (virtual) {
          const top = (index + direction) * ROW_HEIGHT;
          if (top < element.scrollTop) element.scrollTop = top;
          else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight)
            element.scrollTop = top + ROW_HEIGHT - element.clientHeight;
          setViewport({ top: element.scrollTop, height: element.clientHeight });
        }
        onOpen(next.caseId);
        requestAnimationFrame(() =>
          element
            .querySelector<HTMLButtonElement>(`button[data-case-id="${CSS.escape(next.caseId)}"]`)
            ?.focus(),
        );
      }}
    >
      {start > 0 ? <div aria-hidden="true" style={{ height: start * ROW_HEIGHT }} /> : null}
      {cases.slice(start, end).map(renderRow)}
      {end < cases.length ? (
        <div aria-hidden="true" style={{ height: (cases.length - end) * ROW_HEIGHT }} />
      ) : null}
      {children}
    </div>
  );
}
