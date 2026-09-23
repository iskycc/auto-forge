import { describe, expect, it } from "vitest";
import { colorModeCookie, parseColorMode, readBrowserColorMode } from "./color-mode";

describe("browser color preference", () => {
  it("accepts only known modes and defaults missing or untrusted values to light", () => {
    expect(parseColorMode("dark")).toBe("dark");
    for (const value of [undefined, "", "light", "dark; Path=/", "<style>"]) {
      expect(parseColorMode(value)).toBe("light");
    }
  });
  it("isolates appearance from session cookies and similarly named keys", () => {
    expect(readBrowserColorMode("autoforge_session=dark; other-autoforge-color-mode=dark")).toBe(
      "light",
    );
    expect(
      readBrowserColorMode("autoforge_session=ignored; autoforge-color-mode=dark; other=1"),
    ).toBe("dark");
  });
  it("persists a site-wide preference for HTTP offline installs and HTTPS deployments", () => {
    expect(colorModeCookie("dark", false)).toBe(
      "autoforge-color-mode=dark; Path=/; Max-Age=31536000; SameSite=Lax",
    );
    expect(colorModeCookie("light", true)).toBe(
      "autoforge-color-mode=light; Path=/; Max-Age=31536000; SameSite=Lax; Secure",
    );
  });
});
