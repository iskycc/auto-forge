"use client";

import { useState } from "react";
import { ActionDialog } from "./action-dialog";
import { AuthEntryForm } from "./auth-entry-form";

export function LoginDialog({
  open,
  passwordChanged,
  onClose,
}: {
  open: boolean;
  passwordChanged: boolean;
  onClose: () => void;
}) {
  const [pending, setPending] = useState(false);
  return (
    <ActionDialog
      open={open}
      onClose={onClose}
      title="登录控制台"
      description="使用本地账号或企业目录账号登录，系统会自动识别认证方式。"
      className="w-[440px]"
      closeDisabled={pending}
    >
      <AuthEntryForm
        mode="login"
        onPendingChange={setPending}
        notice={passwordChanged ? "密码已修改，请使用新密码重新登录。" : undefined}
      />
    </ActionDialog>
  );
}
