import { authenticationDestination, authenticationReturnPath } from "./authentication-return-path";

export const AUTHENTICATION_FRAGMENT_KEY = "autoforge:authentication-fragment:v1";
const MAXIMUM_FRAGMENT_AGE_MS = 5 * 60_000;

/** Runs before streamed redirects; only a matching, short-lived fragment can be restored. */
export function authenticationFragmentCaptureScript(): string {
  return `(function(){try{var u=new URL(window.location.href);if(!u.hash||u.href.length>8192||["/login","/register","/setup","/landing","/account/security"].includes(u.pathname)||u.searchParams.get("login")==="1")return;window.sessionStorage.setItem(${JSON.stringify(AUTHENTICATION_FRAGMENT_KEY)},JSON.stringify({path:u.pathname+u.search,hash:u.hash,recordedAt:Date.now()}));}catch{return;}})();`;
}

export function restoreAuthenticationFragment(
  destination: string,
  remembered: string | null,
  now: number,
): string {
  if (!remembered || destination.includes("#")) return destination;
  try {
    const fragment: unknown = JSON.parse(remembered);
    if (
      !fragment ||
      typeof fragment !== "object" ||
      !("path" in fragment) ||
      typeof fragment.path !== "string" ||
      !("hash" in fragment) ||
      typeof fragment.hash !== "string" ||
      !fragment.hash.startsWith("#") ||
      !("recordedAt" in fragment) ||
      typeof fragment.recordedAt !== "number" ||
      fragment.recordedAt > now ||
      now - fragment.recordedAt > MAXIMUM_FRAGMENT_AGE_MS ||
      authenticationReturnPath(fragment.path) !== destination
    )
      return destination;
    return authenticationReturnPath(`${destination}${fragment.hash}`);
  } catch {
    return destination;
  }
}

export function browserAuthenticationDestination(currentUrl: URL): string {
  const destination = authenticationDestination(currentUrl);
  try {
    const restored = restoreAuthenticationFragment(
      destination,
      window.sessionStorage.getItem(AUTHENTICATION_FRAGMENT_KEY),
      Date.now(),
    );
    if (restored !== destination) window.sessionStorage.removeItem(AUTHENTICATION_FRAGMENT_KEY);
    return restored;
  } catch {
    // Private browsing/storage policies cannot prevent an explicit return URL from working.
    return destination;
  }
}
