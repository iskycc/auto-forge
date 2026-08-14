import { expect, type Page } from "@playwright/test";

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

export async function expectUiIntegrity(page: Page): Promise<void> {
  const report = await page.evaluate((): UiIntegrityReport => {
    const minimumFontSize = 12;
    const minimumControlHeight = 32;
    const isVisible = (element: HTMLElement): boolean => {
      const style = window.getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      const closedDetails = element.closest("details:not([open])");
      const visibleSummary = closedDetails?.querySelector(":scope > summary");
      if (closedDetails && !visibleSummary?.contains(element)) return false;
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

    const fontViolations = Array.from(document.body.querySelectorAll<HTMLElement>("*"))
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
      document.body.querySelectorAll<HTMLElement>(controlSelector),
    )
      .filter(isVisible)
      .map((element) => ({
        element: element.tagName.toLowerCase(),
        label: label(element),
        value: Math.round(element.getBoundingClientRect().height * 10) / 10,
      }))
      .filter(({ value }) => value < minimumControlHeight)
      .slice(0, 20);

    const interactiveElements = Array.from(
      document.body.querySelectorAll<HTMLElement>(controlSelector),
    ).filter(isVisible);
    const overlapViolations: UiViolation[] = [];
    for (let index = 0; index < interactiveElements.length; index += 1) {
      const current = interactiveElements[index];
      if (!current) continue;
      const currentBounds = current.getBoundingClientRect();
      for (let peerIndex = index + 1; peerIndex < interactiveElements.length; peerIndex += 1) {
        const peer = interactiveElements[peerIndex];
        if (!peer || current.contains(peer) || peer.contains(current)) continue;
        const peerBounds = peer.getBoundingClientRect();
        const overlapWidth =
          Math.min(currentBounds.right, peerBounds.right) -
          Math.max(currentBounds.left, peerBounds.left);
        const overlapHeight =
          Math.min(currentBounds.bottom, peerBounds.bottom) -
          Math.max(currentBounds.top, peerBounds.top);
        if (overlapWidth <= 1 || overlapHeight <= 1) continue;
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
      document.body.querySelectorAll<HTMLElement>(
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
      viewportWidth: window.innerWidth,
    };
  });

  expect(report.fontViolations, "visible text smaller than 12px").toEqual([]);
  expect(report.controlViolations, "visible controls shorter than 32px").toEqual([]);
  expect(report.overlapViolations, "interactive controls overlapping each other").toEqual([]);
  expect(report.cardOverflow, "card content escaping its layout boundary").toEqual([]);
  expect(report.documentWidth, "page-level horizontal overflow").toBe(report.viewportWidth);
}
