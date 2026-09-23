"use client";
import { Notice } from "@/components/ui/notice";

import { Card } from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";

import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import { formatPlatformDateTime } from "@/lib/platform-date-time";

import type { AuthenticatedIdentity, UserSession } from "@autoforge/domain";
import { KeyRound, LogOut, ShieldCheck } from "lucide-react";
import { useState, type FormEvent } from "react";

import { Button, Input } from "@/components/ui";
import { useConfirm } from "@/components/ui-feedback";

export function AccountSecurity({
  identity,
  sessions: initialSessions,
}: {
  identity: AuthenticatedIdentity;
  sessions: UserSession[];
}) {
  const confirmAction = useConfirm();
  const [sessions, setSessions] = useState(initialSessions);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const newPassword = String(form.get("newPassword") ?? "");
    if (newPassword !== String(form.get("confirmPassword") ?? "")) {
      setError("两次输入的新密码不一致。");
      return;
    }
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/v1/auth/password", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          currentPassword: form.get("currentPassword"),
          newPassword,
        }),
      });
      if (!response.ok) throw new Error(await responseMessage(response, "修改密码失败。"));
      window.location.replace("/login?passwordChanged=1");
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "修改密码失败。");
      setPending(false);
    }
  }

  async function revokeSession(session: UserSession) {
    if (
      !(await confirmAction({
        title: "终止登录会话",
        description: "该设备上的登录状态会立即失效；若终止当前会话，你将返回登录页。",
        confirmLabel: "终止会话",
        tone: "danger",
      }))
    )
      return;
    setPending(true);
    setError("");
    try {
      const response = await fetch(`/api/v1/sessions/${encodeURIComponent(session.id)}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error(await responseMessage(response, "终止会话失败。"));
      if (session.id === identity.sessionId) {
        window.location.replace("/login");
        return;
      }
      setSessions((current) => current.filter((item) => item.id !== session.id));
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "终止会话失败。");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className={cn("settings-stack", uiPatterns["settings-stack"])}>
      {identity.user.forcePasswordChange ? (
        <div
          className={cn("implementation-notice", accountSecurityStyles["implementation-notice"])}
          role="status"
        >
          <ShieldCheck size={18} aria-hidden="true" />
          管理员要求你先修改初始密码。完成前其他页面和业务 API 均不可使用。
        </div>
      ) : null}
      {error ? (
        <Notice tone="error" className={cn("form-error", uiPatterns["form-error"])} role="alert">
          {error}
        </Notice>
      ) : null}

      <Card
        as="section"
        className={cn(
          "content-card settings-section",
          uiPatterns["content-card"],
          uiPatterns["settings-section"],
        )}
      >
        <div className={cn("section-heading", uiPatterns["section-heading"])}>
          <div>
            <p className={cn("eyebrow", uiPatterns["eyebrow"])}>Password</p>
            <h2>登录密码</h2>
          </div>
          <KeyRound size={22} aria-hidden="true" />
        </div>
        {identity.user.source === "local" ? (
          <form
            className={cn("settings-grid-form", uiPatterns["settings-grid-form"])}
            onSubmit={(event) => void changePassword(event)}
          >
            <label>
              当前密码
              <Input
                autoComplete="current-password"
                name="currentPassword"
                required
                type="password"
              />
            </label>
            <label>
              新密码
              <Input
                autoComplete="new-password"
                minLength={12}
                name="newPassword"
                required
                type="password"
              />
            </label>
            <label>
              确认新密码
              <Input
                autoComplete="new-password"
                minLength={12}
                name="confirmPassword"
                required
                type="password"
              />
            </label>
            <Button
              className={cn(
                "button button-primary",
                uiPatterns["button"],
                uiPatterns["button-primary"],
              )}
              disabled={pending}
              type="submit"
            >
              修改密码并重新登录
            </Button>
          </form>
        ) : (
          <div className={cn("inline-empty", uiPatterns["inline-empty"])}>
            LDAP 账号密码由目录服务管理，AutoForge 不保存或修改目录密码。
          </div>
        )}
      </Card>

      <Card
        as="section"
        className={cn(
          "content-card settings-section",
          uiPatterns["content-card"],
          uiPatterns["settings-section"],
        )}
      >
        <div className={cn("section-heading", uiPatterns["section-heading"])}>
          <div>
            <p className={cn("eyebrow", uiPatterns["eyebrow"])}>Sessions</p>
            <h2>登录会话</h2>
          </div>
          <LogOut size={22} aria-hidden="true" />
        </div>
        <div className={cn("table-scroll", uiPatterns["table-scroll"])}>
          <Table className={cn("data-table", uiPatterns["data-table"])}>
            <TableHeader>
              <TableRow>
                <TableHead>会话</TableHead>
                <TableHead>创建时间</TableHead>
                <TableHead>最近活动</TableHead>
                <TableHead>过期时间</TableHead>
                <TableHead>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.map((session) => (
                <TableRow key={session.id}>
                  <TableCell>
                    {session.id === identity.sessionId ? "当前会话" : session.id}
                  </TableCell>
                  <TableCell>{formatDate(session.createdAt)}</TableCell>
                  <TableCell>{formatDate(session.lastSeenAt)}</TableCell>
                  <TableCell>{formatDate(session.expiresAt)}</TableCell>
                  <TableCell>
                    <Button
                      className={cn("danger-text-button", uiPatterns["danger-text-button"])}
                      disabled={pending}
                      onClick={() => void revokeSession(session)}
                      type="button"
                    >
                      终止
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Card>
    </div>
  );
}

async function responseMessage(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
  return body?.error?.message ?? fallback;
}

function formatDate(value: string): string {
  return formatPlatformDateTime(value, undefined, { dateStyle: "medium", timeStyle: "short" });
}

const accountSecurityStyles = {
  "implementation-notice":
    "mt-4 rounded-lg bg-warning/10 text-warning py-[11px] px-3 text-xs leading-[1.5]",
} as const;
