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
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="login-title">
        <div className="auth-brand-mark" aria-hidden="true">
          AF
        </div>
        <p className="eyebrow">AutoForge Control Plane</p>
        <h1 id="login-title">欢迎回来</h1>
        <p className="auth-intro">使用本地账号或企业目录账号登录，系统会自动识别认证方式。</p>
        <AuthEntryForm
          mode="login"
          notice={passwordChanged ? "密码已修改，请使用新密码重新登录。" : undefined}
        />
      </section>
    </main>
  );
}
