"use client";

import { useEffect } from "react";
import { passwordChangePath } from "@/lib/authentication-return-path";
import { browserAuthenticationDestination } from "@/lib/authentication-fragment";
import { LoadingStateMessage } from "./ui/loading-state-message";

/** Browser fragments are unavailable to Server Components and must be captured before navigation. */
export function AuthenticationEntryRedirect({
  mode,
  passwordChanged = false,
}: {
  mode: "login" | "continue" | "change_password";
  passwordChanged?: boolean;
}) {
  useEffect(() => {
    const destination = browserAuthenticationDestination(new URL(window.location.href));
    if (mode !== "login") {
      window.location.replace(
        mode === "change_password" ? passwordChangePath(destination) : destination,
      );
      return;
    }
    const parameters = new URLSearchParams({ login: "1" });
    if (passwordChanged) parameters.set("passwordChanged", "1");
    if (destination !== "/") parameters.set("returnTo", destination);
    window.location.replace(`/?${parameters}`);
  }, [mode, passwordChanged]);
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-8">
      <LoadingStateMessage>正在返回登录来源页面…</LoadingStateMessage>
    </main>
  );
}
