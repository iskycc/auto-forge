import type { Metadata } from "next";

import { JarImporter } from "@/components/jar-importer";
import { requireAuthorizedPageProjectScope, requirePageProjectScope } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
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
    <div className="page-stack narrow-page">
      <section className="page-hero">
        <div>
          <span className="eyebrow">用例来源</span>
          <h1>导入 TestNG JAR</h1>
          <p>静态读取 class 注解，预览测试类和方法后再写入用例资产。</p>
        </div>
      </section>
      <JarImporter
        maxJarBytes={services.config.maxJarBytes}
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
