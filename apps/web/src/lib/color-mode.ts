export type ColorMode = "light" | "dark";

export const COLOR_MODE_COOKIE = "autoforge-color-mode";
const PREFERENCE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

export function parseColorMode(value: string | undefined): ColorMode {
  return value === "dark" ? "dark" : "light";
}

export function readBrowserColorMode(cookies: string): ColorMode {
  const prefix = `${COLOR_MODE_COOKIE}=`;
  return parseColorMode(
    cookies
      .split(";")
      .map((entry) => entry.trim())
      .find((entry) => entry.startsWith(prefix))
      ?.slice(prefix.length),
  );
}

export function colorModeCookie(mode: ColorMode, secure: boolean): string {
  return `${COLOR_MODE_COOKIE}=${mode}; Path=/; Max-Age=${PREFERENCE_MAX_AGE_SECONDS}; SameSite=Lax${secure ? "; Secure" : ""}`;
}
