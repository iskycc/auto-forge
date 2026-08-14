import { hasPermission } from "@autoforge/domain";

import { ManagementNavigation } from "@/components/management-navigation";
import { PlatformSettings } from "@/components/platform-settings";
import { OperationsSettings } from "@/components/operations-settings";
import { SectionTabs } from "@/components/section-tabs";
import { SystemDiagnostics } from "@/components/system-diagnostics";
import { hasPermissionInAnyScope, requirePagePermission } from "@/lib/auth";
import { platformConfigurationView } from "@/lib/platform-configuration";
import { getPlatformServices } from "@/lib/services";

type PlatformSection = "configuration" | "accounts" | "retention" | "diagnostics";

export default async function PlatformSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ section?: string }>;
}) {
  const identity = await requirePagePermission("settings.read", undefined);
  const services = await getPlatformServices();
  const configuration = services.configurationStore.read();
  const requestedSection = (await searchParams).section;
  const activeSection: PlatformSection =
    requestedSection === "accounts" ||
    requestedSection === "retention" ||
    requestedSection === "diagnostics"
      ? requestedSection
      : requestedSection === "automation"
        ? "accounts"
        : "configuration";
  const [retentionPolicies, serviceAccounts, projects] = await Promise.all([
    activeSection === "retention"
      ? services.platformOperations.listRetentionPolicies(identity)
      : Promise.resolve([]),
    activeSection === "accounts" && hasPermission(identity, "api_token.manage")
      ? services.platformOperations.listServiceAccounts(identity)
      : Promise.resolve([]),
    activeSection === "accounts" && hasPermission(identity, "project.read")
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
        <ManagementNavigation
          active="platform"
          showAccess
          showEnvironments={
            hasPermissionInAnyScope(identity, "environment.read") ||
            hasPermissionInAnyScope(identity, "secret.manage")
          }
          showOverview
          showPlatform
          showProjects={hasPermission(identity, "project.read")}
        />
      </header>
      <SectionTabs
        label="平台管理模块"
        tabs={[
          {
            href: "/settings/platform?section=configuration",
            label: "运行配置",
            active: activeSection === "configuration",
          },
          {
            href: "/settings/platform?section=accounts",
            label: "服务账号",
            active: activeSection === "accounts",
          },
          {
            href: "/settings/platform?section=retention",
            label: "数据保留",
            active: activeSection === "retention",
          },
          {
            href: "/settings/platform?section=diagnostics",
            label: "系统诊断",
            active: activeSection === "diagnostics",
          },
        ]}
      />
      {activeSection === "configuration" ? (
        <PlatformSettings
          canManage={hasPermission(identity, "settings.manage")}
          initial={platformConfigurationView(
            configuration,
            services.configurationStore.paths.configurationFile,
          )}
        />
      ) : null}
      {activeSection === "accounts" || activeSection === "retention" ? (
        <OperationsSettings
          canManageSettings={hasPermission(identity, "settings.manage")}
          canManageTokens={hasPermission(identity, "api_token.manage")}
          initialAccounts={serviceAccounts}
          initialPolicies={retentionPolicies}
          projects={projects.map((project) => ({ id: project.id, name: project.name }))}
          visibleSection={activeSection}
        />
      ) : null}
      {activeSection === "diagnostics" ? <SystemDiagnostics /> : null}
    </section>
  );
}
