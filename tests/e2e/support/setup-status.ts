import type { APIRequestContext } from "@playwright/test";

export async function readSetupStatus(request: APIRequestContext): Promise<boolean> {
  // Playwright pools HTTP sockets across request contexts. An idle socket can
  // close as the next test borrows it. Recover only ECONNRESET for this public,
  // read-only probe; never retry HTTP errors, login, bootstrap or a whole test.
  const response = await request.get("/api/v1/auth/setup-status", {
    maxRetries: 1,
    timeout: 10_000,
  });
  try {
    if (!response.ok())
      throw new Error(`Administrator setup probe failed: HTTP ${response.status()}.`);
    const status: unknown = await response.json();
    if (
      typeof status !== "object" ||
      status === null ||
      !("setupRequired" in status) ||
      typeof status.setupRequired !== "boolean"
    ) {
      throw new Error("Administrator setup probe returned an invalid setupRequired field.");
    }
    return status.setupRequired;
  } finally {
    await response.dispose();
  }
}
