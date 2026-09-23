import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";
import type { Metadata } from "next";

import { JarImporter } from "@/components/jar-importer";
import { requireAuthorizedPageProjectScope, requirePageProjectScope } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";
import { DEFAULT_PROJECT_ID, hasPermission } from "@autoforge/domain";
import {
  selectableProjectIds,
  selectedProjectHierarchy,
  selectedProjectId,
} from "@/lib/selected-project";

export const metadata: Metadata = { title: "导入 TestNG JAR" };
export const dynamic = "force-dynamic";

export default async function ImportJarPage() {
  const { identity } = await requirePageProjectScope("case_source.manage");
  const services = await getPlatformServices();
  const projects = await services.identities
    .listProjects(selectableProjectIds(identity))
    .catch(() => []);
  const projectId =
    (await selectedProjectId(identity, projects, "case_source.manage")) ?? DEFAULT_PROJECT_ID;
  const projectName = projects.find((project) => project.id === projectId)?.name;
  requireAuthorizedPageProjectScope(identity, "case_source.manage", projectId);
  const structure = await services.projectStructures.list(projectId);
  const hierarchy = await selectedProjectHierarchy(structure);
  const projectVersion = structure.versions.find(
    (version) => version.id === hierarchy.projectVersionId,
  );
  const testStage = projectVersion?.stages.find((stage) => stage.id === hierarchy.testStageId);
  return (
    <div
      className={cn("page-stack narrow-page", uiPatterns["page-stack"], uiPatterns["narrow-page"])}
    >
      <section className={cn("page-hero", uiPatterns["page-hero"])}>
        <div>
          <span className={cn("eyebrow", uiPatterns["eyebrow"])}>用例来源</span>
          <h1>导入 TestNG JAR</h1>
          <p>上传 JAR 扫描导入，或从其他版本继承已有用例。</p>
        </div>
      </section>
      <JarImporter
        maxJarBytes={services.config.maxJarBytes}
        versions={structure.versions.map(({ id, name, stages }) => ({
          id,
          name,
          stages: stages.map(({ id, name }) => ({ id, name })),
        }))}
        canInherit={hasPermission(identity, "case.read", projectId)}
        projectId={projectId}
        projectName={projectName}
        projectVersionId={projectVersion?.id}
        projectVersionName={projectVersion?.name}
        testStageId={testStage?.id}
        testStageName={testStage?.name}
      />
    </div>
  );
}
