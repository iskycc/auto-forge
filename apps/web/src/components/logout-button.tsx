"use client";

import { Button } from "@/components/ui";

import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function LogoutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function logout() {
    setPending(true);
    await fetch("/api/v1/auth/logout", { method: "POST" }).catch(() => undefined);
    router.push("/login");
  }

  return (
    <Button
      className="icon-button"
      disabled={pending}
      onClick={logout}
      title="退出登录"
      type="button"
    >
      <LogOut size={17} aria-hidden="true" />
      <span className="visually-hidden">退出登录</span>
    </Button>
  );
}
