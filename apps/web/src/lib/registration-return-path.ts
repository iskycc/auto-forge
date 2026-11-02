const REGISTRATION_ORIGIN = "http://autoforge.local";
const AUTHENTICATION_PATHS = new Set(["/register", "/login", "/setup", "/landing"]);

/** Registration may return to a public business page, never to a different site. */
export function registrationReturnPath(candidate?: unknown): string {
  if (
    typeof candidate !== "string" ||
    candidate.length > 8192 ||
    !candidate.startsWith("/") ||
    candidate.startsWith("//") ||
    /[\\\u0000-\u0020\u007f]/u.test(candidate)
  )
    return "/";
  const target = new URL(candidate, REGISTRATION_ORIGIN);
  if (target.origin !== REGISTRATION_ORIGIN || AUTHENTICATION_PATHS.has(target.pathname))
    return "/";
  target.searchParams.delete("login");
  target.searchParams.delete("passwordChanged");
  return `${target.pathname}${target.search}${target.hash}`;
}
