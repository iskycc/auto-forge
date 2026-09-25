/** Read the caption without including selected values or nested widget controls. */
export function formControlLabel(
  control: HTMLInputElement | HTMLSelectElement,
): string | undefined {
  const labels = Array.from(control.labels ?? [], (label) => {
    const caption = label.cloneNode(true) as HTMLLabelElement;
    caption
      .querySelectorAll(
        ".ui-select, .ui-datetime, .ant-select, .ant-input-number, input, select, textarea, button",
      )
      .forEach((element) => {
        element.remove();
      });
    return caption.textContent?.trim() ?? "";
  });
  return labels.join(" ").replace(/\s+/gu, " ").trim() || undefined;
}
