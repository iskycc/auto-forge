import { redirect } from "next/navigation";
import { fileStorageLocation } from "@/lib/file-storage-location";
import { TabContent } from "@/components/ui/tab-content";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";
import Link from "next/link";
import { CursorPagination } from "@/components/cursor-pagination";
import { PlatformNodes } from "@/components/platform-nodes";
import { hasPermission } from "@autoforge/domain";

import { PlatformSettings } from "@/components/platform-settings";
import { OperationsSettings } from "@/components/operations-settings";
import { requirePagePermission } from "@/lib/auth";
import { platformConfigurationView } from "@/lib/platform-configuration";
import { getPlatformServices } from "@/lib/services";
import { SectionTabs } from "@/components/section-tabs";
import { AiModelSettings } from "@/components/ai-model-settings";

type PlatformSection = "nodes" | "configuration" | "accounts" | "retention" | "ai";

export default async function PlatformSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    section?: string;
    category?: string;
    query?: string;
    focus?: string;
    nodeCursor?: string;
    logCursor?: string;
    cursor?: string;
    status?: string;
  }>;
}) {
  const identity = await requirePagePermission("settings.read", undefined);
  const parameters = await searchParams;
  if (parameters.section === "diagnostics") redirect("/system-info");
  if (parameters.section === "logs")
    redirect(
      `/logs?${new URLSearchParams({ section: "databases", ...(parameters.logCursor ? { logCursor: parameters.logCursor } : {}) })}`,
    );

  if (parameters.section === "storage" || parameters.section === "archives") {
    redirect(
      fileStorageLocation(parameters.section, {
        ...(parameters.category ? { category: parameters.category } : {}),
        ...(parameters.query ? { query: parameters.query } : {}),
      }),
    );
  }
  const services = await getPlatformServices();
  const configuration = services.configurationStore.read();
  const requestedSection = parameters.section;
  const activeSection: PlatformSection =
    (requestedSection === "nodes" && Boolean(services.platformNodes)) ||
    requestedSection === "accounts" ||
    requestedSection === "ai" ||
    requestedSection === "retention"
      ? requestedSection
      : requestedSection === "automation"
        ? "accounts"
        : "configuration";
  const nodePage =
    activeSection === "nodes" && services.platformNodes
      ? await services.platformNodes.list(parameters.nodeCursor)
      : { items: [] };
  const heading = platformSectionHeading(activeSection);
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
      ? services.platformOperations.listServiceAccountsPage(identity, {
          ...(parameters.cursor ? { cursor: parameters.cursor.slice(0, 128) } : {}),
          ...(parameters.query ? { query: parameters.query.trim().slice(0, 120) } : {}),
          ...(["active", "disabled"].includes(parameters.status ?? "")
            ? { status: parameters.status! }
            : {}),
        })
      : Promise.resolve({ items: [], nextCursor: undefined }),
    activeSection === "accounts" && hasPermission(identity, "project.read")
      ? services.identityAccess.listProjects(identity)
      : Promise.resolve([]),
  ]);

  return (
    <section className={cn("page-stack", uiPatterns["page-stack"])}>
      <header
        className={cn(
          "page-header settings-page-header",
          uiPatterns["page-header"],
          uiPatterns["settings-page-header"],
        )}
      >
        <div>
          <p className={cn("eyebrow", uiPatterns["eyebrow"])}>System Settings</p>
          <h1>{heading.title}</h1>
          <p>{heading.description}</p>
          <Badge className={cn("permission-chip", uiPatterns["permission-chip"])}>
            范围：全平台
          </Badge>
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
            href: "/settings/platform?section=ai",
            label: "模型配置",
            active: activeSection === "ai",
          },
          {
            href: "/settings/platform?section=retention",
            label: "数据保留",
            active: activeSection === "retention",
          },
        ]}
      />
      <TabContent activeKey={activeSection} className="gap-5">
        {activeSection === "ai" ? (
          <AiModelSettings
            initial={await services.aiAnalysis.configuration()}
            canManage={hasPermission(identity, "settings.manage")}
          />
        ) : null}
        {activeSection === "nodes" ? (
          <>
            <PlatformNodes
              nodes={nodePage.items}
              currentNodeId={configuration.nodeId}
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
          <>
            <OperationsSettings
              key={`${activeSection}:${parameters.cursor ?? ""}:${parameters.query ?? ""}:${parameters.status ?? ""}`}
              canManageSettings={hasPermission(identity, "settings.manage")}
              canManageTokens={hasPermission(identity, "api_token.manage")}
              initialAccounts={serviceAccounts.items}
              accountFilter={{ query: parameters.query ?? "", status: parameters.status ?? "" }}
              initialPolicies={retentionPolicies}
              projects={projects.map((project) => ({ id: project.id, name: project.name }))}
              visibleSection={activeSection}
            />
            {activeSection === "accounts" ? (
              <CursorPagination
                nextCursor={serviceAccounts.nextCursor}
                count={serviceAccounts.items.length}
                label="服务账号分页"
              />
            ) : null}
          </>
        ) : null}
      </TabContent>
    </section>
  );
}

function platformSectionHeading(section: PlatformSection): { title: string; description: string } {
  switch (section) {
    case "ai":
      return {
        title: "模型配置",
        description: "配置内网模型接口、上下文、Worker 共享额度与重试预算。",
      };
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
      return { title: "数据保留", description: "管理保留期限、影响预览与不可恢复的数据清理。" };
  }
}
