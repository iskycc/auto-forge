import { NextResponse, type NextRequest } from "next/server";

const PUBLIC_PATHS = new Set(["/", "/login", "/setup"]);
// 只读公开页由各自页面按限资源、限时 token 校验访问；代理只负责让匿名请求到达页面。
const PUBLIC_PREFIXES = ["/share/", "/progress/"];

export function isPublicPath(pathname: string): boolean {
  return (
    PUBLIC_PATHS.has(pathname) || PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
}

export function proxy(request: NextRequest): NextResponse {
  const pathname = request.nextUrl.pathname;
  if (!isPublicPath(pathname) && !request.cookies.has("autoforge_session")) {
    return withSecurityHeaders(NextResponse.redirect(new URL("/login", request.url)));
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const contentSecurityPolicy = createContentSecurityPolicy(nonce);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", contentSecurityPolicy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", contentSecurityPolicy);
  return withSecurityHeaders(response);
}

function createContentSecurityPolicy(nonce: string): string {
  const developmentDirective = process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : "";
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${developmentDirective}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self' ws: wss:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

function withSecurityHeaders(response: NextResponse): NextResponse {
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  return response;
}

export const config = {
  // API routes perform their own authentication and bounded body parsing. Keeping
  // them outside the page proxy avoids Next's proxy body buffering and 10 MiB cap.
  matcher: [
    "/((?!api(?:/|$)|_next(?:/|$)|favicon.ico|robots.txt|.*\\.(?:png|jpg|jpeg|gif|svg|ico)$).*)",
  ],
};
