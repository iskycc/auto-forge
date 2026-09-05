import Link from "next/link";
import { PlatformNodes } from "@/components/platform-nodes";
import { hasPermission } from "@autoforge/domain";

import { PlatformSettings } from "@/components/platform-settings";
import { OperationsSettings } from "@/components/operations-settings";
import { SystemDiagnostics } from "@/components/system-diagnostics";
import { StorageInventory } from "@/components/storage-inventory";
import { requirePagePermission } from "@/lib/auth";
import { platformConfigurationView } from "@/lib/platform-configuration";
import { getPlatformServices } from "@/lib/services";
import { SectionTabs } from "@/components/section-tabs";
import { storageInventoryCategorySchema } from "@autoforge/contracts";

type PlatformSection =
  "nodes" | "configuration" | "accounts" | "retention" | "diagnostics" | "storage";

export default async function PlatformSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    section?: string;
    category?: string;
    query?: string;
    focus?: string;
    nodeCursor?: string;
  }>;
}) {
  const identity = await requirePagePermission("settings.read", undefined);
  const services = await getPlatformServices();
  const configuration = services.configurationStore.read();
  const parameters = await searchParams;
  const requestedSection = parameters.section;
  const activeSection: PlatformSection =
    (requestedSection === "nodes" && Boolean(services.platformNodes)) ||
    requestedSection === "accounts" ||
    requestedSection === "retention" ||
    requestedSection === "diagnostics" ||
    requestedSection === "storage"
      ? requestedSection
      : requestedSection === "automation"
        ? "accounts"
        : "configuration";
  const nodePage =
    activeSection === "nodes" && services.platformNodes
      ? await services.platformNodes.list(parameters.nodeCursor)
      : { items: [] };
  const heading = platformSectionHeading(activeSection);
  const storageCategory = storageInventoryCategorySchema.safeParse(parameters.category).data;
  const platformView = platformConfigurationView(
    configuration,
    services.configurationStore.paths.configurationFile,
  );
  const publicConfiguration = Object.fromEntries(
    Object.entries(platformView).filter(([key]) => key !== "configurationFile"),
  ) as Omit<typeof platformView, "configurationFile">;
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
          ...(services.platformNodes
            ? [
                {
                  href: "/settings/platform?section=nodes",
                  label: "平台节点",
                  active: activeSection === "nodes",
                },
              ]
            : []),
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
          {
            href: "/settings/platform?section=storage",
            label: "存储空间",
            active: activeSection === "storage",
          },
        ]}
      />
      {activeSection === "nodes" ? (
        <>
          <PlatformNodes
            nodes={nodePage.items}
            canManage={hasPermission(identity, "settings.manage")}
          />
          {nodePage.nextCursor ? (
            <Link
              href={`/settings/platform?section=nodes&nodeCursor=${encodeURIComponent(nodePage.nextCursor)}`}
            >
              下一页节点
            </Link>
          ) : null}
        </>
      ) : null}
      {activeSection === "configuration" ? (
        <PlatformSettings
          canManage={hasPermission(identity, "settings.manage")}
          initial={publicConfiguration}
          {...(parameters.focus ? { initialFocus: parameters.focus.slice(0, 80) } : {})}
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
      {activeSection === "diagnostics" ? (
        <SystemDiagnostics canManage={hasPermission(identity, "settings.manage")} />
      ) : null}
      {activeSection === "storage" ? (
        <StorageInventory
          canManage={hasPermission(identity, "settings.manage")}
          {...(storageCategory ? { initialCategory: storageCategory } : {})}
          initialQuery={parameters.query?.slice(0, 240) ?? ""}
          key={`${storageCategory ?? "all"}:${parameters.query ?? ""}`}
          timeZone={configuration.web.timeZone}
        />
      ) : null}
    </section>
  );
}

function platformSectionHeading(section: PlatformSection): { title: string; description: string } {
  switch (section) {
    case "nodes":
      return {
        title: "平台节点",
        description: "管理平台节点之间的访问地址，让执行日志始终可从所属节点读取。",
      };
    case "configuration":
      return {
        title: "平台配置",
        description: "管理运行模式、平台时区、监听地址、基础设施、容量限制和调度阈值。",
      };
    case "accounts":
      return { title: "服务账号", description: "管理服务账号、项目权限和 API 令牌。" };
    case "retention":
      return { title: "数据保留", description: "管理平台数据保留期限和可恢复清理策略。" };
    case "diagnostics":
      return { title: "系统诊断", description: "检查平台配置、存储和运行时健康状态。" };
    case "storage":
      return { title: "存储空间", description: "查看平台文件、数据库与对象存储的空间占用。" };
  }
}
