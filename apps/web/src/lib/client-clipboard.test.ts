import { describe, expect, it, vi } from "vitest";

import { copyTextToClipboard } from "./client-clipboard";

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
    const execCommand = vi.fn().mockReturnValue(true);
    const document = {
      body: { append },
      createElement: vi.fn().mockReturnValue(textarea),
      execCommand,
    } as unknown as Document;

    await copyTextToClipboard("http://10.0.0.8/share/run/token", { document });

    expect(textarea.value).toBe("http://10.0.0.8/share/run/token");
    expect(textarea.select).toHaveBeenCalledOnce();
    expect(execCommand).toHaveBeenCalledWith("copy");
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
    const document = {
      body: { append: vi.fn() },
      createElement: vi.fn().mockReturnValue(textarea),
      execCommand: vi.fn().mockReturnValue(false),
    } as unknown as Document;

    await expect(copyTextToClipboard("share-url", { document })).rejects.toThrow(
      "浏览器未允许复制，请打开分享链接后从地址栏手动复制。",
    );
    expect(textarea.remove).toHaveBeenCalledOnce();
  });
});

function fakeTextarea() {
  return {
    value: "",
    readOnly: false,
    style: {} as CSSStyleDeclaration,
    setAttribute: vi.fn(),
    select: vi.fn(),
    setSelectionRange: vi.fn(),
    remove: vi.fn(),
  };
}
