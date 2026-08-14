import { SectionTabs } from "@/components/section-tabs";

type ManagementArea = "overview" | "projects" | "access" | "environments" | "platform";

export function ManagementNavigation({
  active,
  showOverview = false,
  showProjects = false,
  showAccess = false,
  showEnvironments = false,
  showPlatform = false,
}: {
  active: ManagementArea;
  showOverview?: boolean;
  showProjects?: boolean;
  showAccess?: boolean;
  showEnvironments?: boolean;
  showPlatform?: boolean;
}) {
  return (
    <SectionTabs
      label="管理中心模块"
      tabs={[
        ...(showOverview
          ? [{ href: "/settings", label: "总览", active: active === "overview" }]
          : []),
        ...(showProjects
          ? [{ href: "/settings/projects", label: "项目", active: active === "projects" }]
          : []),
        ...(showAccess
          ? [
              {
                href: "/settings/access?section=users",
                label: "身份与访问",
                active: active === "access",
              },
            ]
          : []),
        ...(showEnvironments
          ? [
              {
                href: "/settings/environments",
                label: "环境与密文",
                active: active === "environments",
              },
            ]
          : []),
        ...(showPlatform
          ? [
              {
                href: "/settings/platform?section=configuration",
                label: "平台",
                active: active === "platform",
              },
            ]
          : []),
      ]}
    />
  );
}
