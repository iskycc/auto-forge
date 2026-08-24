export function publicLinkBase(publicBaseUrl: string | undefined, request: Request): string {
  const configured = publicBaseUrl?.trim();
  if (configured) return configured.replace(/\/$/u, "");

  const requestUrl = new URL(request.url);
  const forwardedHost = firstHeader(request.headers.get("x-forwarded-host"));
  const requestHost = firstHeader(request.headers.get("host"));
  const publicHost = forwardedHost ?? requestHost;
  if (!publicHost) return requestUrl.origin;

  const forwardedProtocol = firstHeader(request.headers.get("x-forwarded-proto"));
  const protocol = isHttpProtocol(forwardedProtocol) ? forwardedProtocol : requestUrl.protocol;
  try {
    const origin = new URL(`${protocol.replace(/:$/u, "")}://${publicHost}`).origin;
    return origin === "null" ? requestUrl.origin : origin;
  } catch {
    return requestUrl.origin;
  }
}

function firstHeader(value: string | null): string | undefined {
  const first = value?.split(",", 1)[0]?.trim();
  return first || undefined;
}

function isHttpProtocol(value: string | undefined): value is "http" | "https" | "http:" | "https:" {
  return value === "http" || value === "https" || value === "http:" || value === "https:";
}
