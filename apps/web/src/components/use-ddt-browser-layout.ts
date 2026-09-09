"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";

const MINIMUM_LIST_WIDTH = 200;
const MAXIMUM_LIST_WIDTH = 440;
const DEFAULT_MINIMUM_LIST_WIDTH = 240;
const DEFAULT_LIST_RATIO = 0.26;
const MAXIMUM_LIST_RATIO = 0.4;
const MINIMUM_BROWSER_HEIGHT = 320;

export function useDdtBrowserLayout() {
  const browserRef = useRef<HTMLDivElement>(null);
  const [measurements, setMeasurements] = useState({ width: 0, height: 0, filterHeight: 0 });
  const [preferredListRatio, setPreferredListRatio] = useState<number>();

  useEffect(() => {
    const browser = browserRef.current;
    if (!browser) return;
    const filters = browser.querySelector(".ddt-case-filters");
    const filterTrigger = filters?.querySelector(".ddt-advanced-filters > summary");
    let frame = 0;
    const measure = () => {
      frame = 0;
      const bounds = browser.getBoundingClientRect();
      // TestNG/DDT tabs stay mounted; hidden panels must not replace the saved layout.
      if (!bounds.width) return;
      const content = browser.closest(".main-content");
      const bottomPadding = content
        ? Number.parseFloat(getComputedStyle(content).paddingBottom)
        : 0;
      const height = Math.max(
        MINIMUM_BROWSER_HEIGHT,
        Math.floor(window.innerHeight - (bounds.top + window.scrollY) - bottomPadding),
      );
      const width = browser.clientWidth;
      const filterHeight =
        filterTrigger && filters
          ? Math.max(
              0,
              Math.floor(
                height -
                  (filterTrigger.getBoundingClientRect().bottom - bounds.top) -
                  Number.parseFloat(getComputedStyle(filters).paddingBottom),
              ),
            )
          : height;
      setMeasurements((current) =>
        current.width === width &&
        current.height === height &&
        current.filterHeight === filterHeight
          ? current
          : { width, height, filterHeight },
      );
    };
    const scheduleMeasurement = () => {
      if (!frame) frame = window.requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(scheduleMeasurement);
    observer.observe(browser);
    if (filters) observer.observe(filters);
    // Toolbars can wrap or feedback can appear without a window resize.
    const page = browser.closest(".page-stack");
    if (page) observer.observe(page);
    window.addEventListener("resize", scheduleMeasurement);
    scheduleMeasurement();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", scheduleMeasurement);
      window.cancelAnimationFrame(frame);
    };
  }, []);

  const maximumListWidth = measurements.width
    ? Math.min(MAXIMUM_LIST_WIDTH, Math.floor(measurements.width * MAXIMUM_LIST_RATIO))
    : MAXIMUM_LIST_WIDTH;
  const minimumListWidth = Math.min(MINIMUM_LIST_WIDTH, maximumListWidth);
  const clampWidth = (width: number, minimum = minimumListWidth) =>
    Math.round(Math.max(minimum, Math.min(maximumListWidth, width)));
  const listWidth = clampWidth(
    measurements.width * (preferredListRatio ?? DEFAULT_LIST_RATIO),
    preferredListRatio === undefined
      ? Math.min(DEFAULT_MINIMUM_LIST_WIDTH, maximumListWidth)
      : minimumListWidth,
  );

  return {
    browserRef,
    listWidth,
    minimumListWidth,
    maximumListWidth,
    style: {
      ...(measurements.width ? { "--ddt-case-list-width": `${listWidth}px` } : {}),
      ...(measurements.height
        ? {
            "--ddt-case-browser-height": `${measurements.height}px`,
            "--ddt-case-filter-max-height": `${measurements.filterHeight}px`,
          }
        : {}),
    } as CSSProperties,
    resizeList: (width: number) => {
      if (measurements.width) setPreferredListRatio(clampWidth(width) / measurements.width);
    },
    resetListWidth: () => setPreferredListRatio(undefined),
  };
}
