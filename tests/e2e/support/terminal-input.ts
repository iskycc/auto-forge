import { expect, type Page } from "@playwright/test";

export async function sendTerminalInput(page: Page, command: string): Promise<void> {
  const input = page.locator(".terminal-window .xterm-helper-textarea");
  await expect(input).toBeFocused();
  await input.evaluate((textarea, text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", text);
    textarea.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }),
    );
  }, command);
  await page.keyboard.press("Enter");
}

/** Exercise Bash completion through real browser key events and the Agent's PTY. */
export async function expectTerminalTabCompletion(page: Page): Promise<void> {
  const input = page.locator(".terminal-window .xterm-helper-textarea");
  const viewport = page.locator(".terminal-viewport");
  await sendTerminalInput(
    page,
    [
      "set -o emacs",
      `bind '"\\t": complete'`,
      "autoforge_tab_complete() { printf '%s%s\\n' 'TAB_COMMAND_' 'OK'; }",
      "printf '%s%s\\n' 'TAB_PATH_' 'OK' > autoforge-tab-target.txt",
      "printf '%s%s\\n' 'TAB_FIXTURE_' 'READY'",
    ].join("; "),
  );
  // Split markers in the command so terminal echo cannot satisfy these assertions.
  await expect(viewport).toContainText("TAB_FIXTURE_READY");
  await page.keyboard.type("autoforge_tab_comp");
  await page.keyboard.press("Tab");
  await expect(input).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(viewport).toContainText("TAB_COMMAND_OK");

  await page.keyboard.type("cat autoforge-tab-tar");
  await page.keyboard.press("Tab");
  await expect(input).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(viewport).toContainText("TAB_PATH_OK");
}
