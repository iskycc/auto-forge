import { redirect } from "next/navigation";

import { AuthEntryForm } from "@/components/auth-entry-form";
import { PlatformInitialization } from "@/components/platform-initialization";
import { currentIdentity } from "@/lib/auth";
import { platformConfigurationView } from "@/lib/platform-configuration";
import { getPlatformServices } from "@/lib/services";

export default async function SetupPage() {
  const services = await getPlatformServices();
  if (await currentIdentity()) redirect("/");
  if (!(await services.identityAccess.setupRequired())) redirect("/login");

  return (
    <main className="auth-page">
      <div className="setup-layout">
        <PlatformInitialization
          initial={platformConfigurationView(
            services.configurationStore.read(),
            services.configurationStore.paths.configurationFile,
          )}
        />
        <section className="auth-card" aria-labelledby="setup-title">
          <div className="auth-brand-mark" aria-hidden="true">
            AF
          </div>
          <p className="eyebrow">首次离线初始化</p>
          <h1 id="setup-title">创建系统管理员</h1>
          <p className="auth-intro">
            使用首次启动时自动生成的一次性引导令牌。令牌保存在数据目录的
            <code>config/initial-admin-token</code> 文件中，创建成功后平台会自动删除该文件。
          </p>
          <AuthEntryForm mode="setup" />
        </section>
      </div>
    </main>
  );
}
