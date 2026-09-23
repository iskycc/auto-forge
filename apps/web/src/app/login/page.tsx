import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";
import { redirect } from "next/navigation";

import { AuthEntryForm } from "@/components/auth-entry-form";
import { currentIdentity } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ passwordChanged?: string }>;
}) {
  const services = await getPlatformServices();
  const identity = await currentIdentity();
  if (identity) redirect(identity.user.forcePasswordChange ? "/account/security" : "/");
  if (await services.identityAccess.setupRequired()) redirect("/setup");
  const passwordChanged = (await searchParams).passwordChanged === "1";

  return (
    <main className={cn("auth-page", pageStyles["auth-page"])}>
      <section className={cn("auth-card", pageStyles["auth-card"])} aria-labelledby="login-title">
        <div className={cn("auth-brand-mark", pageStyles["auth-brand-mark"])} aria-hidden="true">
          AF
        </div>
        <p className={cn("eyebrow", uiPatterns["eyebrow"])}>AutoForge Control Plane</p>
        <h1 id="login-title">欢迎回来</h1>
        <p className={cn("auth-intro", pageStyles["auth-intro"])}>
          使用本地账号或企业目录账号登录，系统会自动识别认证方式。
        </p>
        <AuthEntryForm
          mode="login"
          notice={passwordChanged ? "密码已修改，请使用新密码重新登录。" : undefined}
        />
      </section>
    </main>
  );
}

const pageStyles = {
  "auth-brand-mark":
    "w-11.5 h-11.5 grid place-items-center mb-6 rounded-lg text-primary-foreground bg-card font-semibold tracking-normal",
  "auth-card":
    "w-[min(100%,_440px)] p-9 border border-solid border-border rounded-xl bg-card shadow-xs [&_h1]:[margin:4px_0_8px] [&_h1]:text-3xl [&_h1]:leading-[36px]",
  "auth-intro": "[margin:0_0_24px] text-muted-foreground",
  "auth-page": "min-h-screen grid place-items-center p-6 bg-card",
} as const;
