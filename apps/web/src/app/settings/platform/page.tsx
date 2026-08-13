import Link from "next/link";
import { hasPermission } from "@autoforge/domain";

import { PlatformSettings } from "@/components/platform-settings";
import { OperationsSettings } from "@/components/operations-settings";
import { SystemDiagnostics } from "@/components/system-diagnostics";
import { hasPermissionInAnyScope, requirePagePermission } from "@/lib/auth";
import { platformConfigurationView } from "@/lib/platform-configuration";
import { getPlatformServices } from "@/lib/services";

export default async function PlatformSettingsPage() {
  const identity = await requirePagePermission("settings.read", undefined);
  const services = await getPlatformServices();
  const configuration = services.configurationStore.read();
  const [retentionPolicies, serviceAccounts, projects] = await Promise.all([
    services.platformOperations.listRetentionPolicies(identity),
    hasPermission(identity, "api_token.manage")
      ? services.platformOperations.listServiceAccounts(identity)
      : Promise.resolve([]),
    hasPermission(identity, "project.read")
      ? services.identityAccess.listProjects(identity)
      : Promise.resolve([]),
  ]);

  return (
    <section className="page-stack">
      <header className="page-header settings-page-header">
        <div>
          <p className="eyebrow">System Settings</p>
          <h1>平台配置</h1>
          <p>管理运行模式、监听地址、基础设施、容量限制和调度阈值。</p>
        </div>
        <nav className="settings-tabs" aria-label="系统设置分类">
          <Link href="/settings">管理中心</Link>
          <Link aria-current="page" href="/settings/platform">
            平台配置
          </Link>
          <Link href="/settings/access">身份与访问</Link>
          {hasPermissionInAnyScope(identity, "environment.read") ||
          hasPermissionInAnyScope(identity, "secret.manage") ? (
            <Link href="/settings/environments">环境与密文</Link>
          ) : null}
        </nav>
      </header>
      <PlatformSettings
        canManage={hasPermission(identity, "settings.manage")}
        initial={platformConfigurationView(
          configuration,
          services.configurationStore.paths.configurationFile,
        )}
      />
      <OperationsSettings
        canManageSettings={hasPermission(identity, "settings.manage")}
        canManageTokens={hasPermission(identity, "api_token.manage")}
        initialAccounts={serviceAccounts}
        initialPolicies={retentionPolicies}
        projects={projects.map((project) => ({ id: project.id, name: project.name }))}
      />
      <SystemDiagnostics />
    </section>
  );
}
