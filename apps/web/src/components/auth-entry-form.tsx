"use client";

import { LockKeyhole, Network, ShieldCheck, UserRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

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
            bootstrapToken: form.get("bootstrapToken"),
            username: form.get("username"),
            displayName: form.get("displayName"),
            password: form.get("password"),
          }
        : {
            username: form.get("username"),
            password: form.get("password"),
            provider,
          };
    try {
      const response = await fetch(
        mode === "setup" ? "/api/v1/auth/bootstrap" : "/api/v1/auth/login",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      if (!response.ok) {
        const body = (await response.json()) as { error?: { message?: string } };
        throw new Error(body.error?.message ?? "请求未成功。");
      }
      router.push("/");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "请求未成功。");
      setPending(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={submit}>
      {mode === "login" && ldapEnabled ? (
        <div className="auth-provider" role="group" aria-label="登录来源">
          <button
            className={provider === "local" ? "auth-provider-active" : ""}
            onClick={() => setProvider("local")}
            type="button"
          >
            <UserRound size={16} aria-hidden="true" /> 本地账号
          </button>
          <button
            className={provider === "ldap" ? "auth-provider-active" : ""}
            onClick={() => setProvider("ldap")}
            type="button"
          >
            <Network size={16} aria-hidden="true" /> LDAP
          </button>
        </div>
      ) : null}

      {mode === "setup" ? (
        <label>
          <span>一次性管理员引导令牌</span>
          <input autoComplete="off" name="bootstrapToken" required type="password" />
        </label>
      ) : null}

      <label>
        <span>用户名</span>
        <input autoComplete="username" name="username" required />
      </label>

      {mode === "setup" ? (
        <label>
          <span>显示名称</span>
          <input autoComplete="name" name="displayName" required />
        </label>
      ) : null}

      <label>
        <span>{mode === "setup" ? "管理员密码" : "密码"}</span>
        <input
          autoComplete={mode === "setup" ? "new-password" : "current-password"}
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

      <button className="primary-button auth-submit" disabled={pending} type="submit">
        {mode === "setup" ? <ShieldCheck size={17} /> : <LockKeyhole size={17} />}
        {pending ? "正在处理…" : mode === "setup" ? "创建系统管理员" : "登录"}
      </button>
    </form>
  );
}
