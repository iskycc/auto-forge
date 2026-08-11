"use client";

import { apiErrorSchema, bootstrapAdminInputSchema, loginInputSchema } from "@autoforge/contracts";
import { LockKeyhole, Network, ShieldCheck, UserRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { Button, Input } from "@/components/ui";
import { authEntryValidationMessage } from "@/lib/auth-entry-validation";

type AuthMode = "login" | "setup";

export function AuthEntryForm({ mode, ldapEnabled }: { mode: AuthMode; ldapEnabled?: boolean }) {
  const router = useRouter();
  const [provider, setProvider] = useState<"local" | "ldap">("local");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const payload =
      mode === "setup"
        ? {
            bootstrapToken: stringValue(form, "bootstrapToken"),
            username: stringValue(form, "username"),
            displayName: stringValue(form, "displayName"),
            password: stringValue(form, "password"),
          }
        : {
            username: stringValue(form, "username"),
            password: stringValue(form, "password"),
            provider,
          };
    try {
      const parsed = (mode === "setup" ? bootstrapAdminInputSchema : loginInputSchema).safeParse(
        payload,
      );
      if (!parsed.success) {
        throw new Error(
          authEntryValidationMessage(parsed.error.issues) ?? "请检查账号和凭据字段。",
        );
      }
      const response = await fetch(
        mode === "setup" ? "/api/v1/auth/bootstrap" : "/api/v1/auth/login",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(parsed.data),
        },
      );
      if (!response.ok) {
        const apiError = apiErrorSchema.safeParse(await response.json());
        throw new Error(
          (apiError.success
            ? (authEntryValidationMessage(apiError.data.error.details) ??
              apiError.data.error.message)
            : undefined) ?? "请求未成功。",
        );
      }
      router.push("/");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "请求未成功。");
      setPending(false);
    }
  }

  return (
    <form className="auth-form" noValidate onSubmit={submit}>
      {mode === "login" && ldapEnabled ? (
        <div className="auth-provider" role="group" aria-label="登录来源">
          <Button
            className={provider === "local" ? "auth-provider-active" : ""}
            onClick={() => setProvider("local")}
            type="button"
            variant="ghost"
          >
            <UserRound size={16} aria-hidden="true" /> 本地账号
          </Button>
          <Button
            className={provider === "ldap" ? "auth-provider-active" : ""}
            onClick={() => setProvider("ldap")}
            type="button"
            variant="ghost"
          >
            <Network size={16} aria-hidden="true" /> LDAP
          </Button>
        </div>
      ) : null}

      {mode === "setup" ? (
        <label>
          <span>一次性管理员引导令牌</span>
          <Input
            autoComplete="off"
            maxLength={1024}
            minLength={32}
            name="bootstrapToken"
            placeholder="粘贴 initial-admin-token 的完整内容"
            required
            type="password"
          />
        </label>
      ) : null}

      <label>
        <span>用户名</span>
        <Input
          autoComplete="username"
          maxLength={64}
          minLength={3}
          name="username"
          pattern="[A-Za-z0-9][A-Za-z0-9._-]*"
          required
        />
        {mode === "setup" ? (
          <small>3–64 位，以字母或数字开头，可使用字母、数字、点、下划线和短横线。</small>
        ) : null}
      </label>

      {mode === "setup" ? (
        <label>
          <span>显示名称</span>
          <Input autoComplete="name" maxLength={120} name="displayName" required />
        </label>
      ) : null}

      <label>
        <span>{mode === "setup" ? "管理员密码" : "密码"}</span>
        <Input
          autoComplete={mode === "setup" ? "new-password" : "current-password"}
          maxLength={mode === "setup" ? 128 : 1024}
          minLength={mode === "setup" ? 12 : 1}
          name="password"
          required
          type="password"
        />
        {mode === "setup" ? <small>至少 12 位，并包含字母、数字和特殊字符。</small> : null}
      </label>

      {error ? (
        <p className="auth-error" role="alert">
          {error}
        </p>
      ) : null}

      <Button
        className="auth-submit"
        disabled={pending}
        size="large"
        type="submit"
        variant="primary"
      >
        {mode === "setup" ? <ShieldCheck size={17} /> : <LockKeyhole size={17} />}
        {pending ? "正在处理…" : mode === "setup" ? "创建系统管理员" : "登录"}
      </Button>
    </form>
  );
}

function stringValue(form: FormData, name: string): string {
  return String(form.get(name) ?? "");
}
