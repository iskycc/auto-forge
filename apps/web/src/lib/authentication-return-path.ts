const LOCAL_ORIGIN = "http://autoforge.local";
const ENTRY_PATHS = new Set(["/register", "/login", "/setup", "/landing"]);
export const AUTHENTICATION_PAGE_PATH_HEADER = "x-autoforge-page-path";

/** Return destinations are local business pages; authentication entries cannot be destinations. */
export function authenticationReturnPath(candidate?: unknown): string {
  if (
    typeof candidate !== "string" ||
    candidate.length > 8192 ||
    !candidate.startsWith("/") ||
    candidate.startsWith("//") ||
    /[\\\u0000-\u0020\u007f]/u.test(candidate)
  )
    return "/";
  const target = new URL(candidate, LOCAL_ORIGIN);
  // Dot segments may normalize a local-looking path into a protocol-relative URL.
  if (
    target.origin !== LOCAL_ORIGIN ||
    target.pathname.startsWith("//") ||
    ENTRY_PATHS.has(target.pathname.replace(/\/+$/u, ""))
  )
    return "/";
  target.searchParams.delete("login");
  target.searchParams.delete("passwordChanged");
  target.searchParams.delete("_rsc");
  return `${target.pathname}${target.search}${target.hash}`;
}

/** The URL carries one destination across reloads and login/registration switches, per tab. */
export function authenticationDestination(currentUrl: URL): string {
  const usesReturnParameter =
    ENTRY_PATHS.has(currentUrl.pathname) ||
    currentUrl.pathname === "/account/security" ||
    (currentUrl.pathname === "/" && currentUrl.searchParams.get("login") === "1");
  const explicit = usesReturnParameter ? currentUrl.searchParams.get("returnTo") : null;
  const target = new URL(
    authenticationReturnPath(
      explicit ?? `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`,
    ),
    LOCAL_ORIGIN,
  );
  // Fragments are not sent to the server. Browsers carry them through HTTP redirects.
  if (!target.hash && currentUrl.hash) target.hash = currentUrl.hash;
  return `${target.pathname}${target.search}${target.hash}`;
}

export function loginPath(returnTo?: unknown, options: { passwordChanged?: boolean } = {}): string {
  const destination = authenticationReturnPath(returnTo);
  const parameters = new URLSearchParams();
  if (options.passwordChanged) parameters.set("passwordChanged", "1");
  if (destination !== "/") parameters.set("returnTo", destination);
  return parameters.size ? `/login?${parameters}` : "/login";
}

export function passwordChangePath(returnTo?: unknown): string {
  const destination = authenticationReturnPath(returnTo);
  if (destination === "/" || new URL(destination, LOCAL_ORIGIN).pathname === "/account/security")
    return "/account/security";
  return `/account/security?${new URLSearchParams({ returnTo: destination })}`;
}
