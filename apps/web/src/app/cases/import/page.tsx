import type { Metadata } from "next";

import { JarImporter } from "@/components/jar-importer";
import { requireAuthorizedPageProjectScope, requirePageProjectScope } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { selectableProjectIds, selectedProjectId } from "@/lib/selected-project";

export const metadata: Metadata = { title: "导入 TestNG JAR" };
export const dynamic = "force-dynamic";

export default async function ImportJarPage({
  searchParams,
}: {
  searchParams: Promise<{
    projectVersionId?: string | string[];
    testStageId?: string | string[];
  }>;
}) {
  const { identity } = await requirePageProjectScope("case_source.manage");
  const parameters = await searchParams;
  const services = await getPlatformServices();
  const projects = await services.identities
    .listProjects(selectableProjectIds(identity))
    .catch(() => []);
  const projectId =
    (await selectedProjectId(identity, projects, "case_source.manage")) ?? DEFAULT_PROJECT_ID;
  requireAuthorizedPageProjectScope(identity, "case_source.manage", projectId);
  const structure = await services.projectStructures.list(projectId);
  const requestedVersionId = single(parameters.projectVersionId);
  const initialVersion =
    structure.versions.find((version) => version.id === requestedVersionId) ??
    structure.versions[0];
  const requestedStageId = single(parameters.testStageId);
  const initialStage =
    initialVersion?.stages.find((stage) => stage.id === requestedStageId) ??
    initialVersion?.stages[0];
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
        initialProjectVersionId={initialVersion?.id}
        initialTestStageId={initialStage?.id}
        versions={structure.versions}
      />
    </div>
  );
}

function single(value: string | string[] | undefined): string | undefined {
  return (Array.isArray(value) ? value[0] : value)?.trim() || undefined;
}
