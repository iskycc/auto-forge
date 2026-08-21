import { hasPermission } from "@autoforge/domain";

import { PlatformSettings } from "@/components/platform-settings";
import { OperationsSettings } from "@/components/operations-settings";
import { SystemDiagnostics } from "@/components/system-diagnostics";
import { requirePagePermission } from "@/lib/auth";
import { platformConfigurationView } from "@/lib/platform-configuration";
import { getPlatformServices } from "@/lib/services";
import { SectionTabs } from "@/components/section-tabs";

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
  const heading = platformSectionHeading(activeSection);
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
          <h1>{heading.title}</h1>
          <p>{heading.description}</p>
        </div>
      </header>
      <SectionTabs
        label="平台设置模块"
        tabs={[
          {
            href: "/settings/platform?section=configuration",
            label: "平台配置",
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

function platformSectionHeading(section: PlatformSection): { title: string; description: string } {
  switch (section) {
    case "configuration":
      return {
        title: "平台配置",
        description: "管理运行模式、监听地址、基础设施、容量限制和调度阈值。",
      };
    case "accounts":
      return { title: "服务账号", description: "管理服务账号、项目权限和 API 令牌。" };
    case "retention":
      return { title: "数据保留", description: "管理平台数据保留期限和可恢复清理策略。" };
    case "diagnostics":
      return { title: "系统诊断", description: "检查平台配置、存储和运行时健康状态。" };
  }
}
