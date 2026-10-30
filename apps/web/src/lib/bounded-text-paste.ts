/** Check the prospective value before the browser inserts and lays out clipboard text. */
export function textPasteExceedsLimit({
  value,
  pastedText,
  maximumLength,
  selectionStart,
  selectionEnd,
}: {
  value: string;
  pastedText: string;
  maximumLength: number;
  selectionStart: number | null;
  selectionEnd: number | null;
}): boolean {
  const selectedLength =
    selectionStart === null || selectionEnd === null
      ? 0
      : Math.max(0, selectionEnd - selectionStart);
  return value.length - selectedLength + pastedText.length > maximumLength;
}
