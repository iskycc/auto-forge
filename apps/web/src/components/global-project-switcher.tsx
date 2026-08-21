"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { ProjectPicker } from "./project-picker";
import { Select } from "./ui";

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

type ProjectContext = {
  projectId: string;
  projectVersionId?: string;
  testStageId?: string;
};

export function GlobalProjectSwitcher({
  projects,
  projectVersions,
  selectedProjectId,
  selectedProjectVersionId,
  selectedTestStageId,
}: {
  projects: Array<{ id: string; name: string }>;
  projectVersions: ProjectVersionOption[];
  selectedProjectId: string;
  selectedProjectVersionId?: string;
  selectedTestStageId?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [context, setContext] = useState<ProjectContext>({
    projectId: selectedProjectId,
    ...(selectedProjectVersionId ? { projectVersionId: selectedProjectVersionId } : {}),
    ...(selectedTestStageId ? { testStageId: selectedTestStageId } : {}),
  });
  const [pending, setPending] = useState(false);
  const versions = context.projectId === selectedProjectId ? projectVersions : [];
  const stages = versions.find((version) => version.id === context.projectVersionId)?.stages ?? [];

  async function switchContext(nextContext: ProjectContext): Promise<void> {
    if (pending || sameContext(context, nextContext)) return;
    const previous = context;
    setContext(nextContext);
    setPending(true);
    try {
      const response = await fetch("/api/v1/selected-project", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(nextContext),
      });
      if (!response.ok) throw new Error("项目层级切换失败。");
      setContext((await response.json()) as ProjectContext);
      const next = new URLSearchParams(searchParams.toString());
      for (const parameter of PROJECT_DEPENDENT_PARAMETERS) next.delete(parameter);
      router.replace(next.size > 0 ? `${pathname}?${next}` : pathname);
      router.refresh();
    } catch {
      setContext(previous);
    } finally {
      setPending(false);
    }
  }

  if (projects.length === 0) return null;
  return (
    <div aria-busy={pending} aria-label="当前项目层级" className="global-project-switcher">
      <div className="global-context-field global-context-project">
        <span>项目</span>
        <ProjectPicker
          projects={projects}
          value={context.projectId}
          onChange={(projectId) => {
            if (projectId !== context.projectId) void switchContext({ projectId });
          }}
        />
      </div>
      <label className="global-context-field">
        <span>版本</span>
        <Select
          aria-label="当前项目版本"
          disabled={pending || versions.length === 0}
          onChange={(event) => {
            if (event.target.value === context.projectVersionId) return;
            void switchContext({
              projectId: context.projectId,
              projectVersionId: event.target.value,
            });
          }}
          value={context.projectVersionId ?? ""}
        >
          {versions.length > 0 ? (
            versions.map((version) => (
              <option key={version.id} value={version.id}>
                {version.name}
              </option>
            ))
          ) : (
            <option value="">暂无版本</option>
          )}
        </Select>
      </label>
      <label className="global-context-field">
        <span>阶段</span>
        <Select
          aria-label="当前测试阶段"
          disabled={pending || stages.length === 0}
          onChange={(event) =>
            void switchContext({
              projectId: context.projectId,
              ...(context.projectVersionId ? { projectVersionId: context.projectVersionId } : {}),
              testStageId: event.target.value,
            })
          }
          value={context.testStageId ?? ""}
        >
          {stages.length > 0 ? (
            stages.map((stage) => (
              <option key={stage.id} value={stage.id}>
                {stage.name}
              </option>
            ))
          ) : (
            <option value="">暂无阶段</option>
          )}
        </Select>
      </label>
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
