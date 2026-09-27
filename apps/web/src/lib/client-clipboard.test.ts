import { describe, expect, it, vi } from "vitest";

import { copyRichTextToClipboard, copyTextToClipboard } from "./client-clipboard";

describe("copyTextToClipboard", () => {
  it("uses the asynchronous Clipboard API when available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);

    await copyTextToClipboard("https://autoforge.example/share/run/token", {
      navigator: { clipboard: { writeText } },
    });

    expect(writeText).toHaveBeenCalledWith("https://autoforge.example/share/run/token");
  });

  it("falls back to selection copy when Clipboard API is unavailable", async () => {
    const textarea = fakeTextarea();
    const append = vi.fn();
    const restoreFocus = vi.fn();
    const execCommand = vi.fn().mockReturnValue(true);
    const document = {
      activeElement: { focus: restoreFocus },
      body: { append },
      createElement: vi.fn().mockReturnValue(textarea),
      execCommand,
    } as unknown as Document;

    await copyTextToClipboard("http://10.0.0.8/share/run/token", { document });

    expect(textarea.value).toBe("http://10.0.0.8/share/run/token");
    expect(textarea.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(textarea.focus.mock.invocationCallOrder[0]).toBeLessThan(
      textarea.select.mock.invocationCallOrder[0]!,
    );
    expect(textarea.select).toHaveBeenCalledOnce();
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(textarea.remove).toHaveBeenCalledOnce();
    expect(restoreFocus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("keeps the temporary input inside the active dialog's focus boundary", async () => {
    const textarea = fakeTextarea();
    const dialog = { append: vi.fn() };
    const document = {
      activeElement: { closest: vi.fn().mockReturnValue(dialog), focus: vi.fn() },
      body: { append: vi.fn() },
      createElement: vi.fn().mockReturnValue(textarea),
      execCommand: vi.fn().mockReturnValue(true),
    } as unknown as Document;

    await copyTextToClipboard("full-case-id", { document });

    expect(dialog.append).toHaveBeenCalledWith(textarea);
    expect(document.body.append).not.toHaveBeenCalled();
    expect(textarea.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(textarea.remove).toHaveBeenCalledOnce();
  });

  it("falls back after Clipboard API permission rejection", async () => {
    const textarea = fakeTextarea();
    const document = {
      body: { append: vi.fn() },
      createElement: vi.fn().mockReturnValue(textarea),
      execCommand: vi.fn().mockReturnValue(true),
    } as unknown as Document;

    await copyTextToClipboard("share-url", {
      navigator: {
        clipboard: {
          writeText: vi.fn().mockRejectedValue(new Error("permission denied")),
        },
      },
      document,
    });

    expect(document.execCommand).toHaveBeenCalledWith("copy");
  });

  it("reports an actionable error when neither copy method succeeds", async () => {
    const textarea = fakeTextarea();
    const restoreFocus = vi.fn();
    const document = {
      activeElement: { focus: restoreFocus },
      body: { append: vi.fn() },
      createElement: vi.fn().mockReturnValue(textarea),
      execCommand: vi.fn().mockReturnValue(false),
    } as unknown as Document;

    await expect(copyTextToClipboard("share-url", { document })).rejects.toThrow(
      "浏览器未允许复制，请打开分享链接后从地址栏手动复制。",
    );
    expect(textarea.remove).toHaveBeenCalledOnce();
    expect(restoreFocus).toHaveBeenCalledWith({ preventScroll: true });
  });
});

describe("copyRichTextToClipboard", () => {
  it("writes HTML and plain text representations together", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const item = {} as ClipboardItem;
    const createClipboardItem = vi.fn().mockReturnValue(item);

    await copyRichTextToClipboard(
      { html: "<strong>用例</strong>", text: "用例" },
      {
        navigator: { clipboard: { write, writeText: vi.fn() } },
        createClipboardItem,
      },
    );

    expect(createClipboardItem).toHaveBeenCalledWith({
      "text/html": expect.any(Blob),
      "text/plain": expect.any(Blob),
    });
    expect(write).toHaveBeenCalledWith([item]);
  });

  it("falls back to plain text when rich clipboard access is rejected", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);

    await copyRichTextToClipboard(
      { html: "<strong>用例</strong>", text: "用例" },
      {
        navigator: {
          clipboard: { write: vi.fn().mockRejectedValue(new Error("denied")), writeText },
        },
        createClipboardItem: () => ({}) as ClipboardItem,
      },
    );

    expect(writeText).toHaveBeenCalledWith("用例");
  });
});

function fakeTextarea() {
  return {
    value: "",
    readOnly: false,
    style: {} as CSSStyleDeclaration,
    setAttribute: vi.fn(),
    focus: vi.fn(),
    select: vi.fn(),
    setSelectionRange: vi.fn(),
    remove: vi.fn(),
  };
}
