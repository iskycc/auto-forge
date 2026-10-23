"use client";

import { Button } from "@/components/ui";
import { useLoginDialog } from "./login-dialog-provider";

export function SessionLoginButton({
  className,
  label = "登录",
  variant = "primary",
  "aria-label": ariaLabel,
}: {
  className?: string;
  label?: string;
  variant?: "primary" | "secondary";
  "aria-label"?: string;
}) {
  const { openLogin, retrySessionCheck, session } = useLoginDialog();
  // The server page requests this entry when identity is missing. A cached root
  // can still report an older session after expiry or revocation.
  if (session.status === "checking") {
    return (
      <Button
        aria-label={ariaLabel}
        className={className}
        disabled
        loading
        type="button"
        variant={variant}
      >
        正在确认登录状态…
      </Button>
    );
  }
  if (session.status === "failed") {
    return (
      <Button
        aria-label={ariaLabel}
        className={className}
        onClick={retrySessionCheck}
        title={session.message}
        type="button"
        variant={variant}
      >
        登录状态确认失败，重试
      </Button>
    );
  }
  return (
    <Button
      aria-label={ariaLabel}
      className={className}
      onClick={openLogin}
      type="button"
      variant={variant}
    >
      {label}
    </Button>
  );
}
