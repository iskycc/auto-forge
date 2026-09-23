"use client";
import { cn } from "@/lib/utils";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";

const MINIMUM_THUMB_HEIGHT = 40;
const KEYBOARD_SCROLL_STEP = 48;

type ScrollMetrics = {
  scrollable: boolean;
  scrollTop: number;
  maximumScrollTop: number;
  thumbHeight: number;
  thumbTop: number;
};

const EMPTY_METRICS: ScrollMetrics = {
  scrollable: false,
  scrollTop: 0,
  maximumScrollTop: 0,
  thumbHeight: 0,
  thumbTop: 0,
};

export function CustomScrollArea({
  ariaLabel,
  children,
  className,
  viewportClassName,
}: {
  ariaLabel: string;
  children: ReactNode;
  className?: string;
  viewportClassName?: string;
}) {
  const viewportId = useId();
  const viewportRef = useRef<HTMLDivElement>(null);
  const scrollbarRef = useRef<HTMLDivElement>(null);
  const animationFrame = useRef<number | undefined>(undefined);
  const drag = useRef<{ pointerId: number; startY: number; startScrollTop: number } | undefined>(
    undefined,
  );
  const [metrics, setMetrics] = useState(EMPTY_METRICS);

  const measure = useCallback(() => {
    const viewport = viewportRef.current;
    const scrollbar = scrollbarRef.current;
    if (!viewport || !scrollbar) return;
    const next = calculateScrollMetrics({
      clientHeight: viewport.clientHeight,
      scrollHeight: viewport.scrollHeight,
      scrollTop: viewport.scrollTop,
      trackHeight: scrollbar.clientHeight,
    });
    setMetrics((current) => (sameMetrics(current, next) ? current : next));
  }, []);

  const scheduleMeasurement = useCallback(() => {
    if (animationFrame.current !== undefined) return;
    animationFrame.current = window.requestAnimationFrame(() => {
      animationFrame.current = undefined;
      measure();
    });
  }, [measure]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const resizeObserver = new ResizeObserver(scheduleMeasurement);
    const mutationObserver = new MutationObserver(scheduleMeasurement);
    resizeObserver.observe(viewport);
    mutationObserver.observe(viewport, { childList: true, characterData: true, subtree: true });
    scheduleMeasurement();
    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      if (animationFrame.current !== undefined) {
        window.cancelAnimationFrame(animationFrame.current);
        animationFrame.current = undefined;
      }
    };
  }, [scheduleMeasurement]);

  function scrollTo(nextScrollTop: number): void {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollTop = Math.max(0, Math.min(metrics.maximumScrollTop, nextScrollTop));
    scheduleMeasurement();
  }

  function moveFromScrollbar(event: PointerEvent<HTMLDivElement>): void {
    if (!metrics.scrollable || event.target !== event.currentTarget) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const thumbTravel = Math.max(1, bounds.height - metrics.thumbHeight);
    const targetThumbTop = event.clientY - bounds.top - metrics.thumbHeight / 2;
    scrollTo(
      (Math.max(0, Math.min(thumbTravel, targetThumbTop)) / thumbTravel) * metrics.maximumScrollTop,
    );
  }

  function startThumbDrag(event: PointerEvent<HTMLSpanElement>): void {
    if (!metrics.scrollable) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startScrollTop: metrics.scrollTop,
    };
  }

  function dragThumb(event: PointerEvent<HTMLSpanElement>): void {
    const activeDrag = drag.current;
    const scrollbar = scrollbarRef.current;
    if (!activeDrag || activeDrag.pointerId !== event.pointerId || !scrollbar) return;
    const thumbTravel = Math.max(1, scrollbar.clientHeight - metrics.thumbHeight);
    const scrollDelta =
      ((event.clientY - activeDrag.startY) / thumbTravel) * metrics.maximumScrollTop;
    scrollTo(activeDrag.startScrollTop + scrollDelta);
  }

  function endThumbDrag(event: PointerEvent<HTMLSpanElement>): void {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function scrollWithKeyboard(event: KeyboardEvent<HTMLDivElement>): void {
    const viewport = viewportRef.current;
    if (!viewport || !metrics.scrollable) return;
    const pageStep = Math.max(KEYBOARD_SCROLL_STEP, viewport.clientHeight * 0.8);
    const nextScrollTop = {
      ArrowDown: metrics.scrollTop + KEYBOARD_SCROLL_STEP,
      ArrowUp: metrics.scrollTop - KEYBOARD_SCROLL_STEP,
      PageDown: metrics.scrollTop + pageStep,
      PageUp: metrics.scrollTop - pageStep,
      Home: 0,
      End: metrics.maximumScrollTop,
    }[event.key];
    if (nextScrollTop === undefined) return;
    event.preventDefault();
    scrollTo(nextScrollTop);
  }

  return (
    <div
      className={[cn("custom-scroll-area", customScrollAreaStyles["custom-scroll-area"]), className]
        .filter(Boolean)
        .join(" ")}
      data-scrollable={metrics.scrollable ? "true" : "false"}
    >
      <div
        aria-label={ariaLabel}
        className={[
          cn("custom-scroll-viewport", customScrollAreaStyles["custom-scroll-viewport"]),
          viewportClassName,
        ]
          .filter(Boolean)
          .join(" ")}
        id={viewportId}
        onScroll={scheduleMeasurement}
        ref={viewportRef}
        role="region"
        tabIndex={0}
      >
        {children}
      </div>
      <div
        aria-hidden={metrics.scrollable ? undefined : true}
        aria-controls={viewportId}
        aria-label={`${ariaLabel}滚动条`}
        aria-orientation="vertical"
        aria-valuemax={metrics.maximumScrollTop}
        aria-valuemin={0}
        aria-valuenow={metrics.scrollTop}
        className={cn("custom-scrollbar", customScrollAreaStyles["custom-scrollbar"])}
        data-visible={metrics.scrollable ? "true" : "false"}
        onKeyDown={scrollWithKeyboard}
        onPointerDown={moveFromScrollbar}
        ref={scrollbarRef}
        role="scrollbar"
        tabIndex={metrics.scrollable ? 0 : -1}
      >
        <span
          className={cn("custom-scrollbar-thumb", customScrollAreaStyles["custom-scrollbar-thumb"])}
          onPointerCancel={endThumbDrag}
          onPointerDown={startThumbDrag}
          onPointerMove={dragThumb}
          onPointerUp={endThumbDrag}
          style={{ height: metrics.thumbHeight, transform: `translateY(${metrics.thumbTop}px)` }}
        />
      </div>
    </div>
  );
}

