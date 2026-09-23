"use client";
import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import { clearBrowserSnapshots } from "@/lib/browser-read-cache";
import { Button } from "@/components/ui";

import { LogOut } from "lucide-react";
import { useState } from "react";

export function LogoutButton() {
  const [pending, setPending] = useState(false);

  async function logout() {
    setPending(true);
    clearBrowserSnapshots();
    await fetch("/api/v1/auth/logout", { method: "POST" }).catch(() => undefined);
    // Reload the root layout after removing the HTTP-only session cookie.
    window.location.replace("/login");
  }

  return (
    <Button
      className={cn("icon-button", uiPatterns["icon-button"])}
      disabled={pending}
      onClick={logout}
      title="退出登录"
      type="button"
    >
      <LogOut size={17} aria-hidden="true" />
      <span className={cn("visually-hidden", uiPatterns["visually-hidden"])}>退出登录</span>
    </Button>
  );
}
