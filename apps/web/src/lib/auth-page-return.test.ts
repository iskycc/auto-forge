import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pageHeaders: new Headers(),
  authenticateSession: vi.fn(),
  setupRequired: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: "expired-session" }) }),
  headers: async () => mocks.pageHeaders,
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`);
  },
}));
vi.mock("./services", () => ({ getPlatformServices: async () => ({ identityAccess: mocks }) }));

import {
  pageLoginPath,
  requirePageAnyPermission,
  requirePagePermission,
  requirePageProjectScope,
} from "./auth";
import { AUTHENTICATION_PAGE_PATH_HEADER } from "./authentication-return-path";

beforeEach(() => {
  mocks.pageHeaders = new Headers({
    [AUTHENTICATION_PAGE_PATH_HEADER]: "/execution-records?kind=single",
  });
  mocks.setupRequired.mockResolvedValue(false);
  mocks.authenticateSession.mockRejectedValue(new Error("session expired"));
});

it.each([
  () => requirePagePermission("run.read", undefined),
  () => requirePageProjectScope("run.read"),
  () => requirePageAnyPermission(["run.read"]),
])("retains an expired-session destination through each server permission guard", async (guard) => {
  await expect(guard()).rejects.toThrow(
    "redirect:/login?returnTo=%2Fexecution-records%3Fkind%3Dsingle",
  );
});

it("retains the destination while enforcing mandatory password changes", async () => {
  mocks.authenticateSession.mockResolvedValue({ user: { forcePasswordChange: true } });
  await expect(requirePageProjectScope("run.read")).rejects.toThrow(
    "redirect:/account/security?returnTo=%2Fexecution-records%3Fkind%3Dsingle",
  );
});

it("keeps initialization protection and unwraps the original password-change destination", async () => {
  mocks.setupRequired.mockResolvedValue(true);
  await expect(requirePageProjectScope("run.read")).rejects.toThrow("redirect:/setup");
  mocks.pageHeaders.set(
    AUTHENTICATION_PAGE_PATH_HEADER,
    "/account/security?returnTo=%2FCaseLog%3FExecutionId%3Dcase%23log",
  );
  expect(await pageLoginPath()).toBe("/login?returnTo=%2FCaseLog%3FExecutionId%3Dcase%23log");
});
