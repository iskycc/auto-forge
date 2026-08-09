import { redirect } from "next/navigation";

import { AuthEntryForm } from "@/components/auth-entry-form";
import { currentIdentity } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

export default async function LoginPage() {
  const services = await getPlatformServices();
  if (await currentIdentity()) redirect("/");
  if (await services.identityAccess.setupRequired()) redirect("/setup");
  const ldap = await services.identities.getLdapConfiguration();

  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="login-title">
        <div className="auth-brand-mark" aria-hidden="true">
          AF
        </div>
        <p className="eyebrow">AutoForge Control Plane</p>
        <h1 id="login-title">欢迎回来</h1>
        <p className="auth-intro">登录后管理用例、执行批次和 Runner。</p>
        <AuthEntryForm ldapEnabled={ldap?.enabled ?? false} mode="login" />
      </section>
    </main>
  );
}
