import { expect, type Locator, type Page } from "@playwright/test";

export async function expectPageFitsViewport(page: Page): Promise<void> {
  // Reserve space for native scrollbars; only content wider than the usable viewport overflows.
  await expect
    .poll(
      () =>
        page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      { message: "page-level horizontal overflow" },
    )
    .toBeLessThanOrEqual(0);
}

export async function expectReadableText(control: Locator): Promise<void> {
  const contrast = await control.evaluate((element) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "white";
    context.fillRect(0, 0, 1, 1);
    const surfaces: Element[] = [];
    for (let surface: Element | null = element; surface; surface = surface.parentElement)
      surfaces.unshift(surface);
    for (const surface of surfaces) {
      context.fillStyle = getComputedStyle(surface).backgroundColor;
      context.fillRect(0, 0, 1, 1);
    }
    const luminance = () => {
      const pixels = context.getImageData(0, 0, 1, 1).data;
      const linear = Array.from(pixels.slice(0, 3), (byte) => {
        const channel = byte / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
    };
    const background = luminance();
    context.fillStyle = getComputedStyle(element).color;
    context.fillRect(0, 0, 1, 1);
    const foreground = luminance();
    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
  });
  expect(
    contrast,
    "normal text must keep at least 4.5:1 contrast on its painted surface",
  ).toBeGreaterThanOrEqual(4.5);
}

type UiViolation = {
  element: string;
  label: string;
  value: number;
};

type UiIntegrityReport = {
  cardOverflow: UiViolation[];
  controlViolations: UiViolation[];
  documentWidth: number;
  fontViolations: UiViolation[];
  overlapViolations: UiViolation[];
  viewportWidth: number;
};

export async function inspectUiIntegrity(page: Page): Promise<UiIntegrityReport> {
  // Viewport resizing can briefly expose old flex positions alongside the new media query sizes.
  // Inspect after the browser has painted the responsive layout, rather than that intermediate frame.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  return page.evaluate((): UiIntegrityReport => {
    const minimumFontSize = 12;
    const minimumControlHeight = 32;
    type PaintedBounds = {
      bottom: number;
      height: number;
      left: number;
      right: number;
      top: number;
      width: number;
    };
    const clippedOverflowValues = new Set(["auto", "clip", "hidden", "scroll"]);
    const paintedBounds = (element: HTMLElement): PaintedBounds => {
      const elementBounds = element.getBoundingClientRect();
      let left = Math.max(0, elementBounds.left);
      let right = Math.min(window.innerWidth, elementBounds.right);
      let top = Math.max(0, elementBounds.top);
      let bottom = Math.min(window.innerHeight, elementBounds.bottom);

      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const ancestorStyle = window.getComputedStyle(ancestor);
        const ancestorBounds = ancestor.getBoundingClientRect();
        if (clippedOverflowValues.has(ancestorStyle.overflowX)) {
          left = Math.max(left, ancestorBounds.left);
          right = Math.min(right, ancestorBounds.right);
        }
        if (clippedOverflowValues.has(ancestorStyle.overflowY)) {
          top = Math.max(top, ancestorBounds.top);
          bottom = Math.min(bottom, ancestorBounds.bottom);
        }
      }

      const width = Math.max(0, right - left);
      const height = Math.max(0, bottom - top);
      return { bottom, height, left, right, top, width };
    };
    const isVisible = (element: HTMLElement): boolean => {
      const style = window.getComputedStyle(element);
      const bounds = paintedBounds(element);
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity) > 0 &&
        bounds.width > 0 &&
        bounds.height > 0
      );
    };
    const label = (element: HTMLElement): string =>
      (element.getAttribute("aria-label") ?? element.textContent ?? element.tagName)
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 80);
    const hasDirectText = (element: HTMLElement): boolean =>
      Array.from(element.childNodes).some(
        (node) => node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim()),
      );
    const modalRoot = Array.from(
      document.body.querySelectorAll<HTMLElement>('[aria-modal="true"], dialog:modal'),
    )
      .filter(isVisible)
      .at(-1);
    // A modal intentionally overlays the page beneath it. Only its own active interaction
    // surface should participate in control-overlap and readability checks while it is open.
    const inspectionRoot: HTMLElement = modalRoot ?? document.body;

    const fontViolations = Array.from(inspectionRoot.querySelectorAll<HTMLElement>("*"))
      .filter((element) => isVisible(element) && hasDirectText(element))
      .map((element) => ({
        element: element.tagName.toLowerCase(),
        label: label(element),
        value: Number.parseFloat(window.getComputedStyle(element).fontSize),
      }))
      .filter(({ value }) => value > 0 && value < minimumFontSize)
      .slice(0, 20);

    const controlSelector = [
      "button",
      'input:not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="hidden"])',
      "select",
      "textarea",
      "a.button",
      "a.primary-button",
      "a.secondary-button",
      "a.icon-button",
    ].join(",");
    const controlViolations = Array.from(
      inspectionRoot.querySelectorAll<HTMLElement>(controlSelector),
    )
      .filter(isVisible)
      .map((element) => ({
        element: element.tagName.toLowerCase(),
        label: label(element),
        // Measure real hit targets: select/picker wrappers and the clickable label of a Switch.
        value:
          Math.round(
            (
              element.closest(".ant-select, .ant-picker") ??
              (element.matches('[role="switch"]') ? element.closest("label") : null) ??
              element
            ).getBoundingClientRect().height * 10,
          ) / 10,
      }))
      .filter(({ value }) => value < minimumControlHeight)
      .slice(0, 20);

    const interactiveElements = Array.from(
      inspectionRoot.querySelectorAll<HTMLElement>(controlSelector),
    ).filter(isVisible);
    const floatingSurface = (element: HTMLElement): HTMLElement | undefined => {
      for (
        let ancestor = element.parentElement;
        ancestor && ancestor !== inspectionRoot;
        ancestor = ancestor.parentElement
      ) {
        const position = window.getComputedStyle(ancestor).position;
        if (
          position === "fixed" ||
          position === "sticky" ||
          ancestor.matches(".ant-popover, .ant-select-dropdown, .ant-picker-dropdown")
        )
          return ancestor;
      }
      return undefined;
    };
    const floatingSurfaces = new Map(
      interactiveElements.map((element) => [element, floatingSurface(element)]),
    );
    const overlapViolations: UiViolation[] = [];
    for (let index = 0; index < interactiveElements.length; index += 1) {
      const current = interactiveElements[index];
      if (!current) continue;
      const currentBounds = paintedBounds(current);
      for (let peerIndex = index + 1; peerIndex < interactiveElements.length; peerIndex += 1) {
        const peer = interactiveElements[peerIndex];
        if (!peer || current.contains(peer) || peer.contains(current)) continue;
        const peerBounds = paintedBounds(peer);
        const overlapWidth =
          Math.min(currentBounds.right, peerBounds.right) -
          Math.max(currentBounds.left, peerBounds.left);
        const overlapHeight =
          Math.min(currentBounds.bottom, peerBounds.bottom) -
          Math.max(currentBounds.top, peerBounds.top);
        if (overlapWidth <= 1 || overlapHeight <= 1) continue;
        const currentSurface = floatingSurfaces.get(current);
        const peerSurface = floatingSurfaces.get(peer);
        // Headers, sticky actions and portaled popovers intentionally cover the page.
        // Only exempt a painted overlay over the normal document;
        // collisions within or between floating surfaces must still fail.
        if (Boolean(currentSurface) !== Boolean(peerSurface)) {
          const surface = currentSurface ?? peerSurface;
          const paintedElement = document.elementFromPoint(
            Math.max(currentBounds.left, peerBounds.left) + overlapWidth / 2,
            Math.max(currentBounds.top, peerBounds.top) + overlapHeight / 2,
          );
          if (surface?.contains(paintedElement)) continue;
        }
        overlapViolations.push({
          element: `${current.tagName.toLowerCase()} + ${peer.tagName.toLowerCase()}`,
          label: `${label(current)} / ${label(peer)}`,
          value: Math.round(overlapWidth * overlapHeight),
        });
        if (overlapViolations.length >= 20) break;
      }
      if (overlapViolations.length >= 20) break;
    }

    const cardOverflow = Array.from(
      inspectionRoot.querySelectorAll<HTMLElement>(
        ".card, .content-card, .settings-section, .runner-list-item",
      ),
    )
      .filter(isVisible)
      .filter((element) => {
        const style = window.getComputedStyle(element);
        return (
          !["auto", "scroll"].includes(style.overflowX) &&
          element.scrollWidth > element.clientWidth + 2
        );
      })
      .map((element) => ({
        element: element.className,
        label: label(element),
        value: element.scrollWidth - element.clientWidth,
      }))
      .slice(0, 20);

    return {
      cardOverflow,
      controlViolations,
      documentWidth: document.documentElement.scrollWidth,
      fontViolations,
      overlapViolations,
      // Exclude the native scrollbar gutter from the usable layout viewport.
      viewportWidth: document.documentElement.clientWidth,
    };
  });
}

export async function expectUiIntegrity(page: Page): Promise<void> {
  // Modal/popover entry scales controls. Measure settled geometry while leaving
  // continuous loading indicators running; never disable product motion in tests.
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            document
              .getAnimations()
              .filter(
                (animation) =>
                  (animation.pending || animation.playState === "running") &&
                  animation.effect?.getTiming().iterations !== Infinity,
              ).length,
        ),
      { message: "finite UI transitions should settle" },
    )
    .toBe(0);
  const report = await inspectUiIntegrity(page);
  expect(report.fontViolations, "visible text smaller than 12px").toEqual([]);
  expect(report.controlViolations, "visible controls shorter than 32px").toEqual([]);
  expect(report.overlapViolations, "interactive controls overlapping each other").toEqual([]);
  expect(report.cardOverflow, "card content escaping its layout boundary").toEqual([]);
  // Chromium can include a reserved, empty gutter in clientWidth; a narrower document is valid.
  expect(report.documentWidth, "page-level horizontal overflow").toBeLessThanOrEqual(
    report.viewportWidth,
  );
}
