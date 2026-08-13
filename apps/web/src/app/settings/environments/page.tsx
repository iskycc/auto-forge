import { DEFAULT_PROJECT_ID, hasPermission, projectIdsForPermission } from "@autoforge/domain";
import Link from "next/link";

import { EnvironmentSettings } from "@/components/environment-settings";
import { requirePageProjectScope } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

export default async function EnvironmentSettingsPage() {
  const { identity, projectIds } = await requirePageProjectScope("environment.read");
  const services = await getPlatformServices();
  const manageableProjectIds = projectIdsForPermission(identity, "environment.manage");
  const secretProjectIds = projectIdsForPermission(identity, "secret.manage");
  const [environments, secrets, knownProjects] = await Promise.all([
    services.executionEnvironments.list(projectIds),
    secretProjectIds?.length === 0 ? [] : services.executionSecrets.list(secretProjectIds),
    hasPermission(identity, "project.read")
      ? services.identityAccess.listProjects(identity)
      : Promise.resolve([]),
  ]);
  const visibleProjectIds = new Set([
    DEFAULT_PROJECT_ID,
    ...(projectIds ?? []),
    ...environments.map((environment) => environment.projectId),
    ...secrets.map((secret) => secret.projectId),
  ]);
  const projects = [
    ...knownProjects.map((project) => ({ id: project.id, name: project.name })),
    ...[...visibleProjectIds]
      .filter((projectId) => !knownProjects.some((project) => project.id === projectId))
      .map((projectId) => ({ id: projectId, name: projectId })),
  ].sort((left, right) => left.name.localeCompare(right.name));

  return (
    <section className="page-stack">
      <header className="page-header settings-page-header">
        <div>
          <p className="eyebrow">System Settings</p>
          <h1>执行环境与密文</h1>
          <p>管理项目级不可变环境版本、密文元数据和执行引用。</p>
        </div>
        <nav className="settings-tabs" aria-label="系统设置分类">
          <Link href="/settings">管理中心</Link>
          <Link href="/settings/platform">平台配置</Link>
          <Link href="/settings/access">身份与访问</Link>
          <Link aria-current="page" href="/settings/environments">
            环境与密文
          </Link>
        </nav>
      </header>
      <EnvironmentSettings
        initialEnvironments={environments}
        initialSecrets={secrets}
        manageableProjectIds={manageableProjectIds ?? null}
        projects={projects}
        secretProjectIds={secretProjectIds ?? null}
      />
    </section>
  );
}
