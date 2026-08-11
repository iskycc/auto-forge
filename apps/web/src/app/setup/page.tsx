import { redirect } from "next/navigation";
import { Check, DatabaseZap, LockKeyhole, ShieldCheck, WifiOff } from "lucide-react";

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
    <main className="setup-page">
      <div className="setup-shell">
        <aside className="setup-showcase">
          <div className="setup-brand">
            <span aria-hidden="true">AF</span>
            <strong>AutoForge</strong>
          </div>
          <div className="setup-showcase-copy">
            <span className="setup-offline-badge">
              <WifiOff size={14} /> 离线就绪
            </span>
            <h1>
              <span>把自动化执行</span>
              <span>能力，安全地</span>
              <span>带进内网。</span>
            </h1>
            <p>两步完成本地初始化。配置只写入数据目录，不连接遥测、CDN 或在线配置服务。</p>
          </div>
          <ol className="setup-progress-list">
            <li>
              <span>01</span>
              <div>
                <strong>选择部署模式</strong>
                <small>Lite 可直接使用，Full 接入外部基础设施</small>
              </div>
              <Check size={16} />
            </li>
            <li>
              <span>02</span>
              <div>
                <strong>创建系统管理员</strong>
                <small>令牌使用后立即失效并从磁盘删除</small>
              </div>
              <ShieldCheck size={16} />
            </li>
          </ol>
          <div className="setup-security-note">
            <LockKeyhole size={17} />
            <span>
              <strong>一次性安全引导</strong>
              <small>敏感字段不会回显，也不会进入应用日志。</small>
            </span>
          </div>
        </aside>

        <section className="setup-workspace" aria-labelledby="setup-page-title">
          <header className="setup-workspace-header">
            <div>
              <span className="eyebrow">首次启动</span>
              <h1 id="setup-page-title">初始化控制平面</h1>
              <p>先确认运行方式，再建立第一个具备完整管理权限的本地账号。</p>
            </div>
            <span className="setup-local-status">
              <i /> 本地配置
            </span>
          </header>

          <PlatformInitialization
            initial={platformConfigurationView(
              services.configurationStore.read(),
              services.configurationStore.paths.configurationFile,
            )}
          />

          <section className="setup-card setup-admin-card" aria-labelledby="setup-title">
            <div className="setup-card-heading">
              <span className="setup-step-number">02</span>
              <span className="setup-heading-icon setup-heading-icon-red" aria-hidden="true">
                <DatabaseZap size={20} />
              </span>
              <div>
                <span className="setup-kicker">访问控制</span>
                <h2 id="setup-title">创建系统管理员</h2>
                <p>
                  令牌位于 <code>config/initial-admin-token</code>，创建成功后自动删除。
                </p>
              </div>
              <span className="setup-required-badge">必需</span>
            </div>
            <AuthEntryForm mode="setup" />
          </section>

          <footer className="setup-footer">AutoForge · Offline-first control plane</footer>
        </section>
      </div>
    </main>
  );
}
