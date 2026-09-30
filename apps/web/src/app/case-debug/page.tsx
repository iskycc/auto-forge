import { hasPermission } from "@autoforge/domain";
import { CaseDebugWorkspace } from "@/components/case-debug-workspace";
import { Notice } from "@/components/ui/notice";
import { requireAuthorizedPageProjectScope, requirePageProjectScope } from "@/lib/auth";
import {
  selectedProjectHierarchy,
  selectedProjectId,
  selectableProjectIds,
} from "@/lib/selected-project";
import { getPlatformServices } from "@/lib/services";

export const dynamic = "force-dynamic";

export default async function CaseDebugPage() {
  const { identity } = await requirePageProjectScope("run.create");
  const services = await getPlatformServices();
  const projects = await services.identities.listProjects(selectableProjectIds(identity));
  const projectId = await selectedProjectId(identity, projects, "run.create");
  if (!projectId) return <Notice>请先创建或选择一个可调试的项目。</Notice>;
  requireAuthorizedPageProjectScope(identity, "run.create", projectId);
  requireAuthorizedPageProjectScope(identity, "case.read", projectId);
  requireAuthorizedPageProjectScope(identity, "run.read", projectId);
  const structure = await services.projectStructures.list(projectId);
  const hierarchy = await selectedProjectHierarchy(structure);
  const version = structure.versions.find((item) => item.id === hierarchy.projectVersionId);
  const stage = version?.stages.find((item) => item.id === hierarchy.testStageId);
  if (!version || !stage) return <Notice>请在顶栏选择项目版本和测试阶段后开始调试。</Notice>;
  return (
    <CaseDebugWorkspace
      key={`${identity.user.id}:${projectId}:${version.id}:${stage.id}`}
      ddtDebugAccess={await services.ddtDebug.workspace({
        projectId,
        projectVersionId: version.id,
        testStageId: stage.id,
        ownerUserId: identity.user.id,
      })}
      maxJarBytes={services.config.maxJarBytes}
      scope={{ projectId, projectVersionId: version.id, testStageId: stage.id }}
      labels={{
        project: projects.find((item) => item.id === projectId)?.name ?? "项目",
        version: version.name,
        stage: stage.name,
      }}
      permissions={{
        uploadJar: hasPermission(identity, "case_source.manage", projectId),
        uploadDdt: true,
        readLogs: hasPermission(identity, "log.read", projectId),
        cancel: hasPermission(identity, "run.cancel", projectId),
      }}
    />
  );
}