export function calculateScrollMetrics(input: {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
  trackHeight: number;
}): ScrollMetrics {
  const maximumScrollTop = Math.max(0, input.scrollHeight - input.clientHeight);
  if (maximumScrollTop === 0 || input.trackHeight <= 0) return EMPTY_METRICS;
  const thumbHeight = Math.min(
    input.trackHeight,
    Math.max(MINIMUM_THUMB_HEIGHT, (input.clientHeight / input.scrollHeight) * input.trackHeight),
  );
  const thumbTravel = Math.max(0, input.trackHeight - thumbHeight);
  const scrollTop = Math.max(0, Math.min(maximumScrollTop, input.scrollTop));
  return {
    scrollable: true,
    scrollTop,
    maximumScrollTop,
    thumbHeight,
    thumbTop: maximumScrollTop > 0 ? (scrollTop / maximumScrollTop) * thumbTravel : 0,
  };
}

function sameMetrics(left: ScrollMetrics, right: ScrollMetrics): boolean {
  return (
    left.scrollable === right.scrollable &&
    Math.abs(left.scrollTop - right.scrollTop) < 0.5 &&
    Math.abs(left.maximumScrollTop - right.maximumScrollTop) < 0.5 &&
    Math.abs(left.thumbHeight - right.thumbHeight) < 0.5 &&
    Math.abs(left.thumbTop - right.thumbTop) < 0.5
  );
}

const customScrollAreaStyles = {
  "custom-scroll-area": "relative min-w-0 min-h-0 overflow-hidden",
  "custom-scroll-viewport":
    "w-full h-full min-w-0 min-h-0 overflow-x-hidden overflow-y-scroll [overscroll-behavior:contain] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&::-webkit-scrollbar]:w-0 [&::-webkit-scrollbar]:h-0 [&:focus-visible]:[outline:2px_solid_var(--info)] [&:focus-visible]:[outline-offset:-2px]",
  "custom-scrollbar":
    'absolute z-3 top-2 right-1 bottom-2 w-2.5 rounded-full [background:color-mix(in_srgb,_var(--muted-foreground)_18%,_transparent)] cursor-pointer [touch-action:none] [&[data-visible="false"]]:invisible [&[data-visible="false"]]:opacity-0 [&[data-visible="false"]]:pointer-events-none [&:focus-visible]:[outline:2px_solid_var(--info)] [&:focus-visible]:[outline-offset:1px] [&:hover_.custom-scrollbar-thumb]:bg-foreground [&:focus-visible_.custom-scrollbar-thumb]:bg-foreground',
  "custom-scrollbar-thumb":
    "absolute top-0 right-0.5 block w-1.5 min-h-10 rounded-full bg-muted-foreground cursor-grab transition-colors duration-150 motion-reduce:transition-none [&:active]:cursor-grabbing",
} as const;
