import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

import { browserJson, ensureAdministrator } from "./support/session";
import { expectUiIntegrity } from "./support/ui-guard";

test("the application shell proactively updates notifications and renews an active session", async ({
  page,
}) => {
  await ensureAdministrator(page);
  const session = await browserJson<{ user: { id: string } }>(page, "/api/v1/auth/session");
  expect(session.status).toBe(200);
  const initialUnread = await browserJson<{ count: number }>(
    page,
    "/api/v1/notifications/unread-count",
  );
  expect(initialUnread.status).toBe(200);

  const database = new DatabaseSync(
    resolve(requiredEnvironment("AUTOFORGE_E2E_DATA_DIR"), "db", "autoforge.sqlite"),
  );
  const notificationId = `notice-e2e-${randomUUID()}`;
  try {
    database
      .prepare(
        `INSERT INTO notifications
          (id,user_id,project_id,kind,severity,title,message,resource_type,resource_id,read_at,created_at)
         VALUES (?, ?, NULL, 'system.diagnostic', 'warning', '主动计数通知',
                 '无需打开铃铛即可看到未读数量。', NULL, NULL, NULL, ?)`,
      )
      .run(notificationId, session.body.user.id, new Date().toISOString());

    const unreadCountResponse = page.waitForResponse((response) =>
      response.url().endsWith("/api/v1/notifications/unread-count"),
    );
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    expect((await unreadCountResponse).status()).toBe(200);
    const expectedUnreadCount = initialUnread.body.count + 1;
    await expect(
      page.getByRole("button", { name: `${expectedUnreadCount} 条未读通知` }),
    ).toBeVisible();
    for (const viewport of [
      { width: 1536, height: 960 },
      { width: 1024, height: 768 },
    ]) {
      await page.setViewportSize(viewport);
      await expectUiIntegrity(page);
      await captureUi(page, `topbar-notification-badge-${viewport.width}`);
    }

    await page.getByRole("button", { name: `${expectedUnreadCount} 条未读通知` }).click();
    await expect(page.locator(".notification-panel")).toBeVisible();
    await expectUiIntegrity(page);
    await captureUi(page, "topbar-notification-panel-1024", false);
    const notification = page.locator(".notification-item").filter({ hasText: "主动计数通知" });
    await expect(notification).toBeVisible();
    const markReadResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/api/v1/notifications/${notificationId}/read`),
    );
    await notification.click();
    expect((await markReadResponse).status()).toBe(200);
    await expect(
      page.getByRole("button", {
        name: initialUnread.body.count > 0 ? `${initialUnread.body.count} 条未读通知` : "通知",
        exact: true,
      }),
    ).toBeVisible();

    const automaticRefresh = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/api/v1/auth/session/refresh"),
    );
    await page.reload();
    expect((await automaticRefresh).status()).toBe(200);

    const currentCookie = (await page.context().cookies()).find(
      (cookie) => cookie.name === "autoforge_session",
    );
    expect(currentCookie).toBeDefined();
    const shortenedExpiry = Math.floor(Date.now() / 1_000) + 60;
    await page.context().addCookies([
      {
        name: currentCookie!.name,
        value: currentCookie!.value,
        url: new URL(page.url()).origin,
        expires: shortenedExpiry,
        httpOnly: true,
        secure: currentCookie!.secure,
        sameSite: "Strict",
      },
    ]);

    const refreshed = await browserJson<{ expiresAt: string }>(
      page,
      "/api/v1/auth/session/refresh",
      { method: "POST" },
    );
    expect(refreshed.status).toBe(200);
    const refreshedExpirySeconds = Math.floor(Date.parse(refreshed.body.expiresAt) / 1_000);
    expect(refreshedExpirySeconds).toBeGreaterThan(shortenedExpiry + 60 * 60);
    const refreshedCookie = (await page.context().cookies()).find(
      (cookie) => cookie.name === "autoforge_session",
    );
    expect(Math.abs((refreshedCookie?.expires ?? 0) - refreshedExpirySeconds)).toBeLessThan(2);

    const tokenHash = createHash("sha256").update(currentCookie!.value).digest("hex");
    const persistedSession = database
      .prepare("SELECT expires_at AS expiresAt FROM user_sessions WHERE token_hash = ?")
      .get(tokenHash) as { expiresAt: string } | undefined;
    expect(persistedSession?.expiresAt).toBe(refreshed.body.expiresAt);
  } finally {
    database.prepare("DELETE FROM notifications WHERE id = ?").run(notificationId);
    database.close();
  }
});

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for browser acceptance tests.`);
  return value;
}

async function captureUi(
  page: import("@playwright/test").Page,
  name: string,
  fullPage = true,
): Promise<void> {
  const screenshotDirectory = process.env.AUTOFORGE_UI_SCREENSHOT_DIR;
  if (!screenshotDirectory) return;
  await mkdir(screenshotDirectory, { recursive: true });
  await page.screenshot({
    path: resolve(screenshotDirectory, `${name}.png`),
    fullPage,
  });
}
