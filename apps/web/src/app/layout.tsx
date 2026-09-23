import type { Metadata } from "next";
import type { ReactNode } from "react";
import { hasPermission, type Permission } from "@autoforge/domain";
import { connection } from "next/server";
import { cookies } from "next/headers";
import { COLOR_MODE_COOKIE, parseColorMode } from "@/lib/color-mode";

import { PlatformTimeProvider } from "@/components/platform-time";
import { AppShell } from "@/components/app-shell";
import { AntDesignProvider } from "@/components/ant-design-provider";
import { UiFeedbackProvider } from "@/components/ui-feedback";
import { currentIdentity } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";
import {
  selectableProjectIds,
  selectedProjectHierarchy,
  selectedProjectId,
} from "@/lib/selected-project";

import "./theme.css";

export const metadata: Metadata = {
  title: {
    default: "AutoForge",
    template: "%s · AutoForge",
  },
  description: "离线优先的自动化用例工厂",
};

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  // Authentication and platform services are request-bound. Enter dynamic
  // rendering before opening SQLite so parallel prerender workers never race
  // while configuring the same database.
  await connection();
  const colorMode = parseColorMode((await cookies()).get(COLOR_MODE_COOKIE)?.value);
  const services = await getPlatformServices();
  const platformTimeZone = services.configurationStore.read().web.timeZone;
  const identity = await currentIdentity();
  const permissions = identity
    ? ([
        ...new Set([
          ...identity.systemPermissions,
          ...Object.values(identity.projectPermissions).flat(),
        ]),
      ] as Permission[])
    : undefined;
  const projects = identity
    ? await services.identities.listProjects(selectableProjectIds(identity)).catch(() => [])
    : [];
  const activeProjectId = identity ? await selectedProjectId(identity, projects) : undefined;
  const activeProjectStructure = activeProjectId
    ? await services.projectStructures.list(activeProjectId).catch(() => undefined)
    : undefined;
  const activeHierarchy = await selectedProjectHierarchy(activeProjectStructure);
  const projectVersions =
    activeProjectStructure?.versions
      .filter((version) => version.status === "active")
      .map((version) => ({
        id: version.id,
        name: version.name,
        stages: version.stages
          .filter((stage) => stage.status === "active")
          .map(({ id, name }) => ({ id, name })),
      })) ?? [];
  return (
    <html data-time-zone={platformTimeZone} data-color-mode={colorMode} lang="zh-CN">
      <body>
        <AntDesignProvider initialColorMode={colorMode}>
          <PlatformTimeProvider serverTime={services.clock.now().toISOString()}>
            <UiFeedbackProvider>
              <AppShell
                mode={services.config.mode}
                timeZone={platformTimeZone}
                {...(identity
                  ? {
                      userName: identity.user.displayName,
                      userId: identity.user.id,
                      permissions,
                      canCreateProject: hasPermission(identity, "project.manage"),
                      canManageSelectedProject: Boolean(
                        activeProjectId &&
                        !projects.find((project) => project.id === activeProjectId)?.archived &&
                        hasPermission(identity, "project.manage", activeProjectId),
                      ),
                      canReadSelectedProject: Boolean(
                        activeProjectId && hasPermission(identity, "project.read", activeProjectId),
                      ),
                      forcePasswordChange: identity.user.forcePasswordChange,
                      projects: projects.map(({ id, name }) => ({ id, name })),
                      selectedProjectId: activeProjectId,
                      projectVersions,
                      selectedProjectVersionId: activeHierarchy.projectVersionId,
                      selectedTestStageId: activeHierarchy.testStageId,
                    }
                  : {})}
              >
                {children}
              </AppShell>
            </UiFeedbackProvider>
          </PlatformTimeProvider>
        </AntDesignProvider>
      </body>
    </html>
  );
}
