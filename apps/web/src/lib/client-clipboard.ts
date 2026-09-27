type ClipboardEnvironment = {
  navigator?: {
    clipboard?: {
      write?(items: ClipboardItem[]): Promise<void>;
      writeText(text: string): Promise<void>;
    };
  };
  document?: Document;
  createClipboardItem?: (contents: Record<string, Blob>) => ClipboardItem;
};

export async function copyRichTextToClipboard(
  content: { html: string; text: string },
  environment: ClipboardEnvironment = browserClipboardEnvironment(),
): Promise<void> {
  const clipboard = environment.navigator?.clipboard;
  if (typeof clipboard?.write === "function" && environment.createClipboardItem) {
    try {
      const item = environment.createClipboardItem({
        "text/html": new Blob([content.html], { type: "text/html" }),
        "text/plain": new Blob([content.text], { type: "text/plain" }),
      });
      await clipboard.write([item]);
      return;
    } catch {
      // Rich clipboard may be denied while writeText or the selection fallback is still allowed.
    }
  }
  await copyTextToClipboard(content.text, environment);
}

/**
 * Copy text in HTTPS/localhost browsers and in plain-HTTP intranet deployments.
 * The async Clipboard API is restricted to secure contexts, so the hidden
 * textarea path remains necessary for AutoForge installations opened by IP.
 */
export async function copyTextToClipboard(
  text: string,
  environment: ClipboardEnvironment = browserClipboardEnvironment(),
): Promise<void> {
  const clipboard = environment.navigator?.clipboard;
  const writeText = clipboard?.writeText;
  if (typeof writeText === "function") {
    try {
      await writeText.call(clipboard, text);
      return;
    } catch {
      // Browser permission policies can reject Clipboard API even in a secure context.
    }
  }

  if (environment.document && copyWithSelection(environment.document, text)) return;
  throw new Error("浏览器未允许复制，请打开分享链接后从地址栏手动复制。");
}

function browserClipboardEnvironment(): ClipboardEnvironment {
  return {
    ...(typeof navigator === "undefined" ? {} : { navigator }),
    ...(typeof document === "undefined" ? {} : { document }),
    ...(typeof ClipboardItem === "undefined"
      ? {}
      : { createClipboardItem: (contents: Record<string, Blob>) => new ClipboardItem(contents) }),
  };
}

function copyWithSelection(document: Document, text: string): boolean {
  if (typeof document.execCommand !== "function" || !document.body) return false;
  const previousFocus = document.activeElement;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.inset = "0 auto auto -9999px";
  textarea.style.opacity = "0";
  // Modal focus guards reject inputs outside the active dialog.
  const container =
    previousFocus?.closest?.('dialog[open], [role="dialog"], [role="alertdialog"]') ??
    document.body;
  container.append(textarea);
  try {
    // select() alone can leave focus and the document selection on previously selected text.
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
    if (previousFocus && "focus" in previousFocus && typeof previousFocus.focus === "function")
      previousFocus.focus({ preventScroll: true });
  }
}
