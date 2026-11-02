"use client";

import { Button, Typography } from "antd";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  registrationAvailabilitySchema,
  type RegistrationAvailability,
} from "@autoforge/contracts";
import { readApiError } from "@/lib/client-api";
import { registrationReturnPath } from "@/lib/registration-return-path";

export function RegistrationEntry({ disabled }: { disabled: boolean }) {
  const router = useRouter();
  const [availability, setAvailability] = useState<RegistrationAvailability>();
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/v1/auth/register", {
          cache: "no-store",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
        });
        const failure = await readApiError(response, "暂时无法确认注册状态。");
        if (failure) throw failure;
        const value = registrationAvailabilitySchema.parse(await response.json());
        if (!controller.signal.aborted) setAvailability(value);
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "暂时无法确认注册状态。");
      }
    })();
    return () => controller.abort();
  }, []);
  return (
    <div className="mt-4 flex min-h-6 items-center justify-center gap-1">
      {availability?.enabled ? (
        <>
          <Typography.Text type="secondary">没有账号？</Typography.Text>
          <Button
            type="link"
            disabled={disabled}
            href="/register"
            className="!h-8 !px-1 !py-0"
            onClick={(event) => {
              event.preventDefault();
              const returnTo = registrationReturnPath(
                `${window.location.pathname}${window.location.search}${window.location.hash}`,
              );
              router.push(`/register?${new URLSearchParams({ returnTo })}`);
            }}
          >
            创建账号
          </Button>
        </>
      ) : (
        <Typography.Text type="secondary">
          {error ||
            (availability?.reason === "ldap_enabled"
              ? "企业目录已启用，请使用目录账号或已有本地账号登录。"
              : availability
                ? "请先完成平台初始化。"
                : "正在确认注册方式…")}
        </Typography.Text>
      )}
    </div>
  );
}
