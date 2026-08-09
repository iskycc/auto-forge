import { redirect } from "next/navigation";

import { AuthEntryForm } from "@/components/auth-entry-form";
import { currentIdentity } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

export default async function SetupPage() {
  const services = await getPlatformServices();
  if (await currentIdentity()) redirect("/");
  if (!(await services.identityAccess.setupRequired())) redirect("/login");

  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="setup-title">
        <div className="auth-brand-mark" aria-hidden="true">
          AF
        </div>
        <p className="eyebrow">首次离线初始化</p>
        <h1 id="setup-title">创建系统管理员</h1>
        <p className="auth-intro">
          使用部署时配置的一次性引导令牌。创建成功后，请从运行环境移除该令牌。
        </p>
        {services.config.adminBootstrapToken ? (
          <AuthEntryForm mode="setup" />
        ) : (
          <div className="auth-error" role="alert">
            未配置 AUTOFORGE_ADMIN_BOOTSTRAP_TOKEN，管理员引导入口已关闭。
          </div>
        )}
      </section>
    </main>
  );
}
