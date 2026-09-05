import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { expiredSessionCookie, sessionCookie } from "./auth";

afterEach(() => vi.unstubAllEnvs());

describe("session cookie transport security", () => {
  it("retains the platform session lifetime when browser and platform dates differ", () => {
    const request = new Request("http://autoforge.internal/api/v1/auth/login");
    const cookie = sessionCookie(
      "session-token",
      "2000-01-02T00:00:00Z",
      request,
      new Date("2000-01-01T00:00:00Z"),
    );
    expect(cookie.maxAge).toBe(86_400);
    expect(cookie).not.toHaveProperty("expires");
  });
  it("allows a production deployment reached directly over HTTP to retain the session", () => {
    vi.stubEnv("NODE_ENV", "production");
    const request = new Request("http://autoforge.internal/api/v1/auth/login");

    expect(
      sessionCookie(
        "session-token",
        "2030-01-01T00:00:00.000Z",
        request,
        new Date("2026-09-05T00:00:00Z"),
      ).secure,
    ).toBe(false);
    expect(expiredSessionCookie(request).secure).toBe(false);
  });

  it("marks the session secure when an HTTPS reverse proxy forwards the request", () => {
    vi.stubEnv("NODE_ENV", "test");
    const request = new Request("http://autoforge:3000/api/v1/auth/login", {
      headers: { "x-forwarded-proto": "https" },
    });

    expect(
      sessionCookie(
        "session-token",
        "2030-01-01T00:00:00.000Z",
        request,
        new Date("2026-09-05T00:00:00Z"),
      ).secure,
    ).toBe(true);
    expect(expiredSessionCookie(request).secure).toBe(true);
  });

  it("does not allow a forwarded header to downgrade a direct HTTPS request", () => {
    const request = new Request("https://autoforge.internal/api/v1/auth/login", {
      headers: { "x-forwarded-proto": "http" },
    });

    expect(
      sessionCookie(
        "session-token",
        "2030-01-01T00:00:00.000Z",
        request,
        new Date("2026-09-05T00:00:00Z"),
      ).secure,
    ).toBe(true);
  });
});
