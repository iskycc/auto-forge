import { DEFAULT_PROJECT_ID, projectIdsForPermission } from "@autoforge/domain";
import { EnvironmentSettings } from "@/components/environment-settings";
import { hasPermissionInAnyScope, requirePageAnyPermission } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

export default async function EnvironmentSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ section?: string }>;
}) {
  const identity = await requirePageAnyPermission(["environment.read", "secret.manage"]);
  const requestedSection = (await searchParams).section;
  const activeSection =
    requestedSection === "secrets" && hasPermissionInAnyScope(identity, "secret.manage")
      ? "secrets"
      : "environments";
  const services = await getPlatformServices();
  const canReadEnvironments = hasPermissionInAnyScope(identity, "environment.read");
  const projectIds = canReadEnvironments
    ? projectIdsForPermission(identity, "environment.read")
    : [];
  const manageableProjectIds = projectIdsForPermission(identity, "environment.manage");
  const secretProjectIds = projectIdsForPermission(identity, "secret.manage");
  const [environments, secrets, knownProjects] = await Promise.all([
    canReadEnvironments ? services.executionEnvironments.list(projectIds) : Promise.resolve([]),
    secretProjectIds?.length === 0 ? [] : services.executionSecrets.list(secretProjectIds),
    hasPermissionInAnyScope(identity, "project.read")
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
          <h1>{activeSection === "environments" ? "执行环境" : "密文管理"}</h1>
          <p>
            {activeSection === "environments"
              ? "管理项目级不可变环境版本、变量、密文引用和执行引用。"
              : "管理项目级密文元数据、轮换状态和受控引用。"}
          </p>
        </div>
      </header>
      <EnvironmentSettings
        activeView={activeSection}
        initialEnvironments={environments}
        initialSecrets={secrets}
        manageableProjectIds={manageableProjectIds ?? null}
        projects={projects}
        secretProjectIds={secretProjectIds ?? null}
      />
    </section>
  );
}
