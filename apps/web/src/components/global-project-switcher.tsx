"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { readApiErrorMessage } from "@/lib/client-api";
import { ProjectHierarchyPicker } from "./project-hierarchy-picker";
import {
  CreateProjectHierarchyDialog,
  type HierarchyCreationTarget,
  type ProjectContext,
} from "./create-project-hierarchy-dialog";
import { useToast } from "./ui-feedback";

const PROJECT_DEPENDENT_PARAMETERS = [
  "projectId",
  "projectVersionId",
  "testStageId",
  "caseProjectId",
  "caseProjectVersionId",
  "cursor",
] as const;

type ProjectVersionOption = {
  id: string;
  name: string;
  stages: Array<{ id: string; name: string }>;
};

export function GlobalProjectSwitcher({
  projects,
  projectVersions,
  selectedProjectId = "",
  selectedProjectVersionId,
  selectedTestStageId,
  canCreateProject,
  canManageSelectedProject,
  canReadSelectedProject,
}: {
  projects: Array<{ id: string; name: string }>;
  projectVersions: ProjectVersionOption[];
  selectedProjectId?: string;
  selectedProjectVersionId?: string;
  selectedTestStageId?: string;
  canCreateProject: boolean;
  canManageSelectedProject: boolean;
  canReadSelectedProject: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const toast = useToast();
  const [context, setContext] = useState<ProjectContext>({
    projectId: selectedProjectId,
    ...(selectedProjectVersionId ? { projectVersionId: selectedProjectVersionId } : {}),
    ...(selectedTestStageId ? { testStageId: selectedTestStageId } : {}),
  });
  const [pending, setPending] = useState(false);
  const [creationTarget, setCreationTarget] = useState<HierarchyCreationTarget | null>(null);
  const versions = context.projectId === selectedProjectId ? projectVersions : [];
  const project = projects.find((item) => item.id === context.projectId);
  const version = versions.find((item) => item.id === context.projectVersionId);
  const stages = version?.stages ?? [];
  // During a project transition the old project's permissions must not enable actions on the new one.
  const canManage = canManageSelectedProject && context.projectId === selectedProjectId;
  const canRead = canReadSelectedProject && context.projectId === selectedProjectId;
  const disabled = pending || creationTarget !== null;

  async function activateContext(nextContext: ProjectContext): Promise<void> {
    const response = await fetch("/api/v1/selected-project", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(nextContext),
    });
    const message = await readApiErrorMessage(response, "项目层级切换失败。");
    if (message) throw new Error(message);
    setContext((await response.json()) as ProjectContext);
    const next = new URLSearchParams(searchParams.toString());
    for (const parameter of PROJECT_DEPENDENT_PARAMETERS) next.delete(parameter);
    router.replace(next.size > 0 ? `${pathname}?${next}` : pathname);
    router.refresh();
  }

  async function switchContext(nextContext: ProjectContext): Promise<void> {
    if (disabled || sameContext(context, nextContext)) return;
    setPending(true);
    try {
      await activateContext(nextContext);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "项目层级切换失败，请检查网络后重试。");
    } finally {
      setPending(false);
    }
  }

  if (projects.length === 0 && !canCreateProject) return null;
  return (
    <div aria-busy={pending} aria-label="当前项目层级" className="global-project-switcher">
      <div className="global-context-field global-context-project">
        <span>项目</span>
        <ProjectHierarchyPicker
          disabled={disabled}
          items={projects}
          value={context.projectId}
          onChange={(projectId) => void switchContext({ projectId })}
          {...(canCreateProject ? { onCreate: () => setCreationTarget({ kind: "project" }) } : {})}
          {...(canRead ? { settingsLink: { href: "/settings/projects", label: "项目设置" } } : {})}
        />
      </div>
      <div className="global-context-field">
        <span>版本</span>
        <ProjectHierarchyPicker
          label="项目版本"
          items={versions}
          value={context.projectVersionId ?? ""}
          disabled={disabled || (!versions.length && !canManage)}
          onChange={(projectVersionId) =>
            void switchContext({ projectId: context.projectId, projectVersionId })
          }
          {...(canManage && project
            ? {
                onCreate: () =>
                  setCreationTarget({
                    kind: "version",
                    projectId: project.id,
                    projectName: project.name,
                  }),
              }
            : {})}
          {...(canRead && version
            ? {
                settingsLink: {
                  href: "/settings/projects?section=execution",
                  label: "执行资源配置",
                },
              }
            : {})}
        />
      </div>
      <div className="global-context-field">
        <span>阶段</span>
        <ProjectHierarchyPicker
          label="测试阶段"
          items={stages}
          value={context.testStageId ?? ""}
          disabled={disabled || !version || (!stages.length && !canManage)}
          onChange={(testStageId) =>
            void switchContext({
              projectId: context.projectId,
              ...(context.projectVersionId ? { projectVersionId: context.projectVersionId } : {}),
              testStageId,
            })
          }
          {...(canManage && project && version
            ? {
                onCreate: () =>
                  setCreationTarget({
                    kind: "stage",
                    projectId: project.id,
                    projectName: project.name,
                    projectVersionId: version.id,
                    projectVersionName: version.name,
                  }),
              }
            : {})}
        />
      </div>
      {creationTarget ? (
        <CreateProjectHierarchyDialog
          target={creationTarget}
          onCreated={activateContext}
          onClose={() => setCreationTarget(null)}
        />
      ) : null}
    </div>
  );
}

function sameContext(left: ProjectContext, right: ProjectContext): boolean {
  return (
    left.projectId === right.projectId &&
    left.projectVersionId === right.projectVersionId &&
    left.testStageId === right.testStageId
  );
}
