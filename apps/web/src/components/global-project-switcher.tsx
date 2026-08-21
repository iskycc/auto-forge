"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { ProjectPicker } from "./project-picker";

const PROJECT_DEPENDENT_PARAMETERS = [
  "projectId",
  "projectVersionId",
  "testStageId",
  "caseProjectId",
  "caseProjectVersionId",
  "cursor",
] as const;

export function GlobalProjectSwitcher({
  projects,
  selectedProjectId,
}: {
  projects: Array<{ id: string; name: string }>;
  selectedProjectId: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [value, setValue] = useState(selectedProjectId);
  const [pending, setPending] = useState(false);

  async function switchProject(projectId: string): Promise<void> {
    if (pending || projectId === value) return;
    const previous = value;
    setValue(projectId);
    setPending(true);
    try {
      const response = await fetch("/api/v1/selected-project", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      if (!response.ok) throw new Error("项目切换失败。");
      const next = new URLSearchParams(searchParams.toString());
      for (const parameter of PROJECT_DEPENDENT_PARAMETERS) next.delete(parameter);
      router.replace(next.size > 0 ? `${pathname}?${next}` : pathname);
      router.refresh();
    } catch {
      setValue(previous);
    } finally {
      setPending(false);
    }
  }

  if (projects.length === 0) return null;
  return (
    <div aria-busy={pending} className="global-project-switcher">
      <span>当前项目</span>
      <ProjectPicker projects={projects} value={value} onChange={(id) => void switchProject(id)} />
    </div>
  );
}
