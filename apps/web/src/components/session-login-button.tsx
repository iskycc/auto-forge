"use client";

import { Button } from "@/components/ui";
import { useLoginDialog } from "./login-dialog-provider";

export function SessionLoginButton({
  className,
  label = "登录",
}: {
  className?: string;
  label?: string;
}) {
  const { openLogin, retrySessionCheck, session } = useLoginDialog();
  // The server page requests this entry when identity is missing. A cached root
  // can still report an older session after expiry or revocation.
  if (session.status === "checking") {
    return (
      <Button className={className} disabled loading type="button">
        正在确认登录状态…
      </Button>
    );
  }
  if (session.status === "failed") {
    return (
      <Button
        className={className}
        onClick={retrySessionCheck}
        title={session.message}
        type="button"
      >
        登录状态确认失败，重试
      </Button>
    );
  }
  return (
    <Button className={className} onClick={openLogin} type="button" variant="primary">
      {label}
    </Button>
  );
}
